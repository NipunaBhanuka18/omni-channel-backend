import { TenantContext } from "../../shared/types/tenant-context";
import { AgentActionResponse } from "../../shared/types/agent-action";

export interface TenantConfig {
  tenantId: string;
  name: string;
  status: "active" | "suspended" | "inactive";
  allowedChannels: TenantContext["channel"][];
  defaultAgent: string;
}

export interface RoutingDecisionData {
  targetAgent: string;
  tenantContext: TenantContext;
  routedAt: string;
}

export interface RoutingDecisionResult {
  success: boolean;
  data?: RoutingDecisionData;
  error?: AgentActionResponse["error"];
}

/**
 * Multi-Tenant Registry Store
 * Configured so adding a second tenant later is a simple configuration addition without logic changes.
 */
export const TENANT_REGISTRY: Record<string, TenantConfig> = {
  slt: {
    tenantId: "slt",
    name: "Sri Lanka Telecom",
    status: "active",
    allowedChannels: ["web", "whatsapp", "sms", "messenger"],
    defaultAgent: "main-agent",
  },
  "tenant-test-123": {
    tenantId: "tenant-test-123",
    name: "Test Tenant 123",
    status: "active",
    allowedChannels: ["web", "whatsapp", "sms", "messenger"],
    defaultAgent: "main-agent",
  },
};

/**
 * Evaluates a TenantContext against tenant configuration and returns a routing decision.
 *
 * @param context Resolved TenantContext
 * @returns RoutingDecisionResult with targetAgent handoff boundary or error
 */
export function routeRequest(context: TenantContext): RoutingDecisionResult {
  const tenantConfig = TENANT_REGISTRY[context.tenantId];

  if (!tenantConfig) {
    console.warn(`[TenantRouter] Routing failed: Tenant '${context.tenantId}' not found in registry.`);
    return {
      success: false,
      error: {
        code: "TENANT_NOT_FOUND",
        message: `Tenant '${context.tenantId}' is not configured in the platform registry`,
        retryable: false,
        details: { tenantId: context.tenantId },
      },
    };
  }

  if (tenantConfig.status !== "active") {
    console.warn(`[TenantRouter] Routing failed: Tenant '${context.tenantId}' status is '${tenantConfig.status}'.`);
    return {
      success: false,
      error: {
        code: "TENANT_INACTIVE",
        message: `Tenant '${context.tenantId}' account is currently ${tenantConfig.status}`,
        retryable: false,
        details: { tenantId: context.tenantId, status: tenantConfig.status },
      },
    };
  }

  const targetAgent = tenantConfig.defaultAgent;
  const routedAt = new Date().toISOString();

  // Log routing decision clearly as handoff boundary
  console.log(
    `[TenantRouter] Successfully routed request for tenant '${context.tenantId}' ` +
      `(user: '${context.userId}', channel: '${context.channel}', conversationId: '${context.conversationId}') ` +
      `-> targetAgent: '${targetAgent}'`
  );

  return {
    success: true,
    data: {
      targetAgent,
      tenantContext: context,
      routedAt,
    },
  };
}
