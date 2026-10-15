import { DynamoDBClient, CreateTableCommand } from "@aws-sdk/client-dynamodb";

const client = new DynamoDBClient({
  region: "us-east-1",
  endpoint: "http://localhost:4566",
  credentials: {
    accessKeyId: "mock_access_key",
    secretAccessKey: "mock_secret_key",
  },
});

const command = new CreateTableCommand({
  TableName: "omni-channel-conversations",
  KeySchema: [{ AttributeName: "conversationId", KeyType: "HASH" }],
  AttributeDefinitions: [
    { AttributeName: "conversationId", AttributeType: "S" },
  ],
  BillingMode: "PAY_PER_REQUEST",
});

async function createTable() {
  try {
    const response = await client.send(command);
    console.log(
      "✅ Table created successfully:",
      response.TableDescription?.TableName,
    );
  } catch (err: any) {
    if (err.name === "ResourceInUseException") {
      console.log("Table already exists. That's fine, moving on!");
    } else {
      console.error("❌ Error creating table:", err);
    }
  }
}

createTable();
