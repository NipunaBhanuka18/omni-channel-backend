import { setAgentPresence, getAgentPresence } from "./presence-manager";
import { requestHumanHandoff, resolveChatSession, getSessionStatus } from "./escalation-engine";
import { AgentActionResponse } from "../../shared/types/agent-action";

export interface HandoffApiRequest {
  action: "presence_online" | "presence_offline" | "presence_status" | "request_handoff" | "resolve_session" | "session_status";
  tenantId: string;
  agentId?: string;
  sessionId?: string;
  connectionId?: string;
  customerName?: string;
  issueSummary?: string;
}

/**
 * REST/WebSocket Ingress Handler for Presence and Handoff Operations (Member 1 Integration).
 */
export async function handleHandoffApi(request: HandoffApiRequest): Promise<AgentActionResponse> {
  const { action, tenantId } = request;

  if (!tenantId) {
    return {
      success: false,
      error: {
        code: "BAD_REQUEST",
        message: "Missing required field: 'tenantId'",
        retryable: false,
      },
    };
  }

  try {
    switch (action) {
      case "presence_online": {
        if (!request.agentId) {
          return { success: false, error: { code: "BAD_REQUEST", message: "Missing agentId", retryable: false } };
        }
        const record = await setAgentPresence(tenantId, request.agentId, "AVAILABLE", request.connectionId);
        return { success: true, data: record };
      }

      case "presence_offline": {
        if (!request.agentId) {
          return { success: false, error: { code: "BAD_REQUEST", message: "Missing agentId", retryable: false } };
        }
        const record = await setAgentPresence(tenantId, request.agentId, "OFFLINE");
        return { success: true, data: record };
      }

      case "presence_status": {
        if (!request.agentId) {
          return { success: false, error: { code: "BAD_REQUEST", message: "Missing agentId", retryable: false } };
        }
        const record = await getAgentPresence(tenantId, request.agentId);
        return { success: true, data: record || { status: "OFFLINE", activeChats: 0 } };
      }

      case "request_handoff": {
        if (!request.sessionId) {
          return { success: false, error: { code: "BAD_REQUEST", message: "Missing sessionId", retryable: false } };
        }
        const result = await requestHumanHandoff({
          tenantId,
          sessionId: request.sessionId,
          customerName: request.customerName,
          issueSummary: request.issueSummary,
        });
        return { success: true, data: result };
      }

      case "resolve_session": {
        if (!request.sessionId || !request.agentId) {
          return { success: false, error: { code: "BAD_REQUEST", message: "Missing sessionId or agentId", retryable: false } };
        }
        const result = await resolveChatSession({
          tenantId,
          sessionId: request.sessionId,
          agentId: request.agentId,
        });
        return { success: true, data: result };
      }

      case "session_status": {
        if (!request.sessionId) {
          return { success: false, error: { code: "BAD_REQUEST", message: "Missing sessionId", retryable: false } };
        }
        const session = await getSessionStatus(request.sessionId);
        return { success: true, data: session };
      }

      default:
        return {
          success: false,
          error: {
            code: "UNSUPPORTED_ACTION",
            message: `Action '${action}' is not supported by Handoff handler.`,
            retryable: false,
          },
        };
    }
  } catch (err: any) {
    console.error("[HandoffHandler] Unhandled error:", err);
    return {
      success: false,
      error: {
        code: "INTERNAL_ERROR",
        message: err?.message || "Internal handoff error",
        retryable: true,
      },
    };
  }
}
