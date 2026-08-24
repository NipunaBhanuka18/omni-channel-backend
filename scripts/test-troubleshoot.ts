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
  ], // User HAS faults:read
  channel: "web",
  sessionId: "session-999",
  conversationId: "conv-555",
};

async function runTest() {
  console.log("--- Starting Support Agent Test ---");

  const result = await handler({
    context: mockContext,
    intent: "troubleshoot_router", // Testing the NEW intent
    params: { query: "slow internet" },
  });

  console.log("\n--- Result ---");
  if (result.success && result.data?.source === "Vector Index (Mocked)") {
    console.log(
      "✅ SUCCESS: Dynamic routing to Support Agent worked! It queried the mock Vector Index.",
    );
  } else {
    console.log("❌ ERROR: Did not route to support agent correctly.");
    console.log(JSON.stringify(result, null, 2));
  }
}

runTest();
