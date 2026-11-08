/**
 * End-to-end integration test suite for Phase 3:
 * Single durable DynamoDB/S3 company registration, approval, tenant provisioning,
 * and hosted chat resolution against live LocalStack (no db.json / dbPath).
 */
import assert from "node:assert/strict";
import { AddressInfo } from "node:net";
import http from "node:http";
import { DeleteCommand, GetCommand } from "@aws-sdk/lib-dynamodb";
import {
  AdminCreateUserCommand,
  AdminAddUserToGroupCommand,
} from "@aws-sdk/client-cognito-identity-provider";
import { DeleteObjectCommand } from "@aws-sdk/client-s3";
import { createApp } from "../server";
import { docClient } from "../agents/utils/dynamo-client";
import { s3Client } from "../agents/utils/s3-client";
import { LocalSessionTokenService } from "../services/auth/local-session-token";
import { provisionPendingCompanyApproval } from "../services/onboarding/approval-workflow";
import { onboardCompany, OnboardingDeps } from "../services/onboarding/onboarding";
import { ensurePlatformTables, ensureBaselineSeeds } from "./create-tenants-table";

async function reqJson(
  baseUrl: string,
  route: string,
  opts: {
    method?: string;
    token?: string;
    headers?: Record<string, string>;
    body?: unknown;
  } = {}
) {
  const headers: Record<string, string> = { ...(opts.headers || {}) };
  if (opts.token) headers.Authorization = `Bearer ${opts.token}`;
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
  return { status: res.status, headers: res.headers, data };
}

