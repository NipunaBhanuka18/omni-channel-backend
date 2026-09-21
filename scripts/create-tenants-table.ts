import { DynamoDBClient, CreateTableCommand } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, PutCommand } from "@aws-sdk/lib-dynamodb";
import { TenantConfig } from "../services/tenant-router/router";
import { normalizeCompanyName } from "../shared/utils/tenant-name";

/**
 * Creates and seeds the multi-tenant partitioning tables:
 *   - omni-channel-tenants  (PK: tenantId, GSI: NormalizedNameIndex on normalizedName)
 *   - omni-channel-agents   (PK: tenantId, SK: agentId)
 *   - omni-channel-tools    (PK: tenantId, SK: toolId)
 *
 * NOTE (ADR-014, docs/decisions.md): services/tenant-router/router.ts now reads
 * tenant config directly from the omni-channel-tenants table created here — it no
 * longer has a hardcoded in-memory registry. Run this script (against a running
 * LocalStack) before exercising routing for 'slt' or 'tenant-test-123', or routing
 * will fail with TENANT_NOT_FOUND.
 *
 * NOTE (ADR-016): NormalizedNameIndex was added after the table already existed in
 * some LocalStack environments. DynamoDB does not retroactively add a GSI to an
 * existing table via CreateTableCommand — if this script logs "already exists" and
 * onboarding's company-name duplicate check isn't working, delete the table in
 * LocalStack first (or restart your LocalStack container) so it gets recreated with
 * the GSI included.
 */

const client = new DynamoDBClient({
  region: "us-east-1",
  endpoint: "http://localhost:4566",
  credentials: {
    accessKeyId: "mock_access_key",
    secretAccessKey: "mock_secret_key",
  },
});

const docClient = DynamoDBDocumentClient.from(client);

interface AgentRecord {
  tenantId: string;
  agentId: string;
  name: string;
  status: "active" | "inactive";
  defaultModel: string;
  createdAt: string;
}

/**
 * ==============================================================================
 * COMPATIBILITY SHIM — for server.ts (Member 1's local Express dev server) and
 * services/onboarding/register-tenant.ts only.
 * ==============================================================================
 * The REAL onboarding pipeline (services/onboarding/onboarding.ts) does NOT use
 * any of this — it writes directly to DynamoDB via agents/utils/dynamo-client.ts.
 * This in-memory Map + provisionTenantResources() pair exists purely so
 * server.ts's quick local demo flow (company registration/approval UI, before a
 * real Cognito+DynamoDB backend is wired up for it) keeps working without
 * requiring LocalStack to be running. Field shapes are loose (`any`-valued maps)
 * because server.ts and register-tenant.ts each construct slightly different
 * record shapes for their own purposes.
 * ==============================================================================
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

/**
 * Seeds the in-memory maps above from SEED_TENANTS, for server.ts's startup hook.
 * Does not touch DynamoDB — see the shim note above.
 */
export async function provisionTenantResources(): Promise<void> {
  for (const tenant of SEED_TENANTS) {
    if (!inMemoryTenants.has(tenant.tenantId)) {
      inMemoryTenants.set(tenant.tenantId, {
        tenantId: tenant.tenantId,
        companyName: tenant.name,
        status: "active",
        config: { themeColor: "#005EB8", allowedOrigins: ["*"] },
      });
    }
  }
}

async function createTable(command: CreateTableCommand, label: string): Promise<void> {
  try {
    const response = await client.send(command);
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

// Mirrors services/tenant-router/router.ts's TENANT_REGISTRY exactly, so the seeded
// DynamoDB rows and the current in-memory fallback don't disagree while both exist.
const SEED_TENANTS: TenantConfig[] = [
  {
    tenantId: "slt",
    name: "Sri Lanka Telecom",
    normalizedName: normalizeCompanyName("Sri Lanka Telecom"),
    status: "active",
    allowedChannels: ["web", "whatsapp", "sms", "messenger"],
    defaultAgent: "main-agent",
  },
  {
    tenantId: "tenant-test-123",
    name: "Test Tenant 123",
    normalizedName: normalizeCompanyName("Test Tenant 123"),
    status: "active",
    allowedChannels: ["web", "whatsapp", "sms", "messenger"],
    defaultAgent: "main-agent",
  },
];

async function seedTenants(): Promise<void> {
  for (const tenant of SEED_TENANTS) {
    try {
      await docClient.send(
        new PutCommand({
          TableName: "omni-channel-tenants",
          Item: tenant,
        })
      );
      console.log(` Seeded tenant: ${tenant.tenantId} (${tenant.name})`);
    } catch (err) {
      console.error(` Error seeding tenant '${tenant.tenantId}':`, err);
      throw err;
    }
  }
}

async function seedAgents(): Promise<void> {
  const createdAt = new Date().toISOString();
  for (const tenant of SEED_TENANTS) {
    const agent: AgentRecord = {
      tenantId: tenant.tenantId,
      agentId: tenant.defaultAgent,
      name: "Main Agent",
      status: "active",
      defaultModel: "claude-sonnet-4-6",
      createdAt,
    };
    try {
      await docClient.send(
        new PutCommand({
          TableName: "omni-channel-agents",
          Item: agent,
        })
      );
      console.log(` Seeded default agent '${agent.agentId}' for tenant: ${tenant.tenantId}`);
    } catch (err) {
      console.error(` Error seeding agent for tenant '${tenant.tenantId}':`, err);
      throw err;
    }
  }
}

async function main(): Promise<void> {
  console.log("--- Creating multi-tenant partitioning tables ---");

  await createTable(
    new CreateTableCommand({
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
    }),
    "omni-channel-tenants"
  );

  await createTable(
    new CreateTableCommand({
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
    }),
    "omni-channel-agents"
  );

  await createTable(
    new CreateTableCommand({
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
    }),
    "omni-channel-tools"
  );

  console.log("\n--- Seeding baseline data ---");
  await seedTenants();
  await seedAgents();

  console.log("\n--- Done. omni-channel-tools was created empty (Member 4 owns its records). ---");
}

main().catch((err) => {
  console.error(" Fatal error while creating/seeding tenant tables:", err);
  process.exitCode = 1;
});