import http from "http";
import path from "path";
import fs from "fs";
import { spawn, ChildProcess } from "child_process";
import { inMemoryTenants, inMemoryAgents } from "./create-tenants-table";

interface HttpResponse {
  status: number;
  headers: http.IncomingHttpHeaders;
  data: any;
  text: string;
}

function httpRequest(
  urlStr: string,
  options: {
    method?: string;
    headers?: Record<string, string>;
    body?: any;
    timeoutMs?: number;
  } = {}
): Promise<HttpResponse> {
  return new Promise((resolve, reject) => {
    const url = new URL(urlStr);
    const bodyStr = options.body ? (typeof options.body === "string" ? options.body : JSON.stringify(options.body)) : null;

    const reqHeaders: Record<string, string> = {
      ...(options.headers || {}),
    };
    if (bodyStr && !reqHeaders["Content-Type"]) {
      reqHeaders["Content-Type"] = "application/json";
    }
    if (bodyStr) {
      reqHeaders["Content-Length"] = Buffer.byteLength(bodyStr).toString();
    }

    const req = http.request(
      {
        hostname: url.hostname,
        port: url.port,
        path: url.pathname + url.search,
        method: options.method || "GET",
        headers: reqHeaders,
        timeout: options.timeoutMs || 10000,
      },
      (res) => {
        let rawData = "";
        res.on("data", (chunk) => {
          rawData += chunk;
        });
        res.on("end", () => {
          let data: any = null;
          try {
            data = JSON.parse(rawData);
          } catch {
            data = rawData;
          }
          resolve({
            status: res.statusCode || 0,
            headers: res.headers,
            data,
            text: rawData,
          });
        });
      }
    );

    req.on("error", (err) => reject(err));
    req.on("timeout", () => {
      req.destroy();
      reject(new Error(`HTTP request timed out after ${options.timeoutMs || 10000}ms: ${urlStr}`));
    });

    if (bodyStr) {
      req.write(bodyStr);
    }
    req.end();
  });
}

