/**
 * Unit-style verification for the onboarding pipeline (services/onboarding/onboarding.ts).
 * Uses in-memory fake DynamoDB/Cognito clients injected via OnboardingDeps, so this
 * runs standalone with no LocalStack container required — it verifies the pipeline's
 * own logic (validation, duplicate rejection, rollback-on-failure), not the AWS SDK
 * wiring itself. Run scripts/create-tenants-table.ts + scripts/test-tenant-resolver.ts
 * against a live LocalStack for that.
 */
import { GetCommand, PutCommand, DeleteCommand } from "@aws-sdk/lib-dynamodb";
import { AdminCreateUserCommand, AdminAddUserToGroupCommand } from "@aws-sdk/client-cognito-identity-provider";
import { PutObjectCommand, DeleteObjectCommand } from "@aws-sdk/client-s3";
import { onboardCompany, OnboardingDeps } from "../services/onboarding/onboarding";
import { handleOnboardingRequest } from "../services/onboarding/handler";

process.env.ALLOW_MOCK_AUTH = "true";

let passed = 0;
let failed = 0;
function check(label: string, condition: boolean, detail?: unknown) {
  if (condition) {
    console.log(` ${label}`);
    passed++;
  } else {
    console.log(` ${label}`, detail ? JSON.stringify(detail) : "");
    failed++;
  }
}

function makeFakeDeps(opts: { failCognito?: boolean; failS3?: boolean } = {}): {
  deps: OnboardingDeps;
  tenants: Map<string, any>;
  agents: Map<string, any>;
  s3Objects: Map<string, any>;
  cognitoCalls: string[];
} {
  const tenants = new Map<string, any>();
  const agents = new Map<string, any>();
  const s3Objects = new Map<string, any>();
  const cognitoCalls: string[] = [];

  const dynamo = {
    send: async (command: any) => {
      const input: any = command.input;
      if (command instanceof GetCommand) {
        if (input.TableName === "omni-channel-tenants") {
          return { Item: tenants.get(input.Key.tenantId) };
        }
        return { Item: undefined };
      }
      if (command instanceof PutCommand) {
        if (input.TableName === "omni-channel-tenants") {
          const key = input.Item.tenantId;
          if (input.ConditionExpression && tenants.has(key)) {
            const err: any = new Error("ConditionalCheckFailedException");
            err.name = "ConditionalCheckFailedException";
            throw err;
          }
          tenants.set(key, input.Item);
        } else if (input.TableName === "omni-channel-agents") {
          agents.set(`${input.Item.tenantId}#${input.Item.agentId}`, input.Item);
        }
        return {};
      }
      if (command instanceof DeleteCommand) {
        if (input.TableName === "omni-channel-tenants") {
          tenants.delete(input.Key.tenantId);
        } else if (input.TableName === "omni-channel-agents") {
          agents.delete(`${input.Key.tenantId}#${input.Key.agentId}`);
        }
        return {};
      }
      throw new Error(`Unhandled fake DynamoDB command: ${command.constructor.name}`);
    },
  };

  const cognito = {
    send: async (command: any) => {
      if (command instanceof AdminCreateUserCommand) {
        cognitoCalls.push("AdminCreateUserCommand");
        if (opts.failCognito) throw new Error("simulated Cognito outage");
        return {};
      }
      if (command instanceof AdminAddUserToGroupCommand) {
        cognitoCalls.push("AdminAddUserToGroupCommand");
        return {};
      }
      throw new Error(`Unhandled fake Cognito command: ${command.constructor.name}`);
    },
  };

  const s3 = {
    send: async (command: any) => {
      const input: any = command.input;
      if (command instanceof PutObjectCommand) {
        if (opts.failS3) throw new Error("simulated S3 outage");
        s3Objects.set(input.Key, input.Body);
        return {};
      }
      if (command instanceof DeleteObjectCommand) {
        s3Objects.delete(input.Key);
        return {};
      }
      throw new Error(`Unhandled fake S3 command: ${command.constructor.name}`);
    },
  };

  return {
    deps: { dynamo: dynamo as any, cognito: cognito as any, s3: s3 as any, userPoolId: "fake-pool-id" },
    tenants,
    agents,
    s3Objects,
    cognitoCalls,
  };
}

