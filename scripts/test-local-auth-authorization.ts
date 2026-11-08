/** Isolated HTTP integration tests for auth middleware, RBAC, and tenant isolation in server.ts. */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { AddressInfo } from "node:net";
import { PutCommand, DeleteCommand } from "@aws-sdk/lib-dynamodb";
import { DeleteObjectCommand, HeadBucketCommand } from "@aws-sdk/client-s3";
import { createApp } from "../server";
import { createJsonDbStore } from "../services/auth/local-auth-router";
import { LocalLoginAttemptGuard } from "../services/auth/local-login-attempt-guard";
import { LocalSessionTokenService } from "../services/auth/local-session-token";
import { hashPassword } from "../services/auth/password-hashing";
import { docClient } from "../agents/utils/dynamo-client";
import { s3Client } from "../agents/utils/s3-client";

async function main(): Promise<void> {
  process.env.NODE_ENV = "test";
  process.env.IS_LOCAL = "true";

  let passed = 0;
  const pass = (label: string) => {
    console.log(`PASS: ${label}`);
    passed++;
  };

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "omni-authz-"));
  const suffix = randomUUID().slice(0, 8);
  const tenantA = `tenant-iso-a-${suffix}`;
  const tenantB = `tenant-iso-b-${suffix}`;
  const agentA1 = `agent-a1-${suffix}`;
  const agentA2 = `agent-a2-${suffix}`;
  const agentB1 = `agent-b1-${suffix}`;
  const convA = `conv-iso-a-${suffix}`;
  const convB = `conv-iso-b-${suffix}`;
  const kbDocA = `iso-a-${suffix}.txt`;
  const kbBucket = process.env.KB_BUCKET_NAME || "omni-channel-kb-docs";

  let httpServer: import("node:http").Server | null = null;
  let seededConvs = false;
  let uploadedS3Key: string | null = null;
  let baseUrl = "";
  let agentA1Token = "";
  let agentB1Token = "";

  async function reqJson(
    route: string,
    opts: {
      method?: string;
      token?: string;
      headers?: Record<string, string>;
      body?: unknown;
    } = {},
  ) {
    const headers: Record<string, string> = { ...(opts.headers || {}) };
    if (opts.token) {
      headers.Authorization = `Bearer ${opts.token}`;
    }
    if (opts.body !== undefined && !headers["Content-Type"]) {
      headers["Content-Type"] = "application/json";
    }
    const res = await fetch(`${baseUrl}${route}`, {
      method: opts.method || "GET",
      headers,
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    });
    const text = await res.text();
    let data: Record<string, any> = {};
    try {
      data = text ? JSON.parse(text) : {};
    } catch {
      data = { raw: text };
    }
    return { status: res.status, data };
  }

  try {
    const dbPath = path.join(tempDir, "db.json");
    const store = createJsonDbStore(dbPath);
    const tokenService = new LocalSessionTokenService({
      secret: "isolated-authz-test-signing-key-32bytes!",
    });
    const loginGuard = new LocalLoginAttemptGuard({
      maxAttemptsPerWindow: 50,
      windowMs: 60_000,
      maxConcurrent: 4,
      maxTrackedKeys: 256,
    });

    const password = "FICTIONAL-Authz-Pass-2026!";
    const pwHash = await hashPassword(password);

    store.writeDB({
      users: [
        {
          id: "super-1",
          fullName: "Platform Super Admin",
          email: "super@example.test",
          passwordHash: pwHash,
          role: "superadmin",
        },
        {
          id: agentA1,
          fullName: "Tenant A Live Agent 1",
          email: "agenta1@example.test",
          passwordHash: pwHash,
          role: "live_agent",
          tenantId: tenantA,
        },
        {
          id: agentA2,
          fullName: "Tenant A Live Agent 2",
          email: "agenta2@example.test",
          passwordHash: pwHash,
          role: "live_agent",
          tenantId: tenantA,
        },
        {
          id: agentB1,
          fullName: "Tenant B Live Agent 1",
          email: "agentb1@example.test",
          passwordHash: pwHash,
          role: "live_agent",
          tenantId: tenantB,
        },
        {
          id: "slt-agent-1",
          fullName: "SLT Live Agent",
          email: "sltagent@example.test",
          passwordHash: pwHash,
          role: "live_agent",
          tenantId: "slt",
        },
      ],
      registrations: [
        {
          id: "reg-a",
          companyName: "Tenant A Co",
          companySlug: tenantA,
          companyEmail: "companya@example.test",
          adminName: "Admin A",
          status: "Approved",
          tenantId: tenantA,
          passwordHash: pwHash,
        },
        {
          id: "reg-b",
          companyName: "Tenant B Co",
          companySlug: tenantB,
          companyEmail: "companyb@example.test",
          adminName: "Admin B",
          status: "Approved",
          tenantId: tenantB,
          passwordHash: pwHash,
        },
        {
          id: "reg-slt",
          companyName: "Sri Lanka Telecom",
          companySlug: "slt",
          companyEmail: "sltadmin@example.test",
          adminName: "SLT Admin",
          status: "Approved",
          tenantId: "slt",
          passwordHash: pwHash,
        },
        {
          id: "reg-reject-1",
          companyName: "Reject Target Co",
          companySlug: "reject-target",
          companyEmail: "rejectme@example.test",
          adminName: "Reject Admin",
          status: "Pending",
          passwordHash: pwHash,
        },
      ],
    });

    const app = createApp({ dbPath, tokenService, loginGuard });
    httpServer = await new Promise<import("node:http").Server>((resolve) => {
      const s = app.listen(0, "127.0.0.1", () => resolve(s));
    });
    const port = (httpServer.address() as AddressInfo).port;
    baseUrl = `http://127.0.0.1:${port}`;

    async function login(email: string): Promise<string> {
      const res = await reqJson("/api/auth/login", {
        method: "POST",
        body: { email, password },
      });
      assert.equal(res.status, 200, `Login failed for ${email}: ${JSON.stringify(res.data)}`);
      assert.ok(typeof res.data.token === "string" && res.data.token.startsWith("v1."));
      return res.data.token;
    }

    const superToken = await login("super@example.test");
    const companyAToken = await login("companya@example.test");
    const companyBToken = await login("companyb@example.test");
    const sltCompanyToken = await login("sltadmin@example.test");
    const sltAgentToken = await login("sltagent@example.test");
    agentA1Token = await login("agenta1@example.test");
    agentB1Token = await login("agentb1@example.test");

    const expiredService = new LocalSessionTokenService({
      secret: "isolated-authz-test-signing-key-32bytes!",
      now: () => 1_700_000_000_000,
    });
    const expiredToken = expiredService.issueToken(
      { sub: "user-exp", email: "exp@example.test", name: "Exp", role: "superadmin" },
      10,
    );
    const unsignedMockJwt = [
      Buffer.from(JSON.stringify({ alg: "none" })).toString("base64url"),
      Buffer.from(
        JSON.stringify({ tenantId: "slt", sub: "attacker", "cognito:groups": ["superadmin"] }),
      ).toString("base64url"),
      "fake-signature",
    ].join(".");

    // 1. All protected endpoints reject missing, tampered, expired, and unsigned mock JWTs with 401
    const protectedRoutes: Array<{ method: string; path: string; body?: unknown }> = [
      { method: "GET", path: "/api/stats" },
      { method: "GET", path: "/api/notifications" },
      { method: "GET", path: "/api/registrations" },
      { method: "PUT", path: "/api/registrations/reg-reject-1/status", body: { status: "Rejected" } },
      { method: "POST", path: "/api/agent/presence/online", body: {} },
      { method: "POST", path: "/api/agent/presence/offline", body: {} },
      { method: "GET", path: "/api/agent/presence/status" },
      { method: "POST", path: "/api/chat/handoff/resolve", body: { sessionId: "sess-x" } },
      { method: "POST", path: "/api/workspace/upload-doc", body: { documentName: "x.txt", content: "hi" } },
      { method: "GET", path: "/api/workspace/conversations" },
      { method: "GET", path: "/api/dev/admin/overview" },
      { method: "GET", path: "/api/dev/admin/chats" },
      { method: "GET", path: "/api/dev/admin/agents" },
      { method: "POST", path: "/api/dev/admin/agents", body: {} },
      { method: "GET", path: "/api/dev/admin/agents/main-agent" },
      { method: "PATCH", path: "/api/dev/admin/agents/agent-1", body: {} },
      { method: "DELETE", path: "/api/dev/admin/agents/agent-1" },
      { method: "POST", path: "/api/dev/admin/agents/agent-1/publish", body: {} },
      { method: "POST", path: "/api/dev/admin/agents/agent-1/unpublish", body: {} },
      { method: "GET", path: "/api/dev/admin/knowledge-files" },
      { method: "GET", path: "/api/dev/admin/knowledge-files/doc.txt" },
      { method: "PATCH", path: "/api/dev/admin/knowledge-files/doc.txt", body: {} },
      { method: "DELETE", path: "/api/dev/admin/knowledge-files/kb-upload-test-1.txt" },
      { method: "GET", path: "/api/dev/live/queue" },
      { method: "POST", path: "/api/dev/live/conversations/sess-1/close", body: {} },
      { method: "GET", path: "/api/dev/live/conversations/sess-1/messages" },
      { method: "POST", path: "/api/dev/live/conversations/sess-1/messages", body: { role: "live_agent", message: "hi" } },
      { method: "POST", path: "/api/agent", body: { intent: "check_balance" } },
      { method: "POST", path: "/api/tenant/route", body: { intent: "check_balance" } },
    ];

    for (const r of protectedRoutes) {
      const noAuth = await reqJson(r.path, { method: r.method, body: r.body });
      assert.equal(noAuth.status, 401, `Expected 401 without auth for ${r.method} ${r.path}, got ${noAuth.status}`);

      const badJwt = await reqJson(r.path, { method: r.method, body: r.body, token: unsignedMockJwt });
      assert.equal(badJwt.status, 401, `Expected 401 for mock JWT on ${r.method} ${r.path}, got ${badJwt.status}`);
    }
    const tampered = await reqJson("/api/stats", { token: `${superToken.slice(0, -1)}A` });
    assert.equal(tampered.status, 401);
    const expired = await reqJson("/api/stats", { token: expiredToken });
    assert.equal(expired.status, 401);
    pass("All protected endpoints reject missing, tampered, expired, and unsigned mock JWTs with 401");

    // 2. Role-based access control
    for (const token of [companyAToken, agentA1Token]) {
      assert.equal((await reqJson("/api/stats", { token })).status, 403);
      assert.equal((await reqJson("/api/notifications", { token })).status, 403);
      assert.equal((await reqJson("/api/registrations", { token })).status, 403);
      assert.equal(
        (await reqJson("/api/registrations/reg-reject-1/status", {
          method: "PUT",
          token,
          body: { status: "Rejected" },
        })).status,
        403,
      );
    }

    // Superadmin cannot access tenant-scoped workspace, admin, agent, or live routes
    const superBlockedRoutes: Array<{ method: string; path: string; body?: unknown }> = [
      { method: "GET", path: "/api/workspace/conversations" },
      { method: "POST", path: "/api/workspace/upload-doc", body: { documentName: "x.txt", content: "hi" } },
      { method: "GET", path: "/api/dev/admin/overview" },
      { method: "GET", path: "/api/dev/admin/agents" },
      { method: "POST", path: "/api/agent/presence/online", body: {} },
      { method: "POST", path: "/api/chat/handoff/resolve", body: { sessionId: "sess-1" } },
      { method: "GET", path: "/api/dev/live/queue" },
      { method: "POST", path: "/api/agent", body: { intent: "check_balance" } },
    ];
    for (const r of superBlockedRoutes) {
      const blocked = await reqJson(r.path, { method: r.method, token: superToken, body: r.body });
      assert.equal(blocked.status, 403, `Expected 403 for superadmin on ${r.method} ${r.path}, got ${blocked.status}`);
    }

    // live_agent cannot access company-only workspace/admin endpoints
    for (const r of [
      { method: "GET", path: "/api/workspace/conversations" },
      { method: "POST", path: "/api/workspace/upload-doc", body: { documentName: "x.txt", content: "hi" } },
      { method: "GET", path: "/api/dev/admin/overview" },
      { method: "GET", path: "/api/dev/admin/chats" },
      { method: "GET", path: "/api/dev/admin/agents" },
      { method: "GET", path: "/api/dev/admin/knowledge-files" },
    ]) {
      const blocked = await reqJson(r.path, { method: r.method, token: agentA1Token, body: r.body });
      assert.equal(blocked.status, 403, `Expected 403 for live_agent on ${r.method} ${r.path}, got ${blocked.status}`);
    }
    pass("Role-based access control enforces separation across superadmin, company, and live_agent");

    // 3. Superadmin registration review + credential redaction
    const regList = await reqJson("/api/registrations", { token: superToken });
    assert.equal(regList.status, 200);
    assert.ok(Array.isArray(regList.data.registrations));
    for (const r of regList.data.registrations) {
      assert.equal("passwordHash" in r, false);
      assert.equal("password" in r, false);
    }
    const rejectRes = await reqJson("/api/registrations/reg-reject-1/status", {
      method: "PUT",
      token: superToken,
      body: { status: "Rejected" },
    });
    assert.equal(rejectRes.status, 200);
    assert.equal(rejectRes.data.registration?.status, "Rejected");
    assert.equal("passwordHash" in rejectRes.data.registration, false);

    const rejectedLogin = await reqJson("/api/auth/login", {
      method: "POST",
      body: { email: "rejectme@example.test", password },
    });
    assert.equal(rejectedLogin.status, 403);
    pass("Superadmin registration listing/rejection succeeds cleanly without leaking credentials");

    // 4. Zero-trust tenant scope checks reject cross-tenant headers/query/body
    const crossTenantProbes: Array<{ method: string; path: string; headers?: Record<string, string>; body?: unknown }> = [
      { method: "GET", path: `/api/workspace/conversations?tenantId=${tenantB}` },
      { method: "GET", path: "/api/workspace/conversations", headers: { "x-tenant-id": tenantB } },
      {
        method: "POST",
        path: "/api/workspace/upload-doc",
        body: { tenantId: tenantB, documentName: "leak.txt", content: "secret" },
      },
      { method: "GET", path: `/api/dev/admin/overview?tenantId=${tenantB}` },
      { method: "GET", path: "/api/dev/admin/agents", headers: { "x-tenant-id": tenantB } },
    ];
    for (const probe of crossTenantProbes) {
      const res = await reqJson(probe.path, {
        method: probe.method,
        token: companyAToken,
        headers: probe.headers,
        body: probe.body,
      });
      assert.equal(res.status, 403, `Expected 403 cross-tenant block for ${probe.path}, got ${res.status}`);
    }
    const malformedTenantHeader = await reqJson("/api/workspace/conversations", {
      token: companyAToken,
      headers: { "x-tenant-id": "../slt" },
    });
    assert.equal(malformedTenantHeader.status, 400);
    const agentCrossTenant = await reqJson("/api/agent/presence/online", {
      method: "POST",
      token: agentA1Token,
      body: { tenantId: tenantB },
    });
    assert.equal(agentCrossTenant.status, 403);
    pass("Cross-tenant header/query/body parameters fail with 403 and malformed tenantIds return 400");

    // 5. Live agent self-identity enforcement
    const spoofPresence = await reqJson("/api/agent/presence/online", {
      method: "POST",
      token: agentA1Token,
      body: { agentId: agentA2 },
    });
    assert.equal(spoofPresence.status, 403);
    const spoofStatus = await reqJson(`/api/agent/presence/status?agentId=${encodeURIComponent(agentA2)}`, {
      token: agentA1Token,
    });
    assert.equal(spoofStatus.status, 403);
    const spoofResolve = await reqJson("/api/chat/handoff/resolve", {
      method: "POST",
      token: agentA1Token,
      body: { sessionId: "sess-any", agentId: agentA2 },
    });
    assert.equal(spoofResolve.status, 403);
    const spoofQueue = await reqJson(`/api/dev/live/queue?agentId=${encodeURIComponent(agentA2)}`, {
      token: agentA1Token,
    });
    assert.equal(spoofQueue.status, 403);
    const badAgentFormat = await reqJson("/api/agent/presence/status?agentId=bad%20agent%2Fid", {
      token: agentA1Token,
    });
    assert.equal(badAgentFormat.status, 400);
    pass("Live agents cannot spoof another agent identity within their tenant");

    // 6. Handoff tenant requirement + cross-tenant session resolve protection
    const missingTenantHandoff = await reqJson("/api/chat/handoff/request", {
      method: "POST",
      body: { sessionId: `sess-no-tenant-${suffix}`, reason: "Need support" },
    });
    assert.equal(missingTenantHandoff.status, 400);

    const onlineA = await reqJson("/api/agent/presence/online", {
      method: "POST",
      token: agentA1Token,
      body: { connectionId: `conn-${suffix}` },
    });
    assert.equal(onlineA.status, 200);
    assert.equal(onlineA.data.agentId, agentA1);
    assert.equal(onlineA.data.tenantId, tenantA);
    assert.equal(onlineA.data.status, "AVAILABLE");

    const handoffSessionId = `sess-iso-${suffix}`;
    const handoffA = await reqJson("/api/chat/handoff/request", {
      method: "POST",
      body: {
        tenantId: tenantA,
        sessionId: handoffSessionId,
        reason: "Need billing specialist",
        customerInfo: { name: "Test Customer" },
      },
    });
    assert.equal(handoffA.status, 200);
    assert.equal(handoffA.data.assigned, true);
    assert.equal(handoffA.data.agentId, agentA1);
    assert.equal(handoffA.data.status, "HUMAN_ACTIVE");

    // Tenant B cannot hijack or overwrite Tenant A's active sessionId
    const crossTenantHijack = await reqJson("/api/chat/handoff/request", {
      method: "POST",
      body: { tenantId: tenantB, sessionId: handoffSessionId },
    });
    assert.equal(crossTenantHijack.status, 403);

    // Tenant B cannot resolve Tenant A's chat session and cannot alter Tenant A's activeChats count
    const crossResolveByB = await reqJson("/api/chat/handoff/resolve", {
      method: "POST",
      token: companyBToken,
      body: { sessionId: handoffSessionId, agentId: agentA1 },
    });
    assert.equal(crossResolveByB.status, 404);
    const crossResolveByAgentB = await reqJson("/api/chat/handoff/resolve", {
      method: "POST",
      token: agentB1Token,
      body: { sessionId: handoffSessionId },
    });
    assert.equal(crossResolveByAgentB.status, 404);

    const statusBeforeOwnResolve = await reqJson("/api/agent/presence/status", { token: agentA1Token });
    assert.equal(statusBeforeOwnResolve.status, 200);
    assert.equal(statusBeforeOwnResolve.data.activeChats, 1);

    // 6b. When LocalStack DynamoDB is online, verify /api/dev/live/* and /api/dev/admin/chats isolation
    const liveQueueA = await reqJson("/api/dev/live/queue", { token: agentA1Token });
    if (liveQueueA.status === 200) {
      assert.ok((liveQueueA.data.assigned || []).some((s: any) => s.sessionId === handoffSessionId));
      const liveQueueB = await reqJson("/api/dev/live/queue", { token: agentB1Token });
      assert.equal(liveQueueB.status, 200);
      assert.equal((liveQueueB.data.assigned || []).some((s: any) => s.sessionId === handoffSessionId), false);

      const readMsgB = await reqJson(`/api/dev/live/conversations/${handoffSessionId}/messages`, {
        token: agentB1Token,
      });
      assert.equal(readMsgB.status, 404);
      const writeMsgB = await reqJson(`/api/dev/live/conversations/${handoffSessionId}/messages`, {
        method: "POST",
        token: agentB1Token,
        body: { role: "live_agent", message: "cross-tenant probe" },
      });
      assert.equal(writeMsgB.status, 409);

      const writeMsgA = await reqJson(`/api/dev/live/conversations/${handoffSessionId}/messages`, {
        method: "POST",
        token: agentA1Token,
        body: { role: "live_agent", message: "Hello from Tenant A agent" },
      });
      assert.equal(writeMsgA.status, 201);
      const readMsgA = await reqJson(`/api/dev/live/conversations/${handoffSessionId}/messages`, {
        token: agentA1Token,
      });
      assert.equal(readMsgA.status, 200);
      assert.ok((readMsgA.data.messages || []).some((m: any) => m.text === "Hello from Tenant A agent"));

      const adminChatsA = await reqJson("/api/dev/admin/chats", { token: companyAToken });
      assert.equal(adminChatsA.status, 200);
      assert.equal(adminChatsA.data.tenantId, tenantA);
      assert.ok((adminChatsA.data.items || []).some((c: any) => c.sessionId === handoffSessionId));
      const adminChatsB = await reqJson("/api/dev/admin/chats", { token: companyBToken });
      assert.equal(adminChatsB.status, 200);
      assert.equal(adminChatsB.data.tenantId, tenantB);
      assert.equal((adminChatsB.data.items || []).some((c: any) => c.sessionId === handoffSessionId), false);

      const closeByB = await reqJson(`/api/dev/live/conversations/${handoffSessionId}/close`, {
        method: "POST",
        token: agentB1Token,
      });
      assert.equal(closeByB.status, 409);
      pass("Live agent queue, messages, close, and admin chat monitor isolate sessions by tenantId and agentId");
    }

    // Tenant A's assigned agent resolves cleanly, and duplicate resolve returns 409
    const ownResolve = await reqJson("/api/chat/handoff/resolve", {
      method: "POST",
      token: agentA1Token,
      body: { sessionId: handoffSessionId },
    });
    assert.equal(ownResolve.status, 200);
    assert.equal(ownResolve.data.status, "RESOLVED");

    const duplicateResolve = await reqJson("/api/chat/handoff/resolve", {
      method: "POST",
      token: agentA1Token,
      body: { sessionId: handoffSessionId },
    });
    assert.equal(duplicateResolve.status, 409);

    const statusAfterResolve = await reqJson("/api/agent/presence/status", { token: agentA1Token });
    assert.equal(statusAfterResolve.status, 200);
    assert.equal(statusAfterResolve.data.activeChats, 0);
    pass("Handoff request requires tenantId and cross-tenant resolve cannot alter foreign sessions or activeChats");

    // 7. /api/agent & /api/tenant/route verified context, permission map, and HTTP status mapping
    const missingIntent = await reqJson("/api/agent", {
      method: "POST",
      token: sltAgentToken,
      body: {},
    });
    assert.equal(missingIntent.status, 400);

    const forbiddenIntent = await reqJson("/api/agent", {
      method: "POST",
      token: sltAgentToken,
      headers: {
        "x-user-role": "admin",
        "x-user-id": "spoofed-root",
      },
      body: { intent: "pay_bill", params: { amount: 100 } },
    });
    assert.equal(forbiddenIntent.status, 403);

    const unmappedIntent = await reqJson("/api/agent", {
      method: "POST",
      token: sltCompanyToken,
      body: { intent: "unmapped_dangerous_intent" },
    });
    assert.equal(unmappedIntent.status, 403);

    const validAgentCall = await reqJson("/api/agent", {
      method: "POST",
      token: sltCompanyToken,
      body: { intent: "check_balance", params: { accountNumber: "SLT-001" } },
    });
    assert.equal(validAgentCall.status, 200);
    assert.equal(validAgentCall.data.success, true);
    pass("/api/agent derives TenantContext strictly from verified tokens and maps RBAC/error codes to HTTP statuses");

    // 8. Workspace conversations & KB scoping (live LocalStack isolation if running, else fail-closed 503)
    const invalidLimit = await reqJson("/api/workspace/conversations?limit=0", { token: companyAToken });
    assert.equal(invalidLimit.status, 400);

    let localstackAvailable = false;
    try {
      await docClient.send(
        new PutCommand({
          TableName: "omni-channel-conversations",
          Item: {
            conversationId: convA,
            sessionId: `s-${convA}`,
            tenantId: tenantA,
            userId: "user-a",
            intent: "check_balance",
            status: "ROUTED",
            timestamp: new Date().toISOString(),
          },
        }),
      );
      await docClient.send(
        new PutCommand({
          TableName: "omni-channel-conversations",
          Item: {
            conversationId: convB,
            sessionId: `s-${convB}`,
            tenantId: tenantB,
            userId: "user-b",
            intent: "check_balance",
            status: "ROUTED",
            timestamp: new Date().toISOString(),
          },
        }),
      );
      seededConvs = true;
      localstackAvailable = true;
    } catch {
      localstackAvailable = false;
    }

    const convRes = await reqJson("/api/workspace/conversations", { token: companyAToken });
    if (localstackAvailable) {
      assert.equal(convRes.status, 200);
      assert.equal(convRes.data.tenantId, tenantA);
      assert.ok(Array.isArray(convRes.data.conversations));
      assert.ok(convRes.data.conversations.some((c: any) => c.conversationId === convA));
      assert.equal(convRes.data.conversations.some((c: any) => c.conversationId === convB), false);
      assert.equal(convRes.data.conversations.some((c: any) => c.tenantId !== tenantA), false);

      // Verify missing tenant returns 404 TENANT_NOT_FOUND from /api/tenant/route when DynamoDB is online
      const unknownTenantRoute = await reqJson("/api/tenant/route", {
        method: "POST",
        token: companyAToken,
        body: { intent: "check_balance" },
      });
      assert.equal(unknownTenantRoute.status, 404);
      pass("Workspace conversations strictly isolated per tenantId in live DynamoDB (zero cross-tenant or fixture leakage)");
    } else {
      assert.equal(convRes.status, 503);
      assert.equal(convRes.data.success, false);
      pass("Workspace conversations fail closed with 503 when DynamoDB is unavailable (no fake fixture rows)");
    }

    // Optional live S3 KB upload + cross-tenant inventory isolation check when LocalStack S3 bucket is present
    let s3BucketReady = false;
    try {
      await s3Client.send(new HeadBucketCommand({ Bucket: kbBucket }));
      s3BucketReady = true;
    } catch {
      s3BucketReady = false;
    }

    if (s3BucketReady) {
      const uploadRes = await reqJson("/api/workspace/upload-doc", {
        method: "POST",
        token: companyAToken,
        body: {
          documentName: kbDocA,
          content: "Tenant A confidential troubleshooting document",
        },
      });
      assert.equal(uploadRes.status, 201);
      assert.equal(uploadRes.data.tenantId, tenantA);
      assert.equal(uploadRes.data.s3Key, `tenants/${tenantA}/${kbDocA}`);
      uploadedS3Key = uploadRes.data.s3Key;

      const listB = await reqJson("/api/dev/admin/knowledge-files", { token: companyBToken });
      assert.equal(listB.status, 200);
      assert.equal(listB.data.prefix, `tenants/${tenantB}/`);
      assert.equal((listB.data.items || []).some((item: any) => item.name === kbDocA), false);
      pass("Workspace S3 KB upload and listing are strictly partitioned per verified tenantId");
    }

    console.log(`\n--- ${passed} passed, 0 failed ---`);
  } finally {
    if (baseUrl && agentA1Token) {
      await reqJson("/api/agent/presence/offline", { method: "POST", token: agentA1Token, body: {} }).catch(() => {});
    }
    if (baseUrl && agentB1Token) {
      await reqJson("/api/agent/presence/offline", { method: "POST", token: agentB1Token, body: {} }).catch(() => {});
    }
    if (seededConvs) {
      await docClient.send(
        new DeleteCommand({ TableName: "omni-channel-conversations", Key: { conversationId: convA } }),
      ).catch(() => {});
      await docClient.send(
        new DeleteCommand({ TableName: "omni-channel-conversations", Key: { conversationId: convB } }),
      ).catch(() => {});
    }
    if (uploadedS3Key) {
      await s3Client.send(
        new DeleteObjectCommand({ Bucket: kbBucket, Key: uploadedS3Key }),
      ).catch(() => {});
    }
    if (httpServer) {
      await new Promise<void>((resolve) => httpServer!.close(() => resolve()));
    }
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});

