process.env.NODE_ENV = "test";
process.env.ALLOW_MOCK_AUTH = "true";

import { BedrockAgentCoreSupervisor } from "../agents/main-agent/bedrock-adapter";
import { searchKnowledgeBase } from "../agents/utils/kb-retriever";
import { buildTenantS3Key } from "../agents/utils/s3-client";
import { TenantContext } from "../shared/types/tenant-context";
import { app } from "../server";

async function runMember4TestSuite() {
  console.log("================================================================");
  console.log("🤖 MEMBER 4: AI ENGINE PLANE B, TOOLS & RAG TEST SUITE");
  console.log("================================================ statistics\n");

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

  const mockContext: TenantContext = {
    tenantId: "slt",
    userId: "usr-member4-tester",
    role: "staff",
    permissions: ["billing:read", "usage:read", "faults:read"],
    channel: "web",
    sessionId: "sess-m4-test-99",
    conversationId: "conv-m4-test-99",
  };

  try {
    // TEST 1: S3 Path Partitioning for RAG Multi-Tenancy
    console.log("--- Test 1: S3 Path Partitioning for RAG Multi-Tenancy ---");
    const s3Key = buildTenantS3Key("slt", "troubleshooting.txt");
    assert(
      "buildTenantS3Key constructs tenant-partitioned path 'tenants/slt/troubleshooting.txt'",
      s3Key === "tenants/slt/troubleshooting.txt",
      `Constructed S3 key was: ${s3Key}`
    );

    // TEST 2: Knowledge Base RAG Tenant Isolation Guardrail
    console.log("\n--- Test 2: Knowledge Base RAG Tenant Isolation Guardrail ---");
    const ragResult = await searchKnowledgeBase("router blinking red", mockContext);
    assert(
      "searchKnowledgeBase returns tenant-scoped RAG response containing tenantId tag",
      ragResult.includes("[Tenant: slt]"),
      ragResult
    );

    // TEST 3: Bedrock AgentCore Supervisor Routing
    console.log("\n--- Test 3: Bedrock AgentCore Supervisor Sub-Agent Delegation ---");
    const supervisorRes = await BedrockAgentCoreSupervisor.delegateToSubAgent("check_balance", mockContext, { accountNumber: "SLT-001" });
    assert(
      "BedrockAgentCoreSupervisor successfully delegates check_balance to Billing Specialist",
      supervisorRes.success === true && supervisorRes.data?.balance !== undefined,
      JSON.stringify(supervisorRes)
    );

    // TEST 4: Hosted Chat URL Resolver (/api/resolve-chat-url)
    console.log("\n--- Test 4: Hosted Chat URL Resolver ---");
    const TEST_PORT = 3019;
    const server = await new Promise<any>((resolve) => {
      const s = app.listen(TEST_PORT, "127.0.0.1", () => resolve(s));
    });

    try {
      const res = await fetch(`http://127.0.0.1:${TEST_PORT}/resolve-chat-url?company=slt&agent=support`);
      const json = await res.json();
      assert(
        "GET /resolve-chat-url returns dynamic company chatbot configuration",
        res.status === 200 && json.tenantId === "slt" && json.agentName !== undefined,
        JSON.stringify(json)
      );
    } finally {
      server.close();
    }

    // SUMMARY
    console.log("\n================================================================");
    console.log(`📊 Member 4 Test Summary: ${passed} Passed, ${failed} Failed`);
    console.log("================================================================");

    if (failed > 0) {
      process.exit(1);
    }
  } catch (error: any) {
    console.error("Fatal error during Member 4 test suite:", error);
    process.exit(1);
  }
}

runMember4TestSuite();
