process.env.NODE_ENV = "test";
process.env.ALLOW_MOCK_AUTH = "true";

import { app } from "../server";

async function runUiServerTests() {
  console.log("================================================================");
  console.log("🖥️  MEMBER 1: FULL UI API SERVER INTEGRATION TEST SUITE");
  console.log("================================================================\n");

  const TEST_PORT = 3009;
  const baseUrl = `http://127.0.0.1:${TEST_PORT}`;

  // Start dedicated test server
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

  // Helper for HTTP requests
  async function api(path: string, options: { method?: string; body?: any } = {}) {
    const res = await fetch(`${baseUrl}${path}`, {
      method: options.method || "GET",
      headers: { "Content-Type": "application/json" },
      body: options.body ? JSON.stringify(options.body) : undefined,
    });
    const json = await res.json().catch(() => ({}));
    return { status: res.status, data: json };
  }

  try {
    // TEST 1: Dashboard Stats
    console.log("--- Test 1: Admin Console Stats Endpoint ---");
    const statsRes = await api("/api/stats");
    assert(
      "GET /api/stats returns 200 with dashboard metric counters",
      statsRes.status === 200 && statsRes.data.totalAvailability !== undefined && statsRes.data.activeAgentsCount === 12,
      JSON.stringify(statsRes.data)
    );

    // TEST 2: Super Admin Authentication
    console.log("\n--- Test 2: Admin Login Authentication ---");
    const loginRes = await api("/api/auth/login", {
      method: "POST",
      body: { email: "superadmin@slt.lk", password: "admin123" },
    });
    assert(
      "POST /api/auth/login returns 200 with auth token and superadmin role",
      loginRes.status === 200 && loginRes.data.success === true && loginRes.data.user?.role === "superadmin",
      JSON.stringify(loginRes.data)
    );

    // TEST 3: Company Registration Submission
    console.log("\n--- Test 3: Company Registration Submission ---");
    const regRes = await api("/api/registrations", {
      method: "POST",
      body: {
        companyName: "Hemas Holdings",
        companySlug: "hemas",
        companyEmail: "admin@hemas.com",
        tier: "Enterprise",
        channels: ["Web", "WhatsApp"],
      },
    });
    const regId = regRes.data.registration?.id;
    assert(
      "POST /api/registrations creates pending registration",
      regRes.status === 201 && regRes.data.success === true && regRes.data.registration?.status === "Pending",
      JSON.stringify(regRes.data)
    );

    // TEST 4: Super Admin Approval & Auto-Provisioning
    console.log("\n--- Test 4: Registration Approval & Auto-Provisioning ---");
    const approveRes = await api(`/api/registrations/${regId}/status`, {
      method: "PUT",
      body: { status: "Approved" },
    });
    assert(
      "PUT /api/registrations/:id/status sets status Approved and provisions tenantId",
      approveRes.status === 200 &&
        approveRes.data.registration?.status === "Approved" &&
        approveRes.data.registration?.tenantId !== undefined,
      JSON.stringify(approveRes.data)
    );

    // TEST 5: Live Agent Console - Go Online
    console.log("\n--- Test 5: Live Agent Console - Go Online ---");
    const onlineRes = await api("/api/agent/presence/online", {
      method: "POST",
      body: { tenantId: "slt", agentId: "live-agent-01", connectionId: "conn-socket-99" },
    });
    assert(
      "POST /api/agent/presence/online sets status AVAILABLE",
      onlineRes.status === 200 && onlineRes.data.status === "AVAILABLE",
      JSON.stringify(onlineRes.data)
    );

    // TEST 6: Public Chat - Human Escalation Request
    console.log("\n--- Test 6: Public Chat - Human Escalation Request ---");
    const handoffRes = await api("/api/chat/handoff/request", {
      method: "POST",
      body: {
        tenantId: "slt",
        sessionId: "sess-web-customer-777",
        reason: "Customer requested human specialist for fiber line issue",
        customerInfo: { name: "Nilantha Kumara" },
      },
    });
    assert(
      "POST /api/chat/handoff/request pairs customer with online agent",
      handoffRes.status === 200 && handoffRes.data.assigned === true && handoffRes.data.status === "HUMAN_ACTIVE",
      JSON.stringify(handoffRes.data)
    );

    // TEST 7: Live Agent Console - Resolve Session
    console.log("\n--- Test 7: Live Agent Console - Resolve Session ---");
    const resolveRes = await api("/api/chat/handoff/resolve", {
      method: "POST",
      body: {
        tenantId: "slt",
        sessionId: "sess-web-customer-777",
        agentId: "live-agent-01",
      },
    });
    assert(
      "POST /api/chat/handoff/resolve marks session RESOLVED",
      resolveRes.status === 200 && resolveRes.data.success === true,
      JSON.stringify(resolveRes.data)
    );

    // TEST 8: Knowledge Base Document Upload
    console.log("\n--- Test 8: Workspace Portal KB Document Upload ---");
    const uploadRes = await api("/api/workspace/upload-doc", {
      method: "POST",
      body: {
        tenantId: "slt",
        documentName: "fiber-troubleshooting-v2.txt",
        content: "Step 1: Check fiber LOS indicator. If red, dispatch field technician.",
      },
    });
    assert(
      "POST /api/workspace/upload-doc uploads document to tenant S3 prefix",
      uploadRes.status === 201 && uploadRes.data.s3Key?.includes("tenants/slt/"),
      JSON.stringify(uploadRes.data)
    );

    // TEST 9: Hosted Chat URL Resolver
    console.log("\n--- Test 9: Public Hosted Chat URL Resolver ---");
    const resolveUrlRes = await api("/api/resolve-chat-url?company=slt&agent=support");
    assert(
      "GET /api/resolve-chat-url returns dynamic company config and theme",
      resolveUrlRes.status === 200 && resolveUrlRes.data.tenantId === "slt" && resolveUrlRes.data.agentId !== undefined,
      JSON.stringify(resolveUrlRes.data)
    );

    // SUMMARY
    console.log("\n================================================================");
    console.log(`📊 UI Test Summary: ${passed} Passed, ${failed} Failed`);
    console.log("================================================================");
  } finally {
    server.close();
  }

  if (failed > 0) {
    process.exit(1);
  } else {
    process.exit(0);
  }
}

runUiServerTests().catch((err) => {
  console.error("Fatal UI test runner error:", err);
  process.exit(1);
});
