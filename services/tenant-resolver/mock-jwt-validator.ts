import { TenantContext } from "../../shared/types/tenant-context";

/**
 * ==============================================================================
 * [DEV-ONLY / INSECURE] Mock Azure AD / Cognito JWT Token Validator
 * ==============================================================================
 * WARNING: THIS MODULE IS FOR LOCALSTACK AND OFFLINE DEVELOPMENT ONLY.
 * IT DOES NOT PERFORM CRYPTOGRAPHIC JWKS SIGNATURE VERIFICATION.
 *
 * MUST BE REPLACED WITH REAL AZURE AD / COGNITO OIDC/JWKS VALIDATOR BEFORE ANY PRODUCTION DEPLOYMENT.
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
        "Mock token validation MUST NOT be used in production. Deploy real OIDC/JWKS verification."
    );
  }

  if (process.env.ALLOW_MOCK_AUTH !== "true" && process.env.NODE_ENV !== "test") {
    throw new Error(
      "[SECURITY FATAL] MockJWTValidator invoked without ALLOW_MOCK_AUTH=true environment variable set. " +
        "Set ALLOW_MOCK_AUTH=true in local development environment to enable mock JWT processing."
    );
  }
}

export interface MockAzureJwtClaims {
  sub?: string;
  oid?: string;
  tid?: string;
  name?: string;
  preferred_username?: string;
  "custom:tenant_id"?: string;
  tenant_id?: string;
  roles?: string[];
  aud?: string;
  iss?: string;
}

/**
 * Parses and extracts tenant context claims from an unverified mock Azure AD / Cognito JWT token.
 * 
 * @param authorizationHeader The incoming Authorization HTTP header (e.g. "Bearer <token>")
 * @returns Parsed TenantContext
 */
export function decodeMockAzureJwt(authorizationHeader?: string): Partial<TenantContext> {
  // Enforce structural guard first
  assertMockAuthPermitted();

  if (!authorizationHeader || !authorizationHeader.startsWith("Bearer ")) {
    throw new Error("Invalid or missing Authorization header. Expected format: 'Bearer <token>'");
  }

  const token = authorizationHeader.substring(7).trim();
  const parts = token.split(".");

  if (parts.length !== 3) {
    const tenantMatch = token.match(/TEN-\d+/i) || token.match(/tenant-[\w-]+/i);
    const resolvedTenantId = tenantMatch ? tenantMatch[0] : undefined;

    if (token === "dev-token-guest" || token === "dev-token-restricted") {
      return {
        tenantId: resolvedTenantId,
        userId: "dev-user-guest",
        role: "staff",
        permissions: ["usage:read"], // Restricted permissions
      };
    }
    if (token === "dev-token-billing-only") {
      return {
        tenantId: resolvedTenantId,
        userId: "dev-user-billing",
        role: "staff",
        permissions: ["billing:read"], // Billing-only permissions
      };
    }
    // Default mock token for staff in local development (e.g., "dev-token-staff")
    return {
      tenantId: resolvedTenantId || "dev-tenant-local",
      userId: "dev-user-001",
      role: "staff",
      permissions: ["billing:read", "usage:read", "faults:read"],
    };
  }

  try {
    const payloadJson = Buffer.from(parts[1], "base64").toString("utf-8");
    const claims = JSON.parse(payloadJson) as MockAzureJwtClaims;

    const role: "staff" | "admin" = claims.roles?.includes("OmniChannel.Admin") ? "admin" : "staff";
    
    // Resolve tenantId: Priority to custom:tenant_id (Cognito), tenant_id, tid (Azure AD), or default
    const tenantId = claims["custom:tenant_id"] || claims.tenant_id || claims.tid || "dev-tenant-local";

    return {
      tenantId,
      userId: claims.oid || claims.sub || "dev-user-001",
      role,
      permissions: role === "admin" 
        ? ["billing:read", "billing:purchase", "usage:read", "faults:read", "faults:create"]
        : ["billing:read", "usage:read", "faults:read", "faults:create"],
    };
  } catch (err) {
    throw new Error(`Failed to decode mock JWT token payload: ${(err as Error).message}`);
  }
}
