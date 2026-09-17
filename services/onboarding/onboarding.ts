import { GetCommand, PutCommand, DeleteCommand, DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import {
  AdminCreateUserCommand,
  AdminAddUserToGroupCommand,
  CognitoIdentityProviderClient,
} from "@aws-sdk/client-cognito-identity-provider";
import { PutObjectCommand, DeleteObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { randomBytes } from "crypto";
import { docClient } from "../../agents/utils/dynamo-client";
import { cognitoClient } from "../../agents/utils/cognito-client";
import { s3Client } from "../../agents/utils/s3-client";
import { AgentActionResponse } from "../../shared/types/agent-action";
import { OnboardingRequest, OnboardingResult } from "../../shared/types/onboarding";

const TENANT_ID_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Same bucket Member 4's KB retrieval code already uses (scripts/create-kb-bucket.ts,
// agents/utils/s3-client.ts) — NOT the "platform-kb" name used as an illustrative
// example in the task doc, which doesn't exist anywhere else in this codebase. Using
// the bucket that's actually provisioned elsewhere in the repo, rather than inventing
// a second one nothing else references. See ADR-015.
const KB_BUCKET_NAME = process.env.KB_BUCKET_NAME || "omni-channel-kb-docs";

export interface OnboardingDeps {
  dynamo: DynamoDBDocumentClient;
  cognito: CognitoIdentityProviderClient;
  s3: S3Client;
  userPoolId: string;
}

export interface OnboardingOutcome {
  success: boolean;
  data?: OnboardingResult;
  error?: AgentActionResponse["error"];
}

function defaultDeps(): OnboardingDeps {
  const userPoolId = process.env.COGNITO_USER_POOL_ID;
  if (!userPoolId) {
    throw new Error(
      "COGNITO_USER_POOL_ID environment variable is not set. It must be wired from " +
        "module.cognito.user_pool_id (infra/main.tf output) into the onboarding Lambda's environment."
    );
  }
  return { dynamo: docClient, cognito: cognitoClient, s3: s3Client, userPoolId };
}

/**
 * Validates an OnboardingRequest without touching any external service.
 * Exported separately so callers (and tests) can validate cheaply before
 * paying for a network round-trip.
 */
export function validateOnboardingRequest(
  request: Partial<OnboardingRequest>
): AgentActionResponse["error"] | null {
  if (!request.companyName || !request.companyName.trim()) {
    return {
      code: "BAD_REQUEST",
      message: "Missing required field: 'companyName'",
      retryable: false,
      details: { requiredField: "companyName" },
    };
  }

  if (!request.tenantId || !TENANT_ID_PATTERN.test(request.tenantId)) {
    return {
      code: "BAD_REQUEST",
      message:
        "'tenantId' is required and must be a lowercase alphanumeric slug (hyphens allowed, no leading/trailing hyphen), e.g. 'acme-corp'.",
      retryable: false,
      details: { requiredField: "tenantId", pattern: TENANT_ID_PATTERN.source },
    };
  }

  if (!request.adminEmail || !EMAIL_PATTERN.test(request.adminEmail)) {
    return {
      code: "BAD_REQUEST",
      message: "'adminEmail' is required and must be a valid email address.",
      retryable: false,
      details: { requiredField: "adminEmail" },
    };
  }

  return null;
}

/**
 * Generates a temporary password that satisfies infra/cognito/main.tf's password
 * policy (min 8 chars, upper, lower, number, symbol). Built from guaranteed
 * character classes rather than pure randomness so it can never fail the policy.
 */
function generateTemporaryPassword(): string {
  const upper = "ABCDEFGHJKLMNPQRSTUVWXYZ";
  const lower = "abcdefghijkmnopqrstuvwxyz";
  const digits = "23456789";
  const symbols = "!@#$%^&*";
  const all = upper + lower + digits + symbols;

  const pick = (chars: string) => chars[randomBytes(1)[0] % chars.length];

  const guaranteed = [pick(upper), pick(lower), pick(digits), pick(symbols)];
  const rest = Array.from({ length: 8 }, () => pick(all));
  const chars = [...guaranteed, ...rest];

  // Shuffle so the guaranteed classes aren't always in the same first-4 positions.
  for (let i = chars.length - 1; i > 0; i--) {
    const j = randomBytes(1)[0] % (i + 1);
    [chars[i], chars[j]] = [chars[j], chars[i]];
  }
  return chars.join("");
}

/**
 * Company onboarding pipeline. Provisions a new tenant end-to-end:
 *   1. Validate input.
 *   2. Reject if the tenantId is already taken (idempotency / no silent overwrite).
 *   3. Write the tenant record to omni-channel-tenants.
 *   4. Write a default "main-agent" record to omni-channel-agents.
 *   5. Provision the tenant's isolated S3 knowledge-base prefix.
 *   6. Create the company admin's Cognito user with custom:tenant_id set, a
 *      generated temporary password, and add them to the 'admin' group.
 *   7. Return the temporary password in the response (see ADR-015) instead of
 *      relying on Cognito's auto-email, so the Admin Console can show it directly.
 *
 * NOTE ON ORCHESTRATION: the task allocation names this an "AWS Step Functions /
 * Lambda" pipeline. In this Phase 1 implementation, the steps above are executed
 * sequentially in-process by a single Lambda invocation rather than as separate
 * Step Functions Task states — see infra/step-functions/main.tf, which wraps this
 * same Lambda in a single-task state machine so the step-by-step structure above
 * can be split into real Task states later (e.g. inserting a manual-review/approval
 * step between tenant creation and Cognito user creation) without changing this
 * function's external contract.
 *
 * NOTE ON FAILURE HANDLING: this is best-effort compensation, not a real saga /
 * distributed transaction. If a later step fails, earlier writes (DynamoDB records,
 * the S3 prefix marker) are rolled back on a best-effort basis. If the rollback
 * itself fails, that failure is logged but not retried — see the Explicit Deferral
 * note in ADR-013 (docs/decisions.md).
 */
export async function onboardCompany(
  request: Partial<OnboardingRequest>,
  deps?: OnboardingDeps
): Promise<OnboardingOutcome> {
  // 1. Validate input
  const validationError = validateOnboardingRequest(request);
  if (validationError) {
    return { success: false, error: validationError };
  }
  const input = request as OnboardingRequest;

  const resolvedDeps = deps || defaultDeps();
  const { dynamo, cognito, s3, userPoolId } = resolvedDeps;

  // 2. Reject if tenantId is already taken
  try {
    const existing = await dynamo.send(
      new GetCommand({ TableName: "omni-channel-tenants", Key: { tenantId: input.tenantId } })
    );
    if (existing.Item) {
      return {
        success: false,
        error: {
          code: "TENANT_ALREADY_EXISTS",
          message: `A tenant with tenantId '${input.tenantId}' is already registered.`,
          retryable: false,
          details: { tenantId: input.tenantId },
        },
      };
    }
  } catch (err) {
    return {
      success: false,
      error: {
        code: "INTERNAL_ERROR",
        message: `Failed to check for existing tenant: ${(err as Error).message}`,
        retryable: true,
      },
    };
  }

  const createdAt = new Date().toISOString();
  const allowedChannels = input.allowedChannels && input.allowedChannels.length > 0
    ? input.allowedChannels
    : ["web", "whatsapp", "sms", "messenger"];
  const kbPrefix = `${input.tenantId}/`;
  const kbMarkerKey = `${input.tenantId}/.kb-prefix`;

  // 3. Write tenant record
  try {
    await dynamo.send(
      new PutCommand({
        TableName: "omni-channel-tenants",
        Item: {
          tenantId: input.tenantId,
          name: input.companyName,
          status: "active",
          allowedChannels,
          defaultAgent: "main-agent",
        },
        // Belt-and-braces against a race between the check in step 2 and this write.
        ConditionExpression: "attribute_not_exists(tenantId)",
      })
    );
  } catch (err: any) {
    if (err.name === "ConditionalCheckFailedException") {
      return {
        success: false,
        error: {
          code: "TENANT_ALREADY_EXISTS",
          message: `A tenant with tenantId '${input.tenantId}' is already registered.`,
          retryable: false,
          details: { tenantId: input.tenantId },
        },
      };
    }
    return {
      success: false,
      error: {
        code: "INTERNAL_ERROR",
        message: `Failed to create tenant record: ${(err as Error).message}`,
        retryable: true,
      },
    };
  }

  // 4. Write default agent record
  try {
    await dynamo.send(
      new PutCommand({
        TableName: "omni-channel-agents",
        Item: {
          tenantId: input.tenantId,
          agentId: "main-agent",
          name: "Main Agent",
          status: "active",
          defaultModel: "claude-sonnet-4-6",
          createdAt,
        },
      })
    );
  } catch (err) {
    await bestEffortRollback(dynamo, s3, input.tenantId, "default agent record creation failed");
    return {
      success: false,
      error: {
        code: "INTERNAL_ERROR",
        message: `Failed to create default agent record: ${(err as Error).message}`,
        retryable: true,
      },
    };
  }

  // 5. Provision the tenant's isolated S3 knowledge-base prefix.
  // S3 has no real "create a folder" operation — a prefix exists once something is
  // written under it. This marker object is that anchor: it makes the tenant's
  // prefix visible/browsable immediately (e.g. in the S3 console or a `list-objects`
  // call) rather than only appearing once Member 4's KB upload flow writes the first
  // real document there.
  try {
    await s3.send(
      new PutObjectCommand({
        Bucket: KB_BUCKET_NAME,
        Key: kbMarkerKey,
        Body: `Knowledge base prefix provisioned for tenant '${input.tenantId}' at ${createdAt}.`,
        ContentType: "text/plain",
      })
    );
  } catch (err) {
    await bestEffortRollback(dynamo, s3, input.tenantId, "S3 knowledge-base prefix provisioning failed");
    return {
      success: false,
      error: {
        code: "INTERNAL_ERROR",
        message: `Failed to provision S3 knowledge-base prefix: ${(err as Error).message}`,
        retryable: true,
      },
    };
  }

  // 6. Create Cognito admin user, bound to this tenant, in the 'admin' group, with
  // a generated temporary password (returned to the caller in step 7 below instead
  // of relying on Cognito's auto-email — see ADR-015).
  const adminUsername = input.adminEmail;
  const temporaryPassword = generateTemporaryPassword();
  try {
    await cognito.send(
      new AdminCreateUserCommand({
        UserPoolId: userPoolId,
        Username: adminUsername,
        UserAttributes: [
          { Name: "email", Value: input.adminEmail },
          { Name: "email_verified", Value: "true" },
          { Name: "custom:tenant_id", Value: input.tenantId },
        ],
        TemporaryPassword: temporaryPassword,
        MessageAction: "SUPPRESS", // don't also auto-email — the API response carries the credential.
      })
    );

    await cognito.send(
      new AdminAddUserToGroupCommand({
        UserPoolId: userPoolId,
        Username: adminUsername,
        GroupName: "admin",
      })
    );
  } catch (err) {
    await bestEffortRollback(dynamo, s3, input.tenantId, "Cognito admin user creation failed");
    return {
      success: false,
      error: {
        code: "INTERNAL_ERROR",
        message: `Failed to create Cognito admin user: ${(err as Error).message}`,
        retryable: true,
        details: { rolledBack: true },
      },
    };
  }

  // 7. Return the temporary credentials + kb prefix directly in the response.
  return {
    success: true,
    data: {
      tenantId: input.tenantId,
      companyName: input.companyName,
      adminUsername,
      temporaryPassword,
      kbPrefix,
      status: "provisioned",
      createdAt,
    },
  };
}

async function bestEffortRollback(
  dynamo: DynamoDBDocumentClient,
  s3: S3Client,
  tenantId: string,
  reason: string
): Promise<void> {
  console.error(`[Onboarding] Rolling back tenant '${tenantId}' after failure: ${reason}`);
  try {
    await dynamo.send(new DeleteCommand({ TableName: "omni-channel-agents", Key: { tenantId, agentId: "main-agent" } }));
    await dynamo.send(new DeleteCommand({ TableName: "omni-channel-tenants", Key: { tenantId } }));
  } catch (rollbackErr) {
    console.error(`[Onboarding] DynamoDB rollback ALSO failed for tenant '${tenantId}'. Manual cleanup required.`, rollbackErr);
  }
  try {
    await s3.send(new DeleteObjectCommand({ Bucket: KB_BUCKET_NAME, Key: `${tenantId}/.kb-prefix` }));
  } catch (rollbackErr) {
    // Not fatal — a leftover marker object with no tenant/agent records is harmless
    // clutter, not a security or correctness issue, so this is logged only.
    console.error(`[Onboarding] S3 marker rollback failed for tenant '${tenantId}' (non-fatal).`, rollbackErr);
  }
}
