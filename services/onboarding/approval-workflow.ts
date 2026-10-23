import { onboardCompany, validateOnboardingRequest, OnboardingOutcome } from "./onboarding";
import { OnboardingRequest } from "../../shared/types/onboarding";

/**
 * Registration approval is a platform-admin operation, never a self-service action.
 * The caller MUST authorize the approving platform administrator before invoking this.
 * This adapter intentionally has no storage side effects of its own.
 */
export interface PendingCompanyRegistration {
  id?: string;
  status?: string;
  tenantId?: string;
  companyName?: string;
  companySlug?: string;
  companyEmail?: string;
  adminEmail?: string;
}

type OnboardFunction = (request: Partial<OnboardingRequest>) => Promise<OnboardingOutcome>;

type ApprovalResult =
  | {
      success: true;
      approvedRegistration: PendingCompanyRegistration & {
        status: "Approved";
        tenantId: string;
        onboardedAt: string;
      };
      // One-time credentials for an authenticated platform-admin response ONLY.
      // Never persist these in db.json or log them.
      credentials: { username: string; temporaryPassword: string };
    }
  | { success: false; error: { code: string; message: string } };

/**
 * Converts a PENDING registration into a provisioned tenant + default agent +
 * company admin using the existing Cognito-aware pipeline.
 * Only the CALLER may persist approvedRegistration, and only after success.
 */
export async function provisionPendingCompanyApproval(
  registration: PendingCompanyRegistration,
  onboard: OnboardFunction = onboardCompany,
): Promise<ApprovalResult> {
  if (registration.status !== "Pending" || registration.tenantId) {
    return { success: false, error: {
      code: "INVALID_REGISTRATION_STATE",
      message: "Only an unprovisioned pending registration can be approved",
    } };
  }

  const rawSlug = registration.companySlug || registration.companyName || "";
  const cleanSlug = rawSlug.toLowerCase().trim()
    .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  const tenantId = cleanSlug.startsWith("tenant-") ? cleanSlug : `tenant-${cleanSlug}`;
  const request: Partial<OnboardingRequest> = {
    companyName: registration.companyName,
    tenantId,
    adminEmail: registration.adminEmail || registration.companyEmail,
  };
  const invalid = validateOnboardingRequest(request);
  if (invalid) {
    return { success: false, error: {
      code: invalid.code,
      message: invalid.message,
    } };
  }

  let outcome: OnboardingOutcome;
  try {
    outcome = await onboard(request);
  } catch {
    // Missing credentials/configuration or service outage must never approve a company.
    return { success: false, error: {
      code: "ONBOARDING_UNAVAILABLE",
      message: "Company provisioning is unavailable; registration remains pending",
    } };
  }
  if (!outcome.success || !outcome.data) {
    return { success: false, error: {
      code: outcome.error?.code || "ONBOARDING_FAILED",
      message: outcome.error?.message || "Provisioning failed; registration remains pending",
    } };
  }
  // Fail closed if a compromised/misconfigured adapter returns a different tenant.
  if (outcome.data.tenantId !== tenantId || !outcome.data.adminUsername || !outcome.data.temporaryPassword) {
    return { success: false, error: {
      code: "INVALID_ONBOARDING_RESULT",
      message: "Provisioning returned incomplete or inconsistent tenant credentials",
    } };
  }

  return {
    success: true,
    approvedRegistration: {
      ...registration,
      status: "Approved",
      tenantId,
      onboardedAt: new Date().toISOString(),
    },
    credentials: {
      username: outcome.data.adminUsername,
      temporaryPassword: outcome.data.temporaryPassword,
    },
  };
}
