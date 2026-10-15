import {
  AgentActionRequest,
  AgentActionResponse,
} from "../../shared/types/agent-action";

export const handler = async (
  event: AgentActionRequest,
): Promise<AgentActionResponse> => {
  console.log(
    `[Usage Gateway] Received action: ${event.action} for tenant: ${event.tenantId}`,
  );

  if (event.action === "check_usage") {
    // MOCK: Simulating a successful response from the existing SLT Usage API
    return {
      success: true,
      data: {
        packageName: "Unlimited Data Pro",
        dataUsedGb: 45.2,
        dataTotalGb: 100,
        voiceUsedMins: 150,
        voiceTotalMins: 500,
        renewalDate: "2026-09-01",
      },
    };
  }

  return {
    success: false,
    error: {
      code: "UNKNOWN_ACTION",
      message: `Action '${event.action}' is not supported by the usage gateway.`,
      retryable: false,
    },
  };
};
