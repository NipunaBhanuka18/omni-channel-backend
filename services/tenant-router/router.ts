import { GetCommand, DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { docClient } from "../../agents/utils/dynamo-client";
import { inMemoryTenants } from "../../scripts/create-tenants-table";
import { TenantContext } from "../../shared/types/tenant-context";
import { AgentActionResponse } from "../../shared/types/agent-action";

export interface TenantConfig {
  tenantId: string;
  name: string;
  /**
   * Lowercased/trimmed form of `name` (see shared/utils/tenant-name.ts), stored so
   * the NormalizedNameIndex GSI on omni-channel-tenants can catch a company being
   * onboarded twice under different capitalization/spacing. Optional here because
   * routing itself never needs it — only onboarding's duplicate check does.
   */
  normalizedName?: string;
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

export interface TenantRouterDeps {
  dynamo: DynamoDBDocumentClient;
}

function defaultDeps(): TenantRouterDeps {
  return { dynamo: docClient };
}

export async function routeRequest(
  context: TenantContext,
  deps?: TenantRouterDeps
): Promise<RoutingDecisionResult> {
  const { dynamo } = deps || defaultDeps();

  let tenantConfig: TenantConfig | undefined;
  try {
    const result = await dynamo.send(
      new GetCommand({ TableName: "omni-channel-tenants", Key: { tenantId: context.tenantId } })
    );
    tenantConfig = result.Item as TenantConfig | undefined;
  } catch (err: any) {
    // If running in local standalone mode without LocalStack, fall back to in-memory store
    if (!deps && (err?.code === "ECONNREFUSED" || err?.message?.includes("ECONNREFUSED") || err?.message?.includes("connect"))) {
      console.warn(`[TenantRouter] LocalStack offline. Using in-memory store fallback for tenant '${context.tenantId}'.`);
      const fallback = inMemoryTenants.get(context.tenantId);
      if (fallback) {
        tenantConfig = {
          tenantId: fallback.tenantId,
          name: fallback.companyName || (fallback as any).name || context.tenantId,
          status: (fallback.status as any) || "active",
          allowedChannels: ["web", "whatsapp", "sms", "messenger"],
          defaultAgent: (fallback as any).defaultAgent || "main-agent",
        };
      }
    }

    if (!tenantConfig) {
      console.error(`[TenantRouter] DynamoDB lookup failed for tenant '${context.tenantId}':`, err);
      return {
        success: false,
        error: {
          code: "INTERNAL_ERROR",
          message: `Failed to look up tenant configuration: ${(err as Error).message}`,
          retryable: true,
          details: { tenantId: context.tenantId },
        },
      };
    }
  }

  if (!tenantConfig) {
    console.warn(`[TenantRouter] Routing failed: Tenant '${context.tenantId}' not found in omni-channel-tenants.`);
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