import { resolveTenantContext } from "../tenant-resolver/resolver";
import { routeRequest, RoutingDecisionResult } from "./router";
import { AgentActionResponse } from "../../shared/types/agent-action";

export interface HttpRequestPayload {
  headers: Record<string, string | undefined>;
  body?: Record<string, any>;
}

/**
 * Handles incoming API request payload through the Tenant Resolver and Tenant Runtime Router pipeline.
 *
 * @param request Incoming HTTP request containing headers and optional body
 * @returns AgentActionResponse shape (success: boolean, data?: RoutingDecisionData, error?: structuredError)
 */
export function handleTenantRequest(request: HttpRequestPayload): AgentActionResponse {
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

  // Step 3: Return successful routing decision as AgentActionResponse
  return {
    success: true,
    data: routerResult.data,
  };
}
