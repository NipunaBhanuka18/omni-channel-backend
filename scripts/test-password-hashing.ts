/** Offline password-hashing tests. No server, db.json, real credentials, or AWS access. */
import assert from "node:assert/strict";
import { scryptSync } from "node:crypto";
import { hashPassword, verifyPassword } from "../services/auth/password-hashing";

async function main(): Promise<void> {
  let passed = 0;
  const check = (label: string): void => { console.log(`PASS: ${label}`); passed++; };

  const password = "FICTIONAL-test-Passphrase-2026!";
  const first = await hashPassword(password);
  const second = await hashPassword(password);
  assert.notEqual(first, second);
  assert.ok(first.startsWith("scrypt-v2$"));
  check("Identical passwords receive different random salts");

  assert.ok(!first.includes(password));
  assert.ok(!second.includes(password));
  check("Stored hashes contain no plaintext test password");

  assert.equal(await verifyPassword(password, first), true);
  assert.equal(await verifyPassword(password, second), true);
  check("Valid test password verifies with either salted hash");

  assert.equal(await verifyPassword("WRONG-fictional-password", first), false);
  check("Incorrect password is rejected");

  assert.equal(await verifyPassword(password, "not-a-supported-hash"), false);
  assert.equal(await verifyPassword(password, "scrypt-v1$%%%$%%%"), false);
  assert.equal(await verifyPassword(password, "scrypt-v2$%%%$%%%"), false);
  assert.equal(await verifyPassword(password, "scrypt-v3$fake$fake"), false);
  check("Malformed and unsupported hash versions fail closed");

  await assert.rejects(hashPassword(""), TypeError);
  assert.equal(await verifyPassword("", first), false);
  check("Empty passwords cannot be hashed or verified");

  const unicode = "FICTIONAL-ありがとう-Password";
  assert.equal(await verifyPassword(unicode, await hashPassword(unicode)), true);
  check("Unicode test passwords are supported");

  // An older v1 hash stays verifiable even after new hashes switch to v2.
  // The fixture uses a fictional password and never reads application data.
  const legacySalt = Buffer.alloc(32, 0x5a);
  const legacyKey = scryptSync(password, legacySalt, 64, {
    N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024,
  });
  const legacyHash = `scrypt-v1$${legacySalt.toString("base64url")}$${legacyKey.toString("base64url")}`;
  assert.equal(await verifyPassword(password, legacyHash), true);
  assert.equal(await verifyPassword("wrong", legacyHash), false);
  check("Previously issued scrypt-v1 hashes remain verifiable");

  // Escapes avoid terminal encoding issues while testing actual Japanese text.
  const escapedUnicode = "FICTIONAL-\u3053\u3093\u306b\u3061\u306f-Password";
  assert.equal(await verifyPassword(escapedUnicode, await hashPassword(escapedUnicode)), true);
  check("Explicit Unicode escapes round-trip successfully");

  await assert.rejects(hashPassword("x".repeat(4097)), TypeError);
  assert.equal(await verifyPassword("x".repeat(4097), first), false);
  assert.equal(await verifyPassword(password, "x".repeat(257)), false);
  check("Oversized passwords and hashes fail closed");

  console.log(`\n--- ${passed} passed, 0 failed ---`);
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
