/**
 * Pure, OFFLINE-only migration preview for the legacy local demo DB.
 * No fs/network access, writes, logging, or login integration. The caller MUST NOT
 * persist the returned object until a separately reviewed migration is built.
 * Company-admin authentication ultimately belongs in a verified tenant-bound IdP.
 */
import { hashPassword } from "./password-hashing";

type RecordData = Record<string, unknown>;
export interface LegacyLocalDatabase extends RecordData {
  users: RecordData[];
  registrations: RecordData[];
}

export interface MigrationDryRunResult {
  /** A newly created in-memory object; never written to disk by this module. */
  preview: LegacyLocalDatabase;
  summary: {
    userPasswordsConverted: number;
    registrationPasswordsConverted: number;
    existingHashesPreserved: number;
  };
}

type HashFunction = (password: string) => Promise<string>;

function isRecord(value: unknown): value is RecordData {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// Shape validation only; cryptographic verification needs the user's password.
function looksLikeSupportedHash(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 256) return false;
  const match = /^(scrypt-v1|scrypt-v2)\$([A-Za-z0-9_-]+)\$([A-Za-z0-9_-]+)$/.exec(value);
  if (!match) return false;
  const salt = Buffer.from(match[2], "base64url");
  const key = Buffer.from(match[3], "base64url");
  return salt.length === 32 && key.length === 64 &&
    salt.toString("base64url") === match[2] && key.toString("base64url") === match[3];
}

/**
 * A failed conversion rejects the WHOLE preview and leaves the input untouched.
 * The injected hash function exists for deterministic offline failure tests.
 */
export async function previewLegacyCredentialMigration(
  database: LegacyLocalDatabase,
  hash: HashFunction = hashPassword,
): Promise<MigrationDryRunResult> {
  if (!isRecord(database) || !Array.isArray(database.users) ||
      !Array.isArray(database.registrations)) {
    throw new TypeError("Invalid local demo database shape");
  }

  let userPasswordsConverted = 0;
  let registrationPasswordsConverted = 0;
  let existingHashesPreserved = 0;

  const convertGroup = async (records: RecordData[], kind: "user" | "registration") => {
    const converted: RecordData[] = [];
    for (let i = 0; i < records.length; i++) {
      const record = records[i];
      if (!isRecord(record)) throw new TypeError(`Invalid ${kind} record at index ${i}`);
      const hasPlaintext = Object.prototype.hasOwnProperty.call(record, "password");
      const hasHash = Object.prototype.hasOwnProperty.call(record, "passwordHash");
      if (hasPlaintext && hasHash) {
        throw new Error(`Ambiguous ${kind} credentials at index ${i}`);
      }
      if (hasHash) {
        if (!looksLikeSupportedHash(record.passwordHash)) {
          throw new Error(`Invalid existing ${kind} hash at index ${i}`);
        }
        converted.push({ ...record });
        existingHashesPreserved++;
        continue;
      }
      if (!hasPlaintext || typeof record.password !== "string" ||
          record.password.length === 0) {
        throw new Error(`Missing or invalid ${kind} credentials at index ${i}`);
      }
      const passwordHash = await hash(record.password);
      if (!looksLikeSupportedHash(passwordHash) || !passwordHash.startsWith("scrypt-v2$")) {
        throw new Error(`Invalid generated ${kind} hash at index ${i}`);
      }
      const { password: _discardedPlaintext, ...rest } = record;
      converted.push({ ...rest, passwordHash });
      if (kind === "user") userPasswordsConverted++;
      else registrationPasswordsConverted++;
    }
    return converted;
  };

  // Nothing is returned until BOTH collections successfully finish converting.
  const users = await convertGroup(database.users, "user");
  const registrations = await convertGroup(database.registrations, "registration");
  return {
    preview: { ...database, users, registrations },
    summary: { userPasswordsConverted, registrationPasswordsConverted, existingHashesPreserved },
  };
}
