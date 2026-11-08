/**
 * CLI wrapper for safely migrating plaintext credentials in db.json to scrypt-v2 hashes.
 * Usage:
 *   npx tsx ./scripts/migrate-local-credentials.ts          (dry-run preview only)
 *   npx tsx ./scripts/migrate-local-credentials.ts --apply  (creates backup, verifies, and migrates)
 */
import path from "node:path";
import { migrateLocalDatabaseCredentials } from "../services/auth/local-credential-migration";

async function main(): Promise<void> {
  const apply = process.argv.includes("--apply");
  const repoRoot = path.resolve(__dirname, "..");
  const dbPath = path.join(repoRoot, "db.json");
  const backupPath = path.join(repoRoot, "db.json.backup-before-scrypt-migration");

  const result = await migrateLocalDatabaseCredentials({
    dbPath,
    backupPath,
    apply,
  });

  console.log("=== Local Credential Migration ===");
  console.log(`Mode: ${result.apply ? "APPLY" : "DRY-RUN PREVIEW"}`);
  console.log(`Already migrated: ${result.alreadyMigrated}`);
  console.log(`User passwords converted: ${result.summary.userPasswordsConverted}`);
  console.log(`Registration passwords converted: ${result.summary.registrationPasswordsConverted}`);
  console.log(`Existing hashes preserved: ${result.summary.existingHashesPreserved}`);
  if (result.backupCreated && result.backupPath) {
    console.log(`Verified backup written: ${path.basename(result.backupPath)}`);
  }
  if (!result.apply && !result.alreadyMigrated) {
    console.log("Dry-run only; re-run with --apply to write changes.");
  }
}

main().catch((error: any) => {
  console.error("Migration failed:", error?.message || error);
  process.exitCode = 1;
});

