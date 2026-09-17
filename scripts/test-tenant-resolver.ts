import { resolveTenantContext } from "../services/tenant-resolver/resolver";

// Ensure the mock validator's structural guard doesn't fatal in this script.
process.env.ALLOW_MOCK_AUTH = "true";

/**
 * Builds an unsigned mock Cognito-shaped JWT (header.payload.signature) for local
 * testing only. The signature segment is never verified by the mock validator.
 */
function mockJwt(claims: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64");
  const payload = Buffer.from(JSON.stringify(claims)).toString("base64");
  return `${header}.${payload}.mock-signature`;
}

const tenantAToken = mockJwt({
  sub: "usr-admin-a1",
  "cognito:groups": ["admin"],
  "custom:tenant_id": "tenant-a",
});

const tenantBToken = mockJwt({
  sub: "usr-agent-b1",
  "cognito:groups": ["live_agent"],
  "custom:tenant_id": "tenant-b",
});

const noTenantClaimToken = mockJwt({
  sub: "usr-staff-legacy",
  "cognito:groups": ["staff"],
  // no custom:tenant_id — simulates an internal pilot user pre-dating onboarding
});

let passed = 0;
let failed = 0;

function check(label: string, condition: boolean, detail?: unknown) {
  if (condition) {
    console.log(` ${label}`);
    passed++;
  } else {
    console.log(` ${label}`, detail ? JSON.stringify(detail) : "");
    failed++;
  }
}

console.log("--- Tenant Resolver Zero-Trust Verification ---\n");

// 1. Token tenant + matching x-tenant-id header → success
{
  const result = resolveTenantContext({
    authorization: `Bearer ${tenantAToken}`,
    "x-tenant-id": "tenant-a",
  });
  check("Matching header + token tenant resolves successfully", result.success && result.context?.tenantId === "tenant-a", result);
  check("Role derived from cognito:groups (admin)", result.context?.role === "admin", result.context);
}

// 2. Token tenant alone, no x-tenant-id header → success (token is sufficient)
{
  const result = resolveTenantContext({
    authorization: `Bearer ${tenantBToken}`,
  });
  check("Token alone (no x-tenant-id header) resolves successfully", result.success && result.context?.tenantId === "tenant-b", result);
  check("Role derived from cognito:groups (live_agent)", result.context?.role === "live_agent", result.context);
}

// 3. THE SPOOFING CASE: token says tenant-a, header claims tenant-b → must be rejected
{
  const result = resolveTenantContext({
    authorization: `Bearer ${tenantAToken}`,
    "x-tenant-id": "tenant-b",
  });
  check(
    "Header/token tenant mismatch is rejected (403 FORBIDDEN / TENANT_MISMATCH)",
    !result.success && result.error?.code === "FORBIDDEN" && result.error?.details?.reason === "TENANT_MISMATCH",
    result
  );
}

// 4. Token with no tenant claim at all → rejected, not silently allowed
{
  const result = resolveTenantContext({
    authorization: `Bearer ${noTenantClaimToken}`,
    "x-tenant-id": "tenant-a", // even if a header is supplied, it must not fill the gap
  });
  check(
    "Token with no custom:tenant_id claim is rejected, header is not used as fallback",
    !result.success && result.error?.details?.reason === "TENANT_CLAIM_MISSING",
    result
  );
}

// 5. Missing Authorization header entirely → 401
{
  const result = resolveTenantContext({
    "x-tenant-id": "tenant-a",
  });
  check("Missing Authorization header is rejected (401 UNAUTHORIZED)", !result.success && result.error?.code === "UNAUTHORIZED", result);
}

console.log(`\n--- ${passed} passed, ${failed} failed ---`);
if (failed > 0) {
  process.exitCode = 1;
}