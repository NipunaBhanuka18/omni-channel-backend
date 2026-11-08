import { CognitoIdentityProviderClient } from "@aws-sdk/client-cognito-identity-provider";

function isLocalEnvironment(): boolean {
  const nodeEnv = (process.env.NODE_ENV || "").trim().toLowerCase();
  return process.env.IS_LOCAL !== "false" && nodeEnv !== "production" && nodeEnv !== "prod";
}

const isLocal = isLocalEnvironment();
const useLocalEndpoint =
  Boolean((process.env.COGNITO_ENDPOINT || "").trim()) ||
  (isLocal && process.env.USE_REAL_COGNITO !== "true");

// Use COGNITO_ENDPOINT or LOCALSTACK_HOSTNAME in local/container runs, else AWS default endpoint & IAM role.
const localstackEndpoint = (process.env.COGNITO_ENDPOINT || "").trim()
  || (process.env.LOCALSTACK_HOSTNAME
    ? `http://${process.env.LOCALSTACK_HOSTNAME}:4566`
    : "http://127.0.0.1:4566");

export const cognitoClient = new CognitoIdentityProviderClient({
  region: process.env.COGNITO_REGION || process.env.AWS_REGION || "us-east-1",
  ...(useLocalEndpoint && {
    endpoint: localstackEndpoint,
    credentials: {
      accessKeyId: "mock_access_key",
      secretAccessKey: "mock_secret_key",
    },
  }),
});