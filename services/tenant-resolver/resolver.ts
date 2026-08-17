import { TenantContext } from "../../shared/types/tenant-context";
import { AgentActionResponse } from "../../shared/types/agent-action";
import { decodeMockAzureJwt } from "./mock-jwt-validator";
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

  // 2. Validate missing x-tenant-id header
  if (!tenantIdHeader || !tenantIdHeader.trim()) {
    return {
      success: false,
      error: {
        code: "BAD_REQUEST",
        message: "Missing or empty x-tenant-id header",
        retryable: false,
        details: { requiredHeader: "x-tenant-id" },
      },
    };
  }

  // 3. Decode token via dev-only mock validator
  let decodedClaims: Partial<TenantContext>;
  try {
    decodedClaims = decodeMockAzureJwt(authorizationHeader);
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
    tenantId: tenantIdHeader.trim(),
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
