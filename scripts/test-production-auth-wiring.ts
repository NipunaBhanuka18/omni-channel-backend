/**
 * End-to-end integration tests for Phase 2B production Cognito auth wiring,
 * fail-closed non-local gates, Lambda adapters, onboarding auth, and rate limiting.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { AddressInfo } from "node:net";
import { createSign, generateKeyPairSync, randomUUID } from "node:crypto";
import { DeleteCommand, GetCommand, PutCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";
import { DeleteObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";
import { AdminAddUserToGroupCommand, AdminCreateUserCommand } from "@aws-sdk/client-cognito-identity-provider";
import { createApp } from "../server";
import { BoundedRateLimiter } from "../services/auth/bounded-rate-limiter";
import {
  CognitoFetchFn,
  CognitoJwtVerifier,
} from "../services/auth/cognito-jwt-verifier";
import { createJsonDbStore } from "../services/auth/local-auth-router";
import { LocalSessionTokenService } from "../services/auth/local-session-token";
import { handleOnboardingRequest } from "../services/onboarding/handler";
import { handler as onboardingLambdaHandler } from "../services/onboarding/lambda-adapter";
import { OnboardingDeps } from "../services/onboarding/onboarding";
import { decodeMockCognitoJwt } from "../services/tenant-resolver/mock-jwt-validator";
import { resolveTenantContextVerified } from "../services/tenant-resolver/resolver";
import { handleTenantRequest } from "../services/tenant-router/handler";
import { handler as tenantRouterLambdaHandler } from "../services/tenant-router/lambda-adapter";

function signRs256Jwt(
  kid: string,
  payload: Record<string, unknown>,
  privateKeyPem: string | Buffer,
): string {
  const headerB64 = Buffer.from(JSON.stringify({ alg: "RS256", kid, typ: "JWT" }), "utf8").toString("base64url");
  const payloadB64 = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  const signingInput = `${headerB64}.${payloadB64}`;
  const signer = createSign("RSA-SHA256");
  signer.update(signingInput, "ascii");
  signer.end();
  return `${signingInput}.${signer.sign(privateKeyPem).toString("base64url")}`;
}

function makeFakeOnboardingDeps(): OnboardingDeps {
  const tenants = new Map<string, any>();
  const dynamo = {
    send: async (command: any) => {
      const input: any = command.input;
      if (command instanceof GetCommand) return { Item: tenants.get(input.Key.tenantId) };
      if (command instanceof QueryCommand) {
        const wanted = input.ExpressionAttributeValues?.[":n"];
        const match = [...tenants.values()].find((t) => t.normalizedName === wanted);
        return { Items: match ? [match] : [] };
      }
      if (command instanceof PutCommand) {
        if (input.TableName === "omni-channel-tenants") {
          tenants.set(input.Item.tenantId, input.Item);
        }
        return {};
      }
      if (command instanceof DeleteCommand) {
        if (input.TableName === "omni-channel-tenants") tenants.delete(input.Key.tenantId);
        return {};
      }
      return {};
    },
  };
  const cognito = {
    send: async (command: any) => {
      if (command instanceof AdminCreateUserCommand || command instanceof AdminAddUserToGroupCommand) {
        return {};
      }
      return {};
    },
  };
  const s3 = {
    send: async (command: any) => {
      if (command instanceof PutObjectCommand || command instanceof DeleteObjectCommand) return {};
      return {};
    },
  };
  return { dynamo: dynamo as any, cognito: cognito as any, s3: s3 as any, userPoolId: "us-east-1_FakePool" };
}

async function reqJson(
  baseUrl: string,
  route: string,
  opts: {
    method?: string;
    token?: string;
    headers?: Record<string, string>;
    body?: unknown;
    rawBody?: string;
  } = {},
) {
  const headers: Record<string, string> = { ...(opts.headers || {}) };
  if (opts.token) headers.Authorization = `Bearer ${opts.token}`;
  if ((opts.body !== undefined || opts.rawBody !== undefined) && !headers["Content-Type"]) {
    headers["Content-Type"] = "application/json";
  }
  const res = await fetch(`${baseUrl}${route}`, {
    method: opts.method || "GET",
    headers,
    body: opts.rawBody !== undefined ? opts.rawBody : opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
  const text = await res.text();
  let data: Record<string, any> = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { raw: text };
  }
  return { status: res.status, headers: res.headers, data };
}

async function main(): Promise<void> {
  const savedEnv = {
    NODE_ENV: process.env.NODE_ENV,
    IS_LOCAL: process.env.IS_LOCAL,
    ALLOW_MOCK_AUTH: process.env.ALLOW_MOCK_AUTH,
    COGNITO_USER_POOL_ID: process.env.COGNITO_USER_POOL_ID,
    COGNITO_CLIENT_ID: process.env.COGNITO_CLIENT_ID,
    COGNITO_REGION: process.env.COGNITO_REGION,
    COGNITO_JWKS_URI: process.env.COGNITO_JWKS_URI,
    CORS_ALLOWED_ORIGINS: process.env.CORS_ALLOWED_ORIGINS,
  };

  let passed = 0;
  const pass = (label: string) => {
    console.log(`PASS: ${label}`);
    passed++;
  };

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "omni-prod-auth-"));
  const servers: http.Server[] = [];

  try {
    const userPoolId = "us-east-1_ProdPool9";
    const clientId = "frontendclient987";
    const issuer = `https://cognito-idp.us-east-1.amazonaws.com/${userPoolId}`;
    const kp = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const privPem = kp.privateKey.export({ format: "pem", type: "pkcs8" });
    const pubJwk = { ...(kp.publicKey.export({ format: "jwk" }) as Record<string, unknown>), kid: "prod-k1", use: "sig", alg: "RS256" };

    // Live ephemeral loopback JWKS HTTP server (exercises real fetch -> JWKS JSON parse path)
    let jwksOnline = true;
    const jwksServer = http.createServer((_req, res) => {
      if (!jwksOnline) {
        res.statusCode = 503;
        res.end("down");
        return;
      }
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ keys: [pubJwk] }));
    });
    await new Promise<void>((resolve) => jwksServer.listen(0, "127.0.0.1", resolve));
    servers.push(jwksServer);
    const jwksPort = (jwksServer.address() as AddressInfo).port;
    const localJwksUrl = `http://127.0.0.1:${jwksPort}/.well-known/jwks.json`;

    const nowSec = Math.floor(Date.now() / 1000);
    const makeCognitoToken = (overrides: Record<string, unknown>) =>
      signRs256Jwt(
        "prod-k1",
        {
          sub: "usr-default",
          iss: issuer,
          aud: clientId,
          token_use: "id",
          email: "user@slt.lk",
          iat: nowSec - 10,
          exp: nowSec + 3600,
          ...overrides,
        },
        privPem,
      );

    const superToken = makeCognitoToken({
      sub: "usr-super-prod",
      email: "super@slt.lk",
      "cognito:groups": ["superadmin"],
    });
    const companyAdminToken = makeCognitoToken({
      sub: "usr-company-slt",
      email: "admin@slt.lk",
      "cognito:groups": ["admin"],
      "custom:tenant_id": "slt",
    });
    const agentToken = makeCognitoToken({
      sub: "usr-agent-slt",
      email: "agent@slt.lk",
      "cognito:groups": ["live_agent"],
      "custom:tenant_id": "slt",
    });
    const staffToken = makeCognitoToken({
      sub: "usr-staff-platform",
      email: "staff@slt.lk",
      "cognito:groups": ["staff"],
    });
    const danglingAdminToken = makeCognitoToken({
      sub: "usr-dangling-admin",
      email: "dangling@slt.lk",
      "cognito:groups": ["admin"],
    });

    const dbPath = path.join(tempDir, "db.json");
    createJsonDbStore(dbPath).writeDB({ users: [], registrations: [] });
    const localTokenSvc = new LocalSessionTokenService({
      secret: "test-local-signing-secret-at-least-32b!",
    });
    const demoSuperV1 = localTokenSvc.issueToken({
      sub: "local-super",
      email: "local@example.test",
      name: "Local",
      role: "superadmin",
    });

    // 1. Live loopback JWKS verification inside createApp (test env with Cognito configured & local tokens disabled)
    process.env.NODE_ENV = "test";
    process.env.IS_LOCAL = "true";
    const liveJwksVerifier = new CognitoJwtVerifier({
      userPoolId,
      clientId,
      jwksUri: localJwksUrl,
    });
    const appHybrid = createApp({
      dbPath,
      tokenService: localTokenSvc,
      cognitoVerifier: liveJwksVerifier,
      acceptLocalTokens: false,
    });
    const serverHybrid = await new Promise<http.Server>((resolve) => {
      const s = appHybrid.listen(0, "127.0.0.1", () => resolve(s));
    });
    servers.push(serverHybrid);
    const hybridUrl = `http://127.0.0.1:${(serverHybrid.address() as AddressInfo).port}`;

    assert.equal(
      (await reqJson(hybridUrl, "/api/stats", { token: demoSuperV1 })).status,
      401,
      "Local v1 demo tokens must be rejected when acceptLocalTokens=false",
    );
    assert.equal((await reqJson(hybridUrl, "/api/stats", { token: superToken })).status, 200);
    assert.equal(
      (await reqJson(hybridUrl, "/api/stats", { token: companyAdminToken })).status,
      403,
      "Cognito 'admin' group with custom:tenant_id must NOT access superadmin endpoints",
    );
    assert.equal(
      (await reqJson(hybridUrl, "/api/stats", { token: danglingAdminToken })).status,
      403,
    );
    const agentBalanceRes = await reqJson(hybridUrl, "/api/agent", {
      method: "POST",
      token: agentToken,
      body: { intent: "check_balance", params: { accountNumber: "SLT-001" } },
    });
    assert.equal(agentBalanceRes.status, 200);
    assert.equal(
      (
        await reqJson(hybridUrl, "/api/agent", {
          method: "POST",
          token: agentToken,
          body: { intent: "pay_bill", params: { amount: 50 } },
        })
      ).status,
      403,
    );
    assert.equal(
      (
        await reqJson(hybridUrl, "/api/agent", {
          method: "POST",
          token: companyAdminToken,
          headers: { "x-tenant-id": "tenant-other" },
          body: { intent: "check_balance" },
        })
      ).status,
      403,
    );
    assert.equal(
      (
        await reqJson(hybridUrl, "/api/agent", {
          method: "POST",
          token: superToken,
          body: { intent: "check_balance" },
        })
      ).status,
      403,
    );
    pass("Express createApp verifies Cognito RS256 JWKS over HTTP and isolates superadmin/company/live_agent");

    // 2. Production simulation: NODE_ENV=production, IS_LOCAL=false, HTTPS JWKS fetchFn + CORS/size/error hardening
    process.env.NODE_ENV = "production";
    process.env.IS_LOCAL = "false";
    process.env.CORS_ALLOWED_ORIGINS = "https://console.example.com";
    let allowProdFetch = true;
    const prodFetch: CognitoFetchFn = async () => {
      if (!allowProdFetch) throw new Error("network unreachable");
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ keys: [pubJwk] }),
      };
    };
    const prodVerifier = new CognitoJwtVerifier({
      userPoolId,
      clientId,
      fetchFn: prodFetch,
    });
    const appProd = createApp({
      dbPath,
      tokenService: localTokenSvc,
      cognitoVerifier: prodVerifier,
    });
    const serverProd = await new Promise<http.Server>((resolve) => {
      const s = appProd.listen(0, "127.0.0.1", () => resolve(s));
    });
    servers.push(serverProd);
    const prodUrl = `http://127.0.0.1:${(serverProd.address() as AddressInfo).port}`;

    const prodStats = await reqJson(prodUrl, "/api/stats", {
      token: superToken,
      headers: { Origin: "https://console.example.com" },
    });
    assert.equal(prodStats.status, 200);
    assert.equal(prodStats.headers.get("x-powered-by"), null);
    assert.equal(prodStats.headers.get("access-control-allow-origin"), "https://console.example.com");

    const disallowedCors = await reqJson(prodUrl, "/api/stats", {
      token: superToken,
      headers: { Origin: "https://attacker.example" },
    });
    assert.equal(disallowedCors.headers.get("access-control-allow-origin"), null);

    // Local demo routes MUST return 404 or reject v1 tokens in production
    assert.equal((await reqJson(prodUrl, "/api/auth/login", { method: "POST", body: { email: "a@b.c", password: "x" } })).status, 404);
    assert.equal((await reqJson(prodUrl, "/api/registrations", { token: superToken })).status, 404);
    assert.equal((await reqJson(prodUrl, "/api/stats", { token: demoSuperV1 })).status, 401);

    // Oversized body (>128kb) returns structured JSON 413; malformed JSON returns 400
    const hugeRes = await reqJson(prodUrl, "/api/agent", {
      method: "POST",
      token: companyAdminToken,
      rawBody: JSON.stringify({ intent: "check_balance", filler: "a".repeat(140_000) }),
    });
    assert.equal(hugeRes.status, 413);
    assert.equal(hugeRes.data.success, false);

    const badJsonRes = await reqJson(prodUrl, "/api/agent", {
      method: "POST",
      token: companyAdminToken,
      rawBody: "{not-json",
    });
    assert.equal(badJsonRes.status, 400);
    assert.equal(badJsonRes.data.success, false);

    // JWKS outage returns HTTP 503 (never falls back or falsely marks valid callers 401)
    prodVerifier.clearCache();
    allowProdFetch = false;
    assert.equal((await reqJson(prodUrl, "/api/stats", { token: superToken })).status, 503);
    allowProdFetch = true;

    // Unconfigured Cognito in production MUST fail closed with 503
    delete process.env.COGNITO_USER_POOL_ID;
    delete process.env.COGNITO_CLIENT_ID;
    const unconfiguredProdApp = createApp({ dbPath, tokenService: localTokenSvc });
    const unconfiguredServer = await new Promise<http.Server>((resolve) => {
      const s = unconfiguredProdApp.listen(0, "127.0.0.1", () => resolve(s));
    });
    servers.push(unconfiguredServer);
    const unconfiguredUrl = `http://127.0.0.1:${(unconfiguredServer.address() as AddressInfo).port}`;
    assert.equal(
      (await reqJson(unconfiguredUrl, "/api/stats", { token: superToken })).status,
      503,
    );
    pass("Production mode enforces Cognito, fails closed unconfigured (503), disables local routes, and hardens CORS/JSON");

    // 3. Direct mock validator + resolver + handleOnboardingRequest under production/IS_LOCAL=false
    assert.throws(() => decodeMockCognitoJwt("Bearer dev-token-staff"), /SECURITY FATAL/);
    const unconfResolver = await resolveTenantContextVerified({ authorization: `Bearer ${companyAdminToken}` });
    assert.equal(unconfResolver.success, false);
    assert.equal(unconfResolver.error?.code, "INTERNAL_ERROR");

    const resolvedProd = await resolveTenantContextVerified(
      { authorization: `Bearer ${companyAdminToken}` },
      { cognitoVerifier: prodVerifier },
    );
    assert.equal(resolvedProd.success, true);
    assert.equal(resolvedProd.context?.tenantId, "slt");
    assert.equal(resolvedProd.context?.role, "admin");

    const spoofedHeaderRes = await resolveTenantContextVerified(
      { authorization: `Bearer ${companyAdminToken}`, "x-tenant-id": "other-tenant" },
      { cognitoVerifier: prodVerifier },
    );
    assert.equal(spoofedHeaderRes.success, false);
    assert.equal(spoofedHeaderRes.error?.code, "FORBIDDEN");

    const tenantRouterOut = await handleTenantRequest({
      headers: { authorization: `Bearer ${agentToken}` },
      body: { intent: "check_balance" },
      resolverDeps: { cognitoVerifier: prodVerifier },
    });
    assert.equal(tenantRouterOut.success, true);

    const lambdaUnauth = await tenantRouterLambdaHandler({
      headers: { Authorization: "Bearer not-a-real-jwt" },
      body: JSON.stringify({ intent: "check_balance" }),
    });
    assert.equal(lambdaUnauth.statusCode, 500, "Unconfigured prod Lambda fails closed 500 rather than trusting mock JWT");

    process.env.NODE_ENV = "test";
    process.env.IS_LOCAL = "true";
    process.env.ALLOW_MOCK_AUTH = "true";
    process.env.COGNITO_USER_POOL_ID = userPoolId;
    process.env.COGNITO_CLIENT_ID = clientId;
    process.env.COGNITO_JWKS_URI = localJwksUrl;

    const lambdaInvalidToken = await tenantRouterLambdaHandler({
      headers: { Authorization: "Bearer unsigned.jwt.mock" },
      body: JSON.stringify({ intent: "check_balance" }),
    });
    assert.equal(lambdaInvalidToken.statusCode, 401);

    const lambdaSpoofTenant = await tenantRouterLambdaHandler({
      headers: { Authorization: `Bearer ${companyAdminToken}`, "x-tenant-id": "tenant-b" },
      body: JSON.stringify({ intent: "check_balance" }),
    });
    assert.equal(lambdaSpoofTenant.statusCode, 403);
    pass("resolveTenantContextVerified, handleTenantRequest, and lambda-adapter enforce verified Cognito claims");

    // 4. Onboarding handler + onboarding lambda-adapter with Cognito RS256 tokens
    const fakeOnboardDeps = makeFakeOnboardingDeps();
    const denyAdminOnboard = await handleOnboardingRequest(
      {
        headers: { authorization: `Bearer ${companyAdminToken}` },
        body: { companyName: "New Co", tenantId: "new-co", adminEmail: "a@newco.test" },
      },
      { cognitoVerifier: liveJwksVerifier, onboardingDeps: fakeOnboardDeps },
    );
    assert.equal(denyAdminOnboard.success, false);
    assert.equal(denyAdminOnboard.error?.code, "FORBIDDEN");

    const staffTenantBound = makeCognitoToken({
      sub: "usr-staff-bound",
      "cognito:groups": ["staff"],
      "custom:tenant_id": "slt",
    });
    const denyBoundStaff = await handleOnboardingRequest(
      {
        headers: { authorization: `Bearer ${staffTenantBound}` },
        body: { companyName: "New Co", tenantId: "new-co", adminEmail: "a@newco.test" },
      },
      { cognitoVerifier: liveJwksVerifier, onboardingDeps: fakeOnboardDeps },
    );
    assert.equal(denyBoundStaff.success, false);
    assert.equal(denyBoundStaff.error?.code, "FORBIDDEN");

    const allowStaffOnboard = await handleOnboardingRequest(
      {
        headers: { authorization: `Bearer ${staffToken}` },
        body: { companyName: "Delta Systems", tenantId: "delta-sys", adminEmail: "admin@delta.test" },
      },
      { cognitoVerifier: liveJwksVerifier, onboardingDeps: fakeOnboardDeps },
    );
    assert.equal(allowStaffOnboard.success, true);
    assert.equal(allowStaffOnboard.data?.tenantId, "delta-sys");

    const allowSuperOnboard = await handleOnboardingRequest(
      {
        headers: { authorization: `Bearer ${superToken}` },
        body: { companyName: "Epsilon Labs", tenantId: "epsilon-labs", adminEmail: "admin@epsilon.test" },
      },
      { cognitoVerifier: liveJwksVerifier, onboardingDeps: fakeOnboardDeps },
    );
    assert.equal(allowSuperOnboard.success, true);

    const lambdaUnauthOnboard = await onboardingLambdaHandler({
      headers: { Authorization: "Bearer bad.jwt.token" },
      body: JSON.stringify({ companyName: "X", tenantId: "x-co", adminEmail: "x@x.test" }),
    });
    assert.equal(lambdaUnauthOnboard.statusCode, 401);
    pass("handleOnboardingRequest strictly allows only unscoped Cognito staff/superadmin callers");

    // 5. BoundedRateLimiter & HTTP 429 enforcement on public endpoints
    let clockMs = 1_000_000;
    const boundedLimiter = new BoundedRateLimiter({
      maxRequests: 2,
      windowMs: 10_000,
      maxTrackedKeys: 3,
      now: () => clockMs,
    });
    assert.equal(boundedLimiter.consume("ip:1").allowed, true);
    assert.equal(boundedLimiter.consume("ip:2").allowed, true);
    assert.equal(boundedLimiter.consume("ip:3").allowed, true);
    const overflow = boundedLimiter.consume("ip:4");
    assert.equal(overflow.allowed, false);
    assert.equal(boundedLimiter.trackedKeyCount, 3, "Rate limiter memory remains strictly bounded");
    clockMs += 11_000;
    assert.equal(boundedLimiter.consume("ip:4").allowed, true, "Expired keys are reclaimed cleanly");

    const appLimited = createApp({
      dbPath,
      tokenService: localTokenSvc,
      publicRegistrationLimiter: new BoundedRateLimiter({ maxRequests: 2, windowMs: 60_000 }),
      publicHandoffLimiter: new BoundedRateLimiter({ maxRequests: 2, windowMs: 60_000 }),
      publicChatResolverLimiter: new BoundedRateLimiter({ maxRequests: 2, windowMs: 60_000 }),
    });
    const serverLimited = await new Promise<http.Server>((resolve) => {
      const s = appLimited.listen(0, "127.0.0.1", () => resolve(s));
    });
    servers.push(serverLimited);
    const limitedUrl = `http://127.0.0.1:${(serverLimited.address() as AddressInfo).port}`;

    // Registration limiter (3rd request -> 429)
    await reqJson(limitedUrl, "/api/registrations", { method: "POST", body: {} });
    await reqJson(limitedUrl, "/api/registrations", { method: "POST", body: {} });
    const reg429 = await reqJson(limitedUrl, "/api/registrations", { method: "POST", body: {} });
    assert.equal(reg429.status, 429);
    assert.ok(reg429.headers.get("retry-after"));

    // Handoff limiter (3rd request -> 429)
    await reqJson(limitedUrl, "/api/chat/handoff/request", { method: "POST", body: {} });
    await reqJson(limitedUrl, "/api/chat/handoff/request", { method: "POST", body: {} });
    const handoff429 = await reqJson(limitedUrl, "/api/chat/handoff/request", { method: "POST", body: {} });
    assert.equal(handoff429.status, 429);
    assert.ok(handoff429.headers.get("retry-after"));

    // Chat URL resolver limiter (3rd request -> 429)
    await reqJson(limitedUrl, `/api/resolve-chat-url?company=slt&agent=support&r=${randomUUID().slice(0, 4)}`);
    await reqJson(limitedUrl, `/api/resolve-chat-url?company=slt&agent=support&r=${randomUUID().slice(0, 4)}`);
    const resolver429 = await reqJson(limitedUrl, "/api/resolve-chat-url?company=slt&agent=support");
    assert.equal(resolver429.status, 429);
    pass("BoundedRateLimiter bounds memory and enforces HTTP 429 + Retry-After on public routes");

    console.log(`\n--- ${passed} passed, 0 failed ---`);
  } finally {
    process.env.NODE_ENV = savedEnv.NODE_ENV;
    process.env.IS_LOCAL = savedEnv.IS_LOCAL;
    process.env.ALLOW_MOCK_AUTH = savedEnv.ALLOW_MOCK_AUTH;
    if (savedEnv.COGNITO_USER_POOL_ID === undefined) delete process.env.COGNITO_USER_POOL_ID;
    else process.env.COGNITO_USER_POOL_ID = savedEnv.COGNITO_USER_POOL_ID;
    if (savedEnv.COGNITO_CLIENT_ID === undefined) delete process.env.COGNITO_CLIENT_ID;
    else process.env.COGNITO_CLIENT_ID = savedEnv.COGNITO_CLIENT_ID;
    if (savedEnv.COGNITO_REGION === undefined) delete process.env.COGNITO_REGION;
    else process.env.COGNITO_REGION = savedEnv.COGNITO_REGION;
    if (savedEnv.COGNITO_JWKS_URI === undefined) delete process.env.COGNITO_JWKS_URI;
    else process.env.COGNITO_JWKS_URI = savedEnv.COGNITO_JWKS_URI;
    if (savedEnv.CORS_ALLOWED_ORIGINS === undefined) delete process.env.CORS_ALLOWED_ORIGINS;
    else process.env.CORS_ALLOWED_ORIGINS = savedEnv.CORS_ALLOWED_ORIGINS;

    for (const s of servers) {
      await new Promise<void>((resolve) => s.close(() => resolve()));
    }
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});

