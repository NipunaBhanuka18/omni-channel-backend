import { CognitoIdentityProviderClient } from "@aws-sdk/client-cognito-identity-provider";

// Use LOCALSTACK_HOSTNAME if running inside a Lambda container, else fallback to 127.0.0.1
// (same convention as agents/utils/dynamo-client.ts)
const localstackEndpoint = process.env.LOCALSTACK_HOSTNAME
  ? `http://${process.env.LOCALSTACK_HOSTNAME}:4566`
  : "http://127.0.0.1:4566";

export const cognitoClient = new CognitoIdentityProviderClient({
  region: "us-east-1",
  endpoint: localstackEndpoint,
  credentials: {
    accessKeyId: "mock_access_key",
    secretAccessKey: "mock_secret_key",
  },
});