import { createPublicKey, KeyObject, verify as cryptoVerify } from "node:crypto";
import type { LocalSessionClaims } from "./local-session-token";
import type { TenantContext } from "../../shared/types/tenant-context";

export type CognitoTokenUse = "id" | "access";

export interface CognitoJwk {
  kty: string;
  kid: string;
  use?: string;
  alg?: string;
  n?: string;
  e?: string;
}

export interface CognitoFetchResponse {
  ok: boolean;
  status: number;
  text(): Promise<string>;
}

export type CognitoFetchFn = (
  url: string,
  init?: { method?: string; headers?: Record<string, string>; signal?: AbortSignal },
) => Promise<CognitoFetchResponse>;

export interface CognitoJwtVerifierOptions {
  userPoolId: string;
  clientId: string;
  region?: string;
  expectedIssuer?: string;
  jwksUri?: string;
  allowedTokenUse?: CognitoTokenUse[];
  clockSkewSeconds?: number;
  jwksCacheTtlMs?: number;
  unknownKidRefreshCooldownMs?: number;
  fetchTimeoutMs?: number;
  maxJwksKeys?: number;
  maxJwksBytes?: number;
  fetchFn?: CognitoFetchFn;
  now?: () => number;
}

export interface VerifiedCognitoClaims {
  sub: string;
  iss: string;
  tokenUse: CognitoTokenUse;
  aud?: string;
  clientId?: string;
  email?: string;
  name?: string;
  cognitoUsername?: string;
  tenantId?: string;
  groups: string[];
  iat: number;
  exp: number;
  nbf?: number;
}

export class CognitoTokenValidationError extends Error {
  readonly code = "UNAUTHORIZED" as const;

  constructor(message: string) {
    super(message);
    this.name = "CognitoTokenValidationError";
  }
}

export class CognitoJwksUnavailableError extends Error {
  readonly code = "SERVICE_UNAVAILABLE" as const;

  constructor(message: string) {
    super(message);
    this.name = "CognitoJwksUnavailableError";
  }
}

const REGION_PATTERN = /^[a-z]{2}(?:-[a-z]+)+-\d+$/;
const USER_POOL_ID_PATTERN = /^[a-z]{2}(?:-[a-z]+)+-\d+_[A-Za-z0-9]{1,64}$/;
const KID_PATTERN = /^[A-Za-z0-9._=-]{1,128}$/;
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/;
const TENANT_ID_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const MAX_TOKEN_LENGTH = 8192;
const DEFAULT_CLOCK_SKEW_SECONDS = 30;
const DEFAULT_JWKS_CACHE_TTL_MS = 300_000;
const DEFAULT_UNKNOWN_KID_COOLDOWN_MS = 15_000;
const DEFAULT_FETCH_TIMEOUT_MS = 5_000;
const DEFAULT_MAX_JWKS_KEYS = 32;
const DEFAULT_MAX_JWKS_BYTES = 65_536;
const MAX_CACHED_VERIFIERS = 16;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function isProductionEnv(): boolean {
  const env = (process.env.NODE_ENV || "").trim().toLowerCase();
  return env === "production" || env === "prod" || process.env.IS_LOCAL === "false";
}

