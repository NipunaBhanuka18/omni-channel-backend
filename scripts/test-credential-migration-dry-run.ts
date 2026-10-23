/** Offline tests using FICTIONAL data. No server, db.json, or backup access. */
import assert from "node:assert/strict";
import { previewLegacyCredentialMigration } from "../services/auth/credential-migration-dry-run";
import { verifyPassword } from "../services/auth/password-hashing";

async function main(): Promise<void> {
  let passed = 0;
  const pass = (name: string) => { console.log(`PASS: ${name}`); passed++; };
  const fixture = {
    users: [{ id: "fictional-user", role: "superadmin", password: "FICTIONAL-user-2026!" }],
    registrations: [
      { id: "reg-fictional-1", status: "Pending", tenantId: null, password: "FICTIONAL-reg-1!" },
      { id: "reg-fictional-2", status: "Rejected", companySlug: "two", password: "FICTIONAL-reg-2!" },
      { id: "reg-fictional-3", status: "Approved", metadata: { tier: "test" }, password: "FICTIONAL-reg-3!" },
    ],
    extraInfo: { version: "fictional" },
  };
  const original = JSON.stringify(fixture);
  const result = await previewLegacyCredentialMigration(fixture);
  assert.deepEqual(result.summary, {
    userPasswordsConverted: 1, registrationPasswordsConverted: 3, existingHashesPreserved: 0,
  });
  pass("Converts one fictional user and three fictional registrations");

  const all = [...result.preview.users, ...result.preview.registrations];
  assert.ok(all.every((r) => !("password" in r) &&
    typeof r.passwordHash === "string" && r.passwordHash.startsWith("scrypt-v2$")));
  assert.ok(!JSON.stringify(result.preview).includes("FICTIONAL-"));
  pass("Preview removes plaintext and uses versioned scrypt-v2 hashes");

  assert.equal(await verifyPassword("FICTIONAL-user-2026!", result.preview.users[0].passwordHash as string), true);
  assert.equal(await verifyPassword("FICTIONAL-reg-2!", result.preview.registrations[1].passwordHash as string), true);
  assert.equal(await verifyPassword("WRONG", result.preview.registrations[1].passwordHash as string), false);
  pass("Migrated credentials verify correctly; wrong passwords fail");

  assert.equal(result.preview.registrations[0].status, "Pending");
  assert.equal(result.preview.registrations[1].companySlug, "two");
  assert.deepEqual(result.preview.registrations[2].metadata, { tier: "test" });
  assert.deepEqual(result.preview.extraInfo, { version: "fictional" });
  pass("Non-credential fields and registration statuses remain unchanged");

  assert.equal(JSON.stringify(fixture), original);
  assert.notEqual(result.preview, fixture);
  assert.notEqual(result.preview.users[0], fixture.users[0]);
  pass("Original input remains byte-for-byte equivalent and unmodified");

  const second = await previewLegacyCredentialMigration(result.preview);
  assert.deepEqual(second.summary, {
    userPasswordsConverted: 0, registrationPasswordsConverted: 0, existingHashesPreserved: 4,
  });
  assert.deepEqual(second.preview, result.preview);
  pass("A repeated dry run preserves existing hashes without rehashing");

  await assert.rejects(previewLegacyCredentialMigration({
    users: [{ id: "x", password: "FICTIONAL", passwordHash: "bad" }], registrations: [],
  }), /Ambiguous user credentials/);
  await assert.rejects(previewLegacyCredentialMigration({
    users: [], registrations: [{ id: "x", passwordHash: "invalid" }],
  }), /Invalid existing registration hash/);
  pass("Ambiguous or invalid existing credentials are rejected");

  await assert.rejects(previewLegacyCredentialMigration({
    users: [{ id: "x", password: "" }], registrations: [],
  }), /Missing or invalid user credentials/);
  await assert.rejects(previewLegacyCredentialMigration({
    users: [], registrations: [{ id: "x" }],
  }), /Missing or invalid registration credentials/);
  pass("Missing and empty legacy passwords are rejected");

  const broken = { users: [{ password: "FICTIONAL" }], registrations: [{ password: "FICTIONAL" }] };
  const beforeFailure = JSON.stringify(broken);
  let attempts = 0;
  await assert.rejects(previewLegacyCredentialMigration(broken, async () => {
    attempts++;
    if (attempts === 2) throw new Error("Simulated offline hashing failure");
    return result.preview.users[0].passwordHash as string;
  }), /Simulated offline hashing failure/);
  assert.equal(JSON.stringify(broken), beforeFailure);
  pass("Hashing failure returns no partial preview and leaves input intact");

  console.log(`\n--- ${passed} passed, 0 failed ---`);
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
