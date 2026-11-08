import {
  DynamoDBDocumentClient,
  GetCommand,
  QueryCommand,
  ScanCommand,
} from "@aws-sdk/lib-dynamodb";
import { docClient } from "../../agents/utils/dynamo-client";
import { inMemoryTenants } from "../../scripts/create-tenants-table";

const SLUG_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

export interface HostedChatConfig {
  success: true;
  tenantId: string;
  companyName: string;
  companySlug: string;
  agentId: string;
  agentName: string;
  welcomeMessage: string;
  themeColor: string;
  suggestedPrompts: string[];
  deploymentStatus: string;
}

export type ResolveHostedChatResult =
  | { ok: true; status: 200; config: HostedChatConfig }
  | { ok: false; status: 404 | 503; error: string };

export interface ChatUrlResolverDeps {
  dynamo?: DynamoDBDocumentClient;
  tenantsTable?: string;
  agentsTable?: string;
  isLocalDev?: () => boolean;
}

function defaultIsLocalDev(): boolean {
  const nodeEnv = (process.env.NODE_ENV || "").trim().toLowerCase();
  return nodeEnv !== "production" && nodeEnv !== "prod" && process.env.IS_LOCAL !== "false";
}

function isConnectivityError(err: any): boolean {
  return (
    err?.code === "ECONNREFUSED" ||
    Boolean(err?.message?.includes("ECONNREFUSED")) ||
    Boolean(err?.message?.includes("connect"))
  );
}

async function findTenantRecord(
  dynamo: DynamoDBDocumentClient,
  tenantsTable: string,
  companySlug: string
): Promise<Record<string, any> | null> {
  const candidates = companySlug.startsWith("tenant-")
    ? [companySlug]
    : [companySlug, `tenant-${companySlug}`];

  for (const tenantId of candidates) {
    const res = await dynamo.send(
      new GetCommand({
        TableName: tenantsTable,
        Key: { tenantId },
      })
    );
    if (res.Item) {
      return res.Item as Record<string, any>;
    }
  }

  let lastKey: Record<string, any> | undefined;
  do {
    const scan = await dynamo.send(
      new ScanCommand({
        TableName: tenantsTable,
        FilterExpression: "companySlug = :slug",
        ExpressionAttributeValues: { ":slug": companySlug },
        ExclusiveStartKey: lastKey,
      })
    );
    if ((scan.Items || []).length > 0) {
      return scan.Items![0] as Record<string, any>;
    }
    lastKey = scan.LastEvaluatedKey;
  } while (lastKey);

  return null;
}

async function listTenantAgents(
  dynamo: DynamoDBDocumentClient,
  agentsTable: string,
  tenantId: string
): Promise<Array<Record<string, any>>> {
  const records: Array<Record<string, any>> = [];
  let nextKey: Record<string, any> | undefined;
  do {
    const page = await dynamo.send(
      new QueryCommand({
        TableName: agentsTable,
        KeyConditionExpression: "tenantId = :tenant",
        ExpressionAttributeValues: { ":tenant": tenantId },
        ExclusiveStartKey: nextKey,
      })
    );
    records.push(...((page.Items || []) as Array<Record<string, any>>));
    nextKey = page.LastEvaluatedKey;
  } while (nextKey);
  return records;
}

function isSupportAgentAvailable(agent: Record<string, any>): boolean {
  const status = String(agent.status || "").toUpperCase();
  return status === "ACTIVE" || status === "PUBLISHED";
}