async function main(): Promise<void> {
  process.env.NODE_ENV = "test";
  process.env.IS_LOCAL = "true";

  console.log("================================================================");
  console.log("🚀 PHASE 3: UNIFIED DYNAMODB/S3/COGNITO ONBOARDING SUITE");
  console.log("================================================================\n");

  let passed = 0;
  const pass = (label: string) => {
    console.log(`PASS: ${label}`);
    passed++;
  };

  const suffix = Date.now().toString().slice(-5);
  const companySlug = `unify-${suffix}`;
  const companyName = `Unified Telecom ${suffix}`;
  const adminEmail = `admin@unify-${suffix}.lk`;
  const expectedTenantId = `tenant-${companySlug}`;
  const kbBucket = process.env.KB_BUCKET_NAME || "omni-channel-kb-docs";

  let server: http.Server | null = null;
  let createdRegId: string | null = null;

  try {
    // 0. Ensure tables and baseline rows in LocalStack
    await ensurePlatformTables();
    await ensureBaselineSeeds();

    const tokenService = new LocalSessionTokenService({
      secret: "test-secret-key-32bytes-minimum-length!",
    });
    const superToken = tokenService.issueToken({
      sub: "super-platform-admin",
      email: "superadmin@slt.lk",
      name: "Platform SuperAdmin",
      role: "superadmin",
    });

    // Mock Cognito for LocalStack Community while using real LocalStack DynamoDB + S3
    const liveOnboardingDeps: OnboardingDeps = {
      dynamo: docClient,
      cognito: {
        send: async (cmd: any) => {
          if (
            cmd instanceof AdminCreateUserCommand ||
            cmd instanceof AdminAddUserToGroupCommand
          ) {
            return {};
          }
          return {};
        },
      } as any,
      s3: s3Client,
      userPoolId: "localstack-unified-user-pool-id",
    };

    // Default createApp() WITHOUT options.dbPath -> uses DynamoRegistrationRepository!
    const app = createApp({
      tokenService,
      approvePendingRegistration: (reg) =>
        provisionPendingCompanyApproval(reg, (req) => onboardCompany(req, liveOnboardingDeps)),
    });

    server = await new Promise<http.Server>((resolve) => {
      const s = app.listen(0, "127.0.0.1", () => resolve(s));
    });
    const port = (server.address() as AddressInfo).port;
    const baseUrl = `http://127.0.0.1:${port}`;

    // STEP 1: Prospective company registration via public POST /api/registrations
    console.log("--- Step 1: Company Registration Submission ---");
    const regRes = await reqJson(baseUrl, "/api/registrations", {
      method: "POST",
      body: {
        companyName,
        companySlug,
        companyEmail: adminEmail,
        password: "TemporaryPassword#2026!",
        tier: "Enterprise",
        themeColor: "#0070BA",
        channels: ["Web", "WhatsApp"],
      },
    });
    assert.equal(regRes.status, 201, `Expected 201, got ${regRes.status}: ${JSON.stringify(regRes.data)}`);
    assert.equal(regRes.data.success, true);
    assert.equal(regRes.data.registration?.status, "Pending");
    assert.equal(regRes.data.registration?.companySlug, companySlug);
    assert.equal(regRes.data.registration?.tenantId, undefined);
    assert.equal("password" in regRes.data.registration, false);
    assert.equal("passwordHash" in regRes.data.registration, false);
    createdRegId = regRes.data.registration.id;
    pass("POST /api/registrations writes pending record to DynamoDB omni-channel-registrations");

    // STEP 2: Duplicate registration rejection
    console.log("\n--- Step 2: Duplicate Registration Protection ---");
    const dupRes = await reqJson(baseUrl, "/api/registrations", {
      method: "POST",
      body: {
        companyName: `   ${companyName.toUpperCase()}   `,
        companySlug: `${companySlug}-dup`,
        companyEmail: `other@unify-${suffix}.lk`,
        password: "TemporaryPassword#2026!",
      },
    });
    assert.equal(dupRes.status, 409, `Expected 409 duplicate conflict, got ${dupRes.status}`);
    pass("Duplicate company name (case-insensitive) rejected with 409 Conflict");

    // STEP 3: Super Admin reviews pending list via GET /api/registrations
    console.log("\n--- Step 3: Super Admin Registration Listing ---");
    const unauthList = await reqJson(baseUrl, "/api/registrations");
    assert.equal(unauthList.status, 401);

    const pendingListRes = await reqJson(baseUrl, "/api/registrations?status=pending", {
      token: superToken,
    });
    assert.equal(pendingListRes.status, 200);
    assert.ok(Array.isArray(pendingListRes.data));
    const foundPending = pendingListRes.data.find((r: any) => r.id === createdRegId);
    assert.ok(foundPending, "Pending registration must be present in DynamoDB list");
    assert.equal("passwordHash" in foundPending, false);
    pass("GET /api/registrations queries DynamoDB StatusIndex and redacts credentials");

    // STEP 4: Super Admin approves registration via PUT /api/registrations/:id/status
    console.log("\n--- Step 4: Super Admin Approval & Full Resource Provisioning ---");
    const approveRes = await reqJson(baseUrl, `/api/registrations/${createdRegId}/status`, {
      method: "PUT",
      token: superToken,
      body: { status: "Approved" },
    });
    assert.equal(approveRes.status, 200, `Expected 200, got ${approveRes.status}: ${JSON.stringify(approveRes.data)}`);
    assert.equal(approveRes.data.success, true);
    assert.equal(approveRes.data.registration?.status, "Approved");
    assert.equal(approveRes.data.registration?.tenantId, expectedTenantId);
    assert.ok(approveRes.data.credentials?.temporaryPassword, "One-time credential returned");
    pass("Super Admin approval transitions record to Approved and provisions tenantId");

    // Verify DynamoDB omni-channel-tenants item was created
    const tenantInDb = await docClient.send(
      new GetCommand({
        TableName: "omni-channel-tenants",
        Key: { tenantId: expectedTenantId },
      })
    );
    assert.ok(tenantInDb.Item, "Tenant item must exist in omni-channel-tenants");
    assert.equal(tenantInDb.Item.status, "active");
    assert.equal(tenantInDb.Item.themeColor, "#0070BA");
    pass("Tenant item written to omni-channel-tenants with active status and configuration");

    // Verify DynamoDB omni-channel-agents item was created
    const agentInDb = await docClient.send(
      new GetCommand({
        TableName: "omni-channel-agents",
        Key: { tenantId: expectedTenantId, agentId: "main-agent" },
      })
    );
    assert.ok(agentInDb.Item, "Default agent item must exist in omni-channel-agents");
    assert.equal(agentInDb.Item.publicAgentKey, "support");
    assert.equal(agentInDb.Item.status, "active");
    pass("Default agent item written to omni-channel-agents with publicAgentKey 'support'");

    // STEP 5: Duplicate approval rejection
    console.log("\n--- Step 5: Duplicate Approval Rejection ---");
    const dupApproveRes = await reqJson(baseUrl, `/api/registrations/${createdRegId}/status`, {
      method: "PUT",
      token: superToken,
      body: { status: "Approved" },
    });
    assert.equal(dupApproveRes.status, 409);
    pass("Already approved registration rejects duplicate approval with 409");

    // STEP 6: Platform statistics via GET /api/stats
    console.log("\n--- Step 6: Platform Statistics Dashboard ---");
    const statsRes = await reqJson(baseUrl, "/api/stats", { token: superToken });
    assert.equal(statsRes.status, 200);
    assert.ok(statsRes.data.totalAvailability >= 3, "Total availability includes baseline + new tenant");
    assert.ok(typeof statsRes.data.pendingRequests === "number");
    assert.ok(typeof statsRes.data.activeAgentsCount === "number");
    assert.ok(typeof statsRes.data.systemLatencyMs === "number" && statsRes.data.systemLatencyMs >= 1);
    pass("GET /api/stats computes real metrics from DynamoDB tables with latency measurement");

    // STEP 7: Hosted Chat URL Resolver for newly approved company
    console.log("\n--- Step 7: Dynamic Hosted Chat URL Resolution ---");
    const chatResolverRes = await reqJson(
      baseUrl,
      `/api/resolve-chat-url?company=${companySlug}&agent=support`
    );
    assert.equal(chatResolverRes.status, 200);
    assert.equal(chatResolverRes.data.tenantId, expectedTenantId);
    assert.equal(chatResolverRes.data.companyName, companyName);
    assert.equal(chatResolverRes.data.agentId, "main-agent");
    assert.equal(chatResolverRes.data.themeColor, "#0070BA");
    pass("GET /api/resolve-chat-url dynamically resolves newly approved company chatbot from DynamoDB");

    console.log("\n================================================================");
    console.log(`📊 Unified Onboarding Test Summary: ${passed} Passed, 0 Failed`);
    console.log("================================================================\n");
  } finally {
    if (server) {
      await new Promise<void>((resolve) => server!.close(() => resolve()));
    }
    // Cleanup created tenant resources from LocalStack
    if (createdRegId) {
      await docClient
        .send(
          new DeleteCommand({
            TableName: "omni-channel-registrations",
            Key: { id: createdRegId },
          })
        )
        .catch(() => {});
    }
    await docClient
      .send(
        new DeleteCommand({
          TableName: "omni-channel-tenants",
          Key: { tenantId: expectedTenantId },
        })
      )
      .catch(() => {});
    await docClient
      .send(
        new DeleteCommand({
          TableName: "omni-channel-agents",
          Key: { tenantId: expectedTenantId, agentId: "main-agent" },
        })
      )
      .catch(() => {});
    await s3Client
      .send(
        new DeleteObjectCommand({
          Bucket: kbBucket,
          Key: `tenants/${expectedTenantId}/.kb-prefix`,
        })
      )
      .catch(() => {});
  }
}

main().catch((err) => {
  console.error("Fatal unified onboarding test error:", err);
  process.exitCode = 1;
});

