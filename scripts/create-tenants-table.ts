import { DynamoDBClient, CreateTableCommand, CreateTableCommandInput } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, PutCommand } from "@aws-sdk/lib-dynamodb";
import { TenantConfig } from "../services/tenant-router/router";
import { normalizeCompanyName } from "../shared/utils/tenant-name";

/**
 * Creates and seeds the multi-tenant partitioning tables:
 *   - omni-channel-tenants       (PK: tenantId, GSI: NormalizedNameIndex on normalizedName)
 *   - omni-channel-registrations (PK: id, GSIs: NormalizedNameIndex, StatusIndex)
 *   - omni-channel-agents        (PK: tenantId, SK: agentId)
 *   - omni-channel-tools         (PK: tenantId, SK: toolId)
 *
 * NOTE (ADR-014, docs/decisions.md): services/tenant-router/router.ts reads
 * tenant config directly from omni-channel-tenants. Run this script (against
 * LocalStack) before exercising routing or hosted chat resolution.
 */

const localstackEndpoint =
  process.env.DYNAMODB_ENDPOINT ||
  (process.env.LOCALSTACK_HOSTNAME
    ? `http://${process.env.LOCALSTACK_HOSTNAME}:4566`
    : "http://127.0.0.1:4566");

const isLocal =
  process.env.IS_LOCAL !== "false" &&
  !["production", "prod"].includes((process.env.NODE_ENV || "").trim().toLowerCase());

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

const docClient = DynamoDBDocumentClient.from(client);

interface AgentRecord {
  tenantId: string;
  agentId: string;
  name: string;
  displayName?: string;
  brandName?: string;
  publicAgentKey?: string;
  status: "active" | "inactive" | "PUBLISHED" | "DRAFT";
  defaultModel: string;
  modelId?: string;
  welcomeMessage?: string;
  suggestedPrompts?: string[];
  deploymentStatus?: string;
  createdAt: string;
  updatedAt?: string;
}

/**
 * Legacy local offline-fallback map retained only for standalone unit runs when
 * LocalStack is unreachable in non-production dev/test mode. Do not rely on this
 * as primary storage.
 */
export interface TenantRecord {
  tenantId: string;
  companyName: string;
  companySlug?: string;
  adminEmail?: string;
  status: "active" | "pending" | "suspended" | "inactive";
  planTier?: "starter" | "pro" | "enterprise";
  createdAt?: string;
  updatedAt?: string;
  config?: { themeColor?: string; allowedOrigins?: string[] };
  [key: string]: unknown;
}

export interface TenantAgentRecord {
  tenantId: string;
  agentId: string;
  agentName: string;
  specialist: string;
  status: "active" | "inactive";
  welcomeMessage?: string;
  createdAt?: string;
  [key: string]: unknown;
}

export const inMemoryTenants = new Map<string, TenantRecord>();
export const inMemoryAgents = new Map<string, TenantAgentRecord>();

export interface SeedTenantConfig extends TenantConfig {
  companySlug: string;
  themeColor: string;
  adminEmail?: string;
  tier?: string;
  allocatedAgents?: number;
}

export const SEED_TENANTS: SeedTenantConfig[] = [
  {
    tenantId: "slt",
    name: "Sri Lanka Telecom",
    normalizedName: normalizeCompanyName("Sri Lanka Telecom"),
    companySlug: "slt",
    status: "active",
    allowedChannels: ["web", "whatsapp", "sms", "messenger"],
    defaultAgent: "main-agent",
    themeColor: "#005EB8",
    adminEmail: "admin@slt.lk",
    tier: "Enterprise",
    allocatedAgents: 25,
  },
  {
    tenantId: "tenant-test-123",
    name: "Test Tenant 123",
    normalizedName: normalizeCompanyName("Test Tenant 123"),
    companySlug: "test-123",
    status: "active",
    allowedChannels: ["web", "whatsapp", "sms", "messenger"],
    defaultAgent: "main-agent",
    themeColor: "#005EB8",
    adminEmail: "admin@test123.lk",
    tier: "Standard",
    allocatedAgents: 5,
  },
];

