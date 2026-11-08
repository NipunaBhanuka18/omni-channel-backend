/** Isolated HTTP tests for createLocalAuthRouter using os.tmpdir (never touches db.json). */
import assert from "node:assert/strict";
import express from "express";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AddressInfo } from "node:net";
import { createJsonDbStore, createLocalAuthRouter } from "../services/auth/local-auth-router";
import { LocalLoginAttemptGuard } from "../services/auth/local-login-attempt-guard";
import { LocalSessionTokenService } from "../services/auth/local-session-token";
import { hashPassword } from "../services/auth/password-hashing";

async function main(): Promise<void> {
  let passed = 0;
  const pass = (label: string) => {
    console.log(`PASS: ${label}`);
    passed++;
  };

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "omni-auth-ep-"));
  let httpServer: import("node:http").Server | null = null;

  try {
    const dbPath = path.join(tempDir, "db.json");
    const store = createJsonDbStore(dbPath);
    const tokenService = new LocalSessionTokenService({
      secret: "isolated-test-auth-signing-key-32bytes!",
    });

    const superPass = "FICTIONAL-Super-2026!";
    const companyPass = "FICTIONAL-Company-2026!";
    const pendingPass = "FICTIONAL-Pending-2026!";
    const unprovisionedPass = "FICTIONAL-Unprov-2026!";
    const legacyPass = "FICTIONAL-Legacy-2026!";

    store.writeDB({
      users: [
        {
          id: "user-1",
          fullName: "System Super Admin",
          email: "superadmin@example.test",
          passwordHash: await hashPassword(superPass),
          role: "superadmin",
        },
        {
          id: "user-legacy",
          fullName: "Legacy Plaintext Admin",
          email: "legacy@example.test",
          password: legacyPass,
          role: "superadmin",
        },
        {
          id: "agent-1",
          fullName: "Live Agent One",
          email: "agent@acme.test",
          passwordHash: await hashPassword(companyPass),
          role: "live_agent",
          tenantId: "tenant-acme",
        },
      ],
      registrations: [
        {
          id: "reg-approved",
          companyName: "Acme Holdings",
          companySlug: "acme",
          companyEmail: "admin@acme.test",
          adminName: "Acme Admin",
          status: "Approved",
          tenantId: "tenant-acme",
          passwordHash: await hashPassword(companyPass),
        },
        {
          id: "reg-pending",
          companyName: "Pending Corp",
          companySlug: "pending",
          companyEmail: "admin@pending.test",
          status: "Pending",
          passwordHash: await hashPassword(pendingPass),
        },
        {
          id: "reg-missing-tenant",
          companyName: "Half Provisioned",
          companySlug: "half",
          companyEmail: "half@example.test",
          status: "Approved",
          passwordHash: await hashPassword(unprovisionedPass),
        },
      ],
    });

    const loginGuard = new LocalLoginAttemptGuard({
      maxAttemptsPerWindow: 7,
      windowMs: 60_000,
      maxConcurrent: 2,
      maxTrackedKeys: 128,
    });

    const app = express();
    app.use(express.json());
    app.use(createLocalAuthRouter({ store, tokenService, loginGuard }));

    const startedServer = await new Promise<import("node:http").Server>((resolve) => {
      const s = app.listen(0, "127.0.0.1", () => resolve(s));
    });
    httpServer = startedServer;
    const port = (startedServer.address() as AddressInfo).port;
    const baseUrl = `http://127.0.0.1:${port}`;

    async function postJson(route: string, body: unknown) {
      const res = await fetch(`${baseUrl}${route}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = (await res.json()) as Record<string, any>;
      return { status: res.status, data };
    }

    // 1. Admin self-registration remains disabled
    const adminReg = await postJson("/api/auth/register-admin", { email: "x@example.test" });
    assert.equal(adminReg.status, 404);
    pass("Admin self-registration endpoint stays disabled (404)");

    // 2. Company registration rejects missing/short/whitespace passwords
    const noPassReg = await postJson("/api/registrations", {
      companyName: "No Pass Co",
      companyEmail: "nopass@example.test",
    });
    assert.equal(noPassReg.status, 400);
    const shortPassReg = await postJson("/api/registrations", {
      companyName: "Short Pass Co",
      companyEmail: "short@example.test",
      password: "short",
    });
    assert.equal(shortPassReg.status, 400);
    const spacePassReg = await postJson("/api/registrations", {
      companyName: "Space Pass Co",
      companyEmail: "space@example.test",
      password: "        ",
    });
    assert.equal(spacePassReg.status, 400);
    pass("Registration rejects missing, short, and whitespace-only passwords");

    // 3. Registration hashes password into scrypt-v2, blocks status/tenantId spoofing, redacts response
    const validRegPass = "FICTIONAL-NewReg-2026!";
    const goodReg = await postJson("/api/registrations", {
      companyName: "Beta Telecom",
      companyEmail: "admin@beta.test",
      password: validRegPass,
      status: "Approved",
      tenantId: "slt",
      temporaryPassword: "hack",
    });
    assert.equal(goodReg.status, 201);
    assert.equal(goodReg.data.success, true);
    assert.equal(goodReg.data.registration?.status, "Pending");
    assert.equal(goodReg.data.registration?.tenantId, undefined);
    assert.equal("password" in goodReg.data.registration, false);
    assert.equal("passwordHash" in goodReg.data.registration, false);
    assert.equal("temporaryPassword" in goodReg.data.registration, false);

    const savedDb = store.readDB();
    const persistedBeta = savedDb.registrations.find((r) => r.companyEmail === "admin@beta.test");
    assert.ok(persistedBeta);
    assert.equal("password" in persistedBeta!, false);
    assert.ok(typeof persistedBeta!.passwordHash === "string" && persistedBeta!.passwordHash.startsWith("scrypt-v2$"));
    assert.equal(persistedBeta!.status, "Pending");
    assert.equal(persistedBeta!.tenantId, undefined);
    pass("Registration persists scrypt-v2 passwordHash only and blocks status/tenant spoofing");

    // 4. Plaintext-only legacy account fails closed
    const legacyLogin = await postJson("/api/auth/login", {
      email: "legacy@example.test",
      password: legacyPass,
    });
    assert.equal(legacyLogin.status, 401);
    pass("Unmigrated plaintext-only record fails closed on login");

    // 5. Pending registration never leaks Pending status on wrong password
    const pendingWrong = await postJson("/api/auth/login", {
      email: "admin@pending.test",
      password: "wrong-password",
    });
    assert.equal(pendingWrong.status, 401);
    const pendingRight = await postJson("/api/auth/login", {
      email: "admin@pending.test",
      password: pendingPass,
    });
    assert.equal(pendingRight.status, 403);
    pass("Pending registration returns 401 on wrong password and 403 only after valid password");

    // 6. Approved registration missing tenantId never fabricates tenant-${id}
    const missingTenantLogin = await postJson("/api/auth/login", {
      email: "half@example.test",
      password: unprovisionedPass,
    });
    assert.equal(missingTenantLogin.status, 403);
    pass("Approved registration without provisioned tenantId fails closed");

    // 7. Superadmin login issues verified signed v1 token without tenantId
    const superLogin = await postJson("/api/auth/login", {
      email: "SUPERADMIN@example.test",
      password: superPass,
    });
    assert.equal(superLogin.status, 200);
    assert.equal(superLogin.data.success, true);
    assert.equal(superLogin.data.user?.role, "superadmin");
    assert.equal(superLogin.data.user?.tenantId, undefined);
    assert.ok(typeof superLogin.data.token === "string" && superLogin.data.token.startsWith("v1."));
    const verifiedSuper = tokenService.verifyToken(superLogin.data.token);
    assert.equal(verifiedSuper?.sub, "user-1");
    assert.equal(verifiedSuper?.role, "superadmin");
    assert.equal(verifiedSuper?.tenantId, undefined);
    pass("Superadmin login verifies scrypt-v2 hash and issues signed bearer token");

    // 8. Approved company login issues tenant-scoped signed v1 token
    const companyLogin = await postJson("/api/auth/login", {
      email: "admin@acme.test",
      password: companyPass,
    });
    assert.equal(companyLogin.status, 200);
    assert.equal(companyLogin.data.user?.role, "company");
    assert.equal(companyLogin.data.user?.tenantId, "tenant-acme");
    const verifiedCompany = tokenService.verifyToken(companyLogin.data.token);
    assert.equal(verifiedCompany?.tenantId, "tenant-acme");
    pass("Company admin login verifies scrypt-v2 hash and binds token to tenantId");

    // 8b. Live agent login issues tenant-scoped signed v1 token
    const agentLogin = await postJson("/api/auth/login", {
      email: "agent@acme.test",
      password: companyPass,
    });
    assert.equal(agentLogin.status, 200);
    assert.equal(agentLogin.data.user?.role, "live_agent");
    assert.equal(agentLogin.data.user?.tenantId, "tenant-acme");
    assert.equal(tokenService.verifyToken(agentLogin.data.token)?.role, "live_agent");
    pass("Live agent login verifies scrypt-v2 hash and binds token to tenantId");

    // 9. Repeated attempts trigger HTTP 429 rate limit even with rotating email addresses
    const throttled = await postJson("/api/auth/login", {
      email: "attacker-rotation@example.test",
      password: "bad-password",
    });
    assert.equal(throttled.status, 429);
    pass("Login attempt guard returns 429 when loopback attempt budget is exhausted");

    // 10. Registration hash concurrency limit fails cleanly with 503
    let releaseHash!: () => void;
    const busyApp = express();
    busyApp.use(express.json());
    busyApp.use(
      createLocalAuthRouter({
        store,
        tokenService,
        maxConcurrentRegistrations: 1,
        hashFn: () =>
          new Promise<string>((resolve) => {
            releaseHash = () => resolve("scrypt-v2$fake$fake");
          }),
      }),
    );
    const busyServer: import("node:http").Server = await new Promise((resolve) => {
      const s = busyApp.listen(0, "127.0.0.1", () => resolve(s));
    });
    try {
      const busyBase = `http://127.0.0.1:${(busyServer.address() as AddressInfo).port}`;
      const firstReq = fetch(`${busyBase}/api/registrations`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          companyName: "First Co",
          companyEmail: "first@example.test",
          password: "FICTIONAL-Password-1!",
        }),
      });
      await new Promise((r) => setTimeout(r, 25));
      const secondRes = await fetch(`${busyBase}/api/registrations`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          companyName: "Second Co",
          companyEmail: "second@example.test",
          password: "FICTIONAL-Password-2!",
        }),
      });
      assert.equal(secondRes.status, 503);
      releaseHash();
      const firstRes = await firstReq;
      assert.equal(firstRes.status, 201);
      pass("Concurrent registration hashing bounds overflow cleanly with HTTP 503");
    } finally {
      await new Promise<void>((resolve) => busyServer.close(() => resolve()));
    }

    console.log(`\n--- ${passed} passed, 0 failed ---`);
  } finally {
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
