import { handler } from "../agents/main-agent/handler";
import { TenantContext } from "../shared/types/tenant-context";
import { PERMISSIONS } from "../shared/constants/permissions";

// 1. Mock the TenantContext
const mockContext: TenantContext = {
  tenantId: "tenant-001",
  userId: "user-123",
  role: "staff",
  permissions: [PERMISSIONS.BILLING_READ, PERMISSIONS.USAGE_READ], // User HAS usage:read
  channel: "web",
  sessionId: "session-999",
  conversationId: "conv-555",
};

// 2. Run the test
async function runTest() {
  console.log("--- Starting Usage Agent Test ---");

  const result = await handler({
    context: mockContext,
    intent: "check_usage", // We are testing the NEW intent
    params: {},
  });

  console.log("\n--- Result ---");
  console.log(JSON.stringify(result, null, 2));

  if (result.success && result.data?.packageName) {
    console.log("\n✅ SUCCESS: Dynamic routing to Usage Agent worked!");
  } else {
    console.log("\n❌ ERROR: Did not route to usage agent correctly.");
  }
}

runTest();
