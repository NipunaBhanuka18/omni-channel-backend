import { resolveTenantContext } from "../tenant-resolver/resolver";
import { routeRequest, RoutingDecisionResult } from "./router";
import { AgentActionResponse } from "../../shared/types/agent-action";
import { getRequiredPermissionForIntent } from "./permission-map";
import { handler as mainAgentHandler } from "../../agents/main-agent/handler";

export interface HttpRequestPayload {
  headers: Record<string, string | undefined>;
  body?: Record<string, any>;
}

/**
 * Handles incoming API request payload through the Tenant Resolver, Tenant Runtime Router, and Main Agent pipeline.
 *
 * @param request Incoming HTTP request containing headers and optional body
 * @returns AgentActionResponse shape
 */
export async function handleTenantRequest(request: HttpRequestPayload): Promise<AgentActionResponse> {
  // Step 1: Resolve Tenant Context from headers
  const resolverResult = resolveTenantContext(request.headers);

  if (!resolverResult.success || !resolverResult.context) {
    return {
      success: false,
      error: resolverResult.error || {
        code: "INTERNAL_ERROR",
        message: "Tenant resolution failed without error details",
        retryable: false,
      },
    };
  }

  // Step 2: Route request using resolved TenantContext
  const routerResult: RoutingDecisionResult = routeRequest(resolverResult.context);

  if (!routerResult.success || !routerResult.data) {
    return {
      success: false,
      error: routerResult.error || {
        code: "ROUTING_FAILED",
        message: "Tenant routing failed without error details",
        retryable: false,
      },
    };
  }

  // Step 3: Validate required intent field from body (no fallback default)
  const intent = request.body?.intent;
  if (!intent || typeof intent !== "string" || intent.trim() === "") {
    return {
      success: false,
      error: {
        code: "BAD_REQUEST",
        message: "Missing required request body field: 'intent'",
        retryable: false,
        details: { requiredField: "intent" },
      },
    };
  }

  const params = request.body?.params || {};
  const cleanIntent = intent.trim();

  // Step 4: RBAC Permission Enforcement
  const requiredPermission = getRequiredPermissionForIntent(cleanIntent);

  // Fail closed if intent is not mapped in permission matrix
  if (!requiredPermission) {
    return {
      success: false,
      error: {
        code: "FORBIDDEN",
        message: `Access denied: Intent '${cleanIntent}' is unmapped and denied by security policy.`,
        retryable: false,
        details: { requiredPermission: "none (unmapped_intent)" },
      },
    };
  }

  const userPermissions = routerResult.data.tenantContext.permissions || [];
  if (!userPermissions.includes(requiredPermission)) {
    return {
      success: false,
      error: {
        code: "FORBIDDEN",
        message: "Access denied: Missing required permission for requested intent",
        retryable: false,
        details: { requiredPermission },
      },
    };
  }

  // Step 5: Invoke Main Agent handler (if targetAgent is main-agent)
  if (routerResult.data.targetAgent === "main-agent") {
    return await mainAgentHandler({
      context: routerResult.data.tenantContext,
      intent: cleanIntent,
      params: params,
    });
  }

  // Fallback for other target agents if added in future
  return {
    success: true,
    data: routerResult.data,
  };
}

