import { TenantContext } from "../../../shared/types/tenant-context";
import {
  AgentActionRequest,
  AgentActionResponse,
} from "../../../shared/types/agent-action";
import { PERMISSIONS } from "../../../shared/constants/permissions";
import { handler as billingGatewayHandler } from "../../gateway/billing-gateway";

export const handler = async (
  context: TenantContext,
  params: Record<string, any>,
): Promise<AgentActionResponse> => {
  console.log(
    `[Billing Specialist] Processing request for user ${context.userId}`,
  );

  // 1. Authorization Check
  if (!context.permissions.includes(PERMISSIONS.BILLING_READ)) {
    return {
      success: false,
      error: {
        code: "FORBIDDEN",
        message: "User does not have permission to read billing information.",
        retryable: false,
      },
    };
  }

  // 2. Format the request for the Agent Gateway
  const gatewayRequest: AgentActionRequest = {
    action: "check_balance", // In a dynamic system, this could be passed in from the Main Agent
    tenantId: context.tenantId,
    userId: context.userId,
    params: params,
  };

  // 3. Call the Agent Gateway
  return await billingGatewayHandler(gatewayRequest);
};
