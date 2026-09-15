import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { 
  DynamoDBDocumentClient, 
  GetCommand, 
  PutCommand, 
  QueryCommand,
  GetCommandInput,
  PutCommandInput,
  QueryCommandInput
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

export const docClient = DynamoDBDocumentClient.from(client);

/**
 * Formats a raw tenant ID into a standardized DynamoDB Partition Key (PK).
 */
export function formatTenantPK(tenantId: string): string {
  if (!tenantId) {
    throw new Error("INVALID_TENANT_ID: Tenant ID cannot be empty for database operations");
  }
  return tenantId.startsWith("TENANT#") ? tenantId : `TENANT#${tenantId}`;
}

/**
 * Tenant-partitioned GetItem wrapper ensuring queries cannot breach tenant boundaries.
 */
export async function getTenantItem<T = Record<string, any>>(
  tableName: string,
  context: TenantContext,
  sortKey: { name: string; value: string }
): Promise<T | null> {
  const params: GetCommandInput = {
    TableName: tableName,
    Key: {
      PK: formatTenantPK(context.tenantId),
      [sortKey.name]: sortKey.value,
    },
  };

  const response = await docClient.send(new GetCommand(params));
  return (response.Item as T) || null;
}

/**
 * Tenant-partitioned PutItem wrapper enforcing tenant PK scoping on every write.
 */
export async function putTenantItem(
  tableName: string,
  context: TenantContext,
  item: Record<string, any>
): Promise<void> {
  const params: PutCommandInput = {
    TableName: tableName,
    Item: {
      ...item,
      PK: formatTenantPK(context.tenantId),
      tenantId: context.tenantId,
      updatedAt: new Date().toISOString(),
    },
  };

  await docClient.send(new PutCommand(params));
}

/**
 * Tenant-partitioned Query wrapper locked strictly to the authenticated tenant's partition.
 */
export async function queryTenantItems<T = Record<string, any>>(
  tableName: string,
  context: TenantContext,
  keyConditionExpression?: string,
  expressionAttributeValues?: Record<string, any>
): Promise<T[]> {
  const tenantPK = formatTenantPK(context.tenantId);

  const params: QueryCommandInput = {
    TableName: tableName,
    KeyConditionExpression: keyConditionExpression 
      ? `PK = :pk AND ${keyConditionExpression}` 
      : "PK = :pk",
    ExpressionAttributeValues: {
      ":pk": tenantPK,
      ...expressionAttributeValues,
    },
  };

  const response = await docClient.send(new QueryCommand(params));
  return (response.Items as T[]) || [];
}