function decodeBase64UrlJson(segment: string, label: string): Record<string, unknown> {
  if (!segment || !BASE64URL_PATTERN.test(segment)) {
    throw new CognitoTokenValidationError(`Malformed JWT ${label} encoding`);
  }
  const decoded = Buffer.from(segment, "base64url");
  if (decoded.length === 0 || decoded.toString("base64url") !== segment) {
    throw new CognitoTokenValidationError(`Non-canonical JWT ${label} encoding`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(decoded.toString("utf8"));
  } catch {
    throw new CognitoTokenValidationError(`Malformed JWT ${label} JSON`);
  }
  if (!isPlainObject(parsed)) {
    throw new CognitoTokenValidationError(`Invalid JWT ${label} object`);
  }
  return parsed;
}

function validateJwksUri(rawUri: string, hasCustomFetchFn: boolean): string {
  let parsed: URL;
  try {
    parsed = new URL(rawUri);
  } catch {
    throw new TypeError("Invalid Cognito JWKS URI");
  }
  if (parsed.username || parsed.password) {
    throw new TypeError("Cognito JWKS URI must not include credentials");
  }
  if (parsed.protocol === "https:") {
    return parsed.toString();
  }
  if (parsed.protocol === "http:") {
    const isLoopback = ["127.0.0.1", "localhost", "::1", "[::1]"].includes(parsed.hostname);
    if (!isProductionEnv() && (isLoopback || hasCustomFetchFn)) {
      return parsed.toString();
    }
  }
  throw new TypeError("Cognito JWKS URI must use HTTPS");
}

function inferRegion(userPoolId: string, explicitRegion?: string): string {
  if (explicitRegion !== undefined) {
    const trimmed = explicitRegion.trim();
    if (!REGION_PATTERN.test(trimmed)) {
      throw new TypeError("Invalid AWS Cognito region");
    }
    return trimmed;
  }
  const idx = userPoolId.indexOf("_");
  const prefix = idx > 0 ? userPoolId.slice(0, idx) : "";
  if (!REGION_PATTERN.test(prefix)) {
    throw new TypeError("Invalid Cognito userPoolId format; unable to infer AWS region");
  }
  return prefix;
}

export class CognitoJwtVerifier {
  readonly userPoolId: string;
  readonly clientId: string;
  readonly region: string;
  readonly expectedIssuer: string;
  readonly jwksUri: string;

  private readonly allowedTokenUse: Set<CognitoTokenUse>;
  private readonly clockSkewSeconds: number;
  private readonly jwksCacheTtlMs: number;
  private readonly unknownKidRefreshCooldownMs: number;
  private readonly fetchTimeoutMs: number;
  private readonly maxJwksKeys: number;
  private readonly maxJwksBytes: number;
  private readonly fetchFn: CognitoFetchFn;
  private readonly now: () => number;

  private keyCache = new Map<string, KeyObject>();
  private cacheExpiresAt = 0;
  private lastFetchAt = 0;
  private inFlightFetch: Promise<void> | null = null;

  constructor(options: CognitoJwtVerifierOptions) {
    if (!isPlainObject(options)) {
      throw new TypeError("CognitoJwtVerifier options must be a plain object");
    }

    const userPoolId = typeof options.userPoolId === "string" ? options.userPoolId.trim() : "";
    if (!USER_POOL_ID_PATTERN.test(userPoolId)) {
      throw new TypeError("Invalid Cognito userPoolId");
    }
    const clientId = typeof options.clientId === "string" ? options.clientId.trim() : "";
    if (!clientId || clientId.length > 128 || /\s/.test(clientId)) {
      throw new TypeError("Invalid Cognito clientId");
    }

    const region = inferRegion(userPoolId, options.region);
    const defaultIssuer = `https://cognito-idp.${region}.amazonaws.com/${userPoolId}`;
    const expectedIssuer =
      typeof options.expectedIssuer === "string" && options.expectedIssuer.trim()
        ? options.expectedIssuer.trim().replace(/\/+$/, "")
        : defaultIssuer;

    const allowedUses = options.allowedTokenUse ?? ["id"];
    if (!Array.isArray(allowedUses) || allowedUses.length === 0) {
      throw new TypeError("allowedTokenUse must contain at least one Cognito token_use value");
    }
    const tokenUseSet = new Set<CognitoTokenUse>();
    for (const use of allowedUses) {
      if (use !== "id" && use !== "access") {
        throw new TypeError(`Unsupported Cognito token_use filter: ${String(use)}`);
      }
      tokenUseSet.add(use);
    }

    const clockSkewSeconds = options.clockSkewSeconds ?? DEFAULT_CLOCK_SKEW_SECONDS;
    const jwksCacheTtlMs = options.jwksCacheTtlMs ?? DEFAULT_JWKS_CACHE_TTL_MS;
    const unknownKidRefreshCooldownMs =
      options.unknownKidRefreshCooldownMs ?? DEFAULT_UNKNOWN_KID_COOLDOWN_MS;
    const fetchTimeoutMs = options.fetchTimeoutMs ?? DEFAULT_FETCH_TIMEOUT_MS;
    const maxJwksKeys = options.maxJwksKeys ?? DEFAULT_MAX_JWKS_KEYS;
    const maxJwksBytes = options.maxJwksBytes ?? DEFAULT_MAX_JWKS_BYTES;

    if (!Number.isSafeInteger(clockSkewSeconds) || clockSkewSeconds < 0 || clockSkewSeconds > 300) {
      throw new TypeError("clockSkewSeconds must be an integer between 0 and 300");
    }
    if (!Number.isSafeInteger(jwksCacheTtlMs) || jwksCacheTtlMs < 1_000 || jwksCacheTtlMs > 86_400_000) {
      throw new TypeError("jwksCacheTtlMs must be an integer between 1000 and 86400000");
    }
    if (
      !Number.isSafeInteger(unknownKidRefreshCooldownMs) ||
      unknownKidRefreshCooldownMs < 0 ||
      unknownKidRefreshCooldownMs > 300_000
    ) {
      throw new TypeError("unknownKidRefreshCooldownMs must be an integer between 0 and 300000");
    }
    if (!Number.isSafeInteger(fetchTimeoutMs) || fetchTimeoutMs < 100 || fetchTimeoutMs > 30_000) {
      throw new TypeError("fetchTimeoutMs must be an integer between 100 and 30000");
    }
    if (!Number.isSafeInteger(maxJwksKeys) || maxJwksKeys < 1 || maxJwksKeys > 128) {
      throw new TypeError("maxJwksKeys must be an integer between 1 and 128");
    }
    if (!Number.isSafeInteger(maxJwksBytes) || maxJwksBytes < 1024 || maxJwksBytes > 524_288) {
      throw new TypeError("maxJwksBytes must be an integer between 1024 and 524288");
    }

    const rawJwksUri =
      typeof options.jwksUri === "string" && options.jwksUri.trim()
        ? options.jwksUri.trim()
        : `${expectedIssuer}/.well-known/jwks.json`;

    this.userPoolId = userPoolId;
    this.clientId = clientId;
    this.region = region;
    this.expectedIssuer = expectedIssuer;
    this.jwksUri = validateJwksUri(rawJwksUri, typeof options.fetchFn === "function");
    this.allowedTokenUse = tokenUseSet;
    this.clockSkewSeconds = clockSkewSeconds;
    this.jwksCacheTtlMs = jwksCacheTtlMs;
    this.unknownKidRefreshCooldownMs = unknownKidRefreshCooldownMs;
    this.fetchTimeoutMs = fetchTimeoutMs;
    this.maxJwksKeys = maxJwksKeys;
    this.maxJwksBytes = maxJwksBytes;
    this.fetchFn =
      options.fetchFn ??
      ((url, init) => fetch(url, init) as Promise<CognitoFetchResponse>);
    this.now = options.now ?? Date.now;
  }

  clearCache(): void {
    this.keyCache.clear();
    this.cacheExpiresAt = 0;
    this.lastFetchAt = 0;
  }

  private async fetchAndCacheJwks(force: boolean): Promise<void> {
    const nowMs = this.now();
    if (!force && this.keyCache.size > 0 && nowMs < this.cacheExpiresAt) {
      return;
    }

    if (this.inFlightFetch) {
      return this.inFlightFetch;
    }

    const refreshPromise = (async () => {
      let response: CognitoFetchResponse;
      try {
        response = await this.fetchFn(this.jwksUri, {
          method: "GET",
          headers: { Accept: "application/json" },
          signal: AbortSignal.timeout(this.fetchTimeoutMs),
        });
      } catch (err: any) {
        throw new CognitoJwksUnavailableError(
          `Failed to fetch Cognito JWKS: ${err?.message || String(err)}`,
        );
      }

      if (!response.ok) {
        throw new CognitoJwksUnavailableError(
          `Cognito JWKS endpoint returned HTTP ${response.status}`,
        );
      }

      let rawBody: string;
      try {
        rawBody = await response.text();
      } catch (err: any) {
        throw new CognitoJwksUnavailableError(
          `Failed reading Cognito JWKS body: ${err?.message || String(err)}`,
        );
      }

      if (Buffer.byteLength(rawBody, "utf8") > this.maxJwksBytes) {
        throw new CognitoJwksUnavailableError("Cognito JWKS response exceeds maximum size limit");
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(rawBody);
      } catch {
        throw new CognitoJwksUnavailableError("Cognito JWKS response is not valid JSON");
      }

      if (!isPlainObject(parsed) || !Array.isArray(parsed.keys)) {
        throw new CognitoJwksUnavailableError("Cognito JWKS payload missing keys array");
      }
      if (parsed.keys.length === 0 || parsed.keys.length > this.maxJwksKeys) {
        throw new CognitoJwksUnavailableError("Cognito JWKS keys array has unsupported length");
      }

      const nextCache = new Map<string, KeyObject>();
      for (const rawKey of parsed.keys) {
        if (!isPlainObject(rawKey)) continue;
        if (rawKey.kty !== "RSA") continue;
        if (rawKey.use !== undefined && rawKey.use !== "sig") continue;
        if (rawKey.alg !== undefined && rawKey.alg !== "RS256") continue;

        const kid = typeof rawKey.kid === "string" ? rawKey.kid.trim() : "";
        if (!KID_PATTERN.test(kid)) continue;
        if (typeof rawKey.n !== "string" || !rawKey.n || typeof rawKey.e !== "string" || !rawKey.e) {
          continue;
        }

        try {
          const keyObj = createPublicKey({
            key: { kty: "RSA", n: rawKey.n, e: rawKey.e },
            format: "jwk",
          });
          if (keyObj.type !== "public" || keyObj.asymmetricKeyType !== "rsa") {
            continue;
          }
          const modulusLength = keyObj.asymmetricKeyDetails?.modulusLength;
          if (modulusLength !== undefined && modulusLength < 2048) {
            continue;
          }
          nextCache.set(kid, keyObj);
        } catch {
          // Skip malformed key entry; valid keys in JWKS remain usable.
        }
      }

      if (nextCache.size === 0) {
        throw new CognitoJwksUnavailableError("Cognito JWKS contained no valid RSA signing keys");
      }

      const fetchedAt = this.now();
      this.keyCache = nextCache;
      this.lastFetchAt = fetchedAt;
      this.cacheExpiresAt = fetchedAt + this.jwksCacheTtlMs;
    })();

    this.inFlightFetch = refreshPromise;
    try {
      await refreshPromise;
    } finally {
      this.inFlightFetch = null;
    }
  }

  private async resolveSigningKey(kid: string, issuerHint: unknown): Promise<KeyObject> {
    const nowMs = this.now();
    const shouldFetch = this.keyCache.size === 0 || nowMs >= this.cacheExpiresAt;
    if (shouldFetch) {
      await this.fetchAndCacheJwks(true);
    }

    const cached = this.keyCache.get(kid);
    if (cached) {
      return cached;
    }

    const afterNowMs = this.now();
    const canRefreshUnknownKid =
      !shouldFetch &&
      issuerHint === this.expectedIssuer &&
      afterNowMs - this.lastFetchAt >= this.unknownKidRefreshCooldownMs;

    if (canRefreshUnknownKid) {
      await this.fetchAndCacheJwks(true);
      const refreshed = this.keyCache.get(kid);
      if (refreshed) {
        return refreshed;
      }
    }

    throw new CognitoTokenValidationError("Signing key identifier is unknown or expired");
  }

  async verifyToken(token: unknown): Promise<VerifiedCognitoClaims> {
    if (typeof token !== "string" || token.length < 32 || token.length > MAX_TOKEN_LENGTH) {
      throw new CognitoTokenValidationError("Invalid bearer token format");
    }

    const parts = token.split(".");
    if (parts.length !== 3) {
      throw new CognitoTokenValidationError("JWT must contain three segments");
    }
    const [headerB64, payloadB64, signatureB64] = parts;
    if (!BASE64URL_PATTERN.test(signatureB64)) {
      throw new CognitoTokenValidationError("Malformed JWT signature encoding");
    }
    const sigBuf = Buffer.from(signatureB64, "base64url");
    if (sigBuf.length === 0 || sigBuf.toString("base64url") !== signatureB64) {
      throw new CognitoTokenValidationError("Non-canonical JWT signature encoding");
    }

    const header = decodeBase64UrlJson(headerB64, "header");
    if (header.alg !== "RS256") {
      throw new CognitoTokenValidationError("Unsupported JWT signing algorithm");
    }
    if (header.crit !== undefined) {
      throw new CognitoTokenValidationError("Unsupported critical JWT header extension");
    }
    if (header.typ !== undefined && header.typ !== "JWT") {
      throw new CognitoTokenValidationError("Unsupported JWT token type header");
    }
    const kid = typeof header.kid === "string" ? header.kid.trim() : "";
    if (!KID_PATTERN.test(kid)) {
      throw new CognitoTokenValidationError("Missing or invalid JWT key identifier");
    }

    const payload = decodeBase64UrlJson(payloadB64, "payload");
    const signingKey = await this.resolveSigningKey(kid, payload.iss);

    const signingInput = Buffer.from(`${headerB64}.${payloadB64}`, "ascii");
    const verified = cryptoVerify("RSA-SHA256", signingInput, signingKey, sigBuf);
    if (!verified) {
      throw new CognitoTokenValidationError("Invalid JWT cryptographic signature");
    }

    if (typeof payload.iss !== "string" || payload.iss !== this.expectedIssuer) {
      throw new CognitoTokenValidationError("Token issuer mismatch");
    }

    const tokenUse = payload.token_use;
    if (
      (tokenUse !== "id" && tokenUse !== "access") ||
      !this.allowedTokenUse.has(tokenUse)
    ) {
      throw new CognitoTokenValidationError("Disallowed or missing Cognito token_use claim");
    }

    if (tokenUse === "id") {
      if (typeof payload.aud !== "string" || payload.aud !== this.clientId) {
        throw new CognitoTokenValidationError("Token audience mismatch");
      }
    } else if (typeof payload.client_id !== "string" || payload.client_id !== this.clientId) {
      throw new CognitoTokenValidationError("Token client_id mismatch");
    }

    const exp = payload.exp;
    const iat = payload.iat;
    if (
      typeof exp !== "number" ||
      typeof iat !== "number" ||
      !Number.isSafeInteger(exp) ||
      !Number.isSafeInteger(iat) ||
      iat < 0 ||
      exp <= iat
    ) {
      throw new CognitoTokenValidationError("Invalid JWT timestamp claims");
    }

    let nbf: number | undefined;
    if (payload.nbf !== undefined) {
      if (typeof payload.nbf !== "number" || !Number.isSafeInteger(payload.nbf) || payload.nbf < 0) {
        throw new CognitoTokenValidationError("Invalid JWT nbf claim");
      }
      nbf = payload.nbf;
    }

    const nowMs = this.now();
    if (!Number.isFinite(nowMs) || nowMs < 0) {
      throw new CognitoJwksUnavailableError("Invalid verifier clock state");
    }
    const nowSec = Math.floor(nowMs / 1000);
    if (nowSec >= exp + this.clockSkewSeconds) {
      throw new CognitoTokenValidationError("Token has expired");
    }
    if (iat > nowSec + this.clockSkewSeconds) {
      throw new CognitoTokenValidationError("Token issued in the future");
    }
    if (nbf !== undefined && nowSec + this.clockSkewSeconds < nbf) {
      throw new CognitoTokenValidationError("Token is not yet active");
    }

    const sub = typeof payload.sub === "string" ? payload.sub.trim() : "";
    if (!sub || sub.length > 128) {
      throw new CognitoTokenValidationError("Missing or invalid JWT subject claim");
    }

    let tenantId: string | undefined;
    const rawTenantId = payload["custom:tenant_id"];
    if (rawTenantId !== undefined) {
      if (typeof rawTenantId !== "string") {
        throw new CognitoTokenValidationError("Invalid custom:tenant_id claim type");
      }
      const trimmedTenantId = rawTenantId.trim();
      if (trimmedTenantId.length > 0) {
        if (!TENANT_ID_PATTERN.test(trimmedTenantId)) {
          throw new CognitoTokenValidationError("Invalid custom:tenant_id claim format");
        }
        tenantId = trimmedTenantId;
      }
    }

    const rawGroups = payload["cognito:groups"];
    let groups: string[] = [];
    if (rawGroups !== undefined) {
      if (
        !Array.isArray(rawGroups) ||
        rawGroups.length > 32 ||
        !rawGroups.every((g) => typeof g === "string" && g.trim().length > 0 && g.length <= 64)
      ) {
        throw new CognitoTokenValidationError("Invalid cognito:groups claim");
      }
      groups = rawGroups.map((g) => g.trim());
    }

    const email =
      typeof payload.email === "string" && payload.email.trim().length > 0
        ? payload.email.trim()
        : undefined;
    const name =
      typeof payload.name === "string" && payload.name.trim().length > 0
        ? payload.name.trim()
        : undefined;
    const cognitoUsername =
      typeof payload["cognito:username"] === "string" && payload["cognito:username"].trim().length > 0
        ? payload["cognito:username"].trim()
        : typeof payload.username === "string" && payload.username.trim().length > 0
          ? payload.username.trim()
          : undefined;

    return {
      sub,
      iss: payload.iss,
      tokenUse,
      aud: typeof payload.aud === "string" ? payload.aud : undefined,
      clientId: typeof payload.client_id === "string" ? payload.client_id : undefined,
      email,
      name,
      cognitoUsername,
      tenantId,
      groups,
      iat,
      exp,
      ...(nbf !== undefined ? { nbf } : {}),
    };
  }
}

const verifierCache = new Map<string, CognitoJwtVerifier>();

export function createCognitoJwtVerifierFromEnv(
  overrides: Partial<CognitoJwtVerifierOptions> = {},
): CognitoJwtVerifier | null {
  const userPoolId =
    overrides.userPoolId ?? (process.env.COGNITO_USER_POOL_ID || "").trim();
  const clientId =
    overrides.clientId ?? (process.env.COGNITO_CLIENT_ID || "").trim();

  if (!userPoolId && !clientId) {
    return null;
  }
  if (!userPoolId || !clientId) {
    throw new Error(
      "Both COGNITO_USER_POOL_ID and COGNITO_CLIENT_ID must be configured together",
    );
  }

  const region = overrides.region ?? ((process.env.COGNITO_REGION || "").trim() || undefined);
  const jwksUri = overrides.jwksUri ?? ((process.env.COGNITO_JWKS_URI || "").trim() || undefined);

  let allowedTokenUse = overrides.allowedTokenUse;
  if (!allowedTokenUse) {
    const rawUses = (process.env.COGNITO_ALLOWED_TOKEN_USE || "").trim();
    if (rawUses) {
      allowedTokenUse = rawUses
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean) as CognitoTokenUse[];
    }
  }

  const hasCustomHooks = Boolean(overrides.fetchFn || overrides.now || overrides.expectedIssuer);
  const cacheKey = `${userPoolId}|${clientId}|${region || ""}|${jwksUri || ""}|${(allowedTokenUse || ["id"]).join(",")}`;
  if (!hasCustomHooks) {
    const cached = verifierCache.get(cacheKey);
    if (cached) return cached;
  }

  const verifier = new CognitoJwtVerifier({
    ...overrides,
    userPoolId,
    clientId,
    region,
    jwksUri,
    allowedTokenUse,
  });

  if (!hasCustomHooks) {
    if (verifierCache.size >= MAX_CACHED_VERIFIERS) {
      const oldestKey = verifierCache.keys().next().value;
      if (oldestKey) verifierCache.delete(oldestKey);
    }
    verifierCache.set(cacheKey, verifier);
  }

  return verifier;
}

