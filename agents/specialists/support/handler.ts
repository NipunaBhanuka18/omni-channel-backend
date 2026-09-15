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

  // 1. Authorization Check
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

  // 2. Search the knowledge base based on the user's params
  try {
    // We'll pass a mock query from the params, or default to "slow internet"
    const userQuery = params.query || "slow internet";
    const searchResult = await searchKnowledgeBase(userQuery);

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
        message: "Failed to search knowledge base.",
        retryable: true,
      },
    };
  }
};
