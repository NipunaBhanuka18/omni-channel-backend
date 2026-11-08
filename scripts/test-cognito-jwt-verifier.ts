/**
 * Offline cryptographic test suite for AWS Cognito RS256/JWKS verifier and role mapping.
 * Uses ephemeral RSA-2048/1024 keypairs via node:crypto (zero network/Cognito dependency).
 */
import assert from "node:assert/strict";
import { createHmac, createSign, generateKeyPairSync, KeyObject } from "node:crypto";
import {
  CognitoFetchFn,
  CognitoJwksUnavailableError,
  CognitoJwtVerifier,
  CognitoTokenValidationError,
  mapCognitoClaimsToOnboardingCaller,
  mapCognitoClaimsToSessionClaims,
  mapCognitoClaimsToTenantIdentity,
} from "../services/auth/cognito-jwt-verifier";

function b64UrlJson(obj: Record<string, unknown>): string {
  return Buffer.from(JSON.stringify(obj), "utf8").toString("base64url");
}

function signRs256Jwt(
  header: Record<string, unknown>,
  payload: Record<string, unknown>,
  privateKeyPem: string | Buffer,
): string {
  const signingInput = `${b64UrlJson(header)}.${b64UrlJson(payload)}`;
  const signer = createSign("RSA-SHA256");
  signer.update(signingInput, "ascii");
  signer.end();
  const signature = signer.sign(privateKeyPem).toString("base64url");
  return `${signingInput}.${signature}`;
}

function toPublicJwk(publicKey: KeyObject, kid: string) {
  const jwk = publicKey.export({ format: "jwk" }) as Record<string, unknown>;
  return {
    ...jwk,
    kid,
    use: "sig",
    alg: "RS256",
  };
}