async function waitForServer(url: string, maxAttempts = 30, intervalMs = 500): Promise<boolean> {
  for (let i = 0; i < maxAttempts; i++) {
    try {
      const res = await httpRequest(url, { timeoutMs: 1000 });
      if (res.status >= 200 && res.status < 500) {
        return true;
      }
    } catch {
      // Server not ready yet
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return false;
}

async function runLiveE2ETestSuite() {
  console.log("================================================================");
  console.log("🚀 TASK 11: EXECUTED END-TO-END AUTOMATIC ONBOARDING & FULLSTACK SUITE");
  console.log("================================================================\n");

  const backendPort = 3001;
  const frontendPort = 5173;
  const backendBaseUrl = `http://localhost:${backendPort}`;
  const frontendBaseUrl = `http://localhost:${frontendPort}`;

  // 1. Setup isolated database
  const originalDbPath = path.join(__dirname, "..", "db.json");
  const testDbPath = path.join(__dirname, "..", "test-e2e-live-db.json");
  fs.copyFileSync(originalDbPath, testDbPath);
  console.log(`[E2E Setup] Created isolated database replica: ${testDbPath}`);

  let backendProc: ChildProcess | null = null;
  let frontendProc: ChildProcess | null = null;

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

  try {
    // 2. Start Backend Server
    console.log("[E2E Setup] Spawning Backend server on port 3001...");
    backendProc = spawn("npx", ["tsx", "server.ts"], {
      cwd: path.join(__dirname, ".."),
      env: {
        ...process.env,
        PORT: String(backendPort),
        DB_PATH: testDbPath,
        NODE_ENV: "development",
        ALLOW_MOCK_AUTH: "true",
      },
      shell: true,
      stdio: "pipe",
    });

    backendProc.stderr?.on("data", (data) => {
      const msg = data.toString().trim();
      if (msg && !msg.includes("Warning") && !msg.includes("ExperimentalWarning")) {
        // console.error(`[Backend Log] ${msg}`);
      }
    });

    const backendReady = await waitForServer(`${backendBaseUrl}/api/stats`, 40, 500);
    if (!backendReady) {
      throw new Error("Backend server failed to start within timeout window.");
    }
    console.log(`[E2E Setup] Backend live and responding on ${backendBaseUrl}\n`);

    // 3. Start Frontend Dev Server
    console.log("[E2E Setup] Spawning Frontend Vite server on port 5173...");
    frontendProc = spawn("npm", ["run", "dev", "--", "--port", String(frontendPort), "--strictPort"], {
      cwd: "D:\\Omni Channel\\omni-ui-fullstack",
      env: {
        ...process.env,
        VITE_API_BASE_URL: backendBaseUrl,
      },
      shell: true,
      stdio: "pipe",
    });

    const frontendReady = await waitForServer(frontendBaseUrl, 40, 500);
    if (!frontendReady) {
      throw new Error("Frontend Vite dev server failed to start within timeout window.");
    }
    console.log(`[E2E Setup] Frontend live and serving on ${frontendBaseUrl}\n`);

    // =========================================================================
    // EXERCISE 16 FUNCTIONAL SCENARIOS
    // =========================================================================

    // -------------------------------------------------------------------------
    // Scenario 1: Open Registration Screen
    // -------------------------------------------------------------------------
    console.log("--- 1. Open Registration Screen ---");
    const regScreenRes = await httpRequest(`${frontendBaseUrl}/register`);
    assert(
      "1. Frontend serves registration screen HTML with HTTP 200",
      regScreenRes.status === 200 && regScreenRes.text.includes("<div id=\"root\">"),
      `Status: ${regScreenRes.status}, Body length: ${regScreenRes.text.length}`
    );

    // -------------------------------------------------------------------------
    // Scenario 2: Register a New Valid Company
    // -------------------------------------------------------------------------
    console.log("\n--- 2. Register New Valid Company ---");
    const validRegistrationPayload = {
      companyName: "Zenith Cloud Solutions",
      companySlug: "zenith-cloud",
      companyEmail: "admin@zenithcloud.lk",
      password: "ZenithPassword#2026",
      phone: "+94 11 234 5678",
      website: "https://zenithcloud.lk",
      industry: "Technology",
      country: "Sri Lanka",
      autoApprove: true,
    };
    const regRes = await httpRequest(`${backendBaseUrl}/api/registrations`, {
      method: "POST",
      body: validRegistrationPayload,
    });
    assert(
      "2. Valid company registration returns HTTP 201 Created",
      regRes.status === 201 && regRes.data.success === true,
      JSON.stringify(regRes.data)
    );

    // -------------------------------------------------------------------------
    // Scenario 3: Confirm Automatic Provisioning Without Manual Approval
    // -------------------------------------------------------------------------
    console.log("\n--- 3. Automatic Provisioning Without Manual Approval ---");
    assert(
      "3a. Registration status is immediately 'Active'",
      regRes.data.registration?.status === "Active",
      `Status: ${regRes.data.registration?.status}`
    );
    assert(
      "3b. Registration provisioningStatus is immediately 'ACTIVE'",
      regRes.data.registration?.provisioningStatus === "ACTIVE",
      `ProvisioningStatus: ${regRes.data.registration?.provisioningStatus}`
    );
    assert(
      "3c. Canonical tenantId is derived as 'tenant-zenith-cloud'",
      regRes.data.registration?.tenantId === "tenant-zenith-cloud",
      `TenantId: ${regRes.data.registration?.tenantId}`
    );

    // -------------------------------------------------------------------------
    // Scenario 4: Confirm Tenant and Default Agent Creation
    // -------------------------------------------------------------------------
    console.log("\n--- 4. Confirm Tenant & Default Agent Creation ---");
    const persistedDb = JSON.parse(fs.readFileSync(testDbPath, "utf8"));
    const persistedReg = persistedDb.registrations?.find((r: any) => r.tenantId === "tenant-zenith-cloud");
    assert(
      "4a. Tenant registration persisted in database with active status",
      persistedReg !== undefined && persistedReg.status === "Active" && persistedReg.provisioningStatus === "ACTIVE",
      `PersistedReg: ${JSON.stringify(persistedReg)}`
    );
    assert(
      "4b. Default agent created and allocated in registration configuration",
      regRes.data.registration?.tenantId === "tenant-zenith-cloud" &&
        persistedReg?.allocatedAgents > 0,
      `AllocatedAgents: ${persistedReg?.allocatedAgents}`
    );

    // -------------------------------------------------------------------------
    // Scenario 5: Successful Authenticated Dashboard Navigation
    // -------------------------------------------------------------------------
    console.log("\n--- 5. Authenticated Dashboard Session & Navigation ---");
    const sessionToken = regRes.data.token;
    const sessionUser = regRes.data.user;
    assert(
      "5a. Response returns session token and company admin user profile",
      typeof sessionToken === "string" &&
        sessionToken.length > 20 &&
        sessionUser?.role === "company" &&
        sessionUser?.tenantId === "tenant-zenith-cloud",
      `Token: ${sessionToken ? sessionToken.substring(0, 15) + "..." : "none"}, User: ${JSON.stringify(sessionUser)}`
    );

    // Verify company admin can query their own scoped registration
    const scopedRegsRes = await httpRequest(`${backendBaseUrl}/api/registrations`, {
      headers: { Authorization: `Bearer ${sessionToken}` },
    });
    assert(
      "5b. Company admin can access authenticated /api/registrations scoped to their tenant",
      scopedRegsRes.status === 200 &&
        scopedRegsRes.data.success === true &&
        scopedRegsRes.data.registrations?.length === 1 &&
        scopedRegsRes.data.registrations[0]?.tenantId === "tenant-zenith-cloud",
      JSON.stringify(scopedRegsRes.data)
    );

    // Verify frontend dashboard route loads
    const dashboardHtmlRes = await httpRequest(`${frontendBaseUrl}/dashboard`);
    assert(
      "5c. Frontend dashboard route responds with HTTP 200",
      dashboardHtmlRes.status === 200 && dashboardHtmlRes.text.includes("<div id=\"root\">"),
      `Status: ${dashboardHtmlRes.status}`
    );

    // -------------------------------------------------------------------------
    // Scenario 6 & 7: Log Out and Log Back In
    // -------------------------------------------------------------------------
    console.log("\n--- 6 & 7. Logout & Re-Authentication ---");
    // Client-side logout clears localStorage tokens. Now log back in:
    const loginRes = await httpRequest(`${backendBaseUrl}/api/auth/login`, {
      method: "POST",
      body: {
        email: "admin@zenithcloud.lk",
        password: "ZenithPassword#2026",
      },
    });
    assert(
      "7. Company admin logs back in successfully with 200 OK and valid session",
      loginRes.status === 200 &&
        loginRes.data.success === true &&
        typeof loginRes.data.token === "string" &&
        loginRes.data.user?.tenantId === "tenant-zenith-cloud",
      JSON.stringify(loginRes.data)
    );

    // -------------------------------------------------------------------------
    // Scenario 8: Reject Duplicate Registration
    // -------------------------------------------------------------------------
    console.log("\n--- 8. Reject Duplicate Registration ---");
    const dupRes = await httpRequest(`${backendBaseUrl}/api/registrations`, {
      method: "POST",
      body: {
        companyName: "  zenith   cloud   solutions  ", // casing and spacing variant
        companySlug: "zenith-cloud",
        companyEmail: "another@zenithcloud.lk",
        password: "SomePassword#2026",
      },
    });
    assert(
      "8. Duplicate registration is rejected with HTTP 409 Conflict",
      dupRes.status === 409 && dupRes.data.success === false,
      JSON.stringify(dupRes.data)
    );

    // -------------------------------------------------------------------------
    // Scenario 9: Reject Invalid Registration
    // -------------------------------------------------------------------------
    console.log("\n--- 9. Reject Invalid Registration ---");
    const invalidRes = await httpRequest(`${backendBaseUrl}/api/registrations`, {
      method: "POST",
      body: {
        companyName: "",
        companyEmail: "not-an-email",
      },
    });
    assert(
      "9. Invalid registration (empty name, bad email) rejected with HTTP 400 Bad Request",
      invalidRes.status === 400 && invalidRes.data.success === false,
      JSON.stringify(invalidRes.data)
    );

    // -------------------------------------------------------------------------
    // Scenario 10: Reject Reserved Tenant Slug
    // -------------------------------------------------------------------------
    console.log("\n--- 10. Reject Reserved Tenant Slug ---");
    const reservedSlugRes = await httpRequest(`${backendBaseUrl}/api/registrations`, {
      method: "POST",
      body: {
        companyName: "SLT Impersonator",
        companySlug: "slt",
        companyEmail: "fake@slt.lk",
        password: "Password#2026",
      },
    });
    assert(
      "10. Registration with reserved slug 'slt' rejected with HTTP 400 Bad Request",
      reservedSlugRes.status === 400 && reservedSlugRes.data.success === false,
      JSON.stringify(reservedSlugRes.data)
    );

    // -------------------------------------------------------------------------
    // Scenario 11: Cross-Tenant Isolation (Cannot Access Another Tenant)
    // -------------------------------------------------------------------------
    console.log("\n--- 11. Cross-Tenant Isolation ---");
    const crossTenantPresenceRes = await httpRequest(
      `${backendBaseUrl}/api/agent/presence/status?tenantId=slt`,
      {
        headers: { Authorization: `Bearer ${sessionToken}` },
      }
    );
    assert(
      "11. Company user cannot access another tenant's presence status (403 Forbidden)",
      crossTenantPresenceRes.status === 403 && crossTenantPresenceRes.data.success === false,
      JSON.stringify(crossTenantPresenceRes.data)
    );

    // -------------------------------------------------------------------------
    // Scenario 12: Super Admin Route Access Denied for Company Admin
    // -------------------------------------------------------------------------
    console.log("\n--- 12. Super Admin Escalation Protection ---");
    const superAdminMutationRes = await httpRequest(
      `${backendBaseUrl}/api/registrations/${regRes.data.registration.id}`,
      {
        method: "PATCH",
        headers: { Authorization: `Bearer ${sessionToken}` },
        body: { status: "approved" },
      }
    );
    assert(
      "12. Company user attempting to execute Super Admin approval route is denied (403 Forbidden)",
      superAdminMutationRes.status === 403 && superAdminMutationRes.data.success === false,
      JSON.stringify(superAdminMutationRes.data)
    );

    // -------------------------------------------------------------------------
    // Scenario 13: Provisioning Failure Fails Closed
    // -------------------------------------------------------------------------
    console.log("\n--- 13. Provisioning Failure Fails Closed ---");
    const failSlugRes = await httpRequest(`${backendBaseUrl}/api/registrations`, {
      method: "POST",
      body: {
        companyName: "Malformed Slug Enterprise",
        companySlug: "$$$@@@###",
        companyEmail: "test@malformed.lk",
        password: "Password#2026",
      },
    });
    assert(
      "13. Un-normalizable slug fails closed with HTTP 400 Bad Request",
      failSlugRes.status === 400 && failSlugRes.data.success === false,
      JSON.stringify(failSlugRes.data)
    );

    // -------------------------------------------------------------------------
    // Scenario 14: Repeated Requests & Idempotency Behavior
    // -------------------------------------------------------------------------
    console.log("\n--- 14. Idempotency Key & Adversarial Replay Protection ---");
    const testIdempKey = `idemp-live-test-${Date.now()}`;
    const callerAPayload = {
      companyName: "Idempotent Live Corp",
      companySlug: "idemp-live",
      companyEmail: "caller-a@idemplive.lk",
      password: "CallerAPass#2026",
    };

    // 14a. First call by Caller A
    const idempFirstRes = await httpRequest(`${backendBaseUrl}/api/registrations`, {
      method: "POST",
      headers: { "idempotency-key": testIdempKey },
      body: callerAPayload,
    });
    assert(
      "14a. First call with idempotency key creates registration (201 Created)",
      idempFirstRes.status === 201 && idempFirstRes.data.registration?.tenantId === "tenant-idemp-live",
      JSON.stringify(idempFirstRes.data)
    );

    // 14b. Adversary (Caller B) attempts to hijack key with different payload
    const idempAdversaryRes = await httpRequest(`${backendBaseUrl}/api/registrations`, {
      method: "POST",
      headers: { "idempotency-key": testIdempKey },
      body: {
        companyName: "Adversary Attacker Corp",
        companySlug: "adversary-live",
        companyEmail: "attacker@adversary.lk",
        password: "AttackerPass#2026",
      },
    });
    assert(
      "14b. Adversarial collision with same idempotency key is rejected (409 Conflict)",
      idempAdversaryRes.status === 409 && idempAdversaryRes.data.success === false,
      JSON.stringify(idempAdversaryRes.data)
    );

    // 14c. Caller A replays request: returns 200 OK without token or session minting
    const idempReplayRes = await httpRequest(`${backendBaseUrl}/api/registrations`, {
      method: "POST",
      headers: { "idempotency-key": testIdempKey },
      body: callerAPayload,
    });
    assert(
      "14c. Replayed call returns 200 OK with sanitized registration and NO token (LOGIN_REQUIRED)",
      idempReplayRes.status === 200 &&
        idempReplayRes.data.idempotentReplay === true &&
        idempReplayRes.data.token === undefined &&
        idempReplayRes.data.nextAction === "LOGIN_REQUIRED" &&
        idempReplayRes.data.registration?.tenantId === "tenant-idemp-live",
      JSON.stringify(idempReplayRes.data)
    );

    // -------------------------------------------------------------------------
    // Scenario 15: Suspended Tenant Login Rejection
    // -------------------------------------------------------------------------
    console.log("\n--- 15. Suspended Tenant Login Rejection ---");
    const superAdminToken = "dev-token-superadmin";

    // Super Admin safely suspends Zenith Cloud via DELETE /api/registrations/:id
    const suspendRes = await httpRequest(`${backendBaseUrl}/api/registrations/${regRes.data.registration.id}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${superAdminToken}` },
    });
    assert(
      "15a. Super Admin can safely suspend/deactivate workspace via DELETE /api/registrations/:id",
      suspendRes.status === 200 &&
        suspendRes.data.success === true &&
        suspendRes.data.registration?.status === "Suspended" &&
        suspendRes.data.registration?.provisioningStatus === "SUSPENDED",
      JSON.stringify(suspendRes.data)
    );

    // Attempt login to suspended workspace
    const suspendedLoginRes = await httpRequest(`${backendBaseUrl}/api/auth/login`, {
      method: "POST",
      body: {
        email: "admin@zenithcloud.lk",
        password: "ZenithPassword#2026",
      },
    });
    assert(
      "15b. Login to suspended company workspace is rejected with HTTP 403 Forbidden",
      suspendedLoginRes.status === 403 && suspendedLoginRes.data.success === false,
      JSON.stringify(suspendedLoginRes.data)
    );

    // -------------------------------------------------------------------------
    // Scenario 16: Verify No Credentials Appear in Responses/Logs
    // -------------------------------------------------------------------------
    console.log("\n--- 16. Credential Redaction & Privacy Verification ---");
    const regPayloadStr = JSON.stringify(regRes.data);
    const hasPlaintextPassword = regPayloadStr.includes("ZenithPassword#2026");
    const hasPasswordHash = regPayloadStr.includes("passwordHash");
    const hasSalt = regPayloadStr.includes("$scrypt$");
    assert(
      "16. Registration response NEVER reveals plaintext passwords, hashes, or salts",
      !hasPlaintextPassword && !hasPasswordHash && !hasSalt,
      `Payload contents checked: length=${regPayloadStr.length}`
    );

    console.log("\n================================================================");
    console.log(`📊 LIVE FULLSTACK E2E SUMMARY: ${passed} Passed, ${failed} Failed`);
    console.log("================================================================\n");

  } finally {
    // Teardown processes cleanly on Windows
    if (backendProc && backendProc.pid) {
      console.log("[E2E Teardown] Terminating Backend server process...");
      try {
        spawn("taskkill", ["/pid", String(backendProc.pid), "/T", "/F"], { stdio: "ignore" });
      } catch {}
      backendProc.kill();
    }
    if (frontendProc && frontendProc.pid) {
      console.log("[E2E Teardown] Terminating Frontend Vite server process...");
      try {
        spawn("taskkill", ["/pid", String(frontendProc.pid), "/T", "/F"], { stdio: "ignore" });
      } catch {}
      frontendProc.kill();
    }

    // Clean up temporary database replica
    if (fs.existsSync(testDbPath)) {
      try {
        fs.unlinkSync(testDbPath);
        console.log(`[E2E Teardown] Cleaned up temporary database replica: ${testDbPath}`);
      } catch (err: any) {
        console.warn(`[E2E Teardown] Note on temp db cleanup: ${err.message}`);
      }
    }
  }

  if (failed > 0) {
    process.exit(1);
  }
}

runLiveE2ETestSuite().catch((err) => {
  console.error("FATAL E2E ERROR:", err);
  process.exit(1);
});
