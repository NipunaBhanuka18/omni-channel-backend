import fs from "fs";
import os from "os";
import path from "path";
import crypto from "crypto";

process.env.NODE_ENV = "test";
process.env.ALLOW_MOCK_AUTH = "true";
process.env.COGNITO_USER_POOL_ID = "mock-user-pool-id";

// Use isolated temporary database file to prevent mutating tracked db.json
const tempDbPath = path.join(
  os.tmpdir(),
  `omni-test-db-reg-${Date.now()}-${Math.random().toString(36).slice(2)}.json`
);
const realDbPath = path.join(__dirname, "..", "db.json");
const realDbSnapshotBefore = fs.readFileSync(realDbPath, "utf-8");
fs.writeFileSync(tempDbPath, realDbSnapshotBefore);
process.env.DB_PATH = tempDbPath;

import { app } from "../server";
import { handleOnboardingRequest } from "../services/onboarding/handler";
import { normalizeCompanyName } from "../shared/utils/tenant-name";
import { resolveTenantContext } from "../services/tenant-resolver/resolver";

async function runRegistrationWorkflowTests() {
  console.log("================================================================");
  console.log("📋 COMPANY REGISTRATION & APPROVAL WORKFLOW TEST SUITE");
  console.log("================================================================\n");

  const TEST_PORT = 3019;
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

  async function api(reqPath: string, options: { method?: string; body?: any; headers?: Record<string, string> } = {}) {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      ...(options.headers || {}),
    };
    const res = await fetch(`${baseUrl}${reqPath}`, {
      method: options.method || "GET",
      headers,
      body: options.body ? JSON.stringify(options.body) : undefined,
    });
    const json = await res.json().catch(() => ({}));
    return { status: res.status, data: json };
  }

  try {
    // -------------------------------------------------------------
    // Test 1: Invalid Registration Input Validation
    // -------------------------------------------------------------
    console.log("--- Test 1: Invalid Registration Input Validation ---");
    const emptyRes = await api("/api/registrations", {
      method: "POST",
      body: {},
    });
    assert(
      "POST /api/registrations rejects empty payload with 400 Bad Request",
      emptyRes.status === 400 && emptyRes.data.success === false && emptyRes.data.error.includes("companyName"),
      JSON.stringify(emptyRes.data)
    );

    const blankRes = await api("/api/registrations", {
      method: "POST",
      body: { companyName: "   " },
    });
    assert(
      "POST /api/registrations rejects whitespace-only companyName with 400 Bad Request",
      blankRes.status === 400 && blankRes.data.success === false,
      JSON.stringify(blankRes.data)
    );

    // -------------------------------------------------------------
    // Test 2: Successful Registration & Normalization
    // -------------------------------------------------------------
    console.log("\n--- Test 2: Successful Registration & Normalization ---");
    const validPayload = {
      companyName: "Apex Lanka Technologies",
      companySlug: "apex-lanka",
      companyEmail: "admin@apexlanka.lk",
      industry: "Telecommunications",
      tier: "Enterprise",
      allocatedAgents: 8,
      channels: ["Web", "WhatsApp"],
    };
    const regRes = await api("/api/registrations", {
      method: "POST",
      body: validPayload,
    });
    const reg = regRes.data.registration;
    assert(
      "POST /api/registrations creates pending registration with 201 Created",
      regRes.status === 201 && regRes.data.success === true && reg?.status === "Pending",
      JSON.stringify(regRes.data)
    );

    assert(
      "normalizeRegistration ensures backwards and forwards compatible field aliases",
      reg?.companyName === "Apex Lanka Technologies" &&
        reg?.name === "Apex Lanka Technologies" &&
        reg?.companyEmail === "admin@apexlanka.lk" &&
        reg?.email === "admin@apexlanka.lk" &&
        reg?.adminEmail === "admin@apexlanka.lk" &&
        reg?.industry === "Telecommunications" &&
        reg?.companyType === "Telecommunications" &&
        reg?.submissionDate !== undefined &&
        reg?.date === reg?.submissionDate &&
        reg?.requestedDate === reg?.submissionDate,
      JSON.stringify(reg)
    );
    const apexRegId = reg?.id;

    // -------------------------------------------------------------
    // Test 3: Duplicate Registration Rejection
    // -------------------------------------------------------------
    console.log("\n--- Test 3: Duplicate Pending Registration Rejection ---");
    const dupRes = await api("/api/registrations", {
      method: "POST",
      body: {
        companyName: "Apex Lanka Technologies",
        companyEmail: "other-admin@apexlanka.lk",
      },
    });
    assert(
      "POST /api/registrations rejects duplicate pending registration with 409 Conflict",
      dupRes.status === 409 && dupRes.data.success === false && dupRes.data.error.includes("Conflict"),
      JSON.stringify(dupRes.data)
    );

    // -------------------------------------------------------------
    // Test 4: Query Filter by Status (?status=pending / ?status=approved)
    // -------------------------------------------------------------
    console.log("\n--- Test 4: Status Query Filtering ---");
    const superAdminHeaders = { Authorization: "Bearer dev-token-superadmin" };
    const pendingListRes = await api("/api/registrations?status=pending", { headers: superAdminHeaders });
    assert(
      "GET /api/registrations?status=pending returns array containing pending registration",
      pendingListRes.status === 200 &&
        Array.isArray(pendingListRes.data) &&
        pendingListRes.data.some((r: any) => r.id === apexRegId && r.status === "Pending"),
      JSON.stringify(pendingListRes.data)
    );

    const approvedListRes = await api("/api/registrations?status=approved", { headers: superAdminHeaders });
    assert(
      "GET /api/registrations?status=approved excludes pending registration",
      approvedListRes.status === 200 &&
        Array.isArray(approvedListRes.data) &&
        !approvedListRes.data.some((r: any) => r.id === apexRegId),
      JSON.stringify(approvedListRes.data)
    );

    // -------------------------------------------------------------
    // Test 5: Admin Notifications Endpoint
    // -------------------------------------------------------------
    console.log("\n--- Test 5: Admin Notifications Endpoint ---");
    const notifRes = await api("/api/notifications", { headers: superAdminHeaders });
    assert(
      "GET /api/notifications returns 200 with pending registration alert and system health",
      notifRes.status === 200 &&
        notifRes.data.success === true &&
        Array.isArray(notifRes.data.notifications) &&
        notifRes.data.notifications.some((n: any) => n.id === `notif-reg-${apexRegId}`) &&
        notifRes.data.notifications.some((n: any) => n.id === "notif-system-1"),
      JSON.stringify(notifRes.data)
    );

    // -------------------------------------------------------------
    // Test 6: Company Rejection Workflow
    // -------------------------------------------------------------
    console.log("\n--- Test 6: Company Rejection Workflow ---");
    const spamRegRes = await api("/api/registrations", {
      method: "POST",
      body: {
        companyName: "Spam Inbound Corp",
        companyEmail: "spam@unverified.org",
      },
    });
    const spamId = spamRegRes.data.registration?.id;

    const rejectRes = await api(`/api/registrations/${spamId}`, {
      method: "PATCH",
      headers: superAdminHeaders,
      body: { status: "rejected" },
    });
    assert(
      "PATCH /api/registrations/:id sets status Rejected without auto-provisioning tenantId",
      rejectRes.status === 200 &&
        rejectRes.data.success === true &&
        rejectRes.data.registration?.status === "Rejected" &&
        rejectRes.data.registration?.tenantId === undefined,
      JSON.stringify(rejectRes.data)
    );

    // -------------------------------------------------------------
    // Test 7: Company Approval & Auto-Provisioning (PATCH & case-insensitivity)
    // -------------------------------------------------------------
    console.log("\n--- Test 7: Company Approval & Auto-Provisioning ---");
    const approveRes = await api(`/api/registrations/${apexRegId}`, {
      method: "PATCH",
      headers: superAdminHeaders,
      body: { status: "approved" },
    });
    assert(
      "PATCH /api/registrations/:id sets status Approved and provisions tenantId",
      approveRes.status === 200 &&
        approveRes.data.success === true &&
        approveRes.data.registration?.status === "Approved" &&
        typeof approveRes.data.registration?.tenantId === "string" &&
        approveRes.data.registration?.tenantId.startsWith("tenant-") &&
        approveRes.data.registration?.onboardedAt !== undefined,
      JSON.stringify(approveRes.data)
    );

    // -------------------------------------------------------------
    // Test 8: Backwards Compatibility Route Aliases (PUT /:id & PUT /:id/status)
    // -------------------------------------------------------------
    console.log("\n--- Test 8: Backwards Compatibility Route Aliases ---");
    const ceylonRegRes = await api("/api/registrations", {
      method: "POST",
      body: {
        companyName: "Ceylon Cloud Labs",
        companyEmail: "dev@ceyloncloud.lk",
      },
    });
    const ceylonId = ceylonRegRes.data.registration?.id;

    const putStatusRes = await api(`/api/registrations/${ceylonId}/status`, {
      method: "PUT",
      headers: superAdminHeaders,
      body: { status: "Approved" },
    });
    assert(
      "PUT /api/registrations/:id/status successfully approves and provisions tenant",
      putStatusRes.status === 200 &&
        putStatusRes.data.registration?.status === "Approved" &&
        putStatusRes.data.registration?.tenantId !== undefined,
      JSON.stringify(putStatusRes.data)
    );

    // -------------------------------------------------------------
    // Test 9: Non-Existent Registration Update Error Handling
    // -------------------------------------------------------------
    console.log("\n--- Test 9: Non-Existent Registration 404 ---");
    const missingRes = await api("/api/registrations/reg-non-existent-99999", {
      method: "PATCH",
      headers: superAdminHeaders,
      body: { status: "Approved" },
    });
    assert(
      "PATCH /api/registrations/:id returns 404 for unknown registration ID",
      missingRes.status === 404 && missingRes.data.success === false,
      JSON.stringify(missingRes.data)
    );

    // -------------------------------------------------------------
    // Test 10: Unauthorized Approval & Role Protection (services/onboarding/handler)
    // -------------------------------------------------------------
    console.log("\n--- Test 10: Unauthorized Approval & Role Protection ---");
    // Missing Authorization header
    const unauthOutcome = await handleOnboardingRequest({
      headers: {},
      body: { companyName: "Rogue Corp", tenantId: "rogue-corp", adminEmail: "rogue@corp.com" },
    });
    assert(
      "handleOnboardingRequest rejects request without Authorization header as UNAUTHORIZED",
      !unauthOutcome.success && unauthOutcome.error?.code === "UNAUTHORIZED",
      JSON.stringify(unauthOutcome)
    );

    // Non-staff caller (e.g. tenant admin attempting platform-level company onboarding)
    const tenantAdminToken =
      "mock." +
      Buffer.from(JSON.stringify({ "cognito:groups": ["admin"], "custom:tenant_id": "tenant-001" })).toString("base64") +
      ".mock";
    const forbiddenOutcome = await handleOnboardingRequest({
      headers: {
        authorization: `Bearer ${tenantAdminToken}`,
      },
      body: { companyName: "Unauthorized Branch", tenantId: "unauth-branch", adminEmail: "admin@branch.com" },
    });
    assert(
      "handleOnboardingRequest rejects non-staff caller as FORBIDDEN",
      !forbiddenOutcome.success && forbiddenOutcome.error?.code === "FORBIDDEN",
      JSON.stringify(forbiddenOutcome)
    );

    // -------------------------------------------------------------
    // Test 11: Production Pipeline Name Normalization Utility
    // -------------------------------------------------------------
    console.log("\n--- Test 11: Company Name Normalization Utility ---");
    const norm1 = normalizeCompanyName("  SLT   Mobitel   PLC  ");
    const norm2 = normalizeCompanyName("slt mobitel plc");
    assert(
      "normalizeCompanyName trims and collapses internal whitespace",
      norm1 === "slt mobitel plc" && norm1 === norm2,
      `norm1='${norm1}', norm2='${norm2}'`
    );

    // -------------------------------------------------------------
    // Test 12: Zero-Trust Tenant Isolation Guardrail
    // -------------------------------------------------------------
    console.log("\n--- Test 12: Zero-Trust Tenant Isolation Guardrail ---");
    // Header/token mismatch
    const mismatchOutcome = resolveTenantContext({
      authorization: `Bearer ${tenantAdminToken}`, // custom:tenant_id is "tenant-001"
      "x-tenant-id": "slt",
    });
    assert(
      "Tenant resolver rejects x-tenant-id / token mismatch with 403 TENANT_MISMATCH",
      !mismatchOutcome.success &&
        mismatchOutcome.error?.code === "FORBIDDEN" &&
        mismatchOutcome.error?.details?.reason === "TENANT_MISMATCH",
      JSON.stringify(mismatchOutcome)
    );

    // -------------------------------------------------------------
    // Test 13: Real Development Database Preservation Verification
    // -------------------------------------------------------------
    console.log("\n--- Test 13: Real Development Database Preservation ---");
    const realDbSnapshotAfter = fs.readFileSync(realDbPath, "utf-8");
    assert(
      "Real tracked db.json was NOT mutated during registration and approval workflow tests",
      realDbSnapshotBefore === realDbSnapshotAfter,
      `Length before: ${realDbSnapshotBefore.length}, Length after: ${realDbSnapshotAfter.length}`
    );
  } finally {
    // Graceful teardown
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });

    if (fs.existsSync(tempDbPath)) {
      try {
        fs.unlinkSync(tempDbPath);
      } catch {
        // ignore cleanup error
      }
    }
  }

  console.log(`\n================================================================`);
  console.log(`📊 Registration Workflow Summary: ${passed} Passed, ${failed} Failed`);
  console.log(`================================================================`);

  if (failed > 0) {
    process.exit(1);
  } else {
    process.exit(0);
  }
}

runRegistrationWorkflowTests().catch((err) => {
  console.error("Fatal workflow test runner error:", err);
  process.exit(1);
});
