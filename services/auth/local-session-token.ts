/**
 * LOCAL-DEMO-ONLY HMAC-SHA256 signed bearer session token utility.
 * Replaces unsigned `token-*` strings until Cognito JWT login & JWKS
 * verification (Phase 2B) replaces local credential authentication.
 */
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

export type LocalAuthRole = "superadmin" | "company" | "live_agent";

export interface LocalSessionIdentityInput {
  sub: string;
  email: string;
  name: string;
  role: LocalAuthRole;
  tenantId?: string;
}

export interface LocalSessionClaims {
  sub: string;
  email: string;
  name: string;
  role: LocalAuthRole;
  tenantId?: string;
  iat: number;
  exp: number;
}

export interface LocalSessionTokenServiceOptions {
  secret?: string | Buffer;
  ttlSeconds?: number;
  maxClockSkewSeconds?: number;
  now?: () => number;
}

const TOKEN_VERSION = "v1";
const MIN_SECRET_BYTES = 32;
const DEFAULT_TTL_SECONDS = 3600;
const MAX_TTL_SECONDS = 86400;
const DEFAULT_CLOCK_SKEW_SECONDS = 30;
const MAX_TOKEN_LENGTH = 4096;
const TENANT_ID_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const ALLOWED_ROLES = new Set<LocalAuthRole>(["superadmin", "company", "live_agent"]);
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function resolveSigningKey(explicitSecret?: string | Buffer): Buffer {
  if (explicitSecret !== undefined) {
    const buf = Buffer.isBuffer(explicitSecret)
      ? Buffer.from(explicitSecret)
      : Buffer.from(explicitSecret, "utf8");
    if (buf.length < MIN_SECRET_BYTES) {
      throw new TypeError(`Local auth signing secret must be at least ${MIN_SECRET_BYTES} bytes`);
    }
    return buf;
  }

  const envSecret = process.env.LOCAL_AUTH_TOKEN_SECRET;
  if (envSecret !== undefined) {
    const buf = Buffer.from(envSecret, "utf8");
    if (buf.length < MIN_SECRET_BYTES) {
      throw new Error(
        `LOCAL_AUTH_TOKEN_SECRET must be at least ${MIN_SECRET_BYTES} bytes when configured`,
      );
    }
    return buf;
  }

  if (process.env.NODE_ENV === "production" || process.env.IS_LOCAL === "false") {
    throw new Error(
      "Local session token signing requires explicit LOCAL_AUTH_TOKEN_SECRET outside local development",
    );
  }

  return randomBytes(MIN_SECRET_BYTES);
}

function validateIdentityFields(input: LocalSessionIdentityInput): {
  sub: string;
  email: string;
  name: string;
  role: LocalAuthRole;
  tenantId?: string;
} {
  if (!isPlainObject(input)) {
    throw new TypeError("Session identity payload must be a plain object");
  }
  const sub = typeof input.sub === "string" ? input.sub.trim() : "";
  const email = typeof input.email === "string" ? input.email.trim() : "";
  const name = typeof input.name === "string" ? input.name.trim() : "";
  if (!sub || sub.length > 128) throw new TypeError("Invalid subject identifier");
  if (email.length < 3 || email.length > 254 || !email.includes("@")) {
    throw new TypeError("Invalid email claim");
  }
  if (!name || name.length > 160) throw new TypeError("Invalid name claim");
  if (!ALLOWED_ROLES.has(input.role)) {
    throw new TypeError("Unsupported role claim");
  }

  if (input.role === "superadmin") {
    if (input.tenantId !== undefined) {
      throw new TypeError("Platform superadmin tokens must not carry a tenantId");
    }
    return { sub, email, name, role: "superadmin" };
  }

  const tenantId = typeof input.tenantId === "string" ? input.tenantId.trim() : "";
  if (!TENANT_ID_PATTERN.test(tenantId)) {
    throw new TypeError("Tenant-scoped roles require a valid tenantId");
  }
  return { sub, email, name, role: input.role, tenantId };
}

export function extractBearerToken(authorizationHeader: unknown): string | null {
  if (typeof authorizationHeader !== "string") return null;
  const trimmed = authorizationHeader.trim();
  if (!trimmed || trimmed.length > MAX_TOKEN_LENGTH + 16) return null;
  const match = /^Bearer\s+(\S+)$/i.exec(trimmed);
  return match ? match[1] : null;
}

export class LocalSessionTokenService {
  private readonly signingKey: Buffer;
  private readonly ttlSeconds: number;
  private readonly maxClockSkewSeconds: number;
  private readonly now: () => number;

