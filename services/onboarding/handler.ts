import { decodeMockCognitoJwt } from "../tenant-resolver/mock-jwt-validator";
import { onboardCompany } from "./onboarding";
import { AgentActionResponse } from "../../shared/types/agent-action";
import { OnboardingRequest } from "../../shared/types/onboarding";

export interface HttpRequestPayload {
  headers: Record<string, string | undefined>;
  body?: Partial<OnboardingRequest>;
}

/**
 * Handles POST /tenants/register.
 *
 * AUTH NOTE: this deliberately does NOT go through services/tenant-resolver/resolver.ts.
 * That resolver's zero-trust check (ADR-011) now rejects any token with no
 * custom:tenant_id claim — correct for tenant-scoped requests, but onboarding is a
 * platform-level operation: it's the SLT internal 'staff' group creating a *new*
 * tenant, so by definition the caller has no tenant of their own yet. This handler
 * decodes the token directly and checks group membership instead.
 */
export async function handleOnboardingRequest(request: HttpRequestPayload): Promise<AgentActionResponse> {
  const normalizedHeaders: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(request.headers)) {
    if (value !== undefined) normalizedHeaders[key.toLowerCase()] = value;
  }
  const authorizationHeader = normalizedHeaders["authorization"];

  if (!authorizationHeader || !authorizationHeader.trim()) {
    return {
      success: false,
      error: {
        code: "UNAUTHORIZED",
        message: "Missing or empty Authorization header. Expected format: 'Bearer <token>'",
        retryable: false,
        details: { requiredHeader: "Authorization" },
      },
    };
  }

  let caller;
  try {
    caller = decodeMockCognitoJwt(authorizationHeader);
  } catch (err) {
    return {
      success: false,
      error: {
        code: "UNAUTHORIZED",
        message: `Invalid or malformed Authorization token: ${(err as Error).message}`,
        retryable: false,
      },
    };
  }

  // Only internal platform staff may onboard new companies. Note the mock
  // validator's fallback dev tokens (e.g. "dev-token-staff") resolve to role
  // "staff", so those work here without a hand-built 3-part JWT.
  if (caller.role !== "staff") {
    return {
      success: false,
      error: {
        code: "FORBIDDEN",
        message: "Only internal platform staff may onboard new companies.",
        retryable: false,
        details: { requiredRole: "staff", callerRole: caller.role },
      },
    };
  }

  const outcome = await onboardCompany(request.body || {});
  if (!outcome.success) {
    return { success: false, error: outcome.error };
  }
  return { success: true, data: outcome.data };
}