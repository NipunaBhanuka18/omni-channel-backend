import { handler } from "../agents/main-agent/handler";
import { TenantContext } from "../shared/types/tenant-context";
import { PERMISSIONS } from "../shared/constants/permissions";

const mockContext: TenantContext = {
  tenantId: "slt",
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
  console.log(JSON.stringify(result, null, 2));
  const retrievedRealGuide =
    result.success &&
    typeof result.data?.result === "string" &&
    result.data.result.includes("[Tenant: slt]") &&
    result.data.result.includes("speedtest.slt.lk");

  if (retrievedRealGuide) {
    console.log(
      "✅ PASS: Support Specialist returned content from the real SLT S3 document."
    );
  } else {
    console.error(
      "❌ FAIL: Expected SLT S3 troubleshooting content was not returned."
    );
    process.exitCode = 1;
  }
}

runTest();