/**
 * Maps verified Cognito claims to the Express server's RBAC session model.
 * CRITICAL SECURITY INVARIANT:
 * - Cognito group "admin" represents a tenant-scoped company admin (per onboarding.ts)
 *   and NEVER maps to Express "superadmin".
 * - "superadmin" requires the "superadmin" Cognito group AND NO custom:tenant_id claim.
 * - "company" and "live_agent" require a valid custom:tenant_id claim.
 */
export function mapCognitoClaimsToSessionClaims(
  claims: VerifiedCognitoClaims,
): LocalSessionClaims | null {
  const groupSet = new Set(claims.groups);
  const fallbackEmail = claims.email || `${claims.sub}@cognito.local`;
  const displayName = claims.name || claims.cognitoUsername || claims.email || claims.sub;

  if (groupSet.has("superadmin")) {
    if (claims.tenantId !== undefined) {
      return null;
    }
    if (groupSet.has("admin") || groupSet.has("company") || groupSet.has("live_agent")) {
      return null;
    }
    return {
      sub: claims.sub,
      email: fallbackEmail,
      name: displayName,
      role: "superadmin",
      iat: claims.iat,
      exp: claims.exp,
    };
  }

  if (groupSet.has("admin") || groupSet.has("company")) {
    if (!claims.tenantId || !TENANT_ID_PATTERN.test(claims.tenantId)) {
      return null;
    }
    return {
      sub: claims.sub,
      email: fallbackEmail,
      name: displayName,
      role: "company",
      tenantId: claims.tenantId,
      iat: claims.iat,
      exp: claims.exp,
    };
  }

  if (groupSet.has("live_agent")) {
    if (!claims.tenantId || !TENANT_ID_PATTERN.test(claims.tenantId)) {
      return null;
    }
    return {
      sub: claims.sub,
      email: fallbackEmail,
      name: displayName,
      role: "live_agent",
      tenantId: claims.tenantId,
      iat: claims.iat,
      exp: claims.exp,
    };
  }

  return null;
}

