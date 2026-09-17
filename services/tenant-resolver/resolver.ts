import { TenantContext } from "../../shared/types/tenant-context";
import { AgentActionResponse } from "../../shared/types/agent-action";
import { decodeMockCognitoJwt } from "./mock-jwt-validator";
import { randomUUID } from "crypto";

export interface TenantResolverResult {
  success: boolean;
  context?: TenantContext;
  error?: AgentActionResponse["error"];
}

const ALLOWED_CHANNELS: TenantContext["channel"][] = [
  "web",
  "whatsapp",
  "sms",
  "messenger",
];

/**
 * Resolves incoming HTTP request headers into a strictly typed TenantContext object.
 *
 * ZERO-TRUST TENANT RESOLUTION (ADR-010 / KI: spoofing guard):
 * Tenant identity comes exclusively from the verified token's `custom:tenant_id`
 * claim (see mock-jwt-validator.ts). The client-supplied `x-tenant-id` header is
 * NEVER used as a source of truth — it is accepted only as an optional consistency
 * check. If present and it disagrees with the token's tenant, the request is
 * rejected outright with 403 FORBIDDEN (TENANT_MISMATCH) rather than silently
 * trusting either value. This closes the previous hole where `x-tenant-id` alone
 * decided tenant context, letting any caller impersonate any tenant.
 *
 * @param headers Map of incoming HTTP headers (case-insensitive keys supported)
 * @returns TenantResolverResult containing either the resolved TenantContext or a structured AgentActionResponse error.
 */
export function resolveTenantContext(
  headers: Record<string, string | undefined>
): TenantResolverResult {
  // Normalize header keys to lowercase for robust lookup
  const normalizedHeaders: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (value !== undefined) {
      normalizedHeaders[key.toLowerCase()] = value;
    }
  }

  const authorizationHeader = normalizedHeaders["authorization"];
  const tenantIdHeader = normalizedHeaders["x-tenant-id"];
  const channelHeader = normalizedHeaders["x-channel"];
  const sessionIdHeader = normalizedHeaders["x-session-id"];
  const conversationIdHeader = normalizedHeaders["x-conversation-id"];

  // 1. Validate missing Authorization header
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

  // 2. Decode token via dev-only mock validator
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

  // 3. Zero-trust tenant resolution.
  const tokenTenantId = decodedClaims.tenantId;

  // 3a. Fail closed if the authenticated token carries no tenant claim at all.
  //     (Dev shortcut tokens like "dev-token-staff" hit this too, by design —
  //     use a 3-part mock JWT with a custom:tenant_id claim to test tenant flows.)
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

  // 3b. If the caller also sent x-tenant-id, it must agree with the token's
  //     tenant. Disagreement is treated as spoofing, not as "pick one".
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

  // 4. Resolve Channel with fallback default ("web")
  let channel: TenantContext["channel"] = "web";
  if (channelHeader && ALLOWED_CHANNELS.includes(channelHeader.toLowerCase() as TenantContext["channel"])) {
    channel = channelHeader.toLowerCase() as TenantContext["channel"];
  }

  // 5. Resolve Session ID (reuse existing header if provided, otherwise generate new sess-<uuid>)
  const sessionId =
    sessionIdHeader && sessionIdHeader.trim()
      ? sessionIdHeader.trim()
      : `sess-${randomUUID()}`;

  // 6. Resolve Conversation ID (reuse existing header if provided, otherwise generate new conv-<uuid>)
  /**
   * ARCHITECTURAL NOTE ON conversationId vs sessionId:
   * - sessionId represents the broader authenticated user session, which persists across multiple actions and user interactions.
   * - conversationId tracks a specific, individual conversation thread. Multiple conversationIds can exist sequentially or concurrently within a single user sessionId.
   */
  const conversationId =
    conversationIdHeader && conversationIdHeader.trim()
      ? conversationIdHeader.trim()
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