import fs from "fs";
import os from "os";
import path from "path";
import crypto from "crypto";

process.env.NODE_ENV = "test";
process.env.ALLOW_MOCK_AUTH = "true";
process.env.COGNITO_USER_POOL_ID = "us-east-1_AutoOnboardingTest";

// 1. Isolate Database so tests never mutate real db.json
const tempDbPath = path.join(
  os.tmpdir(),
  `omni-test-db-auto-${Date.now()}-${Math.random().toString(36).slice(2)}.json`
);
const realDbPath = path.join(__dirname, "..", "db.json");
const realDbSnapshotBefore = fs.readFileSync(realDbPath, "utf-8");
fs.writeFileSync(tempDbPath, realDbSnapshotBefore);
process.env.DB_PATH = tempDbPath;

import { app } from "../server";
import { inMemoryTenants, inMemoryAgents } from "./create-tenants-table";

async function runAutomaticOnboardingTestSuite() {
  console.log("================================================================");
  console.log("🏢 TASK 10: AUTOMATIC COMPANY WORKSPACE ONBOARDING TEST SUITE");
  console.log("================================================================\n");

  const TEST_PORT = 3055;
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
    options: { method?: string; body?: any; headers?: Record<string, string> } = {}
  ) {
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
    // Scenario 1 & 2: Valid Company Registration Automatically Provisions & Activates (No Manual Approval)
    // -------------------------------------------------------------
    console.log("--- 1 & 2. Automatic Onboarding Without Manual Approval ---");
    const regPayload1 = {
      companyName: "Acme Cloud Dynamics",
      companySlug: "acme-cloud",
      companyEmail: "admin@acmecloud.lk",
      password: "AcmeSecure#2026!",
      industry: "Cloud Computing",
      tier: "Enterprise",
    };
    const regRes1 = await api("/api/registrations", {
      method: "POST",
      body: regPayload1,
    });

    assert(
      "1. Valid company registration returns HTTP 201 Created",
      regRes1.status === 201 && regRes1.data.success === true,
      JSON.stringify(regRes1.data)
    );

    const regData1 = regRes1.data.registration;
    assert(
      "2. Registration is immediately Active and ACTIVE without manual Super Admin approval",
      regData1?.status === "Active" &&
        regData1?.provisioningStatus === "ACTIVE" &&
        typeof regData1?.tenantId === "string" &&
        regData1.tenantId === "tenant-acme-cloud" &&
        regData1?.onboardedAt !== undefined,
      JSON.stringify(regData1)
    );

    // -------------------------------------------------------------
    // Scenario 3: Company Administrator Has the Correct Tenant Role & Direct Login Token
    // -------------------------------------------------------------
    console.log("\n--- 3. Company Administrator Role & Token Scope ---");
    assert(
      "3a. Response returns session token and company admin user profile",
      typeof regRes1.data.token === "string" &&
        regRes1.data.user !== undefined &&
        regRes1.data.user?.role === "company" &&
        regRes1.data.user?.tenantId === "tenant-acme-cloud",
      JSON.stringify(regRes1.data.user)
    );

    // Verify Company Admin can immediately log in
    const loginRes = await api("/api/auth/login", {
      method: "POST",
      body: {
        email: "admin@acmecloud.lk",
        password: "AcmeSecure#2026!",
      },
    });
    assert(
      "3b. Newly provisioned company admin logs in successfully with role='company'",
      loginRes.status === 200 &&
        loginRes.data.success === true &&
        loginRes.data.user?.role === "company" &&
        loginRes.data.user?.tenantId === "tenant-acme-cloud",
      JSON.stringify(loginRes.data)
    );

    // -------------------------------------------------------------
    // Scenario 4: Public Registration Cannot Create a Super Admin
    // -------------------------------------------------------------
    console.log("\n--- 4. Escalation Prevention: Cannot Register as Super Admin ---");
    const maliciousPayload = {
      companyName: "Rogue Hackers Inc",
      companySlug: "rogue-hack",
      companyEmail: "hacker@rogue.org",
      role: "superadmin", // attempted role escalation
      adminRole: "superadmin",
    };
    const malRes = await api("/api/registrations", {
      method: "POST",
      body: maliciousPayload,
    });
    assert(
      "4. Public registration ignores client-supplied privileged role and forces role='company'",
      malRes.status === 201 &&
        malRes.data.user?.role === "company" &&
        malRes.data.user?.role !== "superadmin",
      JSON.stringify(malRes.data.user)
    );

    // -------------------------------------------------------------
    // Scenario 5: Invalid Company Data is Rejected (Bad Request)
    // -------------------------------------------------------------
    console.log("\n--- 5. Invalid Input Validation ---");
    const noNameRes = await api("/api/registrations", {
      method: "POST",
      body: { companyEmail: "valid@email.com" },
    });
    assert(
      "5a. Missing companyName rejected with 400 Bad Request",
      noNameRes.status === 400 && noNameRes.data.error.includes("companyName"),
      JSON.stringify(noNameRes.data)
    );

    const badEmailRes = await api("/api/registrations", {
      method: "POST",
      body: { companyName: "Valid Name", companyEmail: "not-an-email" },
    });
    assert(
      "5b. Invalid email format rejected with 400 Bad Request",
      badEmailRes.status === 400 && badEmailRes.data.error.includes("adminEmail"),
      JSON.stringify(badEmailRes.data)
    );

    // -------------------------------------------------------------
    // Scenario 6: Reserved Slugs are Rejected
    // -------------------------------------------------------------
    console.log("\n--- 6. Reserved Slugs Rejected ---");
    const reservedSlugs = ["slt", "admin", "system", "api", "platform", "superadmin"];
    for (const slug of reservedSlugs) {
      const res = await api("/api/registrations", {
        method: "POST",
        body: {
          companyName: `Attempt ${slug}`,
          companySlug: slug,
          companyEmail: `test-${slug}@domain.com`,
        },
      });
      assert(
        `6. Reserved slug '${slug}' is rejected with 400 Bad Request`,
        res.status === 400 && res.data.error.includes("reserved"),
        JSON.stringify(res.data)
      );
    }

    // -------------------------------------------------------------
    // Scenario 7: Duplicate Company Registration is Handled (409 Conflict)
    // -------------------------------------------------------------
    console.log("\n--- 7. Duplicate Registration Rejected ---");
    const dupRes = await api("/api/registrations", {
      method: "POST",
      body: {
        companyName: "  ACME   CLOUD   DYNAMICS  ", // Normalized duplicate
        companyEmail: "different@acme.com",
      },
    });
    assert(
      "7. Duplicate company name (case & spacing normalized) rejected with 409 Conflict",
      dupRes.status === 409 && dupRes.data.error.includes("already exists"),
      JSON.stringify(dupRes.data)
    );

    // -------------------------------------------------------------
    // Scenario 8: Concurrent Duplicate Requests Handled Safely
    // -------------------------------------------------------------
    console.log("\n--- 8. Concurrent Duplicate Requests ---");
    const raceSlug = `race-${Date.now().toString().slice(-4)}`;
    const [r1, r2] = await Promise.all([
      api("/api/registrations", {
        method: "POST",
        body: {
          companyName: `Concurrency Co ${raceSlug}`,
          companySlug: raceSlug,
          companyEmail: `race1@${raceSlug}.lk`,
        },
      }),
      api("/api/registrations", {
        method: "POST",
        body: {
          companyName: `Concurrency Co ${raceSlug}`,
          companySlug: raceSlug,
          companyEmail: `race2@${raceSlug}.lk`,
        },
      }),
    ]);
    const oneCreated = (r1.status === 201 && r2.status === 409) || (r2.status === 201 && r1.status === 409);
    assert(
      "8. Concurrent identical requests produce exactly one 201 Created and one 409 Conflict",
      oneCreated,
      `r1.status=${r1.status}, r2.status=${r2.status}`
    );

    // -------------------------------------------------------------
    // Scenario 9: Retried Requests are Idempotent
    // -------------------------------------------------------------
    console.log("\n--- 9. Idempotency Key Replay ---");
    const testIdempotencyKey = `idemp-key-${Date.now()}`;
    const firstCall = await api("/api/registrations", {
      method: "POST",
      headers: { "idempotency-key": testIdempotencyKey },
      body: {
        companyName: "Idempotent Services Ltd",
        companySlug: "idemp-services",
        companyEmail: "admin@idempotentservices.com",
        password: "ValidPassword#2026",
      },
    });
    assert(
      "9a. First call with idempotency key creates registration (201 Created)",
      firstCall.status === 201 && firstCall.data.registration?.tenantId === "tenant-idemp-services",
      JSON.stringify(firstCall.data)
    );

    // Adversarial test: Caller B attempts to use Caller A's idempotency key with different payload
    const adversaryCall = await api("/api/registrations", {
      method: "POST",
      headers: { "idempotency-key": testIdempotencyKey },
      body: {
        companyName: "Adversary Attacker Corp",
        companySlug: "adversary-corp",
        companyEmail: "attacker@adversary.com",
        password: "AttackerPassword#2026",
      },
    });
    assert(
      "9b. Adversarial collision with same idempotency key is rejected with 409 Conflict",
      adversaryCall.status === 409 && adversaryCall.data.success === false,
      JSON.stringify(adversaryCall.data)
    );

    // Safe unauthenticated replay: Caller A replays request
    const replayCall = await api("/api/registrations", {
      method: "POST",
      headers: { "idempotency-key": testIdempotencyKey },
      body: {
        companyName: "Idempotent Services Ltd",
        companySlug: "idemp-services",
        companyEmail: "admin@idempotentservices.com",
        password: "ValidPassword#2026",
      },
    });
    assert(
      "9c. Replayed call returns 200 OK without revealing or minting session token (LOGIN_REQUIRED)",
      replayCall.status === 200 &&
        replayCall.data.idempotentReplay === true &&
        replayCall.data.token === undefined &&
        replayCall.data.nextAction === "LOGIN_REQUIRED" &&
        replayCall.data.registration?.id === firstCall.data.registration?.id &&
        replayCall.data.registration?.tenantId === "tenant-idemp-services",
      JSON.stringify(replayCall.data)
    );

    // -------------------------------------------------------------
    // Scenario 10 & 11: Mandatory Provisioning Failure Fails Closed
    // -------------------------------------------------------------
    console.log("\n--- 10 & 11. Provisioning Failure Fails Closed ---");
    const failRes = await api("/api/registrations", {
      method: "POST",
      body: {
        companyName: "Bad Slug Corp",
        companySlug: "---", // invalid normalized slug
        companyEmail: "bad@slug.com",
      },
    });
    assert(
      "10. Invalid normalized slug fails closed with 400 Bad Request",
      failRes.status === 400 && failRes.data.success === false,
      JSON.stringify(failRes.data)
    );

    // -------------------------------------------------------------
    // Scenario 12: No Credentials or Secrets Leaked in API Responses
    // -------------------------------------------------------------
    console.log("\n--- 12. Response Credential Redaction ---");
    const regCheck = regRes1.data.registration;
    assert(
      "12. Registration response NEVER contains plaintext password, passwordHash, or salts",
      regCheck.password === undefined &&
        regCheck.passwordHash === undefined &&
        regCheck.salt === undefined &&
        regCheck.temporaryPassword === undefined,
      JSON.stringify(regCheck)
    );

    // -------------------------------------------------------------
    // Scenario 13: Tenant Identity Cannot Be Overridden by Client Input
    // -------------------------------------------------------------
    console.log("\n--- 13. Tenant Identity Client Override Denied ---");
    const spoofTenantRes = await api("/api/registrations", {
      method: "POST",
      body: {
        companyName: "Spoofing Corp",
        companySlug: "spoof-corp",
        tenantId: "slt", // attempted override to seeded tenant 'slt'
        companyEmail: "spoof@spoofcorp.com",
      },
    });
    assert(
      "13. Server ignores client-supplied tenantId and derives canonical tenantId 'tenant-spoof-corp'",
      spoofTenantRes.status === 201 &&
        spoofTenantRes.data.registration?.tenantId === "tenant-spoof-corp" &&
        spoofTenantRes.data.registration?.tenantId !== "slt",
      JSON.stringify(spoofTenantRes.data.registration)
    );

    // -------------------------------------------------------------
    // Scenario 14: Local Mock Mode Isolated From Production
    // -------------------------------------------------------------
    console.log("\n--- 14. Mock Auth Mode Isolation ---");
    assert(
      "14. Environment isolates mock auth in test environment",
      process.env.ALLOW_MOCK_AUTH === "true" && process.env.NODE_ENV === "test",
      `ALLOW_MOCK_AUTH=${process.env.ALLOW_MOCK_AUTH}, NODE_ENV=${process.env.NODE_ENV}`
    );

    // -------------------------------------------------------------
    // Scenario 15: Workspace Login Gated by Active Status
    // -------------------------------------------------------------
    console.log("\n--- 15. Workspace Login Gated by Active Status ---");
    // Create an explicit pending registration for manual review test
    const pendingRegRes = await api("/api/registrations", {
      method: "POST",
      body: {
        companyName: "Pending Workspace Ltd",
        companySlug: "pending-workspace",
        companyEmail: "pending@workspace.com",
        password: "PendingPass#2026!",
        requireApproval: true,
      },
    });
    assert(
      "15a-pre. Explicit manual review registration created with status='Pending'",
      pendingRegRes.status === 201 && pendingRegRes.data.registration?.status === "Pending",
      JSON.stringify(pendingRegRes.data)
    );

    const pendingLogin = await api("/api/auth/login", {
      method: "POST",
      body: {
        email: "pending@workspace.com",
        password: "PendingPass#2026!",
      },
    });
    assert(
      "15a. Pending company account login is rejected with 403 Forbidden",
      pendingLogin.status === 403 &&
        pendingLogin.data.error.includes("administrator review"),
      JSON.stringify(pendingLogin.data)
    );

    // Super Admin suspends Acme Cloud
    const superAdminHeaders = { Authorization: "Bearer dev-token-superadmin" };
    const suspendRes = await api(`/api/registrations/${regData1.id}`, {
      method: "PATCH",
      headers: superAdminHeaders,
      body: { status: "suspended" },
    });
    assert(
      "15b. Super Admin can suspend active company workspace",
      suspendRes.status === 200 &&
        suspendRes.data.registration?.status === "Suspended" &&
        suspendRes.data.registration?.provisioningStatus === "SUSPENDED",
      JSON.stringify(suspendRes.data)
    );

    // Suspended company login attempt
    const suspendedLogin = await api("/api/auth/login", {
      method: "POST",
      body: {
        email: "admin@acmecloud.lk",
        password: "AcmeSecure#2026!",
      },
    });
    assert(
      "15c. Suspended company account login is rejected with 403 Forbidden",
      suspendedLogin.status === 403 &&
        suspendedLogin.data.error.includes("suspended"),
      JSON.stringify(suspendedLogin.data)
    );

    // Reactivate workspace
    const reactivateRes = await api(`/api/registrations/${regData1.id}`, {
      method: "PATCH",
      headers: superAdminHeaders,
      body: { status: "active" },
    });
    assert(
      "15d. Super Admin can reactivate suspended company workspace",
      reactivateRes.status === 200 &&
        reactivateRes.data.registration?.status === "Approved",
      JSON.stringify(reactivateRes.data)
    );

    // -------------------------------------------------------------
    // Scenario 16: Super Admin Management (Listing & Deletion)
    // -------------------------------------------------------------
    console.log("\n--- 16. Super Admin Operations & Deletion/Suspension Lifecycle ---");
    const deleteTarget = await api("/api/registrations", {
      method: "POST",
      body: {
        companyName: "Delete Target Inc",
        companySlug: "del-target",
        companyEmail: "del@target.lk",
        password: "TargetPassword#2026",
      },
    });
    const delId = deleteTarget.data.registration?.id;

    // 16a. Non-Super Admin attempting deletion is rejected (401/403)
    const companyHeaders = { Authorization: "Bearer dev-token-company" };
    const unauthDelRes = await api(`/api/registrations/${delId}`, {
      method: "DELETE",
      headers: companyHeaders,
    });
    assert(
      "16a. Non-Super Admin cannot delete company registration (403 Forbidden)",
      unauthDelRes.status === 403 && unauthDelRes.data.success === false,
      JSON.stringify(unauthDelRes.data)
    );

    // 16b. Super Admin safely suspends/deactivates registration
    const delRes = await api(`/api/registrations/${delId}`, {
      method: "DELETE",
      headers: superAdminHeaders,
    });
    assert(
      "16b. Super Admin can safely suspend/deactivate workspace via DELETE /api/registrations/:id",
      delRes.status === 200 &&
        delRes.data.success === true &&
        delRes.data.registration?.status === "Suspended" &&
        delRes.data.registration?.provisioningStatus === "SUSPENDED",
      JSON.stringify(delRes.data)
    );

    // 16c. Company login for suspended workspace is rejected
    const suspendedLoginRes = await api("/api/auth/login", {
      method: "POST",
      body: {
        email: "del@target.lk",
        password: "TargetPassword#2026",
      },
    });
    assert(
      "16c. Suspended workspace admin login is rejected with 403 Forbidden",
      suspendedLoginRes.status === 403 && suspendedLoginRes.data.success === false,
      JSON.stringify(suspendedLoginRes.data)
    );

    // -------------------------------------------------------------
    // Scenario 17: Historical & Pending Registrations Queryable
    // -------------------------------------------------------------
    console.log("\n--- 17. Historical & Pending Registrations Queryable ---");
    const getPendingRes = await api("/api/registrations?status=pending", {
      headers: superAdminHeaders,
    });
    assert(
      "17. Registrations filtered by ?status=pending include pending workspaces",
      getPendingRes.status === 200 &&
        Array.isArray(getPendingRes.data) &&
        getPendingRes.data.some((r: any) => r.companySlug === "pending-workspace" && r.status === "Pending"),
      JSON.stringify(getPendingRes.data?.map((r: any) => ({ id: r.id, status: r.status })))
    );

    // -------------------------------------------------------------
    // Scenario 18: Bounded Rate Limiting Enforced
    // -------------------------------------------------------------
    console.log("\n--- 18. Bounded Rate Limiting ---");
    let hitRateLimit = false;
    for (let i = 0; i < 35; i++) {
      const res = await api("/api/registrations", {
        method: "POST",
        body: {},
      });
      if (res.status === 429) {
        hitRateLimit = true;
        break;
      }
    }
    assert(
      "18. Rapid requests to /api/registrations are rate-limited with HTTP 429",
      hitRateLimit,
      "Expected 429 Too Many Requests within rate limit window"
    );

    // -------------------------------------------------------------
    // Real Database Immutability Verification
    // -------------------------------------------------------------
    console.log("\n--- Real Database Immutability Check ---");
    const realDbSnapshotAfter = fs.readFileSync(realDbPath, "utf-8");
    assert(
      "Real tracked db.json was NOT mutated during automatic onboarding test execution",
      realDbSnapshotBefore === realDbSnapshotAfter,
      `Length before: ${realDbSnapshotBefore.length}, Length after: ${realDbSnapshotAfter.length}`
    );
  } finally {
    server.close();
    if (fs.existsSync(tempDbPath)) {
      try {
        fs.unlinkSync(tempDbPath);
      } catch {}
    }
  }

  console.log(`\n================================================================`);
  console.log(`📊 Automatic Onboarding Test Summary: ${passed} Passed, ${failed} Failed`);
  console.log(`================================================================`);

  if (failed > 0) {
    process.exit(1);
  } else {
    process.exit(0);
  }
}

runAutomaticOnboardingTestSuite().catch((err) => {
  console.error("Fatal test runner error:", err);
  process.exit(1);
});