export const PLATFORM_TABLE_SPECS: CreateTableCommandInput[] = [
  {
    TableName: "omni-channel-tenants",
    KeySchema: [{ AttributeName: "tenantId", KeyType: "HASH" }],
    AttributeDefinitions: [
      { AttributeName: "tenantId", AttributeType: "S" },
      { AttributeName: "normalizedName", AttributeType: "S" },
    ],
    GlobalSecondaryIndexes: [
      {
        IndexName: "NormalizedNameIndex",
        KeySchema: [{ AttributeName: "normalizedName", KeyType: "HASH" }],
        Projection: { ProjectionType: "ALL" },
      },
    ],
    BillingMode: "PAY_PER_REQUEST",
  },
  {
    TableName: "omni-channel-registrations",
    KeySchema: [{ AttributeName: "id", KeyType: "HASH" }],
    AttributeDefinitions: [
      { AttributeName: "id", AttributeType: "S" },
      { AttributeName: "normalizedName", AttributeType: "S" },
      { AttributeName: "status", AttributeType: "S" },
    ],
    GlobalSecondaryIndexes: [
      {
        IndexName: "NormalizedNameIndex",
        KeySchema: [{ AttributeName: "normalizedName", KeyType: "HASH" }],
        Projection: { ProjectionType: "ALL" },
      },
      {
        IndexName: "StatusIndex",
        KeySchema: [{ AttributeName: "status", KeyType: "HASH" }],
        Projection: { ProjectionType: "ALL" },
      },
    ],
    BillingMode: "PAY_PER_REQUEST",
  },
  {
    TableName: "omni-channel-agents",
    KeySchema: [
      { AttributeName: "tenantId", KeyType: "HASH" },
      { AttributeName: "agentId", KeyType: "RANGE" },
    ],
    AttributeDefinitions: [
      { AttributeName: "tenantId", AttributeType: "S" },
      { AttributeName: "agentId", AttributeType: "S" },
    ],
    BillingMode: "PAY_PER_REQUEST",
  },
  {
    TableName: "omni-channel-tools",
    KeySchema: [
      { AttributeName: "tenantId", KeyType: "HASH" },
      { AttributeName: "toolId", KeyType: "RANGE" },
    ],
    AttributeDefinitions: [
      { AttributeName: "tenantId", AttributeType: "S" },
      { AttributeName: "toolId", AttributeType: "S" },
    ],
    BillingMode: "PAY_PER_REQUEST",
  },
];

/**
 * Seeds the in-memory maps above from SEED_TENANTS strictly as a non-prod offline fallback.
 */
export async function provisionTenantResources(): Promise<void> {
  if (!isLocal) return;
  for (const tenant of SEED_TENANTS) {
    if (!inMemoryTenants.has(tenant.tenantId)) {
      inMemoryTenants.set(tenant.tenantId, {
        tenantId: tenant.tenantId,
        companyName: tenant.name,
        companySlug: tenant.companySlug,
        status: "active",
        config: { themeColor: tenant.themeColor || "#005EB8", allowedOrigins: ["*"] },
      });
    }
  }
}

async function createTable(
  ddbClient: DynamoDBClient,
  spec: CreateTableCommandInput
): Promise<void> {
  const label = spec.TableName || "unknown-table";
  try {
    const response = await ddbClient.send(new CreateTableCommand(spec));
    console.log(" Table created successfully:", response.TableDescription?.TableName);
  } catch (err: any) {
    if (err.name === "ResourceInUseException") {
      console.log(`Table '${label}' already exists. That's fine, moving on!`);
    } else {
      console.error(` Error creating table '${label}':`, err);
      throw err;
    }
  }
}

export async function ensurePlatformTables(ddbClient: DynamoDBClient = client): Promise<void> {
  for (const spec of PLATFORM_TABLE_SPECS) {
    await createTable(ddbClient, spec);
  }
}

export async function ensureBaselineSeeds(
  ddbDocClient: DynamoDBDocumentClient = docClient
): Promise<void> {
  const now = new Date().toISOString();
  for (const tenant of SEED_TENANTS) {
    await ddbDocClient.send(
      new PutCommand({
        TableName: "omni-channel-tenants",
        Item: {
          ...tenant,
          createdAt: now,
          updatedAt: now,
        },
      })
    );
    console.log(` Seeded tenant: ${tenant.tenantId} (${tenant.name})`);

    const agent: AgentRecord = {
      tenantId: tenant.tenantId,
      agentId: tenant.defaultAgent,
      name: `${tenant.name} Assistant`,
      displayName: `${tenant.name} Assistant`,
      brandName: tenant.name,
      publicAgentKey: "support",
      status: "active",
      defaultModel: "claude-sonnet-4-6",
      modelId: "claude-sonnet-4-6",
      welcomeMessage: `Welcome to ${tenant.name}! How can we assist you today?`,
      suggestedPrompts:
        tenant.tenantId === "slt"
          ? ["Check my bill", "Check my usage", "Slow internet", "Talk to a person"]
          : ["How can you help me?", "Talk to a person"],
      deploymentStatus: "DEPLOYED",
      createdAt: now,
      updatedAt: now,
    };
    await ddbDocClient.send(
      new PutCommand({
        TableName: "omni-channel-agents",
        Item: agent,
      })
    );
    console.log(` Seeded default agent '${agent.agentId}' for tenant: ${tenant.tenantId}`);
  }
}

async function main(): Promise<void> {
  console.log("--- Creating multi-tenant partitioning tables ---");
  await ensurePlatformTables(client);

  console.log("\n--- Seeding baseline data ---");
  await ensureBaselineSeeds(docClient);

  console.log("\n--- Done. omni-channel-tools was created empty (Member 4 owns its records). ---");
}

if (require.main === module || process.argv[1]?.includes("create-tenants-table")) {
  main().catch((err) => {
    console.error(" Fatal error while creating/seeding tenant tables:", err);
    process.exitCode = 1;
  });
}