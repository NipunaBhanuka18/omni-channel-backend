import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  GetCommand,
  GetCommandInput,
  PutCommand,
  PutCommandInput,
  QueryCommand,
  QueryCommandInput,
} from "@aws-sdk/lib-dynamodb";
import { TenantContext } from "../../shared/types/tenant-context";

// Configure the client to point to LocalStack
const client = new DynamoDBClient({
  region: "us-east-1",
  endpoint: "http://127.0.0.1:4566", // Force IPv4
  credentials: {
    accessKeyId: "mock_access_key", // LocalStack mock credentials
    secretAccessKey: "mock_secret_key",
  },
});

// Base DocumentClient export for low-level access if strictly required
export const docClient = DynamoDBDocumentClient.from(client);

/**
 * TENANT ISOLATED HELPER: Formats a standard Tenant Partition Key (PK)
 * Format: TENANT#<tenantId>
 */
export function formatTenantPK(tenantId: string): string {
  if (!tenantId || !tenantId.trim()) {
    throw new Error("TenantIsolationError: tenantId cannot be empty or null.");
  }
  return `TENANT#${tenantId.trim()}`;
}

/**
 * TENANT ISOLATED GET ITEM
 * Guarantees that the Partition Key (PK) is prefixed with the authenticated tenant's ID.
 */
export async function getTenantItem<T>(
  tableName: string,
  context: TenantContext,
  sortKey: string,
): Promise<T | null> {
  const partitionKey = formatTenantPK(context.tenantId);

  const params: GetCommandInput = {
    TableName: tableName,
    Key: {
      PK: partitionKey,
      SK: sortKey,
    },
  };

  const response = await docClient.send(new GetCommand(params));
  return (response.Item as T) || null;
}

/**
 * TENANT ISOLATED PUT ITEM
 * Enforces that every item stored in DynamoDB carries the PK: TENANT#<tenantId> and explicit tenantId field.
 */
export async function putTenantItem<T extends Record<string, any>>(
  tableName: string,
  context: TenantContext,
  sortKey: string,
  itemData: T,
): Promise<void> {
  const partitionKey = formatTenantPK(context.tenantId);

  const params: PutCommandInput = {
    TableName: tableName,
    Item: {
      PK: partitionKey,
      SK: sortKey,
      tenantId: context.tenantId, // Store explicit attribute for auditing
      updatedAt: new Date().toISOString(),
      ...itemData,
    },
  };

  await docClient.send(new PutCommand(params));
}

/**
 * TENANT ISOLATED QUERY
 * Restricts query scans strictly to items matching PK = TENANT#<tenantId>.
 */
export async function queryTenantItems<T>(
  tableName: string,
  context: TenantContext,
  skPrefix?: string,
): Promise<T[]> {
  const partitionKey = formatTenantPK(context.tenantId);

  let keyConditionExpression = "PK = :pk";
  const expressionAttributeValues: Record<string, any> = {
    ":pk": partitionKey,
  };

  if (skPrefix) {
    keyConditionExpression += " AND begins_with(SK, :skPrefix)";
    expressionAttributeValues[":skPrefix"] = skPrefix;
  }

  const params: QueryCommandInput = {
    TableName: tableName,
    KeyConditionExpression: keyConditionExpression,
    ExpressionAttributeValues: expressionAttributeValues,
  };

  const response = await docClient.send(new QueryCommand(params));
  return (response.Items as T[]) || [];
}
