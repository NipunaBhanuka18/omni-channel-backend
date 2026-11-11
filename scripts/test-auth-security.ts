import fs from "fs";
import os from "os";
import path from "path";
import crypto from "crypto";
import express from "express";

process.env.NODE_ENV = "test";
process.env.ALLOW_MOCK_AUTH = "true";
process.env.COGNITO_USER_POOL_ID = "us-east-1_TestPool";
process.env.COGNITO_APP_CLIENT_ID = "test-client-id-12345";
process.env.AWS_REGION = "us-east-1";

// 1. Isolate Database so tests never mutate real db.json
const tempDbPath = path.join(
  os.tmpdir(),
  `omni-test-db-sec-${Date.now()}-${Math.random().toString(36).slice(2)}.json`
);
const realDbPath = path.join(__dirname, "..", "db.json");
const realDbSnapshotBefore = fs.readFileSync(realDbPath, "utf-8");
fs.writeFileSync(tempDbPath, realDbSnapshotBefore);
process.env.DB_PATH = tempDbPath;

import { app } from "../server";
import { LocalSessionTokenService } from "../services/auth/local-session-token";
import {
  CognitoJwtVerifier,
  CognitoTokenValidationError,
} from "../services/auth/cognito-jwt-verifier";
import { resolveTenantContext } from "../services/tenant-resolver/resolver";
import {
  provisionPendingCompanyApproval,
  PendingCompanyRegistration,
} from "../services/onboarding/approval-workflow";
import { createRequireAuth } from "../services/auth/local-auth-middleware";
import { BoundedRateLimiter, createRateLimitMiddleware } from "../services/auth/bounded-rate-limiter";

function base64UrlEncode(input: Buffer | string): string {
  const buf = typeof input === "string" ? Buffer.from(input, "utf8") : input;
  return buf.toString("base64url");
}