function permissionsForTenantRole(role: TenantContext["role"]): string[] {
  switch (role) {
    case "admin":
      return ["billing:read", "billing:purchase", "usage:read", "faults:read", "faults:create"];
    case "live_agent":
      return ["billing:read", "usage:read", "faults:read", "faults:create"];
    case "staff":
    default:
      return ["billing:read", "usage:read", "faults:read", "faults:create"];
  }
}

export function mapCognitoClaimsToTenantIdentity(
  claims: VerifiedCognitoClaims,
):
  | { ok: true; claims: Partial<TenantContext> }
  | { ok: false; code: "FORBIDDEN"; reason: string; message: string } {
  const groupSet = new Set(claims.groups);

  if (groupSet.has("superadmin") && claims.tenantId !== undefined) {
    return {
      ok: false,
      code: "FORBIDDEN",
      reason: "INVALID_TENANT_SCOPE",
      message: "Platform superadmin credentials cannot be scoped to custom:tenant_id",
    };
  }

  let role: TenantContext["role"] = "staff";
  if (groupSet.has("admin") || groupSet.has("company")) {
    role = "admin";
  } else if (groupSet.has("live_agent")) {
    role = "live_agent";
  }

  return {
    ok: true,
    claims: {
      tenantId: claims.tenantId,
      userId: claims.sub,
      role,
      permissions: permissionsForTenantRole(role),
    },
  };
}

export function mapCognitoClaimsToOnboardingCaller(
  claims: VerifiedCognitoClaims,
): { authorized: boolean; callerRole: string; reason?: string } {
  const groupSet = new Set(claims.groups);

  let callerRole = "unknown";
  if (groupSet.has("superadmin")) callerRole = "superadmin";
  else if (groupSet.has("staff")) callerRole = "staff";
  else if (groupSet.has("admin") || groupSet.has("company")) callerRole = "admin";
  else if (groupSet.has("live_agent")) callerRole = "live_agent";

  if (claims.tenantId !== undefined) {
    return {
      authorized: false,
      callerRole,
      reason: "TENANT_SCOPED_CALLER_FORBIDDEN",
    };
  }

  if (
    (callerRole === "superadmin" || callerRole === "staff") &&
    !groupSet.has("admin") &&
    !groupSet.has("company") &&
    !groupSet.has("live_agent")
  ) {
    return { authorized: true, callerRole };
  }

  return {
    authorized: false,
    callerRole,
    reason: "INSUFFICIENT_PLATFORM_ROLE",
  };
}
