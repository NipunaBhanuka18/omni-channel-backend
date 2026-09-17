import { TenantContext } from "../../shared/types/tenant-context";
import { AgentActionResponse } from "../../shared/types/agent-action";
import { agentRegistry } from "../registry";
import { PutCommand } from "@aws-sdk/lib-dynamodb";
import { docClient } from "../utils/dynamo-client";

export const handler = async (event: {
  context: TenantContext;
  intent: string;
  params: Record<string, any>;
}): Promise<AgentActionResponse> => {
  
  const { context: tenantContext, intent, params } = event;
  console.log(`[Main Agent] Received intent '${intent}' for session ${tenantContext.sessionId}`);

  // 1. SAVE CONVERSATION STATE TO DYNAMODB
  try {
    await docClient.send(new PutCommand({
      TableName: "omni-channel-conversations",
      Item: {
        conversationId: tenantContext.conversationId,
        sessionId: tenantContext.sessionId,
        tenantId: tenantContext.tenantId,
        userId: tenantContext.userId,
        intent: intent,
        status: "ROUTED",
        timestamp: new Date().toISOString()
      }
    }));
    console.log(`[Main Agent] ✅ Saved conversation state to DynamoDB for conv: ${tenantContext.conversationId}`);
  } catch (dbError) {
    console.error("[Main Agent] ❌ Failed to save to DynamoDB:", dbError);
    // We don't want to fail the whole request if DB logging fails, so we continue
  }

  // 2. Dynamic Lookup: Find the agent that handles this intent
  const targetAgentHandler = agentRegistry[intent];

  // 3. If no agent is registered for this intent, fail gracefully
  if (!targetAgentHandler) {
    return {
      success: false,
      error: {
        code: "NO_ROUTING_MATCH",
        message: `Main Agent could not route intent: ${intent}`,
        retryable: false
      }
    };
  }

  // 4. Execute the dynamic agent
  try {
    return await targetAgentHandler(tenantContext, params);
  } catch (error) {
    console.error("[Main Agent] Unhandled error during routing:", error);
    return {
      success: false,
      error: {
        code: "INTERNAL_ERROR",
        message: "An unexpected error occurred in the Main Agent.",
        retryable: false
      }
    };
  }
};