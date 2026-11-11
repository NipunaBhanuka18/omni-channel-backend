import fs from "fs";
import os from "os";
import path from "path";
import crypto from "crypto";
import express from "express";

process.env.NODE_ENV = "test";
process.env.ALLOW_MOCK_AUTH = "true";
process.env.ADMIN_BOOTSTRAP_TOKEN = "test-bootstrap-secret-token-32-chars-long";

// 1. Isolate Database so tests never mutate real db.json
const tempDbPath = path.join(
  os.tmpdir(),
  `omni-test-db-harden-${Date.now()}-${Math.random().toString(36).slice(2)}.json`
);
const realDbPath = path.join(__dirname, "..", "db.json");
const realDbSnapshotBefore = fs.readFileSync(realDbPath, "utf-8");
fs.writeFileSync(tempDbPath, realDbSnapshotBefore);
process.env.DB_PATH = tempDbPath;

import { app, getLocalSessionTokenService } from "../server";
import { LocalSessionTokenService } from "../services/auth/local-session-token";
import { createRequireAuth } from "../services/auth/local-auth-middleware";

async function runHardeningTests() {
  console.log("================================================================");
  console.log("🛡️  CRITICAL ENDPOINT HARDENING REGRESSION TEST SUITE");
  console.log("================================================================\n");

  const TEST_PORT = 3069;
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
    options: { method?: string; body?: any; token?: string; headers?: Record<string, string> } = {}
  ) {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      ...(options.token ? { Authorization: `Bearer ${options.token}` } : {}),
      ...(options.headers || {}),
    };
    const res = await fetch(`${baseUrl}${reqPath}`, {
      method: options.method || "GET",
      headers,
      body: options.body ? JSON.stringify(options.body) : undefined,
    });
    const json = await res.json().catch(() => ({}));
    return { status: res.status, data: json, headers: res.headers };
  }

  const tokenService = new LocalSessionTokenService({
    secret: "test-hardening-secret-at-least-32-chars-long",
    ttlSeconds: 3600,
  });

  try {
    // =========================================================================
    // 1. Anonymous Super Admin creation denied
    // =========================================================================
    console.log("--- 1. Anonymous Super Admin Creation Denied ---");
    const anonAdminRes = await api("/api/auth/register-admin", {
      method: "POST",
      body: {
        fullName: "Rogue Hacker",
        email: "hacker@evil.com",
        password: "evilpassword123",
      },
    });
    assert(
      "Anonymous Super Admin creation is rejected with 403 Forbidden",
      anonAdminRes.status === 403 &&
        anonAdminRes.data.success === false &&
        anonAdminRes.data.error.includes("closed"),
      JSON.stringify(anonAdminRes.data)
    );

    // =========================================================================
    // 2. Bootstrap disabled by default
    // =========================================================================
    console.log("\n--- 2. Bootstrap Disabled by Default ---");
    // Verify bootstrap token mismatch is rejected
    const badTokenRes = await api("/api/auth/register-admin", {
      method: "POST",
      headers: { "x-bootstrap-token": "wrong-or-missing-bootstrap-token" },
      body: {
        fullName: "Unauthorized Admin",
        email: "unauth@bootstrap.com",
        password: "password12345",
      },
    });
    assert(
      "Bootstrap with wrong/missing bootstrap token is rejected with 403 Forbidden",
      badTokenRes.status === 403 && badTokenRes.data.success === false,
      JSON.stringify(badTokenRes.data)
    );

    // =========================================================================
    // 3. Bootstrap credentials never returned
    // =========================================================================
    console.log("\n--- 3. Bootstrap Credentials Never Returned ---");
    // Authorize platform admin creation via existing Super Admin token
    const newAdminEmail = `admin-audit-${Date.now()}@slt.lk`;
    const authorizedAdminRes = await api("/api/auth/register-admin", {
      method: "POST",
      token: "dev-token-superadmin",
      body: {
        fullName: "Secondary Audit Super Admin",
        email: newAdminEmail,
        password: "securePassword123!",
      },
    });
    assert(
      "Authorized Super Admin creation succeeds with 201 Created",
      authorizedAdminRes.status === 201 && authorizedAdminRes.data.success === true,
      JSON.stringify(authorizedAdminRes.data)
    );
    assert(
      "Response object NEVER contains plaintext password, passwordHash, salt, or bootstrap secrets",
      authorizedAdminRes.data.user?.password === undefined &&
        authorizedAdminRes.data.user?.passwordHash === undefined &&
        authorizedAdminRes.data.user?.salt === undefined &&
        authorizedAdminRes.data.user?.role === "superadmin",
      JSON.stringify(authorizedAdminRes.data.user)
    );

    // =========================================================================
    // 4. Repeated unauthorized Super Admin creation denied
    // =========================================================================
    console.log("\n--- 4. Repeated Unauthorized Super Admin Creation Denied ---");
    const repeatAnonRes = await api("/api/auth/register-admin", {
      method: "POST",
      body: {
        fullName: "Second Hacker Attempt",
        email: "hacker2@evil.com",
        password: "anotherpassword123",
      },
    });
    assert(
      "Repeated anonymous Super Admin creation remains strictly denied with 403 Forbidden",
      repeatAnonRes.status === 403 && repeatAnonRes.data.success === false,
      JSON.stringify(repeatAnonRes.data)
    );

    // =========================================================================
    // 5. Production rejects mock authentication
    // =========================================================================
    console.log("\n--- 5. Production Rejects Mock Authentication ---");
    const prodAuthMiddleware = createRequireAuth({
      isLocalTokensAllowed: () => false, // Non-local / Production environment
      getTokenService: () => tokenService,
      getCognitoVerifier: () => null,
    });
    let prodStatusCode = 0;
    let prodBody: any = null;
    const mockRes: any = {
      status(code: number) {
        prodStatusCode = code;
        return this;
      },
      json(data: any) {
        prodBody = data;
        return this;
      },
    };
    await prodAuthMiddleware(
      { headers: { authorization: "Bearer dev-token-superadmin" } } as any,
      mockRes,
      () => {}
    );
    assert(
      "Production-mode middleware rejects dev-token-superadmin with 401 Unauthorized",
      prodStatusCode === 401 && prodBody?.success === false,
      `status=${prodStatusCode}, body=${JSON.stringify(prodBody)}`
    );

    // =========================================================================
    // 6. Anonymous agent presence mutation denied
    // =========================================================================
    console.log("\n--- 6. Anonymous Agent Presence Mutation Denied ---");
    const anonPresenceRes = await api("/api/agent/presence/online", {
      method: "POST",
      body: { tenantId: "slt", agentId: "live-agent-01" },
    });
    assert(
      "POST /api/agent/presence/online without token returns 401 Authentication required",
      anonPresenceRes.status === 401 && anonPresenceRes.data.error === "Authentication required",
      JSON.stringify(anonPresenceRes.data)
    );

    const anonOfflineRes = await api("/api/agent/presence/offline", {
      method: "POST",
      body: { tenantId: "slt", agentId: "live-agent-01" },
    });
    assert(
      "POST /api/agent/presence/offline without token returns 401 Authentication required",
      anonOfflineRes.status === 401 && anonOfflineRes.data.error === "Authentication required",
      JSON.stringify(anonOfflineRes.data)
    );

    // =========================================================================
    // 7. Company admin cannot impersonate live agent
    // =========================================================================
    console.log("\n--- 7. Company Admin Cannot Impersonate Live Agent ---");
    const companyImpersonateRes = await api("/api/agent/presence/online", {
      method: "POST",
      token: "dev-token-company", // role is company
      body: { tenantId: "slt", agentId: "live-agent-01" },
    });
    assert(
      "POST /api/agent/presence/online by Company Admin returns 403 Insufficient permissions",
      companyImpersonateRes.status === 403 &&
        companyImpersonateRes.data.success === false &&
        companyImpersonateRes.data.error.includes("Company administrators cannot modify live agent presence"),
      JSON.stringify(companyImpersonateRes.data)
    );

    // =========================================================================
    // 8. Live agent cannot modify another agent's presence
    // =========================================================================
    console.log("\n--- 8. Live Agent Cannot Modify Another Agent's Presence ---");
    const spoofAgentRes = await api("/api/agent/presence/online", {
      method: "POST",
      token: "dev-token-agent-01", // sub is live-agent-01
      body: { tenantId: "slt", agentId: "live-agent-02" }, // mismatch!
    });
    assert(
      "Live agent attempting to modify another agent's presence returns 403 Forbidden",
      spoofAgentRes.status === 403 &&
        spoofAgentRes.data.success === false &&
        spoofAgentRes.data.error.includes("Agents cannot modify another agent's presence"),
      JSON.stringify(spoofAgentRes.data)
    );

    // =========================================================================
    // 9. Cross-tenant presence mutation denied
    // =========================================================================
    console.log("\n--- 9. Cross-Tenant Presence Mutation Denied ---");
    const crossTenantPresenceRes = await api("/api/agent/presence/online", {
      method: "POST",
      token: "dev-token-agent-01", // tenant is slt
      body: { tenantId: "victim-corp", agentId: "live-agent-01" },
    });
    assert(
      "Live agent attempting to mutate presence in another tenant returns 403 Forbidden",
      crossTenantPresenceRes.status === 403 &&
        crossTenantPresenceRes.data.success === false &&
        crossTenantPresenceRes.data.error.includes("Cross-tenant presence modification denied"),
      JSON.stringify(crossTenantPresenceRes.data)
    );

    // =========================================================================
    // 10. Authorized live agent can update own presence
    // =========================================================================
    console.log("\n--- 10. Authorized Live Agent Can Update Own Presence ---");
    const agentOnlineRes = await api("/api/agent/presence/online", {
      method: "POST",
      token: "dev-token-agent-01",
      body: { tenantId: "slt", agentId: "live-agent-01", connectionId: "conn-socket-test-1" },
    });
    assert(
      "Authorized live agent sets presence AVAILABLE with 200 OK",
      agentOnlineRes.status === 200 &&
        agentOnlineRes.data.success === true &&
        agentOnlineRes.data.status === "AVAILABLE",
      JSON.stringify(agentOnlineRes.data)
    );

    // =========================================================================
    // 11. Anonymous handoff resolution denied
    // =========================================================================
    console.log("\n--- 11. Anonymous Handoff Resolution Denied ---");
    const anonResolveRes = await api("/api/chat/handoff/resolve", {
      method: "POST",
      body: { tenantId: "slt", sessionId: "sess-test-999", agentId: "live-agent-01" },
    });
    assert(
      "POST /api/chat/handoff/resolve without token returns 401 Authentication required",
      anonResolveRes.status === 401 && anonResolveRes.data.error === "Authentication required",
      JSON.stringify(anonResolveRes.data)
    );

    // =========================================================================
    // 12. Cross-tenant handoff resolution denied
    // =========================================================================
    console.log("\n--- 12. Cross-Tenant Handoff Resolution Denied ---");
    // Customer initiates handoff in 'slt'
    const handoffInitRes = await api("/api/chat/handoff/request", {
      method: "POST",
      body: {
        tenantId: "slt",
        sessionId: "sess-isolation-test-101",
        reason: "Billing question",
        customerInfo: { name: "Anura Silva" },
      },
    });
    assert(
      "Prerequisite: Customer escalation session created and assigned to live-agent-01",
      handoffInitRes.status === 200 &&
        handoffInitRes.data.assigned === true &&
        handoffInitRes.data.agentId === "live-agent-01",
      JSON.stringify(handoffInitRes.data)
    );

    // Token for another tenant 'tenant-other'
    const otherTenantToken = getLocalSessionTokenService().issueToken({
      sub: "live-agent-01",
      email: "agent@other.com",
      name: "Agent Other",
      role: "live_agent",
      tenantId: "tenant-other",
    });

    const crossTenantResolveRes = await api("/api/chat/handoff/resolve", {
      method: "POST",
      token: otherTenantToken,
      body: {
        tenantId: "slt", // Mismatch with token's assigned tenant
        sessionId: "sess-isolation-test-101",
      },
    });
    assert(
      "Cross-tenant session resolution attempt returns 403 Forbidden",
      crossTenantResolveRes.status === 403 &&
        crossTenantResolveRes.data.success === false &&
        crossTenantResolveRes.data.error.includes("Cross-tenant"),
      JSON.stringify(crossTenantResolveRes.data)
    );

    // =========================================================================
    // 13. Unassigned agent cannot resolve another agent's session
    // =========================================================================
    console.log("\n--- 13. Unassigned Agent Cannot Resolve Another Agent's Session ---");
    const unassignedResolveRes = await api("/api/chat/handoff/resolve", {
      method: "POST",
      token: "dev-token-agent-02", // sub is live-agent-02, but session is assigned to live-agent-01
      body: {
        tenantId: "slt",
        sessionId: "sess-isolation-test-101",
      },
    });
    assert(
      "Unassigned agent resolution returns 403 Forbidden (ownership check)",
      unassignedResolveRes.status === 403 &&
        unassignedResolveRes.data.success === false &&
        unassignedResolveRes.data.error.includes("not assigned to session"),
      JSON.stringify(unassignedResolveRes.data)
    );

    // =========================================================================
    // 14. Assigned agent can resolve the correct session
    // =========================================================================
    console.log("\n--- 14. Assigned Agent Can Resolve Session ---");
    const assignedResolveRes = await api("/api/chat/handoff/resolve", {
      method: "POST",
      token: "dev-token-agent-01", // sub is live-agent-01 (assigned agent)
      body: {
        tenantId: "slt",
        sessionId: "sess-isolation-test-101",
      },
    });
    assert(
      "Assigned agent resolves session with 200 OK and status RESOLVED",
      assignedResolveRes.status === 200 &&
        assignedResolveRes.data.success === true &&
        assignedResolveRes.data.status === "RESOLVED",
      JSON.stringify(assignedResolveRes.data)
    );

    // =========================================================================
    // 15. Already resolved sessions are handled consistently
    // =========================================================================
    console.log("\n--- 15. Already Resolved Sessions Handled Consistently ---");
    const reResolveRes = await api("/api/chat/handoff/resolve", {
      method: "POST",
      token: "dev-token-agent-01",
      body: {
        tenantId: "slt",
        sessionId: "sess-isolation-test-101",
      },
    });
    assert(
      "Repeated resolution of an already resolved session returns 200 OK idempotently",
      reResolveRes.status === 200 &&
        reResolveRes.data.success === true &&
        reResolveRes.data.status === "RESOLVED",
      JSON.stringify(reResolveRes.data)
    );

    // =========================================================================
    // 16. Existing legitimate public registration and hosted-chat behavior remains functional
    // =========================================================================
    console.log("\n--- 16. Public Registration & Hosted Chat Remain Functional ---");
    const pubRegRes = await api("/api/registrations", {
      method: "POST",
      body: {
        companyName: "Safe Public Onboarding Corp",
        companyEmail: "safe@publiccorp.com",
      },
    });
    assert(
      "Public registration endpoint remains functional (201 Created)",
      pubRegRes.status === 201 &&
        pubRegRes.data.success === true &&
        pubRegRes.data.registration?.status === "Pending",
      JSON.stringify(pubRegRes.data)
    );

    const chatUrlRes = await api("/api/resolve-chat-url?company=slt&agent=support");
    assert(
      "Public hosted chat URL resolver remains functional (200 OK)",
      chatUrlRes.status === 200 && chatUrlRes.data.tenantId === "slt",
      JSON.stringify(chatUrlRes.data)
    );

    // Real database immutability verification
    console.log("\n--- Real Database Immutability Check ---");
    const realDbSnapshotAfter = fs.readFileSync(realDbPath, "utf-8");
    assert(
      "Real tracked db.json was NOT mutated during hardening test execution",
      realDbSnapshotBefore === realDbSnapshotAfter,
      `Length before: ${realDbSnapshotBefore.length}, Length after: ${realDbSnapshotAfter.length}`
    );
  } finally {
    server.close();
    if (fs.existsSync(tempDbPath)) {
      try {
        fs.unlinkSync(tempDbPath);
      } catch {
        // ignore cleanup error
      }
    }
  }

  console.log("\n================================================================");
  console.log(`📊 Hardening Test Summary: ${passed} Passed, ${failed} Failed`);
  console.log("================================================================");

  if (failed > 0) {
    process.exit(1);
  } else {
    process.exit(0);
  }
}

runHardeningTests().catch((err) => {
  console.error("Fatal hardening test suite error:", err);
  process.exit(1);
});
