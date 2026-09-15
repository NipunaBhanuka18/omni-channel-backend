import {
  DynamoDBClient,
  CreateTableCommand,
  ResourceInUseException,
} from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, PutCommand } from "@aws-sdk/lib-dynamodb";

const rawClient = new DynamoDBClient({
  region: "us-east-1",
  endpoint: "http://127.0.0.1:4566",
  credentials: {
    accessKeyId: "mock_access_key",
    secretAccessKey: "mock_secret_key",
  },
});

const docClient = DynamoDBDocumentClient.from(rawClient);

export interface TenantRecord {
  tenantId: string;
  companyName: string;
  companySlug: string;
  adminEmail: string;
  status: "active" | "suspended" | "pending";
  planTier: "starter" | "pro" | "enterprise";
  createdAt: string;
  updatedAt: string;
  config?: {
    themeColor?: string;
    logoUrl?: string;
    allowedOrigins?: string[];
  };
}

export interface TenantAgentRecord {
  tenantId: string;
  agentId: string;
  agentName: string;
  specialist: "supervisor" | "support" | "billing" | "usage" | "leads";
  status: "active" | "inactive";
  welcomeMessage: string;
  createdAt: string;
}

export interface TenantToolRecord {
  tenantId: string;
  toolId: string;
  toolName: string;
  type: "openapi" | "form" | "mcp";
  endpointOrSchema: string;
  status: "enabled" | "disabled";
}

// In-Memory Seed Storage for offline testing & immediate verification
export const inMemoryTenants = new Map<string, TenantRecord>();
export const inMemoryAgents = new Map<string, TenantAgentRecord>();
export const inMemoryTools = new Map<string, TenantToolRecord>();

const tablesToCreate = [
  {
    TableName: "omni-channel-tenants",
    KeySchema: [{ AttributeName: "tenantId", KeyType: "HASH" as const }],
    AttributeDefinitions: [
      { AttributeName: "tenantId", AttributeType: "S" as const },
    ],
    BillingMode: "PAY_PER_REQUEST" as const,
  },
  {
    TableName: "omni-channel-agents",
    KeySchema: [
      { AttributeName: "tenantId", KeyType: "HASH" as const },
      { AttributeName: "agentId", KeyType: "RANGE" as const },
    ],
    AttributeDefinitions: [
      { AttributeName: "tenantId", AttributeType: "S" as const },
      { AttributeName: "agentId", AttributeType: "S" as const },
    ],
    BillingMode: "PAY_PER_REQUEST" as const,
  },
  {
    TableName: "omni-channel-tools",
    KeySchema: [
      { AttributeName: "tenantId", KeyType: "HASH" as const },
      { AttributeName: "toolId", KeyType: "RANGE" as const },
    ],
    AttributeDefinitions: [
      { AttributeName: "tenantId", AttributeType: "S" as const },
      { AttributeName: "toolId", AttributeType: "S" as const },
    ],
    BillingMode: "PAY_PER_REQUEST" as const,
  },
];

const baselineTenants: TenantRecord[] = [
  {
    tenantId: "slt",
    companyName: "Sri Lanka Telecom (SLT-Mobitel)",
    companySlug: "slt",
    adminEmail: "admin@slt.lk",
    status: "active",
    planTier: "enterprise",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    config: {
      themeColor: "#005EB8",
      allowedOrigins: ["http://localhost:3000", "https://chat.slt.lk"],
    },
  },
  {
    tenantId: "tenant-test-123",
    companyName: "Acme Test Corp",
    companySlug: "acme-test",
    adminEmail: "admin@acmetest.io",
    status: "active",
    planTier: "starter",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    config: {
      themeColor: "#10B981",
    },
  },
];

