import { decodeMockCognitoJwt } from "../tenant-resolver/mock-jwt-validator";
import { onboardCompany, OnboardingDeps } from "./onboarding";
import { AgentActionResponse } from "../../shared/types/agent-action";
import { OnboardingRequest } from "../../shared/types/onboarding";
import {
  CognitoJwksUnavailableError,
  CognitoJwtVerifier,
  createCognitoJwtVerifierFromEnv,
  mapCognitoClaimsToOnboardingCaller,
} from "../auth/cognito-jwt-verifier";
import { extractBearerToken } from "../auth/local-session-token";

export interface HttpRequestPayload {
  headers: Record<string, string | undefined>;
  body?: Partial<OnboardingRequest>;
}

export interface OnboardingHandlerDeps {
  cognitoVerifier?: CognitoJwtVerifier | null;
  onboardingDeps?: OnboardingDeps;
}

function isProductionLike(): boolean {
  const nodeEnv = (process.env.NODE_ENV || "").trim().toLowerCase();
  return nodeEnv === "production" || nodeEnv === "prod" || process.env.IS_LOCAL === "false";
}

/**
 * Handles POST /tenants/register.
 *
 * AUTH NOTE: this deliberately does NOT go through services/tenant-resolver/resolver.ts.
 * That resolver's zero-trust check (ADR-011) rejects any token with no
 * custom:tenant_id claim — correct for tenant-scoped requests, but onboarding is a
 * platform-level operation performed by internal platform staff/superadmin callers
 * creating a brand-new tenant.
 */
export async function handleOnboardingRequest(
  request: HttpRequestPayload,
  deps: OnboardingHandlerDeps = {},
): Promise<AgentActionResponse> {
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

  let verifier: CognitoJwtVerifier | null = null;
  try {
    verifier =
      deps.cognitoVerifier !== undefined
        ? deps.cognitoVerifier
        : createCognitoJwtVerifierFromEnv();
  } catch (err: any) {
    return {
      success: false,
      error: {
        code: "INTERNAL_ERROR",
        message: `Authentication configuration error: ${err?.message || String(err)}`,
        retryable: false,
      },
    };
  }

  if (isProductionLike() && !verifier) {
    return {
      success: false,
      error: {
        code: "INTERNAL_ERROR",
        message: "Cognito JWT verifier is required outside local development",
        retryable: false,
      },
    };
  }

  if (verifier) {
    const token = extractBearerToken(authorizationHeader);
    if (!token) {
      return {
        success: false,
        error: {
          code: "UNAUTHORIZED",
          message: "Invalid or missing Authorization header. Expected format: 'Bearer <token>'",
          retryable: false,
        },
      };
    }

    let verifiedClaims;
    try {
      verifiedClaims = await verifier.verifyToken(token);
    } catch (err: any) {
      if (err instanceof CognitoJwksUnavailableError) {
        return {
          success: false,
          error: {
            code: "INTERNAL_ERROR",
            message: err.message,
            retryable: true,
          },
        };
      }
      return {
        success: false,
        error: {
          code: "UNAUTHORIZED",
          message: `Invalid or malformed Authorization token: ${err?.message || String(err)}`,
          retryable: false,
        },
      };
    }

    const authorization = mapCognitoClaimsToOnboardingCaller(verifiedClaims);
    if (!authorization.authorized) {
      return {
        success: false,
        error: {
          code: "FORBIDDEN",
          message: "Only internal platform staff may onboard new companies.",
          retryable: false,
          details: {
            requiredRole: "staff",
            callerRole: authorization.callerRole,
            reason: authorization.reason,
          },
        },
      };
    }
  } else {
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

    // Only internal unscoped platform staff may onboard new companies.
    if (caller.role !== "staff" || caller.tenantId !== undefined) {
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
  }

  const outcome = await onboardCompany(request.body || {}, deps.onboardingDeps);
  if (!outcome.success) {
    return { success: false, error: outcome.error };
  }
  return { success: true, data: outcome.data };
}
