import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";

// Configure the client to point to LocalStack
const client = new DynamoDBClient({
  region: "us-east-1",
  endpoint: "http://127.0.0.1:4566", // Force IPv4
  credentials: {
    accessKeyId: "mock_access_key", // LocalStack doesn't care what these are
    secretAccessKey: "mock_secret_key",
  },
});

// Create a DocumentClient for easier automatic marshalling of TypeScript objects
export const docClient = DynamoDBDocumentClient.from(client);