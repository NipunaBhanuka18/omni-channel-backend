/** Offline unit tests for LocalSessionTokenService. */
import assert from "node:assert/strict";
import {
  extractBearerToken,
  LocalSessionTokenService,
} from "../services/auth/local-session-token";

async function main(): Promise<void> {
  let passed = 0;
  const pass = (label: string) => {
    console.log(`PASS: ${label}`);
    passed++;
  };

  let nowMs = 1_700_000_000_000;
  const secret = "offline-test-signing-secret-at-least-32-bytes!";
  const service = new LocalSessionTokenService({
    secret,
    ttlSeconds: 300,
    maxClockSkewSeconds: 30,
    now: () => nowMs,
  });

  const adminToken = service.issueToken({
    sub: "user-1",
    email: "admin@example.test",
    name: "Fictional Super Admin",
    role: "superadmin",
  });
  assert.ok(adminToken.startsWith("v1."));
  const adminClaims = service.verifyToken(adminToken);
  assert.deepEqual(adminClaims, {
    sub: "user-1",
    email: "admin@example.test",
    name: "Fictional Super Admin",
    role: "superadmin",
    iat: 1_700_000_000,
    exp: 1_700_000_300,
  });
  pass("Issues and verifies signed superadmin token without tenantId");

  const companyToken = service.issueToken({
    sub: "reg-1",
    email: "company@example.test",
    name: "Example Co Admin",
    role: "company",
    tenantId: "tenant-example",
  });
  const companyClaims = service.verifyToken(companyToken);
  assert.equal(companyClaims?.role, "company");
  assert.equal(companyClaims?.tenantId, "tenant-example");
  pass("Issues and verifies tenant-scoped company token");

  const agentToken = service.issueToken({
    sub: "agent-1",
    email: "agent@example.test",
    name: "Support Agent",
    role: "live_agent",
    tenantId: "slt",
  });
  assert.equal(service.verifyToken(agentToken)?.role, "live_agent");
  pass("Issues and verifies tenant-scoped live_agent token");

  assert.throws(() => {
    service.issueToken({
      sub: "user-1",
      email: "admin@example.test",
      name: "Admin",
      role: "superadmin",
      tenantId: "slt",
    });
  }, /superadmin/);
  assert.throws(() => {
    service.issueToken({
      sub: "reg-1",
      email: "company@example.test",
      name: "Company",
      role: "company",
    });
  }, /tenantId/);
  pass("Enforces role/tenant invariant on token issuance");

  const parts = companyToken.split(".");
  const tamperedPayload = Buffer.from(
    JSON.stringify({ ...companyClaims, tenantId: "slt" }),
    "utf8",
  ).toString("base64url");
  assert.equal(service.verifyToken(`v1.${tamperedPayload}.${parts[2]}`), null);
  assert.equal(service.verifyToken(`${parts[0]}.${parts[1]}.${parts[2].slice(0, -1)}A`), null);
  assert.equal(service.verifyToken("token-user-1-123456"), null);
  assert.equal(service.verifyToken("v2." + parts[1] + "." + parts[2]), null);
  const wrongKeyService = new LocalSessionTokenService({
    secret: "a-completely-different-32-byte-secret-value!",
    now: () => nowMs,
  });
  assert.equal(wrongKeyService.verifyToken(companyToken), null);
  pass("Rejects tampered, legacy unsigned, wrong-version, and wrong-key tokens");

  nowMs += 300_000;
  assert.equal(service.verifyToken(companyToken), null);
  nowMs -= 300_000;
  assert.notEqual(service.verifyToken(companyToken), null);
  nowMs -= 40_000;
  assert.equal(service.verifyToken(companyToken), null);
  nowMs += 40_000;
  pass("Enforces token expiration and future iat clock skew");

  assert.equal(extractBearerToken(`Bearer ${companyToken}`), companyToken);
  assert.equal(extractBearerToken(`bearer ${companyToken}`), companyToken);
  assert.equal(extractBearerToken(`Basic ${companyToken}`), null);
  assert.equal(extractBearerToken(`Bearer ${companyToken} extra`), null);
  assert.equal(extractBearerToken(""), null);
  pass("Strict Bearer header extraction rejects non-Bearer or malformed headers");

  assert.throws(() => new LocalSessionTokenService({ secret: "too-short" }), /at least 32/);
  const prevEnv = process.env.NODE_ENV;
  const prevSecret = process.env.LOCAL_AUTH_TOKEN_SECRET;
  try {
    process.env.NODE_ENV = "production";
    delete process.env.LOCAL_AUTH_TOKEN_SECRET;
    assert.throws(() => new LocalSessionTokenService(), /LOCAL_AUTH_TOKEN_SECRET/);
  } finally {
    process.env.NODE_ENV = prevEnv;
    if (prevSecret === undefined) delete process.env.LOCAL_AUTH_TOKEN_SECRET;
    else process.env.LOCAL_AUTH_TOKEN_SECRET = prevSecret;
  }
  pass("Weak secrets and production usage without explicit secret fail closed");

  console.log(`\n--- ${passed} passed, 0 failed ---`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});

