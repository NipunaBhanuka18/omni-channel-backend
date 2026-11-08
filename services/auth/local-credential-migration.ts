/**
 * Safe backup-verified credential migration runner built on previewLegacyCredentialMigration.
 * Never logs or returns plaintext passwords or scrypt hashes.
 */
import fs from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import {
  LegacyLocalDatabase,
  MigrationDryRunResult,
  previewLegacyCredentialMigration,
} from "./credential-migration-dry-run";

export interface LocalDbMigrationOptions {
  dbPath: string;
  backupPath?: string;
  apply?: boolean;
}

export interface LocalDbMigrationResult {
  dbPath: string;
  backupPath?: string;
  apply: boolean;
  alreadyMigrated: boolean;
  backupCreated: boolean;
  migrated: boolean;
  summary: MigrationDryRunResult["summary"];
}

export async function migrateLocalDatabaseCredentials(
  options: LocalDbMigrationOptions,
): Promise<LocalDbMigrationResult> {
  const dbPath = path.resolve(options.dbPath);
  const apply = options.apply === true;

  if (!fs.existsSync(dbPath)) {
    throw new Error(`Local database file not found: ${dbPath}`);
  }

  const originalBytes = fs.readFileSync(dbPath);
  let parsed: unknown;
  try {
    parsed = JSON.parse(originalBytes.toString("utf8"));
  } catch (error: any) {
    throw new Error(`Local database is not valid JSON: ${error?.message || "parse error"}`);
  }

  const { preview, summary } = await previewLegacyCredentialMigration(
    parsed as LegacyLocalDatabase,
  );
  const conversionsNeeded =
    summary.userPasswordsConverted + summary.registrationPasswordsConverted;

  if (conversionsNeeded === 0) {
    return {
      dbPath,
      apply,
      alreadyMigrated: true,
      backupCreated: false,
      migrated: false,
      summary,
    };
  }

  if (!apply) {
    return {
      dbPath,
      apply: false,
      alreadyMigrated: false,
      backupCreated: false,
      migrated: false,
      summary,
    };
  }

  const resolvedBackupPath = path.resolve(
    options.backupPath || `${dbPath}.backup-before-scrypt-migration`,
  );
  if (resolvedBackupPath === dbPath) {
    throw new Error("Backup path must be distinct from the target database path");
  }

  // Create the backup exclusively (`wx`) so an existing verified backup is never
  // overwritten blindly; verify exact byte equivalence before altering dbPath.
  fs.writeFileSync(resolvedBackupPath, originalBytes, { flag: "wx", mode: 0o600 });
  const backupBytes = fs.readFileSync(resolvedBackupPath);
  if (!backupBytes.equals(originalBytes)) {
    throw new Error("Backup verification failed: written backup differs from original database");
  }

  const serialized = `${JSON.stringify(preview, null, 2)}\n`;
  const tempPath = `${dbPath}.tmp-${process.pid}-${randomBytes(6).toString("hex")}`;
  try {
    fs.writeFileSync(tempPath, serialized, { encoding: "utf8", mode: 0o600 });
    fs.renameSync(tempPath, dbPath);
  } catch (error) {
    if (fs.existsSync(tempPath)) {
      fs.unlinkSync(tempPath);
    }
    throw error;
  }

  return {
    dbPath,
    backupPath: resolvedBackupPath,
    apply: true,
    alreadyMigrated: false,
    backupCreated: true,
    migrated: true,
    summary,
  };
}

