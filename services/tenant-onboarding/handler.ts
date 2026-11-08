import { onboardCompany, OnboardingDeps } from "../onboarding/onboarding";
import { deriveTenantId } from "../../shared/utils/tenant-name";

export interface OnboardCompanyInput {
  companyName: string;
  adminEmail: string;
  tenantId?: string;
  companySlug?: string;
  tier?: string;
  themeColor?: string;
  allowedChannels?: ("web" | "whatsapp" | "sms" | "messenger")[];
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
 * Delegates to the unified onboardCompany pipeline.
 */
export async function handleCompanyOnboarding(
  input: OnboardCompanyInput,
  deps?: OnboardingDeps
): Promise<OnboardCompanyOutput> {
  const { companyName, adminEmail } = input;

  if (!companyName || !adminEmail) {
    throw new Error("BAD_REQUEST: companyName and adminEmail are required for onboarding");
  }

  const tenantId =
    input.tenantId ||
    deriveTenantId(input.companySlug, companyName) ||
    `tenant-${Math.floor(1000 + Math.random() * 9000)}`;

  const outcome = await onboardCompany(
    {
      companyName: companyName.trim(),
      tenantId,
      adminEmail: adminEmail.trim().toLowerCase(),
      companySlug: input.companySlug,
      tier: input.tier,
      themeColor: input.themeColor,
      allowedChannels: input.allowedChannels || ["web", "whatsapp", "sms", "messenger"],
    },
    deps
  );

  if (!outcome.success || !outcome.data) {
    throw new Error(outcome.error?.message || "Failed to onboard company");
  }

  return {
    success: true,
    tenantId: outcome.data.tenantId,
    adminEmail,
    s3Prefix: outcome.data.kbPrefix,
    status: "PROVISIONED",
  };
}