async function runSecurityTests() {
  console.log("================================================================");
  console.log("🔒 AUTHENTICATION, AUTHORIZATION & SECURITY REGRESSION SUITE");
  console.log("================================================================\n");

  const TEST_PORT = 3049;
  const baseUrl = `http://127.0.0.1:${TEST_PORT}`;

  const server = await new Promise<any>((resolve) => {
    const s = app.listen(TEST_PORT, "127.0.0.1", () => resolve(s));
  });

  let passed = 0;
  let failed = 0;

  function assert(testName: string, condition: boolean, details?: string) {
    if (condition) {
      console.log(`✅ PASS: ${testName}`);
      passed++;
    } else {
      console.error(`❌ FAIL: ${testName}`);
      if (details) console.error(`   Details: ${details}`);
      failed++;
    }
  }

  async function api(
    reqPath: string,
    options: { method?: string; body?: any; headers?: Record<string, string> } = {}
  ) {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      ...(options.headers || {}),
    };
    const res = await fetch(`${baseUrl}${reqPath}`, {
      method: options.method || "GET",
      headers,
      body: options.body ? JSON.stringify(options.body) : undefined,
    });
    const json = await res.json().catch(() => ({}));
    return { status: res.status, data: json, headers: res.headers };
  }

  try {
    // =========================================================================
    // 1. Missing bearer token
    // =========================================================================
    console.log("--- 1. Missing Bearer Token ---");
    const missingTokenRes = await api("/api/stats");
    assert(
      "Missing bearer token on protected endpoint returns 401 Authentication required",
      missingTokenRes.status === 401 &&
        missingTokenRes.data.success === false &&
        missingTokenRes.data.error === "Authentication required",
      JSON.stringify(missingTokenRes.data)
    );

    // =========================================================================
    // 2. Malformed bearer token
    // =========================================================================
    console.log("\n--- 2. Malformed Bearer Token ---");
    const malformedTokenRes = await api("/api/stats", {
      headers: { Authorization: "Bearer this.is.not.a.valid.jwt.or.v1.token" },
    });
    assert(
      "Malformed bearer token returns 401 Invalid or expired authentication token",
      malformedTokenRes.status === 401 &&
        malformedTokenRes.data.success === false &&
        malformedTokenRes.data.error.includes("Invalid or expired"),
      JSON.stringify(malformedTokenRes.data)
    );

    // =========================================================================
    // 3. Expired token
    // =========================================================================
    console.log("\n--- 3. Expired Token ---");
    // Create an expired local HMAC token (issued 2 hours ago with 1-hour TTL)
    const testSecret = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
    const expiredTokenService = new LocalSessionTokenService({
      secret: testSecret,
      ttlSeconds: 3600,
      now: () => Date.now() - 7200 * 1000, // 2 hours ago
    });
    const expiredToken = expiredTokenService.issueToken({
      sub: "expired-user",
      email: "expired@test.com",
      name: "Expired SuperAdmin",
      role: "superadmin",
    });

    // Verify token service rejects it when checked with real clock
    const realClockService = new LocalSessionTokenService({ secret: testSecret });
    const verifyExpired = realClockService.verifyToken(expiredToken);
    assert("LocalSessionTokenService rejects expired token (returns null)", verifyExpired === null);

    // Verify server endpoint rejects expired token
    const expiredRes = await api("/api/stats", {
      headers: { Authorization: `Bearer ${expiredToken}` },
    });
    assert(
      "Expired token on protected endpoint returns 401",
      expiredRes.status === 401 && expiredRes.data.success === false,
      JSON.stringify(expiredRes.data)
    );

    // =========================================================================
    // 4. Invalid cryptographic signature
    // =========================================================================
    console.log("\n--- 4. Invalid Cryptographic Signature ---");
    const validTokenService = new LocalSessionTokenService({
      secret: testSecret,
      ttlSeconds: 3600,
    });
    const validToken = validTokenService.issueToken({
      sub: "valid-admin",
      email: "superadmin@slt.lk",
      name: "System Super Admin",
      role: "superadmin",
    });
    // Tamper the signature part (v1.<payload>.<signature>)
    const tokenParts = validToken.split(".");
    const tamperedToken = `${tokenParts[0]}.${tokenParts[1]}.${tokenParts[2].slice(0, -4)}XXXX`;

    const tamperedRes = await api("/api/stats", {
      headers: { Authorization: `Bearer ${tamperedToken}` },
    });
    assert(
      "Tampered signature token returns 401 Invalid or expired authentication token",
      tamperedRes.status === 401 && tamperedRes.data.success === false,
      JSON.stringify(tamperedRes.data)
    );

    // =========================================================================
    // 5. Incorrect issuer
    // =========================================================================
    console.log("\n--- 5. Incorrect Issuer (Cognito RS256) ---");
    // Generate RSA key pair for testing CognitoJwtVerifier directly
    const { publicKey, privateKey } = crypto.generateKeyPairSync("rsa", {
      modulusLength: 2048,
    });
    const publicJwk = publicKey.export({ format: "jwk" });
    const kid = "test-security-key-id-01";
    publicJwk.kid = kid;
    publicJwk.use = "sig";
    publicJwk.alg = "RS256";

    const mockJwksFetch = async () => ({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ keys: [publicJwk] }),
    });

    const expectedIssuer = "https://cognito-idp.us-east-1.amazonaws.com/us-east-1_TestPool";
    const verifier = new CognitoJwtVerifier({
      userPoolId: "us-east-1_TestPool",
      clientId: "test-client-id-12345",
      region: "us-east-1",
      fetchFn: mockJwksFetch as any,
    });

    // Create JWT with mismatched issuer
    const badIssuerPayload = {
      sub: "user-123",
      iss: "https://evil-untrusted-issuer.com/us-east-1_TestPool",
      token_use: "id",
      aud: "test-client-id-12345",
      iat: Math.floor(Date.now() / 1000) - 60,
      exp: Math.floor(Date.now() / 1000) + 3600,
    };
    const badIssuerHeader = { alg: "RS256", typ: "JWT", kid };
    const badIssuerSigningInput = `${base64UrlEncode(JSON.stringify(badIssuerHeader))}.${base64UrlEncode(
      JSON.stringify(badIssuerPayload)
    )}`;
    const badIssuerSig = crypto.sign("RSA-SHA256", Buffer.from(badIssuerSigningInput), privateKey);
    const badIssuerJwt = `${badIssuerSigningInput}.${base64UrlEncode(badIssuerSig)}`;

    let badIssuerError: any = null;
    try {
      await verifier.verifyToken(badIssuerJwt);
    } catch (err) {
      badIssuerError = err;
    }
    assert(
      "CognitoJwtVerifier rejects incorrect issuer with CognitoTokenValidationError",
      badIssuerError instanceof CognitoTokenValidationError &&
        badIssuerError.message.includes("issuer mismatch"),
      badIssuerError?.message
    );

    // =========================================================================
    // 6. Incorrect token use / audience / client binding
    // =========================================================================
    console.log("\n--- 6. Incorrect Token Use / Audience / Client Binding ---");
    // 6a: Wrong token_use (neither id nor access)
    const badUsePayload = {
      sub: "user-123",
      iss: expectedIssuer,
      token_use: "refresh", // Disallowed
      aud: "test-client-id-12345",
      iat: Math.floor(Date.now() / 1000) - 60,
      exp: Math.floor(Date.now() / 1000) + 3600,
    };
    const badUseInput = `${base64UrlEncode(JSON.stringify(badIssuerHeader))}.${base64UrlEncode(
      JSON.stringify(badUsePayload)
    )}`;
    const badUseSig = crypto.sign("RSA-SHA256", Buffer.from(badUseInput), privateKey);
    const badUseJwt = `${badUseInput}.${base64UrlEncode(badUseSig)}`;

    let badUseError: any = null;
    try {
      await verifier.verifyToken(badUseJwt);
    } catch (err) {
      badUseError = err;
    }
    assert(
      "CognitoJwtVerifier rejects disallowed token_use (refresh)",
      badUseError instanceof CognitoTokenValidationError &&
        badUseError.message.includes("token_use claim"),
      badUseError?.message
    );

    // 6b: Wrong audience (aud doesn't match client_id)
    const badAudPayload = {
      sub: "user-123",
      iss: expectedIssuer,
      token_use: "id",
      aud: "attacker-client-id-99999",
      iat: Math.floor(Date.now() / 1000) - 60,
      exp: Math.floor(Date.now() / 1000) + 3600,
    };
    const badAudInput = `${base64UrlEncode(JSON.stringify(badIssuerHeader))}.${base64UrlEncode(
      JSON.stringify(badAudPayload)
    )}`;
    const badAudSig = crypto.sign("RSA-SHA256", Buffer.from(badAudInput), privateKey);
    const badAudJwt = `${badAudInput}.${base64UrlEncode(badAudSig)}`;

    let badAudError: any = null;
    try {
      await verifier.verifyToken(badAudJwt);
    } catch (err) {
      badAudError = err;
    }
    assert(
      "CognitoJwtVerifier rejects token with client/audience mismatch",
      badAudError instanceof CognitoTokenValidationError &&
        badAudError.message.includes("audience mismatch"),
      badAudError?.message
    );

    // =========================================================================
    // 7. Tenant claim mismatch
    // =========================================================================
    console.log("\n--- 7. Tenant Claim Mismatch ---");
    // When client sends dev-token-company (tenant "slt") with conflicting x-tenant-id header "victim-tenant"
    const mismatchHeaderRes = await api("/api/workspace/upload-doc", {
      method: "POST",
      headers: {
        Authorization: "Bearer dev-token-company",
        "x-tenant-id": "victim-tenant",
      },
      body: {
        tenantId: "slt",
        documentName: "test.txt",
        content: "test",
      },
    });
    assert(
      "Express auth middleware rejects header x-tenant-id mismatch with 403 Cross-tenant access denied",
      mismatchHeaderRes.status === 403 &&
        mismatchHeaderRes.data.success === false &&
        mismatchHeaderRes.data.error.includes("Cross-tenant access denied"),
      JSON.stringify(mismatchHeaderRes.data)
    );

    // Also verify tenant resolver zero-trust mismatch
    const mockClaimsToken =
      "mock." +
      Buffer.from(
        JSON.stringify({
          "cognito:groups": ["admin"],
          "custom:tenant_id": "tenant-legit",
        })
      ).toString("base64") +
      ".mock";
    const resolverMismatch = resolveTenantContext({
      authorization: `Bearer ${mockClaimsToken}`,
      "x-tenant-id": "tenant-spoofed",
    });
    assert(
      "Tenant resolver rejects x-tenant-id / token tenant mismatch with 403 TENANT_MISMATCH",
      !resolverMismatch.success &&
        resolverMismatch.error?.code === "FORBIDDEN" &&
        resolverMismatch.error?.details?.reason === "TENANT_MISMATCH"
    );

    // =========================================================================
    // 8. Cross-tenant access attempts on workspace endpoints
    // =========================================================================
    console.log("\n--- 8. Cross-Tenant Access Attempts on Workspace Endpoints ---");
    // Company admin of 'slt' attempting to upload document into 'other-corp'
    const crossTenantUploadRes = await api("/api/workspace/upload-doc", {
      method: "POST",
      headers: {
        Authorization: "Bearer dev-token-company", // tenant is 'slt'
      },
      body: {
        tenantId: "other-corp", // mismatch with authorized tenant
        documentName: "secret.txt",
        content: "exfiltrated content",
      },
    });
    assert(
      "POST /api/workspace/upload-doc rejects cross-tenant attempt with 403 Cross-tenant access denied",
      crossTenantUploadRes.status === 403 &&
        crossTenantUploadRes.data.success === false &&
        crossTenantUploadRes.data.error.includes("Cross-tenant access denied"),
      JSON.stringify(crossTenantUploadRes.data)
    );

    // =========================================================================
    // 9. Unauthorized registration approval attempt without token
    // =========================================================================
    console.log("\n--- 9. Unauthorized Registration Approval Attempt Without Token ---");
    // First create a pending registration
    const newReg = await api("/api/registrations", {
      method: "POST",
      body: {
        companyName: "Secured Test Corp",
        companyEmail: "test@securedcorp.com",
      },
    });
    const testRegId = newReg.data.registration?.id;
    assert("Prerequisite: pending registration created", newReg.status === 201 && Boolean(testRegId));

    // Attempt approval without token
    const unauthApproveRes = await api(`/api/registrations/${testRegId}`, {
      method: "PATCH",
      body: { status: "approved" },
    });
    assert(
      "PATCH /api/registrations/:id without token returns 401 Authentication required",
      unauthApproveRes.status === 401 && unauthApproveRes.data.success === false,
      JSON.stringify(unauthApproveRes.data)
    );

    // =========================================================================
    // 10. Company Admin attempting Super Admin approval
    // =========================================================================
    console.log("\n--- 10. Company Admin Attempting Super Admin Approval ---");
    const companyApproveRes = await api(`/api/registrations/${testRegId}`, {
      method: "PATCH",
      headers: { Authorization: "Bearer dev-token-company" },
      body: { status: "approved" },
    });
    assert(
      "PATCH /api/registrations/:id by Company Admin returns 403 Insufficient permissions",
      companyApproveRes.status === 403 &&
        companyApproveRes.data.success === false &&
        companyApproveRes.data.error.includes("Insufficient permissions"),
      JSON.stringify(companyApproveRes.data)
    );

    // =========================================================================
    // 11. Authorized Super Admin approval succeeds
    // =========================================================================
    console.log("\n--- 11. Authorized Super Admin Approval Succeeds ---");
    const superAdminApproveRes = await api(`/api/registrations/${testRegId}`, {
      method: "PATCH",
      headers: { Authorization: "Bearer dev-token-superadmin" },
      body: { status: "approved" },
    });
    assert(
      "PATCH /api/registrations/:id by Super Admin returns 200 with Approved status and provisioned tenantId",
      superAdminApproveRes.status === 200 &&
        superAdminApproveRes.data.success === true &&
        superAdminApproveRes.data.registration?.status === "Approved" &&
        typeof superAdminApproveRes.data.registration?.tenantId === "string" &&
        superAdminApproveRes.data.registration?.tenantId.startsWith("tenant-"),
      JSON.stringify(superAdminApproveRes.data)
    );

    // =========================================================================
    // 12. Rejection without tenant provisioning
    // =========================================================================
    console.log("\n--- 12. Rejection Without Tenant Provisioning ---");
    const rejectTargetReg = await api("/api/registrations", {
      method: "POST",
      body: {
        companyName: "Rejected Inbound Corp",
        companyEmail: "reject@test.com",
      },
    });
    const rejectId = rejectTargetReg.data.registration?.id;

    const superAdminRejectRes = await api(`/api/registrations/${rejectId}`, {
      method: "PATCH",
      headers: { Authorization: "Bearer dev-token-superadmin" },
      body: { status: "rejected" },
    });
    assert(
      "PATCH /api/registrations/:id sets status Rejected and DOES NOT provision tenantId",
      superAdminRejectRes.status === 200 &&
        superAdminRejectRes.data.success === true &&
        superAdminRejectRes.data.registration?.status === "Rejected" &&
        superAdminRejectRes.data.registration?.tenantId === undefined,
      JSON.stringify(superAdminRejectRes.data)
    );

    // =========================================================================
    // 13. Duplicate approval / idempotency rejection
    // =========================================================================
    console.log("\n--- 13. Duplicate Approval / Idempotency Rejection ---");
    const dupApproveRes = await api(`/api/registrations/${testRegId}`, {
      method: "PATCH",
      headers: { Authorization: "Bearer dev-token-superadmin" },
      body: { status: "approved" },
    });
    assert(
      "Duplicate approval attempt on already Approved registration returns 409 Conflict",
      dupApproveRes.status === 409 &&
        dupApproveRes.data.success === false &&
        dupApproveRes.data.error.includes("already been approved"),
      JSON.stringify(dupApproveRes.data)
    );

    // =========================================================================
    // 14. Failure during provisioning fails closed
    // =========================================================================
    console.log("\n--- 14. Failure During Provisioning Fails Closed ---");
    const failingReg: PendingCompanyRegistration = {
      id: "reg-sim-fail-01",
      status: "Pending",
      companyName: "Simulated Outage Corp",
      companySlug: "sim-outage",
      companyEmail: "outage@test.com",
    };
    const failOutcome = await provisionPendingCompanyApproval(failingReg, async () => ({
      success: false,
      error: {
        code: "SIMULATED_DYNAMO_FAIL",
        message: "DynamoDB unavailable during tenant provisioning",
      },
    }));
    assert(
      "provisionPendingCompanyApproval fails closed when provisioner fails",
      failOutcome.success === false &&
        failingReg.status === "Pending" &&
        failingReg.tenantId === undefined,
      JSON.stringify(failOutcome)
    );

    // =========================================================================
    // 15. Production-mode rejection of mock authentication
    // =========================================================================
    console.log("\n--- 15. Production-Mode Rejection of Mock Authentication ---");
    // Create an isolated requireAuth configured for production mode
    const prodAuthMiddleware = createRequireAuth({
      isLocalTokensAllowed: () => false, // Simulate production / non-local
      getTokenService: () => validTokenService,
      getCognitoVerifier: () => null,
    });
    const mockReq: any = {
      headers: { authorization: "Bearer dev-token-superadmin" },
    };
    let capturedProdStatus: number = 0;
    let capturedProdBody: any = null;
    const mockRes: any = {
      status(code: number) {
        capturedProdStatus = code;
        return this;
      },
      json(body: any) {
        capturedProdBody = body;
        return this;
      },
    };
    let nextCalled = false;
    await prodAuthMiddleware(mockReq, mockRes, () => {
      nextCalled = true;
    });
    assert(
      "Production-mode rejects dev-token-superadmin with 401 Unauthorized",
      capturedProdStatus === 401 &&
        nextCalled === false &&
        capturedProdBody?.success === false,
      `status=${capturedProdStatus}, body=${JSON.stringify(capturedProdBody)}`
    );

    // =========================================================================
    // 16. Development-only mock authentication boundaries enforced
    // =========================================================================
    console.log("\n--- 16. Development-Only Mock Auth Boundaries Enforced ---");
    // Verify dev-token-superadmin grants superadmin role with undefined tenantId
    const devSuperReq: any = {
      headers: { authorization: "Bearer dev-token-superadmin" },
    };
    let devSuperNext = false;
    const devAuthMiddleware = createRequireAuth({
      isLocalTokensAllowed: () => true,
      getTokenService: () => validTokenService,
    });
    await devAuthMiddleware(devSuperReq, mockRes, () => {
      devSuperNext = true;
    });
    assert(
      "dev-token-superadmin grants role='superadmin' with NO tenant scope",
      devSuperNext === true &&
        devSuperReq.localAuth?.role === "superadmin" &&
        devSuperReq.localAuth?.tenantId === undefined,
      JSON.stringify(devSuperReq.localAuth)
    );

    // Verify dev-token-company is bound to 'slt' and cannot assume other tenants
    const devCompanyReq: any = {
      headers: { authorization: "Bearer dev-token-company" },
    };
    let devCompanyNext = false;
    await devAuthMiddleware(devCompanyReq, mockRes, () => {
      devCompanyNext = true;
    });
    assert(
      "dev-token-company is strictly bound to tenantId='slt' and role='company'",
      devCompanyNext === true &&
        devCompanyReq.localAuth?.role === "company" &&
        devCompanyReq.localAuth?.tenantId === "slt",
      JSON.stringify(devCompanyReq.localAuth)
    );

    // =========================================================================
    // 17. Rate limits enforced on registration endpoint
    // =========================================================================
    console.log("\n--- 17. Rate Limits Enforced on Registration Endpoint ---");
    // Test the rate limiter utility with a tight maxRequests bound
    const tightLimiter = new BoundedRateLimiter({
      windowMs: 5000,
      maxRequests: 3,
    });
    const tightMiddleware = createRateLimitMiddleware(tightLimiter, {
      errorMessage: "Rate limit exceeded",
    });
    const testApp = express();
    testApp.use(express.json());
    testApp.post("/limited-reg", tightMiddleware, (_req, res) => {
      res.json({ success: true });
    });
    const limiterServer = await new Promise<any>((resolve) => {
      const s = testApp.listen(3059, "127.0.0.1", () => resolve(s));
    });

    try {
      const responses: number[] = [];
      for (let i = 0; i < 4; i++) {
        const r = await fetch("http://127.0.0.1:3059/limited-reg", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ attempt: i }),
        });
        responses.push(r.status);
      }
      assert(
        "Bounded rate limiter allows first 3 requests (200) and rejects 4th with 429 Too Many Requests",
        responses[0] === 200 &&
          responses[1] === 200 &&
          responses[2] === 200 &&
          responses[3] === 429,
        `HTTP statuses: ${responses.join(", ")}`
      );
    } finally {
      limiterServer.close();
    }

    // =========================================================================
    // Real db.json safety check
    // =========================================================================
    console.log("\n--- Real Database Immutability Check ---");
    const realDbSnapshotAfter = fs.readFileSync(realDbPath, "utf-8");
    assert(
      "Real tracked db.json was NOT mutated during security test execution",
      realDbSnapshotBefore === realDbSnapshotAfter,
      `Length before: ${realDbSnapshotBefore.length}, Length after: ${realDbSnapshotAfter.length}`
    );
  } finally {
    server.close();
    if (fs.existsSync(tempDbPath)) {
      try {
        fs.unlinkSync(tempDbPath);
      } catch {
        // ignore cleanup error
      }
    }
  }

  console.log("\n================================================================");
  console.log(`📊 Security Test Summary: ${passed} Passed, ${failed} Failed`);
  console.log("================================================================");

  if (failed > 0) {
    process.exit(1);
  } else {
    process.exit(0);
  }
}

runSecurityTests().catch((err) => {
  console.error("Fatal security test suite error:", err);
  process.exit(1);
});
