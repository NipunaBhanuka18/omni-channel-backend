import { handler } from "../agents/main-agent/handler";
import { TenantContext } from "../shared/types/tenant-context";
import { PERMISSIONS } from "../shared/constants/permissions";

// 1. Mock the TenantContext as if it came from the Tenant Resolver
const mockContext: TenantContext = {
  tenantId: "tenant-001",
  userId: "user-123",
  role: "staff",
  permissions: [PERMISSIONS.BILLING_READ, PERMISSIONS.USAGE_READ], // User HAS billing:read
  channel: "web",
  sessionId: "session-999",
  conversationId: "conv-555",
};

// 2. Run the test
async function runTest() {
  console.log("--- Starting Local Vertical Slice Test ---");

  const result = await handler({
    context: mockContext,
    intent: "check_balance",
    params: {},
  });

  console.log("\n--- Result ---");
  console.log(JSON.stringify(result, null, 2));

  if (result.success && result.data?.balance === 1500.5) {
    console.log(
      "\n✅ SUCCESS: Vertical slice is working perfectly! The dynamic routing worked.",
    );
  } else {
    console.log("\n❌ ERROR: Slice did not return the expected balance.");
  }
}

runTest();
