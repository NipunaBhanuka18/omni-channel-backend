import { handler } from "../agents/main-agent/handler";
import { TenantContext } from "../shared/types/tenant-context";
import { PERMISSIONS } from "../shared/constants/permissions";

const mockContext: TenantContext = {
  tenantId: "tenant-001",
  userId: "user-123",
  role: "staff",
  permissions: [
    PERMISSIONS.BILLING_READ,
    PERMISSIONS.USAGE_READ,
    PERMISSIONS.FAULTS_READ,
  ],
  channel: "web",
  sessionId: "session-999",
  conversationId: "conv-555",
};

async function runAllTests() {
  console.log("--- 🚀 Starting Combined Agent Test Suite ---\n");

  // Test 1: Billing
  const balanceRes = await handler({
    context: mockContext,
    intent: "check_balance",
    params: {},
  });
  console.log(
    `Test 1 (Billing - check_balance): ${balanceRes.success ? "✅ PASS" : "❌ FAIL"}`,
  );

  // Test 2: Usage
  const usageRes = await handler({
    context: mockContext,
    intent: "check_usage",
    params: {},
  });
  console.log(
    `Test 2 (Usage - check_usage): ${usageRes.success ? "✅ PASS" : "❌ FAIL"}`,
  );

  // Test 3: Support (RAG)
  const supportRes = await handler({
    context: mockContext,
    intent: "troubleshoot_router",
    params: { query: "slow internet" },
  });
  console.log(
    `Test 3 (Support - troubleshoot_router): ${supportRes.success ? "✅ PASS" : "❌ FAIL"}\n`,
  );

  console.log("--- Combined Tests Complete ---");
}

runAllTests();
