import { TenantContext } from "../../shared/types/tenant-context";
import { AgentActionResponse } from "../../shared/types/agent-action";
import { agentRegistry } from "../registry";

export interface AgentCoreSessionState {
  sessionId: string;
  tenantId: string;
  userId: string;
  channel: string;
  metadata: Record<string, any>;
}

/**
 * Amazon Bedrock AgentCore Supervisor Adapter
 * Provides microVM session state encapsulation and supervisor routing to specialized sub-agents.
 */
export class BedrockAgentCoreSupervisor {
  /**
   * Initializes an isolated session context for Bedrock AgentCore execution.
   */
  static createIsolatedSession(context: TenantContext): AgentCoreSessionState {
    if (!context || !context.tenantId) {
      throw new Error("[AgentCore Security Error] Cannot initialize microVM session without authenticated TenantContext.");
    }

    return {
      sessionId: context.sessionId,
      tenantId: context.tenantId,
      userId: context.userId,
      channel: context.channel,
      metadata: {
        conversationId: context.conversationId,
        role: context.role,
        permissions: context.permissions,
        bedrockAgentId: `bedrock-agent-${context.tenantId}-supervisor`,
      },
    };
  }

  /**
   * Supervisor Delegation Method: Routes intent to sub-agents (Billing, Usage, Support).
   */
  static async delegateToSubAgent(
    intent: string,
    context: TenantContext,
    params: Record<string, any>
  ): Promise<AgentActionResponse> {
    const session = this.createIsolatedSession(context);
    console.log(`[Bedrock AgentCore] Session '${session.sessionId}' [Tenant: ${session.tenantId}] delegating intent '${intent}' to sub-agent.`);

    const subAgentHandler = agentRegistry[intent];

    if (!subAgentHandler) {
      return {
        success: false,
        error: {
          code: "NO_SUB_AGENT_MATCH",
          message: `Bedrock AgentCore Supervisor could not delegate unmapped intent: ${intent}`,
          retryable: false,
          details: { intent, tenantId: context.tenantId },
        },
      };
    }

    return await subAgentHandler(context, params);
  }
}