async function run() {
  console.log("--- Onboarding Pipeline Verification ---\n");

  // 1. Missing companyName is rejected before any network call
  {
    const { deps } = makeFakeDeps();
    const result = await onboardCompany({ tenantId: "acme-corp", adminEmail: "a@acme.com" }, deps);
    check("Missing companyName rejected as BAD_REQUEST", !result.success && result.error?.code === "BAD_REQUEST", result);
  }

  // 2. Invalid tenantId slug is rejected
  {
    const { deps } = makeFakeDeps();
    const result = await onboardCompany(
      { companyName: "Acme Corp", tenantId: "Not A Slug!", adminEmail: "a@acme.com" },
      deps
    );
    check("Invalid tenantId slug rejected as BAD_REQUEST", !result.success && result.error?.code === "BAD_REQUEST", result);
  }

  // 3. Invalid email is rejected
  {
    const { deps } = makeFakeDeps();
    const result = await onboardCompany({ companyName: "Acme Corp", tenantId: "acme-corp", adminEmail: "not-an-email" }, deps);
    check("Invalid adminEmail rejected as BAD_REQUEST", !result.success && result.error?.code === "BAD_REQUEST", result);
  }

  // 4. Happy path: full pipeline succeeds and writes tenant + agent + S3 prefix + credentials
  {
    const { deps, tenants, agents, s3Objects, cognitoCalls } = makeFakeDeps();
    const result = await onboardCompany(
      { companyName: "Acme Corp", tenantId: "acme-corp", adminEmail: "admin@acme.com" },
      deps
    );
    check("Happy path succeeds", result.success && result.data?.tenantId === "acme-corp", result);
    check("Tenant record written", tenants.has("acme-corp"));
    check("Default agent record written", agents.has("acme-corp#main-agent"));
    check("S3 knowledge-base prefix marker written", s3Objects.has("acme-corp/.kb-prefix"), [...s3Objects.keys()]);
    check("Response includes kbPrefix", result.data?.kbPrefix === "acme-corp/", result.data);
    check(
      "Response includes a real temporary password meeting Cognito's policy (8+ chars, mixed case, digit, symbol)",
      !!result.data?.temporaryPassword &&
        result.data.temporaryPassword.length >= 8 &&
        /[A-Z]/.test(result.data.temporaryPassword) &&
        /[a-z]/.test(result.data.temporaryPassword) &&
        /[0-9]/.test(result.data.temporaryPassword) &&
        /[!@#$%^&*]/.test(result.data.temporaryPassword),
      result.data?.temporaryPassword
    );
    check(
      "Cognito user created and added to admin group",
      cognitoCalls.join(",") === "AdminCreateUserCommand,AdminAddUserToGroupCommand",
      cognitoCalls
    );
  }

  // 5. Duplicate tenantId is rejected (409-style), no second write
  {
    const { deps, tenants } = makeFakeDeps();
    tenants.set("acme-corp", { tenantId: "acme-corp", name: "Acme Corp", status: "active" });
    const result = await onboardCompany(
      { companyName: "Acme Corp Again", tenantId: "acme-corp", adminEmail: "admin2@acme.com" },
      deps
    );
    check("Duplicate tenantId rejected as TENANT_ALREADY_EXISTS", !result.success && result.error?.code === "TENANT_ALREADY_EXISTS", result);
  }

  // 6. Cognito failure triggers rollback of the DynamoDB writes AND the S3 marker
  {
    const { deps, tenants, agents, s3Objects } = makeFakeDeps({ failCognito: true });
    const result = await onboardCompany(
      { companyName: "Acme Corp", tenantId: "acme-corp", adminEmail: "admin@acme.com" },
      deps
    );
    check("Cognito failure surfaces as INTERNAL_ERROR", !result.success && result.error?.code === "INTERNAL_ERROR", result);
    check("Tenant record rolled back after Cognito failure", !tenants.has("acme-corp"), [...tenants.keys()]);
    check("Agent record rolled back after Cognito failure", !agents.has("acme-corp#main-agent"), [...agents.keys()]);
    check("S3 marker rolled back after Cognito failure", !s3Objects.has("acme-corp/.kb-prefix"), [...s3Objects.keys()]);
  }

  // 6b. S3 failure triggers rollback of the DynamoDB writes too (fails before Cognito is ever called)
  {
    const { deps, tenants, agents, cognitoCalls } = makeFakeDeps({ failS3: true });
    const result = await onboardCompany(
      { companyName: "Acme Corp", tenantId: "acme-corp", adminEmail: "admin@acme.com" },
      deps
    );
    check("S3 failure surfaces as INTERNAL_ERROR", !result.success && result.error?.code === "INTERNAL_ERROR", result);
    check("Tenant record rolled back after S3 failure", !tenants.has("acme-corp"), [...tenants.keys()]);
    check("Agent record rolled back after S3 failure", !agents.has("acme-corp#main-agent"), [...agents.keys()]);
    check("Cognito was never called after S3 failed (correct step ordering)", cognitoCalls.length === 0, cognitoCalls);
  }

  // 7. Handler-level auth boundary: no Authorization header at all -> 401
  {
    const result = await handleOnboardingRequest({ headers: {} });
    check("Handler rejects missing Authorization header (UNAUTHORIZED)", !result.success && result.error?.code === "UNAUTHORIZED", result);
  }

  // 8. Handler-level auth boundary: authenticated but wrong role -> 403
  //    (mock validator's dev-token-billing-only decodes to role "staff" though, so
  //    use a 3-part token with cognito:groups: ["admin"] to exercise a non-staff caller)
  {
    const header = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64");
    const payload = Buffer.from(
      JSON.stringify({ sub: "usr-admin-a1", "cognito:groups": ["admin"], "custom:tenant_id": "acme-corp" })
    ).toString("base64");
    const nonStaffToken = `${header}.${payload}.mock-signature`;

    const result = await handleOnboardingRequest({
      headers: { authorization: `Bearer ${nonStaffToken}` },
      body: { companyName: "Acme Corp", tenantId: "acme-corp", adminEmail: "admin@acme.com" },
    });
    check(
      "Handler rejects a caller who isn't platform staff (FORBIDDEN)",
      !result.success && result.error?.code === "FORBIDDEN" && result.error?.details?.callerRole === "admin",
      result
    );
  }

  console.log(`\n--- ${passed} passed, ${failed} failed ---`);
  if (failed > 0) process.exitCode = 1;
}

run();