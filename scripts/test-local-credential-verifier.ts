/** Offline tests using fictional credentials. No db.json, server, AWS, or writes. */
import assert from "node:assert/strict";
import { scryptSync } from "node:crypto";
import { hashPassword } from "../services/auth/password-hashing";
import { verifyLocalCredentialRecord } from "../services/auth/local-credential-verifier";

async function main(): Promise<void> {
  let passed = 0;
  function check(label: string): void { console.log(`PASS: ${label}`); passed++; }

  const password = "FICTIONAL-Local-Login-Password!";
  const passwordHash = await hashPassword(password);
  const record = { id: "offline-test-user", role: "superadmin", passwordHash };
  const originalJSON = JSON.stringify(record);

  assert.equal(await verifyLocalCredentialRecord(record, password), true);
  check("Migrated scrypt-v2 record accepts correct password");

  assert.equal(await verifyLocalCredentialRecord(record, "not-the-password"), false);
  check("Migrated record rejects incorrect password");

  const oldSalt = Buffer.alloc(32, 0x31);
  const oldKey = scryptSync(password, oldSalt, 64, {
    N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024,
  });
  const legacyHash = `scrypt-v1$${oldSalt.toString("base64url")}$${oldKey.toString("base64url")}`;
  assert.equal(await verifyLocalCredentialRecord({ passwordHash: legacyHash }, password), true);
  check("Existing scrypt-v1 record remains verifiable");

  assert.equal(await verifyLocalCredentialRecord({ passwordHash: legacyHash }, "wrong"), false);
  check("Existing scrypt-v1 record rejects wrong password");

  assert.equal(await verifyLocalCredentialRecord({ password }, password), false);
  check("Plaintext-only legacy record is never accepted");

  assert.equal(await verifyLocalCredentialRecord({ password, passwordHash }, password), false);
  check("Ambiguous record containing plaintext and hash is rejected");

  assert.equal(await verifyLocalCredentialRecord({ passwordHash: "unsupported$hash" }, password), false);
  assert.equal(await verifyLocalCredentialRecord({ passwordHash: "scrypt-v2$%%%$%%%" }, password), false);
  check("Malformed and unsupported hashes fail closed");

  for (const invalid of [null, undefined, [], "string", 2, {}]) {
    assert.equal(await verifyLocalCredentialRecord(invalid, password), false);
  }
  check("Missing or malformed records fail closed");

  assert.equal(await verifyLocalCredentialRecord(record, ""), false);
  assert.equal(await verifyLocalCredentialRecord(record, null), false);
  assert.equal(await verifyLocalCredentialRecord(record, "x".repeat(4097)), false);
  check("Empty, non-string and oversized submitted passwords are rejected");

  const unicodePassword = "FICTIONAL-\u3053\u3093\u306b\u3061\u306f-Password";
  const unicodeRecord = { passwordHash: await hashPassword(unicodePassword) };
  assert.equal(await verifyLocalCredentialRecord(unicodeRecord, unicodePassword), true);
  check("Unicode passwords work with migrated records");

  assert.equal(JSON.stringify(record), originalJSON);
  assert.ok(!("password" in record));
  check("Verification does not mutate input records");

  console.log(`\n--- ${passed} passed, 0 failed ---`);
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