  constructor(options: LocalSessionTokenServiceOptions = {}) {
    this.signingKey = resolveSigningKey(options.secret);
    const ttlSeconds = options.ttlSeconds ?? DEFAULT_TTL_SECONDS;
    const maxClockSkewSeconds = options.maxClockSkewSeconds ?? DEFAULT_CLOCK_SKEW_SECONDS;
    if (!Number.isSafeInteger(ttlSeconds) || ttlSeconds < 1 || ttlSeconds > MAX_TTL_SECONDS) {
      throw new TypeError(`Token TTL must be an integer between 1 and ${MAX_TTL_SECONDS} seconds`);
    }
    if (!Number.isSafeInteger(maxClockSkewSeconds) || maxClockSkewSeconds < 0 || maxClockSkewSeconds > 300) {
      throw new TypeError("Clock skew allowance must be an integer between 0 and 300 seconds");
    }
    this.ttlSeconds = ttlSeconds;
    this.maxClockSkewSeconds = maxClockSkewSeconds;
    this.now = options.now ?? Date.now;
  }

  issueToken(identity: LocalSessionIdentityInput, ttlSeconds?: number): string {
    const validated = validateIdentityFields(identity);
    const effectiveTtl = ttlSeconds ?? this.ttlSeconds;
    if (!Number.isSafeInteger(effectiveTtl) || effectiveTtl < 1 || effectiveTtl > MAX_TTL_SECONDS) {
      throw new TypeError(`Token TTL must be an integer between 1 and ${MAX_TTL_SECONDS} seconds`);
    }
    const nowMs = this.now();
    if (!Number.isFinite(nowMs) || nowMs < 0) {
      throw new Error("Invalid clock value");
    }
    const iat = Math.floor(nowMs / 1000);
    const exp = iat + effectiveTtl;
    const claims: LocalSessionClaims = validated.tenantId !== undefined
      ? { ...validated, iat, exp }
      : {
          sub: validated.sub,
          email: validated.email,
          name: validated.name,
          role: validated.role,
          iat,
          exp,
        };

    const payloadPart = Buffer.from(JSON.stringify(claims), "utf8").toString("base64url");
    const signingInput = `${TOKEN_VERSION}.${payloadPart}`;
    const signaturePart = createHmac("sha256", this.signingKey)
      .update(signingInput, "utf8")
      .digest()
      .toString("base64url");
    return `${signingInput}.${signaturePart}`;
  }

  verifyToken(token: unknown): LocalSessionClaims | null {
    if (typeof token !== "string" || token.length < 20 || token.length > MAX_TOKEN_LENGTH) {
      return null;
    }
    const parts = token.split(".");
    if (parts.length !== 3) return null;
    const [version, payloadPart, signaturePart] = parts;
    if (version !== TOKEN_VERSION) return null;
    if (!BASE64URL_PATTERN.test(payloadPart) || !BASE64URL_PATTERN.test(signaturePart)) {
      return null;
    }

    const actualSig = Buffer.from(signaturePart, "base64url");
    if (actualSig.length !== 32 || actualSig.toString("base64url") !== signaturePart) {
      return null;
    }

    const expectedSig = createHmac("sha256", this.signingKey)
      .update(`${version}.${payloadPart}`, "utf8")
      .digest();
    if (!timingSafeEqual(actualSig, expectedSig)) {
      return null;
    }

    let parsed: unknown;
    try {
      const jsonText = Buffer.from(payloadPart, "base64url").toString("utf8");
      parsed = JSON.parse(jsonText);
    } catch {
      return null;
    }
    if (!isPlainObject(parsed)) return null;

    const iat = parsed.iat;
    const exp = parsed.exp;
    if (typeof iat !== "number" || typeof exp !== "number" ||
        !Number.isSafeInteger(iat) || !Number.isSafeInteger(exp) || exp <= iat) {
      return null;
    }

    const nowMs = this.now();
    if (!Number.isFinite(nowMs) || nowMs < 0) return null;
    const nowSec = Math.floor(nowMs / 1000);
    if (nowSec >= exp || iat > nowSec + this.maxClockSkewSeconds) {
      return null;
    }

    try {
      const identity = validateIdentityFields({
        sub: parsed.sub as string,
        email: parsed.email as string,
        name: parsed.name as string,
        role: parsed.role as LocalAuthRole,
        tenantId: parsed.tenantId as string | undefined,
      });
      return identity.tenantId !== undefined
        ? { ...identity, iat, exp }
        : {
            sub: identity.sub,
            email: identity.email,
            name: identity.name,
            role: identity.role,
            iat,
            exp,
          };
    } catch {
      return null;
    }
  }
}

