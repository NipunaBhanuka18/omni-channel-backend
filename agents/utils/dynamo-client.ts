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

// Environment-aware LocalStack vs AWS Cloud configuration
const isLocal = process.env.IS_LOCAL !== "false";
const localstackEndpoint = process.env.LOCALSTACK_HOSTNAME
  ? `http://${process.env.LOCALSTACK_HOSTNAME}:4566`
  : "http://127.0.0.1:4566";

const client = new DynamoDBClient({
  region: process.env.AWS_REGION || "us-east-1",
  ...(isLocal && {
    endpoint: localstackEndpoint,
    credentials: {
      accessKeyId: "mock_access_key",
      secretAccessKey: "mock_secret_key",
    },
  }),
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
  const cleanTenant = tenantId.trim();
  return cleanTenant.startsWith("TENANT#") ? cleanTenant : `TENANT#${cleanTenant}`;
}

/**
 * TENANT ISOLATED GET ITEM
 * Guarantees that the Partition Key (PK) is prefixed with the authenticated tenant's ID.
 */
export async function getTenantItem<T = Record<string, any>>(
  tableName: string,
  context: TenantContext,
  sortKey: string | { name: string; value: string }
): Promise<T | null> {
  const partitionKey = formatTenantPK(context.tenantId);
  const keyObj: Record<string, any> = { PK: partitionKey };

  if (typeof sortKey === "string") {
    keyObj["SK"] = sortKey;
  } else {
    keyObj[sortKey.name] = sortKey.value;
  }

  const params: GetCommandInput = {
    TableName: tableName,
    Key: keyObj,
  };

  const response = await docClient.send(new GetCommand(params));
  return (response.Item as T) || null;
}

/**
 * TENANT ISOLATED PUT ITEM
 * Enforces that every item stored in DynamoDB carries PK: TENANT#<tenantId> and explicit tenantId field.
 */
export async function putTenantItem<T extends Record<string, any>>(
  tableName: string,
  context: TenantContext,
  sortKeyOrItem: string | T,
  itemData?: T
): Promise<void> {
  const partitionKey = formatTenantPK(context.tenantId);
  let itemPayload: Record<string, any> = {};

  if (typeof sortKeyOrItem === "string") {
    itemPayload = {
      PK: partitionKey,
      SK: sortKeyOrItem,
      tenantId: context.tenantId,
      updatedAt: new Date().toISOString(),
      ...(itemData || {}),
    };
  } else {
    itemPayload = {
      ...sortKeyOrItem,
      PK: partitionKey,
      tenantId: context.tenantId,
      updatedAt: new Date().toISOString(),
    };
  }

  const params: PutCommandInput = {
    TableName: tableName,
    Item: itemPayload,
  };

  await docClient.send(new PutCommand(params));
}

/**
 * TENANT ISOLATED QUERY
 * Restricts query scans strictly to items matching PK = TENANT#<tenantId>.
 */
export async function queryTenantItems<T = Record<string, any>>(
  tableName: string,
  context: TenantContext,
  skPrefixOrCondition?: string,
  expressionAttributeValues?: Record<string, any>
): Promise<T[]> {
  const partitionKey = formatTenantPK(context.tenantId);

  let keyConditionExpression = "PK = :pk";
  const attrValues: Record<string, any> = {
    ":pk": partitionKey,
    ...expressionAttributeValues,
  };

  if (skPrefixOrCondition) {
    if (skPrefixOrCondition.includes("=") || skPrefixOrCondition.includes("AND")) {
      keyConditionExpression = `PK = :pk AND ${skPrefixOrCondition}`;
    } else {
      keyConditionExpression += " AND begins_with(SK, :skPrefix)";
      attrValues[":skPrefix"] = skPrefixOrCondition;
    }
  }

  const params: QueryCommandInput = {
    TableName: tableName,
    KeyConditionExpression: keyConditionExpression,
    ExpressionAttributeValues: attrValues,
  };

  const response = await docClient.send(new QueryCommand(params));
  return (response.Items as T[]) || [];
}