async function main(): Promise<void> {
  let passed = 0;
  const pass = (label: string) => {
    console.log(`PASS: ${label}`);
    passed++;
  };

  const userPoolId = "us-east-1_TestPool1";
  const clientId = "testclient123456";
  const expectedIssuer = `https://cognito-idp.us-east-1.amazonaws.com/${userPoolId}`;

  const kp1 = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const kp2 = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const kpWeak = generateKeyPairSync("rsa", { modulusLength: 1024 });

  let currentTimeMs = 1_750_000_000_000;
  const nowSec = () => Math.floor(currentTimeMs / 1000);

  let activeJwks: Record<string, unknown> = {
    keys: [toPublicJwk(kp1.publicKey, "kid-1")],
  };
  let jwksStatus = 200;
  let jwksFetchCount = 0;
  let throwNetwork = false;
  let rawOverrideBody: string | null = null;

  const fetchFn: CognitoFetchFn = async () => {
    jwksFetchCount++;
    if (throwNetwork) {
      throw new Error("ECONNRESET");
    }
    return {
      ok: jwksStatus >= 200 && jwksStatus < 300,
      status: jwksStatus,
      text: async () => rawOverrideBody ?? JSON.stringify(activeJwks),
    };
  };

  const verifier = new CognitoJwtVerifier({
    userPoolId,
    clientId,
    jwksCacheTtlMs: 300_000,
    unknownKidRefreshCooldownMs: 15_000,
    clockSkewSeconds: 30,
    fetchFn,
    now: () => currentTimeMs,
  });

  const baseIdClaims = (): Record<string, unknown> => ({
    sub: "cognito-sub-001",
    iss: expectedIssuer,
    aud: clientId,
    token_use: "id",
    email: "admin@slt.lk",
    name: "SLT Admin",
    "custom:tenant_id": "slt",
    "cognito:groups": ["admin"],
    iat: nowSec(),
    exp: nowSec() + 3600,
  });

  // 1. Single-flight deduplication + JWKS caching + valid ID token
  const validToken1 = signRs256Jwt(
    { alg: "RS256", kid: "kid-1", typ: "JWT" },
    baseIdClaims(),
    kp1.privateKey.export({ format: "pem", type: "pkcs8" }),
  );
  const concurrentResults = await Promise.all([
    verifier.verifyToken(validToken1),
    verifier.verifyToken(validToken1),
    verifier.verifyToken(validToken1),
  ]);
  assert.equal(jwksFetchCount, 1, "Concurrent cold-start verifications share single JWKS fetch");
  assert.equal(concurrentResults[0].sub, "cognito-sub-001");
  assert.equal(concurrentResults[0].tenantId, "slt");
  assert.deepEqual(concurrentResults[0].groups, ["admin"]);

  await verifier.verifyToken(validToken1);
  assert.equal(jwksFetchCount, 1, "Warm cache serves subsequent tokens without re-fetching");
  pass("RS256 signature verified with single-flight deduplication and warm JWKS caching");

  // 2. Key rotation + unknown-kid cooldown DoS protection
  activeJwks = {
    keys: [
      toPublicJwk(kp1.publicKey, "kid-1"),
      toPublicJwk(kp2.publicKey, "kid-2"),
    ],
  };
  const unknownKidWrongIss = signRs256Jwt(
    { alg: "RS256", kid: "kid-unknown", typ: "JWT" },
    { ...baseIdClaims(), iss: "https://evil.example/pool" },
    kp2.privateKey.export({ format: "pem", type: "pkcs8" }),
  );
  currentTimeMs += 20_000;
  await assert.rejects(() => verifier.verifyToken(unknownKidWrongIss), CognitoTokenValidationError);
  assert.equal(jwksFetchCount, 1, "Mismatched issuer on unknown kid never triggers JWKS fetch");

  const validToken2 = signRs256Jwt(
    { alg: "RS256", kid: "kid-2", typ: "JWT" },
    baseIdClaims(),
    kp2.privateKey.export({ format: "pem", type: "pkcs8" }),
  );
  // Within cooldown (5s after lastFetchAt): should NOT fetch yet
  currentTimeMs = 1_750_000_005_000;
  await assert.rejects(() => verifier.verifyToken(validToken2), CognitoTokenValidationError);
  assert.equal(jwksFetchCount, 1, "Unknown kid inside cooldown does not hammer JWKS endpoint");

  // Past cooldown (16s after lastFetchAt): refreshes once and accepts kid-2
  currentTimeMs = 1_750_000_016_000;
  const rotated = await verifier.verifyToken(validToken2);
  assert.equal(rotated.sub, "cognito-sub-001");
  assert.equal(jwksFetchCount, 2);

  // Past cache TTL (+301s): refreshes automatically
  currentTimeMs += 301_000;
  await verifier.verifyToken(validToken2);
  assert.equal(jwksFetchCount, 3);
  pass("JWKS rotation, unknown-kid cooldown throttling, and cache TTL expiration work properly");

  // 3. Algorithm confusion & malformed token rejections
  const algNone = `${b64UrlJson({ alg: "none", kid: "kid-2" })}.${b64UrlJson(baseIdClaims())}.sig`;
  await assert.rejects(() => verifier.verifyToken(algNone), CognitoTokenValidationError);

  const pubPem = kp2.publicKey.export({ format: "pem", type: "spki" });
  const hsHeader = b64UrlJson({ alg: "HS256", kid: "kid-2" });
  const hsPayload = b64UrlJson(baseIdClaims());
  const hsSig = createHmac("sha256", pubPem).update(`${hsHeader}.${hsPayload}`).digest("base64url");
  await assert.rejects(
    () => verifier.verifyToken(`${hsHeader}.${hsPayload}.${hsSig}`),
    CognitoTokenValidationError,
  );

  const tamperedParts = validToken2.split(".");
  const tamperedClaims = b64UrlJson({ ...baseIdClaims(), "custom:tenant_id": "tenant-b" });
  await assert.rejects(
    () => verifier.verifyToken(`${tamperedParts[0]}.${tamperedClaims}.${tamperedParts[2]}`),
    CognitoTokenValidationError,
  );

  const critToken = signRs256Jwt(
    { alg: "RS256", kid: "kid-2", crit: ["exp"] },
    baseIdClaims(),
    kp2.privateKey.export({ format: "pem", type: "pkcs8" }),
  );
  await assert.rejects(() => verifier.verifyToken(critToken), CognitoTokenValidationError);
  pass("Algorithm confusion (none/HS256), crit header, and payload tampering fail closed");

  // 4. Claim & timestamp checks
  const issuedNow = nowSec();
  const shortLived = signRs256Jwt(
    { alg: "RS256", kid: "kid-2" },
    { ...baseIdClaims(), iat: issuedNow - 10, exp: issuedNow + 5 },
    kp2.privateKey.export({ format: "pem", type: "pkcs8" }),
  );
  // At exp + 29s: allowed under 30s skew
  currentTimeMs = (issuedNow + 5 + 29) * 1000;
  await verifier.verifyToken(shortLived);
  // At exp + 30s: rejected
  currentTimeMs = (issuedNow + 5 + 30) * 1000;
  await assert.rejects(() => verifier.verifyToken(shortLived), CognitoTokenValidationError);
  currentTimeMs = issuedNow * 1000;

  for (const badPayload of [
    { ...baseIdClaims(), iss: "https://cognito-idp.us-east-1.amazonaws.com/us-east-1_Other" },
    { ...baseIdClaims(), aud: "wrong-client-id" },
    { ...baseIdClaims(), token_use: "access", client_id: clientId },
    { ...baseIdClaims(), "custom:tenant_id": "../evil" },
    { ...baseIdClaims(), "cognito:groups": "admin" },
    { ...baseIdClaims(), iat: nowSec() + 60 },
    { ...baseIdClaims(), nbf: nowSec() + 60 },
  ]) {
    const badJwt = signRs256Jwt(
      { alg: "RS256", kid: "kid-2" },
      badPayload,
      kp2.privateKey.export({ format: "pem", type: "pkcs8" }),
    );
    await assert.rejects(() => verifier.verifyToken(badJwt), CognitoTokenValidationError);
  }

  // Access token accepted only when explicitly opted-in with matching client_id
  const accessVerifier = new CognitoJwtVerifier({
    userPoolId,
    clientId,
    allowedTokenUse: ["access"],
    fetchFn,
    now: () => currentTimeMs,
  });
  const validAccess = signRs256Jwt(
    { alg: "RS256", kid: "kid-2" },
    {
      sub: "cognito-sub-001",
      iss: expectedIssuer,
      token_use: "access",
      client_id: clientId,
      "cognito:groups": ["live_agent"],
      "custom:tenant_id": "slt",
      iat: nowSec(),
      exp: nowSec() + 300,
    },
    kp2.privateKey.export({ format: "pem", type: "pkcs8" }),
  );
  const accessVerified = await accessVerifier.verifyToken(validAccess);
  assert.equal(accessVerified.tokenUse, "access");
  assert.equal(accessVerified.clientId, clientId);
  pass("Issuer, audience/client_id, token_use, clock skew, tenantId, and group claim boundaries verified");

  // 5. Outage / weak key / oversized JWKS handling + prod HTTPS check
  verifier.clearCache();
  throwNetwork = true;
  await assert.rejects(() => verifier.verifyToken(validToken2), CognitoJwksUnavailableError);
  throwNetwork = false;

  activeJwks = { keys: [toPublicJwk(kpWeak.publicKey, "kid-weak")] };
  await assert.rejects(
    () =>
      verifier.verifyToken(
        signRs256Jwt(
          { alg: "RS256", kid: "kid-weak" },
          baseIdClaims(),
          kpWeak.privateKey.export({ format: "pem", type: "pkcs8" }),
        ),
      ),
    CognitoJwksUnavailableError,
  );

  rawOverrideBody = "x".repeat(70_000);
  await assert.rejects(() => verifier.verifyToken(validToken2), CognitoJwksUnavailableError);
  rawOverrideBody = null;

  const prevEnv = process.env.NODE_ENV;
  try {
    process.env.NODE_ENV = "production";
    assert.throws(
      () =>
        new CognitoJwtVerifier({
          userPoolId,
          clientId,
          jwksUri: "http://127.0.0.1:4566/jwks.json",
        }),
      /HTTPS/,
    );
  } finally {
    process.env.NODE_ENV = prevEnv;
  }
  pass("JWKS outages, weak RSA-1024 keys, oversized JWKS, and prod HTTPS requirement fail safely");

  // 6. Role & tenant mapping boundaries (prevent Cognito "admin" -> "superadmin" escalation)
  const adminTenantSession = mapCognitoClaimsToSessionClaims({
    sub: "usr-company-admin",
    iss: expectedIssuer,
    tokenUse: "id",
    email: "admin@slt.lk",
    tenantId: "slt",
    groups: ["admin"],
    iat: nowSec(),
    exp: nowSec() + 300,
  });
  assert.equal(adminTenantSession?.role, "company");
  assert.equal(adminTenantSession?.tenantId, "slt");

  const adminWithoutTenant = mapCognitoClaimsToSessionClaims({
    sub: "usr-dangling-admin",
    iss: expectedIssuer,
    tokenUse: "id",
    groups: ["admin"],
    iat: nowSec(),
    exp: nowSec() + 300,
  });
  assert.equal(adminWithoutTenant, null, "Cognito 'admin' without tenantId MUST NOT elevate to superadmin");

  const superadminValid = mapCognitoClaimsToSessionClaims({
    sub: "usr-super-1",
    iss: expectedIssuer,
    tokenUse: "id",
    email: "super@platform.test",
    groups: ["superadmin"],
    iat: nowSec(),
    exp: nowSec() + 300,
  });
  assert.equal(superadminValid?.role, "superadmin");
  assert.equal(superadminValid?.tenantId, undefined);

  const superadminWithTenant = {
    sub: "usr-spoofed-super",
    iss: expectedIssuer,
    tokenUse: "id" as const,
    tenantId: "slt",
    groups: ["superadmin"],
    iat: nowSec(),
    exp: nowSec() + 300,
  };
  assert.equal(mapCognitoClaimsToSessionClaims(superadminWithTenant), null);
  assert.equal(mapCognitoClaimsToTenantIdentity(superadminWithTenant).ok, false);
  assert.equal(mapCognitoClaimsToOnboardingCaller(superadminWithTenant).authorized, false);

  const staffUnscoped = {
    sub: "usr-staff-1",
    iss: expectedIssuer,
    tokenUse: "id" as const,
    groups: ["staff"],
    iat: nowSec(),
    exp: nowSec() + 300,
  };
  assert.equal(mapCognitoClaimsToOnboardingCaller(staffUnscoped).authorized, true);
  assert.equal(mapCognitoClaimsToSessionClaims(staffUnscoped), null);

  const staffScoped = { ...staffUnscoped, tenantId: "slt" };
  assert.equal(mapCognitoClaimsToOnboardingCaller(staffScoped).authorized, false);
  pass("Role mapping strictly blocks admin->superadmin escalation and tenant-scoped onboarding");

  console.log(`\n--- ${passed} passed, 0 failed ---`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