export async function resolveHostedChatConfig(
  rawCompanySlug: unknown,
  rawAgentSlug: unknown,
  deps?: ChatUrlResolverDeps
): Promise<ResolveHostedChatResult> {
  const companySlug =
    typeof rawCompanySlug === "string" && rawCompanySlug.trim()
      ? rawCompanySlug.trim().toLowerCase()
      : "slt";
  const agentSlug =
    typeof rawAgentSlug === "string" && rawAgentSlug.trim()
      ? rawAgentSlug.trim().toLowerCase()
      : "support";

  if (!SLUG_PATTERN.test(companySlug) || !SLUG_PATTERN.test(agentSlug)) {
    return { ok: false, status: 404, error: "Chatbot not found" };
  }

  const dynamo = deps?.dynamo || docClient;
  const tenantsTable = deps?.tenantsTable || process.env.TENANTS_TABLE || "omni-channel-tenants";
  const agentsTable = deps?.agentsTable || process.env.AGENTS_TABLE || "omni-channel-agents";
  const isLocal = (deps?.isLocalDev || defaultIsLocalDev)();

  try {
    const tenant = await findTenantRecord(dynamo, tenantsTable, companySlug);
    if (!tenant || String(tenant.status || "").toLowerCase() !== "active") {
      return { ok: false, status: 404, error: "Chatbot not found" };
    }

    const tenantId = String(tenant.tenantId);
    const companyName = String(tenant.name || tenant.companyName || tenantId);
    const themeColor = String(
      tenant.themeColor || tenant.config?.themeColor || "#005EB8"
    );
    const defaultAgentId = String(tenant.defaultAgent || "main-agent");

    const agents = await listTenantAgents(dynamo, agentsTable, tenantId);

    let matchedAgent: Record<string, any> | undefined;
    if (agentSlug === "support") {
      matchedAgent =
        agents.find((a) => a.publicAgentKey === "support" && isSupportAgentAvailable(a)) ||
        agents.find((a) => a.agentId === defaultAgentId && isSupportAgentAvailable(a)) ||
        agents.find((a) => a.agentId === "main-agent" && isSupportAgentAvailable(a)) ||
        agents.find((a) => String(a.specialist || "").toLowerCase() === "support" && isSupportAgentAvailable(a));

      if (!matchedAgent) {
        return { ok: false, status: 404, error: "Default support chatbot is not active" };
      }
    } else {
      const publishedMatches = agents.filter(
        (a) =>
          a.publicAgentKey === agentSlug &&
          String(a.status || "").toUpperCase() === "PUBLISHED"
      );
      if (publishedMatches.length !== 1) {
        return { ok: false, status: 404, error: "This chatbot has not been published" };
      }
      matchedAgent = publishedMatches[0];
    }

    const resolvedCompanyName = String(matchedAgent.brandName || companyName);
    const defaultPrompts =
      tenantId === "slt" && agentSlug === "support"
        ? ["Check my bill", "Check my usage", "Slow internet", "Talk to a person"]
        : ["How can you help me?", "Talk to a person"];

    return {
      ok: true,
      status: 200,
      config: {
        success: true,
        tenantId,
        companyName: resolvedCompanyName,
        companySlug: String(tenant.companySlug || companySlug),
        agentId: String(matchedAgent.agentId),
        agentName: String(
          matchedAgent.displayName ||
            matchedAgent.name ||
            matchedAgent.agentName ||
            `${resolvedCompanyName} Assistant`
        ),
        welcomeMessage: String(
          matchedAgent.welcomeMessage ||
            `Welcome to ${resolvedCompanyName}! How can we assist you today?`
        ),
        themeColor,
        suggestedPrompts: Array.isArray(matchedAgent.suggestedPrompts)
          ? matchedAgent.suggestedPrompts
          : defaultPrompts,
        deploymentStatus: String(matchedAgent.deploymentStatus || "NOT_DEPLOYED"),
      },
    };
  } catch (err: any) {
    if (!deps?.dynamo && isLocal && companySlug === "slt" && agentSlug === "support" && isConnectivityError(err)) {
      const fallback = inMemoryTenants.get("slt");
      const companyName = fallback?.companyName || "Sri Lanka Telecom";
      return {
        ok: true,
        status: 200,
        config: {
          success: true,
          tenantId: "slt",
          companyName,
          companySlug: "slt",
          agentId: "main-agent",
          agentName: `${companyName} Assistant`,
          welcomeMessage: `Welcome to ${companyName}! How can we assist you today?`,
          themeColor: fallback?.config?.themeColor || "#005EB8",
          suggestedPrompts: ["Check my bill", "Check my usage", "Slow internet", "Talk to a person"],
          deploymentStatus: "DEPLOYED",
        },
      };
    }
    console.error("[ChatUrlResolver] DynamoDB error:", err);
    return { ok: false, status: 503, error: "Chatbot configuration unavailable" };
  }
}

