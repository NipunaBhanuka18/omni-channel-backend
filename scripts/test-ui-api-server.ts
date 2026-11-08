process.env.NODE_ENV = "test";
process.env.IS_LOCAL = "true";

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { AddressInfo } from "node:net";
import { GetCommand, PutCommand, DeleteCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";
import { AdminCreateUserCommand, AdminAddUserToGroupCommand } from "@aws-sdk/client-cognito-identity-provider";
import { PutObjectCommand, DeleteObjectCommand } from "@aws-sdk/client-s3";
import { createApp } from "../server";
import { createJsonDbStore } from "../services/auth/local-auth-router";
import { LocalLoginAttemptGuard } from "../services/auth/local-login-attempt-guard";
import { LocalSessionTokenService } from "../services/auth/local-session-token";
import { hashPassword } from "../services/auth/password-hashing";
import { provisionPendingCompanyApproval } from "../services/onboarding/approval-workflow";
import { onboardCompany, OnboardingDeps } from "../services/onboarding/onboarding";
import { s3Client } from "../agents/utils/s3-client";

function createFakeOnboardingDeps(): OnboardingDeps {
  const tenants = new Map<string, any>();
  const dynamo = {
    send: async (command: any) => {
      const input: any = command.input;
      if (command instanceof GetCommand) {
        return { Item: tenants.get(input.Key.tenantId) };
      }
      if (command instanceof QueryCommand) {
        const wanted = input.ExpressionAttributeValues?.[":n"];
        const match = [...tenants.values()].find((t) => t.normalizedName === wanted);
        return { Items: match ? [match] : [] };
      }
      if (command instanceof PutCommand) {
        if (input.TableName === "omni-channel-tenants") {
          tenants.set(input.Item.tenantId, input.Item);
        }
        return {};
      }
      if (command instanceof DeleteCommand) {
        if (input.TableName === "omni-channel-tenants") {
          tenants.delete(input.Key.tenantId);
        }
        return {};
      }
      return {};
    },
  };
  const cognito = {
    send: async (command: any) => {
      if (command instanceof AdminCreateUserCommand || command instanceof AdminAddUserToGroupCommand) {
        return {};
      }
      return {};
    },
  };
  const s3 = {
    send: async (command: any) => {
      if (command instanceof PutObjectCommand || command instanceof DeleteObjectCommand) {
        return {};
      }
      return {};
    },
  };
  return {
    dynamo: dynamo as any,
    cognito: cognito as any,
    s3: s3 as any,
    userPoolId: "test-local-pool-id",
  };
}

async function runUiServerTests() {
  console.log("================================================================");
  console.log("🖥️  MEMBER 1: FULL UI API SERVER INTEGRATION TEST SUITE");
  console.log("================================================================\n");

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "omni-ui-api-"));
  const suffix = randomUUID().slice(0, 8);
  const uiHandoffTenant = `tenant-ui-${suffix}`;
  const uiAgentId = `live-agent-${suffix}`;
  const kbDocName = `kb-upload-test-ui-${suffix}.txt`;
  const kbBucket = process.env.KB_BUCKET_NAME || "omni-channel-kb-docs";
  let uploadedS3Key: string | null = null;
  let server: import("node:http").Server | null = null;
  let baseUrl = "";
  let agentToken = "";

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

  type UiApiResponse = {
    totalAvailability?: number;
    activeAgentsCount?: number;
    success?: boolean;
    token?: string;
    user?: { role?: string; tenantId?: string };
    registration?: Record<string, any> & { id?: string; status?: string; tenantId?: string };
    credentials?: { username?: string; temporaryPassword?: string };
    status?: string;
    assigned?: boolean;
    s3Key?: string;
    tenantId?: string;
    agentId?: string;
  };

  async function api(
    route: string,
    options: { method?: string; body?: any; token?: string } = {},
  ) {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (options.token) {
      headers.Authorization = `Bearer ${options.token}`;
    }
    const res = await fetch(`${baseUrl}${route}`, {
      method: options.method || "GET",
      headers,
      body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
    });
    const json = (await res.json().catch(() => ({}))) as UiApiResponse;
    return { status: res.status, data: json };
  }

  try {
    const dbPath = path.join(tempDir, "db.json");
    const store = createJsonDbStore(dbPath);
    const tokenService = new LocalSessionTokenService({
      secret: "isolated-ui-suite-signing-key-32bytes!!",
    });
    const loginGuard = new LocalLoginAttemptGuard({
      maxAttemptsPerWindow: 30,
      windowMs: 60_000,
      maxConcurrent: 4,
      maxTrackedKeys: 128,
    });
    const fakeDeps = createFakeOnboardingDeps();

    const superPass = "FICTIONAL-UiSuper-2026!";
    const companyPass = "FICTIONAL-UiCompany-2026!";
    const agentPass = "FICTIONAL-UiAgent-2026!";
    const hemasPass = "FICTIONAL-HemasReg-2026!";

    store.writeDB({
      users: [
        {
          id: "usr-super-ui",
          fullName: "System Super Admin",
          email: "superadmin@slt.lk",
          passwordHash: await hashPassword(superPass),
          role: "superadmin",
        },
        {
          id: uiAgentId,
          fullName: "Live Agent 01",
          email: "agent01@slt.lk",
          passwordHash: await hashPassword(agentPass),
          role: "live_agent",
          tenantId: uiHandoffTenant,
        },
      ],
      registrations: [
        {
          id: "reg-slt-ui",
          companyName: "Sri Lanka Telecom",
          companySlug: "slt",
          companyEmail: "admin@slt.lk",
          adminName: "SLT Admin",
          status: "Approved",
          tenantId: "slt",
          passwordHash: await hashPassword(companyPass),
        },
      ],
    });

    const app = createApp({
      dbPath,
      tokenService,
      loginGuard,
      approvePendingRegistration: (reg) =>
        provisionPendingCompanyApproval(reg, (req) => onboardCompany(req, fakeDeps)),
    });

    server = await new Promise<import("node:http").Server>((resolve) => {
      const s = app.listen(0, "127.0.0.1", () => resolve(s));
    });
    const port = (server.address() as AddressInfo).port;
    baseUrl = `http://127.0.0.1:${port}`;

    // TEST 1: Unauthenticated stats rejected; authenticated superadmin stats succeed
    console.log("--- Test 1: Admin Console Stats Endpoint & Auth Boundary ---");
    const unauthStatsRes = await api("/api/stats");
    assert(
      "GET /api/stats rejects unauthenticated callers with 401",
      unauthStatsRes.status === 401,
      JSON.stringify(unauthStatsRes.data),
    );

    // TEST 2: Super Admin Authentication
    console.log("\n--- Test 2: Admin Login Authentication ---");
    const loginRes = await api("/api/auth/login", {
      method: "POST",
      body: { email: "superadmin@slt.lk", password: superPass },
    });
    const superToken = loginRes.data.token || "";
    assert(
      "POST /api/auth/login returns 200 with signed auth token and superadmin role",
      loginRes.status === 200 &&
        loginRes.data.success === true &&
        loginRes.data.user?.role === "superadmin" &&
        superToken.startsWith("v1."),
      JSON.stringify(loginRes.data),
    );

    const statsRes = await api("/api/stats", { token: superToken });
    assert(
      "Authenticated GET /api/stats returns 200 with dashboard metric counters",
      statsRes.status === 200 &&
        statsRes.data.totalAvailability !== undefined &&
        typeof statsRes.data.activeAgentsCount === "number" &&
        statsRes.data.activeAgentsCount >= 0,
      JSON.stringify(statsRes.data),
    );

    // TEST 3: Company Registration Submission
    console.log("\n--- Test 3: Company Registration Submission ---");
    const regRes = await api("/api/registrations", {
      method: "POST",
      body: {
        companyName: "Hemas Holdings",
        companySlug: "hemas",
        companyEmail: "admin@hemas.com",
        password: hemasPass,
        tier: "Enterprise",
        channels: ["Web", "WhatsApp"],
      },
    });
    const regId = regRes.data.registration?.id;
    assert(
      "POST /api/registrations creates pending registration and redacts password hashes",
      regRes.status === 201 &&
        regRes.data.success === true &&
        regRes.data.registration?.status === "Pending" &&
        !("passwordHash" in (regRes.data.registration || {})) &&
        !("password" in (regRes.data.registration || {})),
      JSON.stringify(regRes.data),
    );

    // TEST 4: Super Admin Approval & Auto-Provisioning + Verified Company Login
    console.log("\n--- Test 4: Registration Approval & Auto-Provisioning ---");
    const approveRes = await api(`/api/registrations/${regId}/status`, {
      method: "PUT",
      token: superToken,
      body: { status: "Approved" },
    });
    assert(
      "PUT /api/registrations/:id/status sets status Approved and provisions tenantId",
      approveRes.status === 200 &&
        approveRes.data.registration?.status === "Approved" &&
        approveRes.data.registration?.tenantId === "tenant-hemas" &&
        !("passwordHash" in (approveRes.data.registration || {})),
      JSON.stringify(approveRes.data),
    );

    const hemasLoginRes = await api("/api/auth/login", {
      method: "POST",
      body: { email: "admin@hemas.com", password: hemasPass },
    });
    assert(
      "Newly approved company admin can log in and receives tenant-scoped token",
      hemasLoginRes.status === 200 &&
        hemasLoginRes.data.user?.role === "company" &&
        hemasLoginRes.data.user?.tenantId === "tenant-hemas",
      JSON.stringify(hemasLoginRes.data),
    );

    // TEST 5: Live Agent Console - Go Online
    console.log("\n--- Test 5: Live Agent Console - Go Online ---");
    const agentLoginRes = await api("/api/auth/login", {
      method: "POST",
      body: { email: "agent01@slt.lk", password: agentPass },
    });
    agentToken = agentLoginRes.data.token || "";
    assert(
      "Live agent logs in and receives tenant-bound token",
      agentLoginRes.status === 200 &&
        agentLoginRes.data.user?.role === "live_agent" &&
        agentLoginRes.data.user?.tenantId === uiHandoffTenant,
      JSON.stringify(agentLoginRes.data),
    );

    const onlineRes = await api("/api/agent/presence/online", {
      method: "POST",
      token: agentToken,
      body: { connectionId: `conn-socket-${suffix}` },
    });
    assert(
      "POST /api/agent/presence/online sets status AVAILABLE",
      onlineRes.status === 200 &&
        onlineRes.data.status === "AVAILABLE" &&
        onlineRes.data.agentId === uiAgentId,
      JSON.stringify(onlineRes.data),
    );

    // TEST 6: Public Chat - Human Escalation Request
    console.log("\n--- Test 6: Public Chat - Human Escalation Request ---");
    const sessionId = `sess-web-customer-${suffix}`;
    const handoffRes = await api("/api/chat/handoff/request", {
      method: "POST",
      body: {
        tenantId: uiHandoffTenant,
        sessionId,
        reason: "Customer requested human specialist for fiber line issue",
        customerInfo: { name: "Nilantha Kumara" },
      },
    });
    assert(
      "POST /api/chat/handoff/request pairs customer with online agent",
      handoffRes.status === 200 &&
        handoffRes.data.assigned === true &&
        handoffRes.data.agentId === uiAgentId &&
        handoffRes.data.status === "HUMAN_ACTIVE",
      JSON.stringify(handoffRes.data),
    );

    // TEST 7: Live Agent Console - Resolve Session
    console.log("\n--- Test 7: Live Agent Console - Resolve Session ---");
    const resolveRes = await api("/api/chat/handoff/resolve", {
      method: "POST",
      token: agentToken,
      body: { sessionId },
    });
    assert(
      "POST /api/chat/handoff/resolve marks session RESOLVED",
      resolveRes.status === 200 && resolveRes.data.success === true,
      JSON.stringify(resolveRes.data),
    );

    // TEST 8: Knowledge Base Document Upload
    console.log("\n--- Test 8: Workspace Portal KB Document Upload ---");
    const sltCompanyLogin = await api("/api/auth/login", {
      method: "POST",
      body: { email: "admin@slt.lk", password: companyPass },
    });
    const sltCompanyToken = sltCompanyLogin.data.token || "";
    const uploadRes = await api("/api/workspace/upload-doc", {
      method: "POST",
      token: sltCompanyToken,
      body: {
        documentName: kbDocName,
        content: "Step 1: Check fiber LOS indicator. If red, dispatch field technician.",
      },
    });
    uploadedS3Key = uploadRes.data.s3Key || null;
    assert(
      "POST /api/workspace/upload-doc uploads document to tenant S3 prefix",
      uploadRes.status === 201 &&
        uploadRes.data.tenantId === "slt" &&
        uploadRes.data.s3Key === `tenants/slt/${kbDocName}`,
      JSON.stringify(uploadRes.data),
    );

    // TEST 9: Hosted Chat URL Resolver
    console.log("\n--- Test 9: Public Hosted Chat URL Resolver ---");
    const resolveUrlRes = await api("/api/resolve-chat-url?company=slt&agent=support");
    assert(
      "GET /api/resolve-chat-url returns dynamic company config and theme",
      resolveUrlRes.status === 200 &&
        resolveUrlRes.data.tenantId === "slt" &&
        resolveUrlRes.data.agentId !== undefined,
      JSON.stringify(resolveUrlRes.data),
    );

    // SUMMARY
    console.log("\n================================================================");
    console.log(`📊 UI Test Summary: ${passed} Passed, ${failed} Failed`);
    console.log("================================================================");
  } finally {
    if (baseUrl && agentToken) {
      await api("/api/agent/presence/offline", { method: "POST", token: agentToken, body: {} }).catch(() => {});
    }
    if (uploadedS3Key) {
      await s3Client.send(
        new DeleteObjectCommand({ Bucket: kbBucket, Key: uploadedS3Key }),
      ).catch(() => {});
    }
    if (server) {
      await new Promise<void>((resolve) => server!.close(() => resolve()));
    }
    fs.rmSync(tempDir, { recursive: true, force: true });
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
