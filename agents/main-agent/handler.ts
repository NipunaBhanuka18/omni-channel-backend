import { TenantContext } from "../../shared/types/tenant-context";
import { AgentActionResponse } from "../../shared/types/agent-action";
import { BedrockAgentCoreSupervisor } from "./bedrock-adapter";
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
    await docClient.send(
      new PutCommand({
        TableName: "omni-channel-conversations",
        Item: {
          conversationId: tenantContext.conversationId,
          sessionId: tenantContext.sessionId,
          tenantId: tenantContext.tenantId,
          userId: tenantContext.userId,
          intent: intent,
          status: "ROUTED",
          timestamp: new Date().toISOString(),
        },
      })
    );
    console.log(`[Main Agent] ✅ Saved conversation state to DynamoDB for conv: ${tenantContext.conversationId}`);
  } catch (dbError) {
    console.error("[Main Agent] ❌ Failed to save to DynamoDB:", dbError);
  }

  // 2. Bedrock AgentCore Supervisor Delegation
  try {
    return await BedrockAgentCoreSupervisor.delegateToSubAgent(intent, tenantContext, params);
  } catch (error) {
    console.error("[Main Agent] Unhandled error during Bedrock AgentCore supervisor routing:", error);
    return {
      success: false,
      error: {
        code: "INTERNAL_ERROR",
        message: "An unexpected error occurred in the Main Agent Bedrock Supervisor.",
        retryable: false,
      },
    };
  }
};