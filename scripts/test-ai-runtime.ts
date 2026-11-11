import fs from "fs";
import os from "os";
import path from "path";
import crypto from "crypto";

process.env.NODE_ENV = "test";
process.env.ALLOW_MOCK_AUTH = "true";
process.env.BEDROCK_MOCK_MODE = "true";
process.env.COGNITO_USER_POOL_ID = "us-east-1_AiRuntimeTest";

// 1. Isolate Database so tests never mutate real db.json
const tempDbPath = path.join(
  os.tmpdir(),
  `omni-test-db-ai-${Date.now()}-${Math.random().toString(36).slice(2)}.json`
);
const realDbPath = path.join(__dirname, "..", "db.json");
const realDbSnapshotBefore = fs.readFileSync(realDbPath, "utf-8");
fs.writeFileSync(tempDbPath, realDbSnapshotBefore);
process.env.DB_PATH = tempDbPath;

import { app, getLocalSessionTokenService } from "../server";
import {
  agentRepository,
  orchestrator,
  toolExecutor,
  knowledgeRetriever,
  getBedrockRuntime,
  DeterministicMockBedrockAdapter,
  AwsBedrockRuntimeAdapter,
  AgentConfig,
} from "../services/ai-runtime";

async function runAiRuntimeTestSuite() {
  console.log("================================================================");
  console.log("🤖 TASK 12: SUPERVISOR MVP AI RUNTIME INTEGRATION TEST SUITE");
  console.log("================================================================\n");

  const TEST_PORT = 3066;
  const baseUrl = `http://127.0.0.1:${TEST_PORT}`;

  const server = await new Promise<any>((resolve) => {
    const s = app.listen(TEST_PORT, "127.0.0.1", () => resolve(s));
  });

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

  async function api(
    reqPath: string,
    method = "GET",
    body?: any,
    headers: Record<string, string> = {}
  ) {
    const opts: RequestInit = {
      method,
      headers: {
        "Content-Type": "application/json",
        ...headers,
      },
    };
    if (body) {
      opts.body = JSON.stringify(body);
    }
    const res = await fetch(`${baseUrl}${reqPath}`, opts);
    let data: any = null;
    try {
      data = await res.json();
    } catch {
      data = null;
    }
    return { status: res.status, ok: res.ok, data };
  }

  try {
    // --- Test 1: Published Agent Resolution by Public Key ---
    console.log("--- 1. Published Agent Resolution & Public Profile ---");
    const pubRes = await api("/v1/public/agents/slt-support");
    assert(
      "1a. GET /v1/public/agents/slt-support resolves published agent with 200 OK",
      pubRes.status === 200 && pubRes.data?.success === true
    );
    assert(
      "1b. Resolved agent returns public metadata without leaking system prompt or credentials",
      pubRes.data?.displayName === "SLT Support Assistant" &&
        pubRes.data?.systemPrompt === undefined &&
        pubRes.data?.tools === undefined
    );

    const missingPubRes = await api("/v1/public/agents/non-existent-agent");
    assert(
      "1c. GET /v1/public/agents/non-existent-agent returns 404 Not Found",
      missingPubRes.status === 404 && missingPubRes.data?.success === false
    );

    // --- Test 2: Dynamic Agent Configuration Loading & Defaults ---
    console.log("\n--- 2. Dynamic Agent Configuration Loading & Tenant Scoping ---");
    const sltAgent = await agentRepository.getAgent("slt", "agent-slt-support-01");
    assert(
      "2a. Agent loaded with configurable modelId, maxTokens, and systemPrompt",
      sltAgent !== null &&
        sltAgent.modelId === "anthropic.claude-3-sonnet-20240229-v1:0" &&
        sltAgent.displayName === "SLT Support Assistant"
    );

    // Create custom agent for Dialog tenant
    const dialogAgent: AgentConfig = {
      tenantId: "dialog-telecom",
      agentId: "agent-dialog-sales-01",
      displayName: "Dialog Axiata Sales Assistant",
      brandName: "Dialog Axiata",
      welcomeMessage: "Welcome to Dialog Axiata! How can I help you choose your package?",
      systemPrompt: "You are an AI sales assistant for Dialog Axiata.",
      modelId: "amazon.nova-lite-v1:0",
      status: "DRAFT",
      publicAgentKey: "dialog-sales",
      enabledSubAgents: ["sales", "lead"],
      tools: [
        {
          name: "check_coverage",
          type: "api",
          description: "Check 5G/Fiber coverage by location",
          enabled: true,
          endpoint: "https://mock.internal/api/coverage",
          inputSchema: { type: "object", properties: { postalCode: { type: "string" } } },
        },
      ],
      createdAt: new Date().toISOString(),
    };
    await agentRepository.saveAgent(dialogAgent);

    const loadedDialog = await agentRepository.getAgent("dialog-telecom", "agent-dialog-sales-01");
    assert(
      "2b. Successfully loaded newly created custom agent in tenant partition",
      loadedDialog !== null && loadedDialog.displayName === "Dialog Axiata Sales Assistant"
    );

    // --- Test 3: Cross-Tenant Access Denial & Isolation ---
    console.log("\n--- 3. Cross-Tenant Access Denial & Zero-Trust Boundary ---");
    // Tenant SLT cannot retrieve Dialog's agent directly
    const crossTenantAgent = await agentRepository.getAgent("slt", "agent-dialog-sales-01");
    assert(
      "3a. Tenant SLT cannot load Dialog's agent (returns null across tenant partition)",
      crossTenantAgent === null
    );

    // Unauthenticated caller cannot publish agent
    const unauthPub = await api("/api/dev/admin/agents/agent-dialog-sales-01/publish", "POST", {
      publicAgentKey: "dialog-sales",
    });
    assert(
      "3b. Unauthenticated agent publish attempt returns 401 Unauthorized",
      unauthPub.status === 401
    );

    // Publish Dialog agent with valid company token
    const tokenService = getLocalSessionTokenService();
    const dialogToken = tokenService.issueToken({
      sub: "user-dialog-admin",
      role: "company",
      email: "admin@dialog.lk",
      name: "Dialog Admin",
      tenantId: "dialog-telecom",
    });
    const authHeaders = {
      Authorization: `Bearer ${dialogToken}`,
      "x-tenant-id": "dialog-telecom",
    };
    const pubDialogRes = await api(
      "/api/dev/admin/agents/agent-dialog-sales-01/publish",
      "POST",
      { publicAgentKey: "dialog-sales" },
      authHeaders
    );
    assert(
      "3c. Authorized company admin publishes agent with 200 OK and receives chatUrl",
      pubDialogRes.status === 200 && pubDialogRes.data?.chatUrl === "/chat/dialog-sales"
    );

    // Cross-tenant key collision: SLT cannot publish using Dialog's key
    const sltToken = tokenService.issueToken({
      sub: "user-slt-admin",
      role: "company",
      email: "admin@slt.lk",
      name: "SLT Admin",
      tenantId: "slt",
    });
    const sltCollisionHeaders = {
      Authorization: `Bearer ${sltToken}`,
      "x-tenant-id": "slt",
    };
    const collisionRes = await api(
      "/api/dev/admin/agents/agent-slt-support-01/publish",
      "POST",
      { publicAgentKey: "dialog-sales" },
      sltCollisionHeaders
    );
    assert(
      "3d. Adversarial attempt by Tenant SLT to hijack Dialog's publicAgentKey is rejected with 400 Bad Request",
      collisionRes.status === 400
    );

    // --- Test 4: Public Session Creation & Tenant Binding ---
    console.log("\n--- 4. Public Session Creation & Tenant Binding ---");
    const sessionRes = await api("/v1/public/sessions", "POST", {
      agentKey: "slt-support",
    });
    assert(
      "4a. POST /v1/public/sessions returns 201 Created with sessionId and public agent details",
      sessionRes.status === 201 && !!sessionRes.data?.sessionId
    );
    const sessionId = sessionRes.data?.sessionId;

    const sessionRecord = await agentRepository.getSession(sessionId);
    assert(
      "4b. Stored session partition is strictly bound to tenant 'slt' and agent 'agent-slt-support-01'",
      sessionRecord?.tenantId === "slt" &&
        sessionRecord?.agentId === "agent-slt-support-01" &&
        sessionRecord?.status === "AI_ACTIVE"
    );

    // Missing agentKey
    const invalidSession = await api("/v1/public/sessions", "POST", {});
    assert(
      "4c. POST /v1/public/sessions without agentKey returns 400 Bad Request",
      invalidSession.status === 400
    );

    // --- Test 5: Bedrock Converse Model Invocation with Configured Model ID ---
    console.log("\n--- 5. Bedrock Converse Adapter Invocation ---");
    const mockRuntime = new DeterministicMockBedrockAdapter();
    const converseResult = await mockRuntime.converse(
      sltAgent!,
      "System prompt instruction",
      [],
      "What packages are available for broadband?"
    );
    assert(
      "5a. Bedrock Converse adapter produces coherent response based on agent config and specialist route",
      converseResult.text.includes("Sales Specialist") && converseResult.stopReason === "end_turn"
    );

    // --- Test 6: Mock vs Production Mode Separation (Fail-Closed) ---
    console.log("\n--- 6. Mock vs Production Mode Fail-Closed Separation ---");
    const prevNodeEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = "production";
    let prodMockBlocked = false;
    try {
      getBedrockRuntime({ forceMock: true });
    } catch (e: any) {
      if (e.message.includes("Security Violation") || e.message.includes("prohibited")) {
        prodMockBlocked = true;
      }
    } finally {
      process.env.NODE_ENV = prevNodeEnv;
    }
    assert(
      "6. In production (NODE_ENV=production), DeterministicMockBedrockAdapter is strictly prohibited and fails closed",
      prodMockBlocked
    );

    // --- Test 7: Bedrock Error and Timeout Handling ---
    console.log("\n--- 7. Bedrock Error and Timeout Resilience ---");
    const realAdapter = new AwsBedrockRuntimeAdapter();
    let handledAwsError = false;
    try {
      // Calling real AWS Bedrock without valid cloud credentials triggers clean caught error
      await realAdapter.converse(sltAgent!, "system", [], "test message");
    } catch (err: any) {
      if (err.message.includes("Bedrock Invocation Failed") || err.message.includes("CredentialsProviderError")) {
        handledAwsError = true;
      }
    }
    assert(
      "7. Missing cloud credentials or Bedrock service errors produce structured, non-leaking error messages",
      handledAwsError
    );

    // --- Test 8: Tenant-Scoped Knowledge Base Retrieval ---
    console.log("\n--- 8. Tenant-Scoped Knowledge Base Retrieval ---");
    const kbResult = await knowledgeRetriever.retrieve(
      sltAgent!,
      "How do I troubleshoot router optical red light?"
    );
    assert(
      "8a. Knowledge retrieved is scoped strictly to tenant 'slt' and contains relevant guide",
      kbResult.context.includes("slt") &&
        kbResult.citations.length > 0 &&
        kbResult.citations[0].uri.includes("tenants/slt/")
    );

    // --- Test 9: Explicit Empty KB Behavior (No Leakage) ---
    console.log("\n--- 9. Explicit Empty KB Handling Without Cross-Tenant Leakage ---");
    const unconfiguredAgent: AgentConfig = {
      tenantId: "tenant-no-kb-corp",
      agentId: "agent-no-kb",
      displayName: "No KB Assistant",
      modelId: "anthropic.claude-3-sonnet-20240229-v1:0",
      status: "PUBLISHED",
      publicAgentKey: "no-kb",
    };
    const emptyKbResult = await knowledgeRetriever.retrieve(
      unconfiguredAgent,
      "What is the CEO personal cell phone number?"
    );
    assert(
      "9. When no KB is configured or query yields no matches, retriever returns empty string and zero citations (never leaks other tenant data)",
      emptyKbResult.context === "" && emptyKbResult.citations.length === 0
    );

    // --- Test 10: Multi-Turn Conversation Memory Isolation ---
    console.log("\n--- 10. Multi-Turn Conversation Memory Isolation ---");
    // Turn 1
    const turn1 = await api(`/v1/public/sessions/${sessionId}/messages`, "POST", {
      message: "Hello, my internet has been very slow today.",
    });
    assert(
      "10a. Turn 1 executes successfully, categorized as 'technical' route",
      turn1.status === 200 && turn1.data?.route === "technical"
    );

    // Turn 2
    const turn2 = await api(`/v1/public/sessions/${sessionId}/messages`, "POST", {
      message: "Can I check my current bill payment status?",
    });
    assert(
      "10b. Turn 2 executes successfully, categorized as 'billing' route",
      turn2.status === 200 && turn2.data?.route === "billing"
    );

    // Verify session history in repository
    const historyRes = await api(`/v1/public/sessions/${sessionId}/messages`);
    assert(
      "10c. Session message history contains 4 chronological turns (2 user, 2 assistant)",
      historyRes.status === 200 && historyRes.data?.messages?.length === 4
    );

    // Verify cross-session memory isolation
    const sessionRes2 = await api("/v1/public/sessions", "POST", {
      agentKey: "slt-support",
    });
    const sessionId2 = sessionRes2.data?.sessionId;
    const historyRes2 = await api(`/v1/public/sessions/${sessionId2}/messages`);
    assert(
      "10d. Separate session has empty message history (strict partition isolation between sessions)",
      historyRes2.data?.messages?.length === 0
    );

    // --- Test 11: Tool Allowlists & Schema Validation ---
    console.log("\n--- 11. Tool Allowlists & Prototype Pollution Defense ---");
    // Execute allowed tool for Dialog agent
    const toolExecRes = await toolExecutor.execute(dialogAgent, "check_coverage", {
      postalCode: "00100",
    });
    assert(
      "11a. Allowed tool 'check_coverage' in agent configuration executes successfully",
      toolExecRes?.tool === "check_coverage"
    );

    // Attempt to execute unallowlisted tool
    let unallowlistBlocked = false;
    try {
      await toolExecutor.execute(dialogAgent, "execute_shell_command", { cmd: "dir" });
    } catch (e: any) {
      if (e.message.includes("not enabled")) {
        unallowlistBlocked = true;
      }
    }
    assert(
      "11b. Unallowlisted tool 'execute_shell_command' is rejected by allowlist validation",
      unallowlistBlocked
    );

    // Attempt prototype pollution in tool arguments
    let protoPollutionBlocked = false;
    try {
      const maliciousInput = JSON.parse('{"__proto__": {"admin": true}}');
      await toolExecutor.execute(dialogAgent, "check_coverage", maliciousInput);
    } catch (e: any) {
      if (e.message.includes("prototype pollution")) {
        protoPollutionBlocked = true;
      }
    }
    assert(
      "11c. Malicious prototype pollution payload in tool arguments is rejected",
      protoPollutionBlocked
    );

    // --- Test 12: Human Handoff Intent Detection & Session Escalation ---
    console.log("\n--- 12. Human Handoff Intent Detection & Session Escalation ---");
    const handoffMsgRes = await api(`/v1/public/sessions/${sessionId}/messages`, "POST", {
      message: "I want to speak to a real human person or live agent please.",
    });
    assert(
      "12a. Message containing 'human' or 'live agent' triggers handoff route with 200 OK",
      handoffMsgRes.status === 200 &&
        handoffMsgRes.data?.route === "handoff" &&
        handoffMsgRes.data?.status === "handoff_requested"
    );

    const escalatedSession = await agentRepository.getSession(sessionId);
    assert(
      "12b. Session record status escalated to 'HANDOFF_REQUESTED'",
      escalatedSession?.status === "HANDOFF_REQUESTED" &&
        escalatedSession?.handoffReason?.includes("human assistance") === true
    );

    // Follow-up message during handoff routes to human queue
    const followUpRes = await api(`/v1/public/sessions/${sessionId}/messages`, "POST", {
      message: "Are you connecting me to someone?",
    });
    assert(
      "12c. Subsequent message while in HANDOFF_REQUESTED status routes to human (status: delivered_to_human)",
      followUpRes.status === 200 &&
        followUpRes.data?.status === "delivered_to_human" &&
        followUpRes.data?.route === "human"
    );

    // --- Test 13: Dynamic Lead Form Triggering ---
    console.log("\n--- 13. Dynamic Lead Form Triggering & Submission ---");
    // Create new session for lead form test
    const leadSessionRes = await api("/v1/public/sessions", "POST", {
      agentKey: "slt-support",
    });
    const leadSessionId = leadSessionRes.data?.sessionId;

    const leadPromptRes = await api(`/v1/public/sessions/${leadSessionId}/messages`, "POST", {
      message: "I am interested in buying a new connection. Please call me for a quote.",
    });
    assert(
      "13a. Sales/lead purchase intent triggers structured form payload in uiAction",
      leadPromptRes.status === 200 &&
        leadPromptRes.data?.uiAction?.type === "form" &&
        leadPromptRes.data?.uiAction?.formId === "sales_interest"
    );

    // Submit form response
    const formSubmitRes = await api(`/v1/public/sessions/${leadSessionId}/messages`, "POST", {
      formSubmission: {
        formId: "sales_interest",
        values: {
          fullName: "Kasun Perera",
          contactPhone: "+94771234567",
          packageInterest: "Fiber Unlimited 100Mbps",
        },
      },
    });
    assert(
      "13b. Submitting form values completes successfully with confirmation message and submissionId",
      formSubmitRes.status === 200 &&
        formSubmitRes.data?.status === "completed" &&
        !!formSubmitRes.data?.submissionId
    );

    // --- Test 14: Hosted Chat URL Resolver Integration ---
    console.log("\n--- 14. Hosted Chat URL Resolver Integration ---");
    const resolveRes = await api("/api/resolve-chat-url?company=slt&agent=support");
    assert(
      "14a. GET /api/resolve-chat-url?company=slt&agent=support resolves published agent with dynamic theme and model",
      resolveRes.status === 200 &&
        resolveRes.data?.success === true &&
        resolveRes.data?.tenantId === "slt" &&
        resolveRes.data?.agent?.model === "anthropic.claude-3-sonnet-20240229-v1:0"
    );

    // --- Test 15: Session Feedback Endpoint ---
    console.log("\n--- 15. Session Feedback Rating ---");
    const feedbackRes = await api(`/v1/public/sessions/${sessionId}/feedback`, "POST", {
      messageId: "msg-test-101",
      rating: "up",
    });
    assert(
      "15. POST /v1/public/sessions/:id/feedback saves positive rating with 201 Created",
      feedbackRes.status === 201 && feedbackRes.data?.saved === true
    );

    // --- Test 16: Real db.json Immutability Check ---
    console.log("\n--- Real Database Immutability Check ---");
    const realDbSnapshotAfter = fs.readFileSync(realDbPath, "utf-8");
    assert(
      "Real tracked db.json was NOT mutated during AI runtime test execution",
      realDbSnapshotBefore === realDbSnapshotAfter
    );
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    if (fs.existsSync(tempDbPath)) {
      try {
        fs.unlinkSync(tempDbPath);
      } catch {}
    }
  }

  console.log("\n================================================================");
  console.log(`📊 AI Runtime Test Summary: ${passed} Passed, ${failed} Failed`);
  console.log("================================================================\n");

  if (failed > 0) {
    process.exit(1);
  }
}

runAiRuntimeTestSuite().catch((err) => {
  console.error("Unhandled error in AI runtime test suite:", err);
  process.exit(1);
});
