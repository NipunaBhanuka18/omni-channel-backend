import { uploadKbDocument } from "../../agents/utils/s3-client";
import { TenantContext } from "../../shared/types/tenant-context";
import {
  inMemoryTenants,
  inMemoryAgents,
  TenantRecord,
  TenantAgentRecord,
} from "../../scripts/create-tenants-table";
import { onboardCompany, OnboardingDeps } from "./onboarding";
import { deriveTenantId, normalizeCompanySlug } from "../../shared/utils/tenant-name";

export interface RegisterTenantInput {
  companyName: string;
  companySlug: string;
  adminEmail: string;
  planTier?: "starter" | "pro" | "enterprise";
  themeColor?: string;
  allowedOrigins?: string[];
}

export interface RegisterTenantResult {
  success: boolean;
  tenantId: string;
  companyName: string;
  companySlug: string;
  adminEmail: string;
  status: "active" | "pending";
  planTier: "starter" | "pro" | "enterprise";
  defaultAgent: {
    agentId: string;
    agentName: string;
    specialist: string;
  };
  credentials: {
    username: string;
    temporaryPassword: string;
    userPoolId: string;
    loginUrl: string;
  };
  storage: {
    s3Prefix: string;
    welcomeDocKey: string;
  };
  message: string;
}

/**
 * Onboards a new company onto the Multi-Tenant Platform by delegating to the
 * single durable onboarding pipeline (onboardCompany).
 */
export async function registerTenant(
  input: RegisterTenantInput,
  deps?: OnboardingDeps
): Promise<RegisterTenantResult> {
  if (!input.companyName || !input.companyName.trim()) {
    throw new Error("Validation Failed: 'companyName' is required.");
  }
  if (!input.companySlug || !input.companySlug.trim()) {
    throw new Error("Validation Failed: 'companySlug' is required.");
  }
  if (!input.adminEmail || !input.adminEmail.includes("@")) {
    throw new Error("Validation Failed: Valid 'adminEmail' is required.");
  }

  const cleanSlug = normalizeCompanySlug(input.companySlug);
  const tenantId = deriveTenantId(cleanSlug, input.companyName);
  const planTier = input.planTier || "starter";

  const outcome = await onboardCompany(
    {
      companyName: input.companyName.trim(),
      tenantId,
      adminEmail: input.adminEmail.trim().toLowerCase(),
      companySlug: cleanSlug,
      tier: planTier,
      themeColor: input.themeColor || "#005EB8",
      allowedChannels: ["web", "whatsapp", "sms", "messenger"],
    },
    deps
  );

  if (!outcome.success || !outcome.data) {
    const errCode = outcome.error?.code;
    if (errCode === "TENANT_ALREADY_EXISTS" || errCode === "COMPANY_NAME_ALREADY_EXISTS") {
      throw new Error(`Conflict: Tenant with ID '${tenantId}' already exists.`);
    }
    if (errCode === "BAD_REQUEST") {
      throw new Error(`Validation Failed: ${outcome.error?.message || "Invalid input"}`);
    }
    throw new Error(outcome.error?.message || "Failed to onboard tenant");
  }

  const now = outcome.data.createdAt;
  const defaultAgentId = `agent-${cleanSlug}-support-01`;

  // Maintain local fallback maps for offline/dev compatibility
  const tenantRecord: TenantRecord = {
    tenantId,
    companyName: input.companyName.trim(),
    companySlug: cleanSlug,
    adminEmail: input.adminEmail.trim().toLowerCase(),
    status: "active",
    planTier,
    createdAt: now,
    updatedAt: now,
    config: {
      themeColor: input.themeColor || "#005EB8",
      allowedOrigins: input.allowedOrigins || ["*"],
    },
  };
  inMemoryTenants.set(tenantId, tenantRecord);

  const defaultAgent: TenantAgentRecord = {
    tenantId,
    agentId: defaultAgentId,
    agentName: `${input.companyName} Customer Support Specialist`,
    specialist: "support",
    status: "active",
    welcomeMessage: `Hello! Welcome to ${input.companyName} AI Support. How can we assist you today?`,
    createdAt: now,
  };
  inMemoryAgents.set(`${tenantId}#${defaultAgentId}`, defaultAgent);

  // Best-effort optional welcome doc in isolated S3 prefix
  let welcomeDocKey = `${outcome.data.kbPrefix}welcome.txt`;
  try {
    const tenantContext: TenantContext = {
      tenantId,
      userId: "system-onboarding",
      role: "admin",
      permissions: ["faults:read", "billing:read", "usage:read"],
      channel: "web",
      sessionId: `sess-onboard-${Date.now()}`,
      conversationId: `conv-onboard-${Date.now()}`,
    };
    welcomeDocKey = await uploadKbDocument(
      tenantContext,
      "welcome.txt",
      `# Welcome to ${input.companyName} Knowledge Base\nTenant: ${tenantId}`
    );
  } catch {
    // Non-fatal optional welcome document
  }

  const userPoolId =
    deps?.userPoolId || process.env.COGNITO_USER_POOL_ID || "omni-channel-user-pool-dev";

  return {
    success: true,
    tenantId,
    companyName: input.companyName,
    companySlug: cleanSlug,
    adminEmail: input.adminEmail,
    status: "active",
    planTier,
    defaultAgent: {
      agentId: defaultAgentId,
      agentName: defaultAgent.agentName,
      specialist: defaultAgent.specialist,
    },
    credentials: {
      username: outcome.data.adminUsername,
      temporaryPassword: outcome.data.temporaryPassword,
      userPoolId,
      loginUrl: `https://console.platform.com/login?tenant=${tenantId}`,
    },
    storage: {
      s3Prefix: outcome.data.kbPrefix,
      welcomeDocKey,
    },
    message: `Tenant '${input.companyName}' (${tenantId}) successfully onboarded with isolated partition, S3 folder, and Admin credentials.`,
  };
}

/**
 * Lambda / HTTP Gateway handler for POST /tenants/register
 */
export async function handleRegisterTenantRequest(
  event: {
    httpMethod?: string;
    body?: string | Record<string, any>;
  },
  deps?: OnboardingDeps
): Promise<{ statusCode: number; headers: Record<string, string>; body: string }> {
  const headers = {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
  };

  try {
    let payload: RegisterTenantInput;
    if (typeof event.body === "string") {
      payload = JSON.parse(event.body);
    } else if (typeof event.body === "object" && event.body !== null) {
      payload = event.body as RegisterTenantInput;
    } else {
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({
          success: false,
          error: "BAD_REQUEST",
          message: "Request body is required.",
        }),
      };
    }

    const result = await registerTenant(payload, deps);
    return {
      statusCode: 201,
      headers,
      body: JSON.stringify(result),
    };
  } catch (error: any) {
    const isConflict = error.message?.includes("already exists") || error.message?.includes("Conflict");
    const statusCode = isConflict ? 409 : 400;

    return {
      statusCode,
      headers,
      body: JSON.stringify({
        success: false,
        error: isConflict ? "CONFLICT" : "INVALID_INPUT",
        message: error.message,
      }),
    };
  }
}
