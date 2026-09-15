process.env.ALLOW_MOCK_AUTH = "true";
import { resolveTenantContext } from "../services/tenant-resolver/resolver";


// Helper to create a valid base64url encoded mock JWT with specific claims
function makeMockJwt(claims: Record<string, any>): string {
  const header = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");
  const payload = Buffer.from(JSON.stringify(claims)).toString("base64url");
  const signature = "mock_signature_bytes";
  return `Bearer ${header}.${payload}.${signature}`;
}

async function runTenantResolverSecurityTests() {
  console.log("================================================================");
  console.log("🛡️  MEMBER 2: ZERO-TRUST TENANT RESOLVER SECURITY TEST SUITE");
  console.log("================================================================\n");

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

  // TEST 1: Legitimate Request (Token claims match x-tenant-id header)
  console.log("--- Test 1: Valid Authenticated Request ---");
  const sltToken = makeMockJwt({
    tid: "slt",
    oid: "usr-slt-admin-01",
    roles: ["OmniChannel.Admin"],
  });

  const res1 = resolveTenantContext({
    authorization: sltToken,
    "x-tenant-id": "slt",
    "x-channel": "web",
  });

  assert(
    "Authorized tenant matching token claims resolves successfully",
    res1.success === true && res1.context?.tenantId === "slt" && res1.context?.role === "admin",
    JSON.stringify(res1)
  );

  // TEST 2: Security Guardrail - Cross-Tenant Spoofing Attack
  console.log("\n--- Test 2: Cross-Tenant Spoofing Attack Detection ---");
  // Attacker has a valid SLT token, but sends x-tenant-id: "dialog-enterprise"
  const res2 = resolveTenantContext({
    authorization: sltToken,
    "x-tenant-id": "dialog-enterprise",
    "x-channel": "web",
  });

  assert(
    "Cross-tenant mismatch is strictly REJECTED with 403 FORBIDDEN",
    res2.success === false &&
      res2.error?.code === "FORBIDDEN" &&
      res2.error?.message.includes("Tenant mismatch error"),
    JSON.stringify(res2.error)
  );

  // TEST 3: Missing Authorization Header
  console.log("\n--- Test 3: Missing Authorization Header ---");
  const res3 = resolveTenantContext({
    "x-tenant-id": "slt",
  });

  assert(
    "Missing Authorization header rejected with 401 UNAUTHORIZED",
    res3.success === false && res3.error?.code === "UNAUTHORIZED",
    JSON.stringify(res3.error)
  );

  // TEST 4: Missing x-tenant-id Header
  console.log("\n--- Test 4: Missing x-tenant-id Header ---");
  const res4 = resolveTenantContext({
    authorization: sltToken,
  });

  assert(
    "Missing x-tenant-id header rejected with 400 BAD_REQUEST",
    res4.success === false && res4.error?.code === "BAD_REQUEST",
    JSON.stringify(res4.error)
  );

  // TEST 5: Role & Multi-Channel Header Verification
  console.log("\n--- Test 5: Channel & Session ID Parsing ---");
  const res5 = resolveTenantContext({
    authorization: sltToken,
    "x-tenant-id": "slt",
    "x-channel": "whatsapp",
    "x-session-id": "sess-wa-998811",
  });

  assert(
    "Channel 'whatsapp' and explicit session ID parsed properly into TenantContext",
    res5.success === true &&
      res5.context?.channel === "whatsapp" &&
      res5.context?.sessionId === "sess-wa-998811",
    JSON.stringify(res5.context)
  );

  // SUMMARY
  console.log("\n================================================================");
  console.log(`📊 Test Summary: ${passed} Passed, ${failed} Failed`);
  console.log("================================================================");

  if (failed > 0) {
    process.exit(1);
  }
}

runTenantResolverSecurityTests().catch((err) => {
  console.error("Fatal test runner error:", err);
  process.exit(1);
});
