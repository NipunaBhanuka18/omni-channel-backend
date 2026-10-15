import { putTenantItem } from "../../agents/utils/dynamo-client";
import { TenantContext } from "../../shared/types/tenant-context";

export interface OnboardCompanyInput {
  companyName: string;
  adminEmail: string;
  tenantId?: string;
}

export interface OnboardCompanyOutput {
  success: boolean;
  tenantId: string;
  adminEmail: string;
  s3Prefix: string;
  status: string;
}

/**
 * Handles the automated onboarding process for a new company tenant.
 * Provisions tenant storage paths, database partitioning records, and default configurations.
 */
export async function handleCompanyOnboarding(
  input: OnboardCompanyInput
): Promise<OnboardCompanyOutput> {
  const { companyName, adminEmail } = input;

  if (!companyName || !adminEmail) {
    throw new Error("BAD_REQUEST: companyName and adminEmail are required for onboarding");
  }

  // Generate standardized Tenant ID if omitted
  const tenantId = input.tenantId || `TEN-${Math.floor(1000 + Math.random() * 9000)}`;

  // Construct temporary onboarding context
  const onboardingContext: TenantContext = {
    tenantId,
    userId: "system-onboarding",
    role: "admin",
    permissions: ["billing:read", "usage:read", "faults:create"],
    channel: "web",
    sessionId: `sess-onboarding-${tenantId}`,
    conversationId: `conv-onboarding-${tenantId}`,
  };

  // 1. Register Tenant Metadata Record
  await putTenantItem("omni-channel-tenants", onboardingContext, {
    SK: "METADATA",
    companyName,
    adminEmail,
    status: "ACTIVE",
    createdAt: new Date().toISOString(),
  });

  // 2. Initialize Default Agent Configuration for the Tenant
  await putTenantItem("omni-channel-agents", onboardingContext, {
    SK: "AGENT#DEFAULT",
    agentName: `${companyName} Main Agent`,
    status: "CONFIGURED",
    enabledTools: ["billing", "support", "usage"],
    createdAt: new Date().toISOString(),
  });

  const s3Prefix = `tenants/${tenantId}/`;

  return {
    success: true,
    tenantId,
    adminEmail,
    s3Prefix,
    status: "PROVISIONED",
  };
}