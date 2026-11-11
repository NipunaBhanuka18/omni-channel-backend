/**
 * Password-hashing primitive for isolated migration tests and legacy LOCAL accounts.
 * No database access, server routes, logging, or identity-provider integration here.
 * Company administrators must eventually authenticate through a verified tenant-bound IdP.
 */
import { randomBytes, scrypt, timingSafeEqual } from "node:crypto";

const CURRENT_HASH_FORMAT = "scrypt-v2";
const LEGACY_HASH_FORMAT = "scrypt-v1";
const SALT_BYTES = 32;
const KEY_BYTES = 64;
const MAX_PASSWORD_BYTES = 4096;
// Fixed parameters belong to the versioned format; changing them requires a new version.
const LEGACY_SCRYPT_OPTIONS = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
// OWASP scrypt setting: N=2^17, r=8, p=1 (~128 MiB). The limit must exceed
// 128*N*r, so allow 256 MiB for implementation overhead.
// Hash/verify calls are intentionally NOT exposed through HTTP yet; before
// doing so, add rate limiting and cap concurrent expensive operations.
const CURRENT_SCRYPT_OPTIONS = { N: 131072, r: 8, p: 1, maxmem: 256 * 1024 * 1024 };

function validPassword(value: string): boolean {
  return typeof value === "string" &&
    Buffer.byteLength(value, "utf8") > 0 &&
    Buffer.byteLength(value, "utf8") <= MAX_PASSWORD_BYTES;
}

function derive(
  password: string, salt: Buffer, options: typeof CURRENT_SCRYPT_OPTIONS,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, KEY_BYTES, options, (error, key) => {
      if (error) reject(error);
      else resolve(key);
    });
  });
}

/** Generate a unique, salted, non-reversible password verifier. */
export async function hashPassword(password: string): Promise<string> {
  if (!validPassword(password)) {
    throw new TypeError("Password must be a nonempty string of at most 4096 UTF-8 bytes");
  }
  const salt = randomBytes(SALT_BYTES);
  const key = await derive(password, salt, CURRENT_SCRYPT_OPTIONS);
  return `${CURRENT_HASH_FORMAT}$${salt.toString("base64url")}$${key.toString("base64url")}`;
}

/** Verify without returning credential material; malformed/unsupported hashes fail closed. */
export async function verifyPassword(password: string, storedHash: string): Promise<boolean> {
  if (!validPassword(password) || typeof storedHash !== "string" || storedHash.length > 256) return false;
  const parts = storedHash.split("$");
  if (parts.length !== 3 ||
      (parts[0] !== CURRENT_HASH_FORMAT && parts[0] !== LEGACY_HASH_FORMAT)) return false;
  const [, saltText, keyText] = parts;
  if (!/^[A-Za-z0-9_-]+$/.test(saltText) || !/^[A-Za-z0-9_-]+$/.test(keyText)) return false;
  const salt = Buffer.from(saltText, "base64url");
  const expected = Buffer.from(keyText, "base64url");
  if (salt.length !== SALT_BYTES || expected.length !== KEY_BYTES ||
      salt.toString("base64url") !== saltText || expected.toString("base64url") !== keyText) {
    return false;
  }
  const options = parts[0] === CURRENT_HASH_FORMAT
    ? CURRENT_SCRYPT_OPTIONS : LEGACY_SCRYPT_OPTIONS;
  const actual = await derive(password, salt, options);
  return timingSafeEqual(actual, expected);
}
