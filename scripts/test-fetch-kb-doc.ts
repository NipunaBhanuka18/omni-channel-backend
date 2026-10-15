import { fetchKbDocument } from "../agents/utils/s3-client";
import type { TenantContext } from "../shared/types/tenant-context";

async function runTest() {
  console.log("--- Starting S3 Fetch Test ---");

  try {
    const context: TenantContext = {
      tenantId: "slt",
      userId: "kb-test-user",
      role: "staff",
      permissions: ["kb:read"],
      channel: "web",
      sessionId: "kb-test-session",
      conversationId: "kb-test-conversation",
    };
    const content = await fetchKbDocument(context, "router-troubleshooting-guide.txt");
    console.log("\n✅ SUCCESS: Fetched document from S3!");
    console.log("\n--- Document Content ---");
    console.log(content);
    console.log("------------------------\n");
  } catch (error) {
    console.error("\n❌ ERROR: Failed to fetch from S3.", error);
  }
}

runTest();
