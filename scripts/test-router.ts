import { GetCommand } from "@aws-sdk/lib-dynamodb";
import { routeRequest, TenantRouterDeps, TenantConfig } from "../services/tenant-router/router";
import { TenantContext } from "../shared/types/tenant-context";

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

function makeFakeDeps(tenants: Record<string, TenantConfig>, opts: { fail?: boolean } = {}): TenantRouterDeps {
  return {
    dynamo: {
      send: async (command: any) => {
        if (opts.fail) throw new Error("simulated DynamoDB outage");
        if (command instanceof GetCommand) {
          const input: any = command.input;
          return { Item: tenants[input.Key.tenantId] };
        }
        throw new Error(`Unhandled fake DynamoDB command: ${command.constructor.name}`);
      },
    } as any,
  };
}

function makeContext(tenantId: string): TenantContext {
  return {
    tenantId,
    userId: "user-123",
    role: "staff",
    permissions: [],
    channel: "web",
    sessionId: "sess-1",
    conversationId: "conv-1",
  };
}

async function run() {
  console.log("--- Tenant Router (DynamoDB-backed) Verification ---\n");

  {
    const deps = makeFakeDeps({
      slt: { tenantId: "slt", name: "Sri Lanka Telecom", status: "active", allowedChannels: ["web"], defaultAgent: "main-agent" },
    });
    const result = await routeRequest(makeContext("slt"), deps);
    check("Active tenant routes to its defaultAgent", result.success && result.data?.targetAgent === "main-agent", result);
  }

  {
    const deps = makeFakeDeps({});
    const result = await routeRequest(makeContext("ghost-tenant"), deps);
    check("Unknown tenant rejected as TENANT_NOT_FOUND", !result.success && result.error?.code === "TENANT_NOT_FOUND", result);
  }

  {
    const deps = makeFakeDeps({
      "acme-corp": { tenantId: "acme-corp", name: "Acme Corp", status: "suspended", allowedChannels: ["web"], defaultAgent: "main-agent" },
    });
    const result = await routeRequest(makeContext("acme-corp"), deps);
    check("Suspended tenant rejected as TENANT_INACTIVE", !result.success && result.error?.code === "TENANT_INACTIVE", result);
  }

  {
    const deps = makeFakeDeps({}, { fail: true });
    const result = await routeRequest(makeContext("slt"), deps);
    check(
      "DynamoDB failure surfaces as retryable INTERNAL_ERROR",
      !result.success && result.error?.code === "INTERNAL_ERROR" && result.error?.retryable === true,
      result
    );
  }

  console.log(`\n--- ${passed} passed, ${failed} failed ---`);
  if (failed > 0) process.exitCode = 1;
}

run();