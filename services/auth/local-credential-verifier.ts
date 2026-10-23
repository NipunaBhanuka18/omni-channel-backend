/**
 * Offline credential check for local demo records AFTER a reviewed password migration.
 * No filesystem, HTTP, account lookup, token issuance, logging, or AWS operations.
 * Not an authorization boundary: production login requires trusted identity tokens,
 * rate limiting and scrypt concurrency limits.
 */
import { verifyPassword } from "./password-hashing";

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Only a migrated, hash-only record may authenticate through this helper.
 * Legacy plaintext and ambiguous mixed records fail closed (no downgrade path).
 */
export async function verifyLocalCredentialRecord(
  record: unknown,
  submittedPassword: unknown,
): Promise<boolean> {
  if (!isObjectRecord(record) || typeof submittedPassword !== "string") return false;
  if (Object.prototype.hasOwnProperty.call(record, "password")) return false;
  if (typeof record.passwordHash !== "string") return false;

  try {
    return await verifyPassword(submittedPassword, record.passwordHash);
  } catch {
    // Never authenticate when the verifier or crypto subsystem fails.
    return false;
  }
}
