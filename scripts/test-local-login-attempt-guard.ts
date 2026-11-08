/** Offline tests only: no server, db.json, real credentials, or network calls. */
import { LocalLoginAttemptGuard } from "../services/auth/local-login-attempt-guard";

function equal<T>(actual: T, expected: T, description: string): void {
  if (actual !== expected) throw new Error(`FAIL: ${description}: got ${String(actual)}`);
}

async function main(): Promise<void> {
  let passed = 0;
  function pass(label: string): void { console.log(`PASS: ${label}`); passed++; }

  let now = 1000;
  const guard = new LocalLoginAttemptGuard({
    maxAttemptsPerWindow: 2, windowMs: 100, maxConcurrent: 1,
    maxTrackedKeys: 2, now: () => now,
  });

  equal(await guard.run("trusted-ip-A", async () => true), "verified", "success outcome");
  pass("Legitimate fictional password check is allowed");
  equal(await guard.run("trusted-ip-A", async () => false), "invalid", "invalid outcome");
  pass("Incorrect fictional password is rejected");

  let invoked = false;
  equal(await guard.run("trusted-ip-A", async () => { invoked = true; return true; }), "rate_limited", "throttle");
  equal(invoked, false, "blocked check not run");
  pass("Too many attempts are blocked before expensive verification");

  now += 101;
  equal(await guard.run("trusted-ip-A", async () => true), "verified", "window reset");
  pass("Attempt allowance resets when the window expires");

  let unblock: (() => void) | undefined;
  const pending = guard.run("trusted-ip-B", () => new Promise<boolean>((resolve) => {
    unblock = () => resolve(true);
  }));
  equal(await guard.run("trusted-ip-A", async () => true), "busy", "concurrent limit");
  if (!unblock) throw new Error("FAIL: Deferred verifier did not start");
  unblock();
  equal(await pending, "verified", "pending verifier");
  pass("Concurrent expensive checks are limited and slots released");

  equal(await guard.run("trusted-ip-B", async () => { throw new Error("simulated crypto outage"); }), "invalid", "failure closed");
  pass("Verifier exceptions fail closed and release concurrency slots");
  equal(
    await guard.run("trusted-ip-A", async () => true),
    "verified",
    "concurrency slot released after verifier failure"
  );

  equal(await guard.run("trusted-ip-C", async () => true), "busy", "bounded identifiers");
  pass("Unique request-key storage cannot grow without bound");

  equal(await guard.run("", async () => true), "rate_limited", "empty key");
  equal(await guard.run("z".repeat(257), async () => true), "rate_limited", "oversized key");
  pass("Invalid or oversized caller keys are rejected");

  let badConfigFailed = false;
  try { new LocalLoginAttemptGuard({ maxConcurrent: 0 }); }
  catch (error) { badConfigFailed = error instanceof TypeError; }
  equal(badConfigFailed, true, "invalid settings");
  pass("Invalid guard settings fail closed");

  console.log(`\n--- ${passed} passed, 0 failed ---`);
}
main().catch((error) => { console.error(error); throw error; });
