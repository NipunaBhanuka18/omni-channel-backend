import { CreateTableCommand, CreateTableCommandInput } from "@aws-sdk/client-dynamodb";
import { docClient } from "../agents/utils/dynamo-client";

async function createTenantTables() {
  const tables: CreateTableCommandInput[] = [
    {
      TableName: "omni-channel-tenants",
      BillingMode: "PAY_PER_REQUEST",
      KeySchema: [
        { AttributeName: "PK", KeyType: "HASH" },
        { AttributeName: "SK", KeyType: "RANGE" },
      ],
      AttributeDefinitions: [
        { AttributeName: "PK", AttributeType: "S" },
        { AttributeName: "SK", AttributeType: "S" },
      ],
    },
    {
      TableName: "omni-channel-agents",
      BillingMode: "PAY_PER_REQUEST",
      KeySchema: [
        { AttributeName: "PK", KeyType: "HASH" },
        { AttributeName: "SK", KeyType: "RANGE" },
      ],
      AttributeDefinitions: [
        { AttributeName: "PK", AttributeType: "S" },
        { AttributeName: "SK", AttributeType: "S" },
      ],
    },
  ];

  for (const tableInput of tables) {
    try {
      await docClient.send(new CreateTableCommand(tableInput));
      console.log(` Table created successfully: ${tableInput.TableName}`);
    } catch (err: any) {
      if (err.name === "ResourceInUseException") {
        console.log(`ℹ Table already exists: ${tableInput.TableName}`);
      } else {
        console.error(` Error creating table ${tableInput.TableName}:`, err.message);
      }
    }
  }
}

createTenantTables();