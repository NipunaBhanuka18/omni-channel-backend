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
 * Enforces Zero-Trust tenant validation and spoofing detection (Member 2 Scope).
 *
 * @param headers Map of incoming HTTP headers (case-insensitive keys supported)
 * @returns TenantResolverResult containing either the resolved TenantContext or a structured AgentActionResponse error.
 */
export function resolveTenantContext(
  headers: Record<string, string | undefined>
): TenantResolverResult {
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

  // Validate missing Authorization header
  if (!authorizationHeader || !authorizationHeader.trim()) {
    return {
      success: false,
      error: {
        code: "UNAUTHORIZED",
        message:
          "Missing or empty Authorization header. Expected format: 'Bearer <token>'",
        retryable: false,
        details: { requiredHeader: "Authorization" },
      },
    };
  }

  // Validate missing x-tenant-id header
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

  // Decode token via JWT validator
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

  // STRICT TENANT ISOLATION CHECK (ZERO-TRUST SPOOFING GUARD)
  const tokenTenantId = decodedClaims.tenantId;
  const requestedTenantId = tenantIdHeader.trim();

  if (tokenTenantId && tokenTenantId !== requestedTenantId) {
    return {
      success: false,
      error: {
        code: "FORBIDDEN",
        message: `Tenant ID spoofing detected. Token tenant '${tokenTenantId}' does not match requested header tenant '${requestedTenantId}'.`,
        retryable: false,
        details: { tokenTenantId, requestedTenantId },
      },
    };
  }

  const tenantId = tokenTenantId || requestedTenantId;

  // Resolve Channel
  let channel: TenantContext["channel"] = "web";
  if (
    channelHeader &&
    ALLOWED_CHANNELS.includes(
      channelHeader.toLowerCase() as TenantContext["channel"]
    )
  ) {
    channel = channelHeader.toLowerCase() as TenantContext["channel"];
  }

  // Resolve Session ID
  const sessionId =
    sessionIdHeader && sessionIdHeader.trim()
      ? sessionIdHeader.trim()
      : `sess-${randomUUID()}`;

  // Resolve Conversation ID
  const conversationId =
    conversationIdHeader && conversationIdHeader.trim()
      ? conversationIdHeader.trim()
      : `conv-${randomUUID()}`;

  const context: TenantContext = {
    tenantId,
    userId: decodedClaims.userId || "dev-user-001",
    role: decodedClaims.role || "staff",
    permissions: decodedClaims.permissions || [
      "billing:read",
      "usage:read",
      "faults:read",
    ],
    channel,
    sessionId,
    conversationId,
  };

  return {
    success: true,
    context,
  };
}
