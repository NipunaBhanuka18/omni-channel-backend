import { DynamoDBClient, CreateTableCommand } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, PutCommand } from "@aws-sdk/lib-dynamodb";
import { TenantConfig } from "../services/tenant-router/router";

/**
 * Creates and seeds the multi-tenant partitioning tables:
 *   - omni-channel-tenants  (PK: tenantId)
 *   - omni-channel-agents   (PK: tenantId, SK: agentId)
 *   - omni-channel-tools    (PK: tenantId, SK: toolId)
 *
 * NOTE (ADR-014, docs/decisions.md): services/tenant-router/router.ts now reads
 * tenant config directly from the omni-channel-tenants table created here — it no
 * longer has a hardcoded in-memory registry. Run this script (against a running
 * LocalStack) before exercising routing for 'slt' or 'tenant-test-123', or routing
 * will fail with TENANT_NOT_FOUND.
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
    status: "active",
    allowedChannels: ["web", "whatsapp", "sms", "messenger"],
    defaultAgent: "main-agent",
  },
  {
    tenantId: "tenant-test-123",
    name: "Test Tenant 123",
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
      AttributeDefinitions: [{ AttributeName: "tenantId", AttributeType: "S" }],
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