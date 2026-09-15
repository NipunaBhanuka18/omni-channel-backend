import { ScanCommand } from "@aws-sdk/lib-dynamodb";
import { docClient } from "../../agents/utils/dynamo-client";

/**
 * Workspace Portal API: List all recent conversations.
 * (In a real app, this would be paginated and filtered by tenantId)
 */
export const handler = async () => {
  console.log("[Workspace Portal] Fetching all conversations...");

  try {
    const command = new ScanCommand({
      TableName: "omni-channel-conversations",
      Limit: 10, // Just grab the latest 10 for now
    });

    const response = await docClient.send(command);

    console.log("[Workspace Portal] ✅ Successfully fetched conversations.");
    return {
      success: true,
      data: response.Items,
    };
  } catch (error) {
    console.error(
      "[Workspace Portal] ❌ Failed to fetch conversations:",
      error,
    );
    return {
      success: false,
      error: {
        code: "DB_SCAN_FAILED",
        message: "Could not retrieve conversations from the database.",
        retryable: false,
      },
    };
  }
};
