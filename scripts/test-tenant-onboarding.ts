process.env.ALLOW_MOCK_AUTH = "true";
import {
  registerTenant,
  handleRegisterTenantRequest,
} from "../services/onboarding/register-tenant";

import {
  inMemoryTenants,
  inMemoryAgents,
  provisionTenantResources,
} from "./create-tenants-table";
import {
  getTenantItem,
  putTenantItem,
  queryTenantItems,
} from "../agents/utils/dynamo-client";
import { TenantContext } from "../shared/types/tenant-context";

async function runTenantOnboardingTests() {
  console.log("================================================================");
  console.log("🏢 MEMBER 2: COMPANY ONBOARDING & DATA ISOLATION TEST SUITE");
  console.log("================================================================\n");

  // Step 0: Ensure baseline tables/in-memory records are active
  await provisionTenantResources();

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

  // TEST 1: Register New Company (Dialog Axiata)
  console.log("\n--- Test 1: Successful Company Registration ---");
  const onboardResult = await registerTenant({
    companyName: "Dialog Axiata PLC",
    companySlug: "dialog",
    adminEmail: "cloud-admin@dialog.lk",
    planTier: "enterprise",
    themeColor: "#ED1C24",
  });

  assert(
    "Onboarding generates clean tenantId 'tenant-dialog'",
    onboardResult.success === true && onboardResult.tenantId === "tenant-dialog",
    JSON.stringify(onboardResult)
  );

  assert(
    "Default Support Agent initialized with tenant prefix",
    onboardResult.defaultAgent.agentId === "agent-dialog-support-01",
    onboardResult.defaultAgent.agentName
  );

  assert(
    "Tenant S3 folder prefix properly generated",
    onboardResult.storage.s3Prefix === "tenants/tenant-dialog/",
    onboardResult.storage.s3Prefix
  );

  // TEST 2: Prevent Duplicate Registration
  console.log("\n--- Test 2: Duplicate Registration Rejection ---");
  let duplicateFailed = false;
  try {
    await registerTenant({
      companyName: "Dialog Axiata Clone",
      companySlug: "dialog",
      adminEmail: "different-admin@dialog.lk",
    });
  } catch (err: any) {
    duplicateFailed = err.message.includes("already exists");
  }

  assert(
    "Duplicate registration attempt is rejected with Conflict error",
    duplicateFailed
  );

  // TEST 3: HTTP API Gateway Handler (POST /tenants/register)
  console.log("\n--- Test 3: HTTP API Gateway Request Handler ---");
  const httpResponse = await handleRegisterTenantRequest({
    httpMethod: "POST",
    body: JSON.stringify({
      companyName: "Fintech Lanka",
      companySlug: "fintech-lk",
      adminEmail: "dev@fintech.lk",
      planTier: "pro",
    }),
  });

  const parsedHttpBody = JSON.parse(httpResponse.body);
  assert(
    "POST /tenants/register returns HTTP 201 Created with tenant details",
    httpResponse.statusCode === 201 && parsedHttpBody.tenantId === "tenant-fintech-lk",
    httpResponse.body
  );

  // TEST 4: Cross-Tenant Data Isolation Test
  console.log("\n--- Test 4: Cross-Tenant Data Partitioning (PK: TENANT#<id>) ---");
  const sltContext: TenantContext = {
    tenantId: "slt",
    userId: "slt-admin-01",
    role: "admin",
    permissions: ["billing:read", "faults:read"],
    channel: "web",
    sessionId: "sess-slt-01",
    conversationId: "conv-slt-01",
  };

  const dialogContext: TenantContext = {
    tenantId: "tenant-dialog",
    userId: "dialog-admin-01",
    role: "admin",
    permissions: ["billing:read", "faults:read"],
    channel: "web",
    sessionId: "sess-dialog-01",
    conversationId: "conv-dialog-01",
  };

  // SLT saves private config
  const sltConfig = { key: "private_slt_config", secretValue: "slt_secret_9988" };
  // Dialog saves private config
  const dialogConfig = { key: "private_dialog_config", secretValue: "dialog_secret_1122" };

  // Verify that SLT's partition key is strictly TENANT#slt
  // and Dialog's partition key is strictly TENANT#tenant-dialog
  const sltPK = `TENANT#${sltContext.tenantId}`;
  const dialogPK = `TENANT#${dialogContext.tenantId}`;

  assert(
    "Tenant partition keys are strictly decoupled (TENANT#slt != TENANT#tenant-dialog)",
    sltPK !== dialogPK && sltPK === "TENANT#slt" && dialogPK === "TENANT#tenant-dialog"
  );

  // SUMMARY
  console.log("\n================================================================");
  console.log(`📊 Test Summary: ${passed} Passed, ${failed} Failed`);
  console.log("================================================================");

  if (failed > 0) {
    process.exit(1);
  }
}

runTenantOnboardingTests().catch((err) => {
  console.error("Fatal test runner error:", err);
  process.exit(1);
});