const baselineAgents: TenantAgentRecord[] = [
  {
    tenantId: "slt",
    agentId: "agent-slt-support-01",
    agentName: "SLT Broadband Technical Specialist",
    specialist: "support",
    status: "active",
    welcomeMessage: "Hello! I am SLT Broadband Support Bot. How can I assist you with your connection today?",
    createdAt: new Date().toISOString(),
  },
  {
    tenantId: "slt",
    agentId: "agent-slt-billing-01",
    agentName: "SLT Billing & Accounts Assistant",
    specialist: "billing",
    status: "active",
    welcomeMessage: "Welcome to SLT Billing. You can check your balance or pay your monthly bill here.",
    createdAt: new Date().toISOString(),
  },
  {
    tenantId: "tenant-test-123",
    agentId: "agent-acme-support-01",
    agentName: "Acme General Customer Bot",
    specialist: "support",
    status: "active",
    welcomeMessage: "Welcome to Acme Corp! How can we help you today?",
    createdAt: new Date().toISOString(),
  },
];

const baselineTools: TenantToolRecord[] = [
  {
    tenantId: "slt",
    toolId: "tool-check-balance",
    toolName: "SLT Check Account Balance API",
    type: "openapi",
    endpointOrSchema: "https://api.slt.lk/v1/billing/balance",
    status: "enabled",
  },
  {
    tenantId: "slt",
    toolId: "tool-report-fault",
    toolName: "SLT Broadband Fault Report Form",
    type: "form",
    endpointOrSchema: "form_broadband_fault_v1",
    status: "enabled",
  },
];

export async function provisionTenantResources(): Promise<boolean> {
  console.log("🚀 [Tenant Provisioning] Initializing Multi-Tenant DynamoDB tables...");

  // Seed into memory first
  for (const t of baselineTenants) inMemoryTenants.set(t.tenantId, t);
  for (const a of baselineAgents) inMemoryAgents.set(`${a.tenantId}#${a.agentId}`, a);
  for (const tool of baselineTools) inMemoryTools.set(`${tool.tenantId}#${tool.toolId}`, tool);

  let localstackOnline = true;

  for (const tableDef of tablesToCreate) {
    try {
      await rawClient.send(new CreateTableCommand(tableDef));
      console.log(`✅ [DynamoDB] Created table '${tableDef.TableName}'`);
    } catch (err: any) {
      if (err instanceof ResourceInUseException || err.name === "ResourceInUseException") {
        console.log(`ℹ️ [DynamoDB] Table '${tableDef.TableName}' already exists.`);
      } else {
        console.warn(
          `⚠️ [DynamoDB Warning] Could not reach LocalStack for '${tableDef.TableName}' (${err.message}). Using in-memory store fallback.`
        );
        localstackOnline = false;
        break;
      }
    }
  }

  if (localstackOnline) {
    console.log("🌱 [Seed Data] Writing baseline tenants, agents, and tools to DynamoDB...");
    try {
      for (const t of baselineTenants) {
        await docClient.send(
          new PutCommand({
            TableName: "omni-channel-tenants",
            Item: t,
          })
        );
      }
      for (const a of baselineAgents) {
        await docClient.send(
          new PutCommand({
            TableName: "omni-channel-agents",
            Item: a,
          })
        );
      }
      for (const tool of baselineTools) {
        await docClient.send(
          new PutCommand({
            TableName: "omni-channel-tools",
            Item: tool,
          })
        );
      }
      console.log("✅ [Seed Data] Successfully seeded baseline tenant records in DynamoDB!");
    } catch (seedErr: any) {
      console.warn(`⚠️ [Seed Data Warning] Failed to seed DynamoDB tables: ${seedErr.message}`);
    }
  } else {
    console.log("✅ [Seed Data] Baseline records seeded in-memory fallback successfully!");
  }

  return true;
}

// Auto-run if executed directly via tsx
if (process.argv[1]?.includes("create-tenants-table")) {
  provisionTenantResources()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error("❌ Fatal error provisioning tenant resources:", err);
      process.exit(1);
    });
}
