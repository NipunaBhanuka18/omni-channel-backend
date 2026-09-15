import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";

// Use LOCALSTACK_HOSTNAME if running inside a Lambda container, else fallback to 127.0.0.1
const localstackEndpoint = process.env.LOCALSTACK_HOSTNAME
  ? `http://${process.env.LOCALSTACK_HOSTNAME}:4566`
  : "http://127.0.0.1:4566";

const client = new DynamoDBClient({
  region: "us-east-1",
  endpoint: localstackEndpoint,
  credentials: {
    accessKeyId: "mock_access_key",
    secretAccessKey: "mock_secret_key",
  },
});

export const docClient = DynamoDBDocumentClient.from(client);
