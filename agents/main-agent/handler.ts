import { TenantContext } from "../../shared/types/tenant-context";
import { AgentActionResponse } from "../../shared/types/agent-action";
import { agentRegistry } from "../registry";

export const handler = async (event: {
  context: TenantContext;
  intent: string;
  params: Record<string, any>;
}): Promise<AgentActionResponse> => {
  const { context: tenantContext, intent, params } = event;
  console.log(
    `[Main Agent] Received intent '${intent}' for session ${tenantContext.sessionId}`,
  );

  // 1. Dynamic Lookup: Find the agent that handles this intent
  const targetAgentHandler = agentRegistry[intent];

  // 2. If no agent is registered for this intent, fail gracefully
  if (!targetAgentHandler) {
    return {
      success: false,
      error: {
        code: "NO_ROUTING_MATCH",
        message: `Main Agent could not route intent: ${intent}`,
        retryable: false,
      },
    };
  }

  // 3. Execute the dynamic agent
  try {
    return await targetAgentHandler(tenantContext, params);
  } catch (error) {
    console.error("[Main Agent] Unhandled error during routing:", error);
    return {
      success: false,
      error: {
        code: "INTERNAL_ERROR",
        message: "An unexpected error occurred in the Main Agent.",
        retryable: false,
      },
    };
  }
};
