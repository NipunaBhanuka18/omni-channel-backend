import { TenantContext } from "../../shared/types/tenant-context";

/**
 * ==============================================================================
 * [DEV-ONLY / INSECURE] Mock Cognito JWT Token Validator
 * ==============================================================================
 * WARNING: THIS MODULE IS FOR LOCALSTACK AND OFFLINE DEVELOPMENT ONLY.
 * IT DOES NOT PERFORM CRYPTOGRAPHIC JWKS SIGNATURE VERIFICATION AGAINST COGNITO.
 *
 * MUST BE REPLACED WITH REAL COGNITO JWKS VALIDATOR (aws-jwt-verify or equivalent)
 * BEFORE ANY PRODUCTION DEPLOYMENT.
 *
 * NOTE (ADR-010): This module previously decoded Azure AD-shaped claims (tid, oid,
 * roles). It now decodes Cognito-shaped claims (sub, cognito:groups,
 * custom:tenant_id) to match the reactivated Cognito identity provider.
 * ==============================================================================
 */

/**
 * Structural safety check to prevent accidental usage in production environments.
 * Throws a fatal error if executed in production mode or if ALLOW_MOCK_AUTH is not explicitly enabled.
 */
function assertMockAuthPermitted(): void {
  if (process.env.NODE_ENV === "production") {
    throw new Error(
      "[SECURITY FATAL] MockJWTValidator invoked while NODE_ENV=production! " +
        "Mock token validation MUST NOT be used in production. Deploy real Cognito JWKS verification."
    );
  }

  if (process.env.ALLOW_MOCK_AUTH !== "true" && process.env.NODE_ENV !== "test") {
    throw new Error(
      "[SECURITY FATAL] MockJWTValidator invoked without ALLOW_MOCK_AUTH=true environment variable set. " +
        "Set ALLOW_MOCK_AUTH=true in local development environment to enable mock JWT processing."
    );
  }
}

export interface MockCognitoIdTokenClaims {
  sub?: string;
  email?: string;
  "cognito:groups"?: string[];
  "custom:tenant_id"?: string;
  token_use?: string;
  aud?: string;
  iss?: string;
}

/**
 * Maps Cognito group membership to an internal role.
 * Precedence: admin > live_agent > staff (matches group `precedence` in infra/cognito/main.tf).
 */
function resolveRole(groups: string[] | undefined): TenantContext["role"] {
  if (groups?.includes("admin")) return "admin";
  if (groups?.includes("live_agent")) return "live_agent";
  return "staff";
}

function permissionsForRole(role: TenantContext["role"]): string[] {
  switch (role) {
    case "admin":
      return ["billing:read", "billing:purchase", "usage:read", "faults:read", "faults:create"];
    case "live_agent":
      // TODO(Member 3): revisit once live-agent-specific permissions (presence,
      // handoff acceptance) are defined; borrowing the staff set for now so the
      // resolver doesn't block Live Agent Console requests during integration.
      return ["billing:read", "usage:read", "faults:read", "faults:create"];
    case "staff":
    default:
      return ["billing:read", "usage:read", "faults:read", "faults:create"];
  }
}

/**
 * Parses and extracts tenant context claims from an unverified mock Cognito JWT token.
 *
 * IMPORTANT: `tenantId` in the returned object is the ONLY trusted source of tenant
 * identity for a real (3-part) token — it comes from the `custom:tenant_id` claim,
 * never from a request header. If the claim is absent, `tenantId` is left undefined
 * and the caller (resolver.ts) MUST decide how to handle an unscoped token; it must
 * never fall back to a client-supplied header to fill the gap.
 *
 * @param authorizationHeader The incoming Authorization HTTP header (e.g. "Bearer <token>")
 * @returns Parsed TenantContext
 */
export function decodeMockCognitoJwt(authorizationHeader?: string): Partial<TenantContext> {
  // Enforce structural guard first
  assertMockAuthPermitted();

  if (!authorizationHeader || !authorizationHeader.startsWith("Bearer ")) {
    throw new Error("Invalid or missing Authorization header. Expected format: 'Bearer <token>'");
  }

  const token = authorizationHeader.substring(7).trim();
  const parts = token.split(".");

  if (parts.length !== 3) {
    // Short-circuit dev tokens for quick local testing without hand-building a JWT.
    // These intentionally carry NO tenantId — they exercise permission logic only,
    // never the zero-trust tenant matching in resolver.ts.
    if (token === "dev-token-guest" || token === "dev-token-restricted") {
      return {
        userId: "dev-user-guest",
        role: "staff",
        permissions: ["usage:read"], // Restricted permissions (has usage:read; lacks billing:read & faults:read)
      };
    }
    if (token === "dev-token-billing-only") {
      return {
        userId: "dev-user-billing",
        role: "staff",
        permissions: ["billing:read"], // Billing-only permissions (has billing:read; lacks usage:read & faults:read)
      };
    }
    // Default mock token for staff in local development (e.g., "dev-token-staff")
    return {
      userId: "dev-user-001",
      role: "staff",
      permissions: ["billing:read", "usage:read", "faults:read"],
    };
  }

  try {
    const payloadJson = Buffer.from(parts[1], "base64").toString("utf-8");
    const claims = JSON.parse(payloadJson) as MockCognitoIdTokenClaims;

    const role = resolveRole(claims["cognito:groups"]);

    return {
      // No fallback here on purpose — see the function-level note above.
      tenantId: claims["custom:tenant_id"] || undefined,
      userId: claims.sub || "dev-user-001",
      role,
      permissions: permissionsForRole(role),
    };
  } catch (err) {
    throw new Error(`Failed to decode mock JWT token payload: ${(err as Error).message}`);
  }
}