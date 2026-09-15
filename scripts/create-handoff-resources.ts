import { CreateTableCommand } from "@aws-sdk/client-dynamodb";
import { docClient } from "../agents/utils/dynamo-client";

interface TableSpec {
  tableName: string;
  pk: string;
  sk?: string;
}

const handoffTables: TableSpec[] = [
  {
    tableName: "omni-channel-agent-presence",
    pk: "tenantId",
    sk: "agentId",
  },
  {
    tableName: "omni-channel-chat-sessions",
    pk: "sessionId",
  },
  {
    tableName: "omni-channel-missed-handoffs",
    pk: "tenantId",
    sk: "missedId",
  },
];

async function createTableIfNotExists(spec: TableSpec) {
  const keySchema = [{ AttributeName: spec.pk, KeyType: "HASH" as const }];
  const attributeDefinitions = [{ AttributeName: spec.pk, AttributeType: "S" as const }];

  if (spec.sk) {
    keySchema.push({ AttributeName: spec.sk, KeyType: "RANGE" as const });
    attributeDefinitions.push({ AttributeName: spec.sk, AttributeType: "S" as const });
  }

  const command = new CreateTableCommand({
    TableName: spec.tableName,
    KeySchema: keySchema,
    AttributeDefinitions: attributeDefinitions,
    BillingMode: "PAY_PER_REQUEST",
  });

  try {
    const response = await docClient.send(command);
    console.log(`✅ Table created: ${response.TableDescription?.TableName}`);
  } catch (err: any) {
    if (err.name === "ResourceInUseException") {
      console.log(`ℹ️ Table already exists: ${spec.tableName}`);
    } else {
      console.error(`❌ Error creating table ${spec.tableName}:`, err?.message || err);
    }
  }
}

async function main() {
  console.log("=== Provisioning Live Agent Handoff & Presence Tables ===");
  for (const table of handoffTables) {
    await createTableIfNotExists(table);
  }
  console.log("✅ Handoff table provisioning routine complete.");
}

main();
