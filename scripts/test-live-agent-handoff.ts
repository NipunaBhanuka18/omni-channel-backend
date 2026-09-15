import { handleHandoffApi } from "../services/handoff/handler";

function assert(condition: boolean, message: string) {
  if (!condition) {
    console.error(`❌ Assertion Failed: ${message}`);
    process.exit(1);
  }
}

async function runTests() {
  console.log("==========================================================================");
  console.log("       RUNNING MEMBER 3: LIVE AGENT HANDOFF & PRESENCE TEST SUITE         ");
  console.log("==========================================================================\n");

  const tenantId = "slt";
  const agentId = "admin1";

  // Test 1: Agent toggles "Go Online" (Presence Online)
  console.log("Test 1: Live Agent 'admin1' toggles 'Go Online'");
  const onlineRes = await handleHandoffApi({
    action: "presence_online",
    tenantId,
    agentId,
    connectionId: "conn-socket-001",
  });
  assert(onlineRes.success, "Setting presence online should succeed");
  assert(onlineRes.data.status === "AVAILABLE", "Agent status must be AVAILABLE");
  assert(onlineRes.data.activeChats === 0, "Initial active chats must be 0");
  console.log(`✅ PASS: Agent '${agentId}' is now ONLINE (Status: ${onlineRes.data.status}, Active Chats: ${onlineRes.data.activeChats})\n`);

  // Test 2: Customer requests human handoff -> Assigned to online agent
  console.log("Test 2: Customer in session 'sess-cust-101' requests human assistance");
  const handoffRes1 = await handleHandoffApi({
    action: "request_handoff",
    tenantId,
    sessionId: "sess-cust-101",
    customerName: "Kamal Perera",
    issueSummary: "Broadband fiber optic light flashing red",
  });
  assert(handoffRes1.success, "Handoff request should succeed");
  assert(handoffRes1.data.assigned === true, "Must be assigned to human agent");
  assert(handoffRes1.data.agentId === agentId, "Must be assigned to 'admin1'");
  assert(handoffRes1.data.status === "HUMAN_ACTIVE", "Status must be HUMAN_ACTIVE");
  console.log(`✅ PASS: Successfully assigned session 'sess-cust-101' to agent '${handoffRes1.data.agentId}' (Status: ${handoffRes1.data.status})\n`);

  // Test 3: Verify agent activeChats workload incremented to 1
  console.log("Test 3: Verify agent workload incremented");
  const statusRes1 = await handleHandoffApi({
    action: "presence_status",
    tenantId,
    agentId,
  });
  assert(statusRes1.success, "Fetching presence status should succeed");
  assert(statusRes1.data.activeChats === 1, "Agent activeChats must be incremented to 1");
  console.log(`✅ PASS: Agent workload verified: activeChats=${statusRes1.data.activeChats}\n`);

  // Test 4: Agent toggles "Go Offline"
  console.log("Test 4: Agent 'admin1' toggles 'Go Offline'");
  const offlineRes = await handleHandoffApi({
    action: "presence_offline",
    tenantId,
    agentId,
  });
  assert(offlineRes.success, "Setting presence offline should succeed");
  assert(offlineRes.data.status === "OFFLINE", "Agent status must be OFFLINE");
  console.log(`✅ PASS: Agent '${agentId}' is now OFFLINE (Status: ${offlineRes.data.status})\n`);

  // Test 5: New customer requests human assistance when NO agents are online (Missed Handoff)
  console.log("Test 5: Second customer in session 'sess-cust-202' requests human assistance when offline");
  const handoffRes2 = await handleHandoffApi({
    action: "request_handoff",
    tenantId,
    sessionId: "sess-cust-202",
    customerName: "Nimal Silva",
    issueSummary: "Billing payment gateway double deduction",
  });
  assert(handoffRes2.success, "Handoff request should be handled cleanly");
  assert(handoffRes2.data.assigned === false, "Must not be assigned since all agents are offline");
  assert(handoffRes2.data.status === "MISSED_HANDOFF", "Status must be MISSED_HANDOFF");
  assert(
    handoffRes2.data.message.includes("currently offline"),
    "Must return courteous offline notification message"
  );
  console.log(`✅ PASS: Missed handoff properly captured: status=${handoffRes2.data.status}, msg="${handoffRes2.data.message}"\n`);

  // Test 6: Agent comes back online and resolves first session
  console.log("Test 6: Agent comes back online and resolves session 'sess-cust-101'");
  await handleHandoffApi({
    action: "presence_online",
    tenantId,
    agentId,
  });

  const resolveRes = await handleHandoffApi({
    action: "resolve_session",
    tenantId,
    agentId,
    sessionId: "sess-cust-101",
  });
  assert(resolveRes.success, "Resolving chat session should succeed");
  assert(resolveRes.data.status === "RESOLVED", "Session status must be RESOLVED");

  // Check agent workload returned to 0
  const finalStatus = await handleHandoffApi({
    action: "presence_status",
    tenantId,
    agentId,
  });
  assert(finalStatus.data.activeChats === 0, "Agent activeChats must return to 0");
  console.log(`✅ PASS: Session resolved and agent workload returned to activeChats=${finalStatus.data.activeChats}\n`);

  console.log("==========================================================================");
  console.log("       ALL 6 MEMBER 3 HANDOFF & PRESENCE TESTS PASSED SUCCESSFULLY!       ");
  console.log("==========================================================================");
}

runTests();
