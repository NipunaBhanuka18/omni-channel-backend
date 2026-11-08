import { ScanCommand } from "@aws-sdk/lib-dynamodb";
import { docClient } from "../../agents/utils/dynamo-client";

/**
 * Queries recent conversations belonging exclusively to a verified tenantId.
 * Never falls back to unscoped scans or fixture records.
 */
export async function listConversationsForTenant(
  tenantId: string,
  limit = 50,
): Promise<Array<Record<string, any>>> {
  const cleanTenant = typeof tenantId === "string" ? tenantId.trim() : "";
  if (!cleanTenant) {
    throw new Error("Tenant identifier is required to list conversations");
  }

  const maxItems = Math.min(Math.max(1, Number.isFinite(limit) ? Math.floor(limit) : 50), 100);
  const items: Array<Record<string, any>> = [];
  let exclusiveStartKey: Record<string, any> | undefined;

  do {
    const response = await docClient.send(
      new ScanCommand({
        TableName: "omni-channel-conversations",
        FilterExpression: "tenantId = :tid",
        ExpressionAttributeValues: { ":tid": cleanTenant },
        ExclusiveStartKey: exclusiveStartKey,
      }),
    );

    for (const item of (response.Items || []) as Array<Record<string, any>>) {
      if (item && item.tenantId === cleanTenant) {
        items.push(item);
      }
    }
    exclusiveStartKey = response.LastEvaluatedKey;
  } while (exclusiveStartKey && items.length < maxItems * 2);

  items.sort((a, b) =>
    String(b.timestamp || b.updatedAt || "").localeCompare(String(a.timestamp || a.updatedAt || "")),
  );
  return items.slice(0, maxItems);
}

/**
 * Legacy script helper kept for CLI verification (scripts/test-list-conversations.ts).
 */
export const handler = async (tenantId?: string) => {
  console.log("[Workspace Portal] Fetching conversations...");

  try {
    if (tenantId) {
      const scoped = await listConversationsForTenant(tenantId, 10);
      return { success: true, data: scoped };
    }

    const command = new ScanCommand({
      TableName: "omni-channel-conversations",
      Limit: 10,
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
