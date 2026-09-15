import { TenantContext } from "../../../shared/types/tenant-context";
import { AgentActionResponse } from "../../../shared/types/agent-action";
import { PERMISSIONS } from "../../../shared/constants/permissions";
import { searchKnowledgeBase } from "../../utils/kb-retriever";

export const handler = async (
  context: TenantContext,
  params: Record<string, any>,
): Promise<AgentActionResponse> => {
  console.log(
    `[Support Specialist] Processing request for user ${context.userId}`,
  );

  // Authorization Check
  if (!context.permissions.includes(PERMISSIONS.FAULTS_READ)) {
    return {
      success: false,
      error: {
        code: "FORBIDDEN",
        message: "User does not have permission to read support documents.",
        retryable: false,
      },
    };
  }

  // Search the knowledge base based on the user's params with Tenant Context
  try {
    const userQuery = params.query || "slow internet";
    
    // Pass userQuery and authenticated context into isolated KB retriever
    const searchResult = await searchKnowledgeBase(userQuery, context);

    return {
      success: true,
      data: {
        source: "Vector Index (Mocked)",
        query: userQuery,
        result: searchResult,
      },
    };
  } catch (error) {
    return {
      success: false,
      error: {
        code: "KB_SEARCH_FAILED",
        message: `Failed to search knowledge base: ${(error as Error).message}`,
        retryable: true,
      },
    };
  }
};