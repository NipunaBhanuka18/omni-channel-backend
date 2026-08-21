import { TenantContext } from "../../../shared/types/tenant-context";
import { AgentActionResponse } from "../../../shared/types/agent-action";
import { PERMISSIONS } from "../../../shared/constants/permissions";
import { fetchKbDocument } from "../../utils/s3-client";

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

  // 2. Fetch the troubleshooting guide from S3
  try {
    const docText = await fetchKbDocument("router-troubleshooting-guide.txt");

    // 3. Return the document text to the user
    return {
      success: true,
      data: {
        source: "S3 Knowledge Base",
        guide: docText,
      },
    };
  } catch (error) {
    return {
      success: false,
      error: {
        code: "KB_FETCH_FAILED",
        message: "Failed to retrieve troubleshooting guide.",
        retryable: true,
      },
    };
  }
};
