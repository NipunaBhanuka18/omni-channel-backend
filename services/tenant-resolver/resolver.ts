import { TenantContext } from "../../shared/types/tenant-context";
import { AgentActionResponse } from "../../shared/types/agent-action";
import { decodeMockCognitoJwt } from "./mock-jwt-validator";
import {
  CognitoJwksUnavailableError,
  CognitoJwtVerifier,
  createCognitoJwtVerifierFromEnv,
  mapCognitoClaimsToTenantIdentity,
} from "../auth/cognito-jwt-verifier";
import { extractBearerToken } from "../auth/local-session-token";
import { randomUUID } from "crypto";

export interface TenantResolverResult {
  success: boolean;
  context?: TenantContext;
  error?: AgentActionResponse["error"];
}

export interface TenantResolverDeps {
  cognitoVerifier?: CognitoJwtVerifier | null;
}

const ALLOWED_CHANNELS: TenantContext["channel"][] = [
  "web",
  "whatsapp",
  "sms",
  "messenger",
];

const SAFE_TRACE_ID_PATTERN = /^[a-zA-Z0-9._:@-]{1,128}$/;

function isProductionLike(): boolean {
  const nodeEnv = (process.env.NODE_ENV || "").trim().toLowerCase();
  return nodeEnv === "production" || nodeEnv === "prod" || process.env.IS_LOCAL === "false";
}

function normalizeHeaders(
  headers: Record<string, string | undefined>,
): Record<string, string | undefined> {
  const normalizedHeaders: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (value !== undefined) {
      normalizedHeaders[key.toLowerCase()] = value;
    }
  }
  return normalizedHeaders;
}

function buildTenantContextResult(
  decodedClaims: Partial<TenantContext>,
  normalizedHeaders: Record<string, string | undefined>,
): TenantResolverResult {
  const tenantIdHeader = normalizedHeaders["x-tenant-id"];
  const channelHeader = normalizedHeaders["x-channel"];
  const sessionIdHeader = normalizedHeaders["x-session-id"];
  const conversationIdHeader = normalizedHeaders["x-conversation-id"];

  const tokenTenantId = decodedClaims.tenantId;
  if (!tokenTenantId) {
    return {
      success: false,
      error: {
        code: "FORBIDDEN",
        message:
          "Authenticated token carries no tenant claim (custom:tenant_id). Request rejected.",
        retryable: false,
        details: { reason: "TENANT_CLAIM_MISSING" },
      },
    };
  }

  if (tenantIdHeader && tenantIdHeader.trim() && tenantIdHeader.trim() !== tokenTenantId) {
    return {
      success: false,
      error: {
        code: "FORBIDDEN",
        message: `x-tenant-id header ('${tenantIdHeader.trim()}') does not match the tenant bound to the authenticated token ('${tokenTenantId}').`,
        retryable: false,
        details: { reason: "TENANT_MISMATCH", httpStatus: 403 },
      },
    };
  }

  let channel: TenantContext["channel"] = "web";
  if (
    channelHeader &&
    ALLOWED_CHANNELS.includes(channelHeader.toLowerCase() as TenantContext["channel"])
  ) {
    channel = channelHeader.toLowerCase() as TenantContext["channel"];
  }

  const trimmedSessionId = sessionIdHeader?.trim();
  const sessionId =
    trimmedSessionId && SAFE_TRACE_ID_PATTERN.test(trimmedSessionId)
      ? trimmedSessionId
      : `sess-${randomUUID()}`;

  /**
   * ARCHITECTURAL NOTE ON conversationId vs sessionId:
   * - sessionId represents the broader authenticated user session, which persists across multiple actions and user interactions.
   * - conversationId tracks a specific, individual conversation thread. Multiple conversationIds can exist sequentially or concurrently within a single user sessionId.
   */
  const trimmedConvId = conversationIdHeader?.trim();
  const conversationId =
    trimmedConvId && SAFE_TRACE_ID_PATTERN.test(trimmedConvId)
      ? trimmedConvId
      : `conv-${randomUUID()}`;

  const context: TenantContext = {
    tenantId: tokenTenantId,
    userId: decodedClaims.userId || "dev-user-001",
    role: decodedClaims.role || "staff",
    permissions: decodedClaims.permissions || ["billing:read", "usage:read", "faults:read"],
    channel,
    sessionId,
    conversationId,
  };

  return {
    success: true,
    context,
  };
}

