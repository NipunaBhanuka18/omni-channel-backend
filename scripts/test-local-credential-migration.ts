/** Isolated filesystem tests for migrateLocalDatabaseCredentials (uses os.tmpdir). */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { migrateLocalDatabaseCredentials } from "../services/auth/local-credential-migration";
import { verifyLocalCredentialRecord } from "../services/auth/local-credential-verifier";

async function main(): Promise<void> {
  let passed = 0;
  const pass = (label: string) => {
    console.log(`PASS: ${label}`);
    passed++;
  };

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "omni-cred-mig-"));
  try {
    const dbPath = path.join(tempDir, "db.json");
    const backupPath = path.join(tempDir, "db.json.backup-before-scrypt-migration");
    const fixture = {
      users: [
        {
          id: "u-1",
          email: "super@example.test",
          password: "FICTIONAL-super-pass!",
          role: "superadmin",
        },
      ],
      registrations: [
        {
          id: "reg-1",
          companyEmail: "org@example.test",
          status: "Approved",
          tenantId: "tenant-org",
          password: "FICTIONAL-company-pass!",
        },
      ],
    };
    const originalText = JSON.stringify(fixture, null, 2);
    fs.writeFileSync(dbPath, originalText, "utf8");

    const dryRun = await migrateLocalDatabaseCredentials({ dbPath, backupPath, apply: false });
    assert.equal(dryRun.migrated, false);
    assert.equal(dryRun.backupCreated, false);
    assert.equal(dryRun.summary.userPasswordsConverted, 1);
    assert.equal(dryRun.summary.registrationPasswordsConverted, 1);
    assert.equal(fs.existsSync(backupPath), false);
    assert.equal(fs.readFileSync(dbPath, "utf8"), originalText);
    pass("Dry-run does not modify database or create backup");

    const applied = await migrateLocalDatabaseCredentials({ dbPath, backupPath, apply: true });
    assert.equal(applied.migrated, true);
    assert.equal(applied.backupCreated, true);
    assert.equal(applied.alreadyMigrated, false);
    assert.equal(fs.readFileSync(backupPath, "utf8"), originalText);

    const migratedRaw = fs.readFileSync(dbPath, "utf8");
    assert.ok(!migratedRaw.includes("FICTIONAL-"));
    const migratedDb = JSON.parse(migratedRaw);
    assert.ok(!("password" in migratedDb.users[0]));
    assert.ok(!("password" in migratedDb.registrations[0]));
    assert.equal(
      await verifyLocalCredentialRecord(migratedDb.users[0], "FICTIONAL-super-pass!"),
      true,
    );
    assert.equal(
      await verifyLocalCredentialRecord(migratedDb.registrations[0], "FICTIONAL-company-pass!"),
      true,
    );
    assert.equal(
      await verifyLocalCredentialRecord(migratedDb.registrations[0], "wrong-password"),
      false,
    );
    pass("Applied migration verifies backup, removes plaintext, and writes scrypt-v2 hashes");

    const secondRun = await migrateLocalDatabaseCredentials({ dbPath, backupPath, apply: true });
    assert.equal(secondRun.alreadyMigrated, true);
    assert.equal(secondRun.migrated, false);
    assert.equal(secondRun.backupCreated, false);
    assert.equal(secondRun.summary.existingHashesPreserved, 2);
    pass("Re-running migration on migrated DB is idempotent");

    const ambiguousDbPath = path.join(tempDir, "ambiguous.json");
    const ambiguousText = JSON.stringify({
      users: [{ id: "u-bad", password: "FICTIONAL", passwordHash: "scrypt-v2$abc$def" }],
      registrations: [],
    });
    fs.writeFileSync(ambiguousDbPath, ambiguousText, "utf8");
    const badBackupPath = path.join(tempDir, "ambiguous.bak");
    await assert.rejects(
      migrateLocalDatabaseCredentials({ dbPath: ambiguousDbPath, backupPath: badBackupPath, apply: true }),
      /Ambiguous user credentials/,
    );
    assert.equal(fs.existsSync(badBackupPath), false);
    assert.equal(fs.readFileSync(ambiguousDbPath, "utf8"), ambiguousText);
    pass("Ambiguous database fails before backup or overwrite");

    const overwriteDbPath = path.join(tempDir, "no-clobber.json");
    fs.writeFileSync(overwriteDbPath, originalText, "utf8");
    const existingBackupPath = path.join(tempDir, "existing.bak");
    fs.writeFileSync(existingBackupPath, "existing-backup", "utf8");
    await assert.rejects(
      migrateLocalDatabaseCredentials({
        dbPath: overwriteDbPath,
        backupPath: existingBackupPath,
        apply: true,
      }),
    );
    assert.equal(fs.readFileSync(existingBackupPath, "utf8"), "existing-backup");
    assert.equal(fs.readFileSync(overwriteDbPath, "utf8"), originalText);
    pass("Existing backup file is never overwritten blindly");

    console.log(`\n--- ${passed} passed, 0 failed ---`);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});