/**
 * Resolves incoming HTTP request headers into a strictly typed TenantContext object
 * using the dev-only synchronous mock JWT decoder. Preserved for unit/local scripts;
 * live request paths use `resolveTenantContextVerified`.
 */
export function resolveTenantContext(
  headers: Record<string, string | undefined>,
): TenantResolverResult {
  const normalizedHeaders = normalizeHeaders(headers);
  const authorizationHeader = normalizedHeaders["authorization"];

  if (!authorizationHeader || !authorizationHeader.trim()) {
    return {
      success: false,
      error: {
        code: "UNAUTHORIZED",
        message: "Missing or empty Authorization header. Expected format: 'Bearer <token>'",
        retryable: false,
        details: { requiredHeader: "Authorization" },
      },
    };
  }

  let decodedClaims: Partial<TenantContext>;
  try {
    decodedClaims = decodeMockCognitoJwt(authorizationHeader);
  } catch (err) {
    return {
      success: false,
      error: {
        code: "UNAUTHORIZED",
        message: `Invalid or malformed Authorization token: ${(err as Error).message}`,
        retryable: false,
      },
    };
  }

  return buildTenantContextResult(decodedClaims, normalizedHeaders);
}

/**
 * Production-capable async zero-trust tenant resolver:
 * - Verifies Cognito RS256 JWKS JWTs cryptographically whenever configured (and REQUIRED in production).
 * - Never falls back to unsigned mock JWT decoding in production or when Cognito is configured.
 * - Derives tenant identity exclusively from verified token claims (`custom:tenant_id`).
 */
export async function resolveTenantContextVerified(
  headers: Record<string, string | undefined>,
  deps: TenantResolverDeps = {},
): Promise<TenantResolverResult> {
  const normalizedHeaders = normalizeHeaders(headers);
  const authorizationHeader = normalizedHeaders["authorization"];

  if (!authorizationHeader || !authorizationHeader.trim()) {
    return {
      success: false,
      error: {
        code: "UNAUTHORIZED",
        message: "Missing or empty Authorization header. Expected format: 'Bearer <token>'",
        retryable: false,
        details: { requiredHeader: "Authorization" },
      },
    };
  }

  let verifier: CognitoJwtVerifier | null = null;
  try {
    verifier =
      deps.cognitoVerifier !== undefined
        ? deps.cognitoVerifier
        : createCognitoJwtVerifierFromEnv();
  } catch (err: any) {
    return {
      success: false,
      error: {
        code: "INTERNAL_ERROR",
        message: `Authentication configuration error: ${err?.message || String(err)}`,
        retryable: false,
      },
    };
  }

  if (isProductionLike() && !verifier) {
    return {
      success: false,
      error: {
        code: "INTERNAL_ERROR",
        message: "Cognito JWT verifier is required outside local development",
        retryable: false,
      },
    };
  }

  if (verifier) {
    const token = extractBearerToken(authorizationHeader);
    if (!token) {
      return {
        success: false,
        error: {
          code: "UNAUTHORIZED",
          message: "Invalid or missing Authorization header. Expected format: 'Bearer <token>'",
          retryable: false,
        },
      };
    }

    try {
      const verified = await verifier.verifyToken(token);
      const mapped = mapCognitoClaimsToTenantIdentity(verified);
      if (!mapped.ok) {
        return {
          success: false,
          error: {
            code: mapped.code,
            message: mapped.message,
            retryable: false,
            details: { reason: mapped.reason, httpStatus: 403 },
          },
        };
      }
      return buildTenantContextResult(mapped.claims, normalizedHeaders);
    } catch (err: any) {
      if (err instanceof CognitoJwksUnavailableError) {
        return {
          success: false,
          error: {
            code: "INTERNAL_ERROR",
            message: err.message,
            retryable: true,
          },
        };
      }
      return {
        success: false,
        error: {
          code: "UNAUTHORIZED",
          message: `Invalid or malformed Authorization token: ${err?.message || String(err)}`,
          retryable: false,
        },
      };
    }
  }

  // Local non-production fallback only when Cognito isn't configured and mock auth is permitted.
  let decodedClaims: Partial<TenantContext>;
  try {
    decodedClaims = decodeMockCognitoJwt(authorizationHeader);
  } catch (err) {
    return {
      success: false,
      error: {
        code: "UNAUTHORIZED",
        message: `Invalid or malformed Authorization token: ${(err as Error).message}`,
        retryable: false,
      },
    };
  }

  return buildTenantContextResult(decodedClaims, normalizedHeaders);
}
