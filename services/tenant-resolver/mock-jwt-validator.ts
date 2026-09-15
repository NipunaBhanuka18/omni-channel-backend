import { TenantContext } from "../../shared/types/tenant-context";

/**
 * ==============================================================================
 * [DEV-ONLY / INSECURE] Mock Auth JWT Token Validator
 * ==============================================================================
 * WARNING: THIS MODULE IS FOR LOCALSTACK AND OFFLINE DEVELOPMENT ONLY.
 * MUST BE REPLACED WITH REAL JWKS VERIFICATION BEFORE PRODUCTION DEPLOYMENT.
 * ==============================================================================
 */

/**
 * Structural safety check to prevent accidental usage in production environments.
 */
function assertMockAuthPermitted(): void {
  if (process.env.NODE_ENV === "production") {
    throw new Error(
      "[SECURITY FATAL] MockJWTValidator invoked while NODE_ENV=production! " +
        "Mock token validation MUST NOT be used in production."
    );
  }

  if (process.env.ALLOW_MOCK_AUTH !== "true" && process.env.NODE_ENV !== "test") {
    throw new Error(
      "[SECURITY FATAL] MockJWTValidator invoked without ALLOW_MOCK_AUTH=true environment variable set."
    );
  }
}

export interface MockJwtClaims {
  sub?: string;
  oid?: string;
  tid?: string;
  email?: string;
  "custom:tenant_id"?: string;
  tenant_id?: string;
  roles?: string[];
  iss?: string;
}

/**
 * Parses and extracts tenant context claims from a mock JWT token.
 * Supports both Cognito custom:tenant_id and Azure AD tid claims.
 */
export function decodeMockAzureJwt(authorizationHeader?: string): Partial<TenantContext> {
  assertMockAuthPermitted();

  if (!authorizationHeader || !authorizationHeader.startsWith("Bearer ")) {
    throw new Error("Invalid or missing Authorization header. Expected format: 'Bearer <token>'");
  }

  const token = authorizationHeader.substring(7).trim();
  const parts = token.split(".");

  // Handle mock bypass tokens for testing
  if (parts.length !== 3) {
    const tenantMatch = token.match(/TEN-\d+/i) || token.match(/tenant-[\w-]+/i);
    const resolvedTenantId = tenantMatch ? tenantMatch[0] : undefined;

    if (token === "dev-token-guest" || token === "dev-token-restricted") {
      return {
        tenantId: resolvedTenantId,
        userId: "dev-user-guest",
        role: "staff",
        permissions: ["usage:read"],
      };
    }
    if (token === "dev-token-billing-only") {
      return {
        tenantId: resolvedTenantId,
        userId: "dev-user-billing",
        role: "staff",
        permissions: ["billing:read"],
      };
    }
    return {
      tenantId: resolvedTenantId || "TEN-001",
      userId: "dev-user-001",
      role: "staff",
      permissions: ["billing:read", "usage:read", "faults:read"],
    };
  }

  try {
    const payloadJson = Buffer.from(parts[1], "base64").toString("utf-8");
    const claims = JSON.parse(payloadJson) as MockJwtClaims;

    const role: "staff" | "admin" = claims.roles?.includes("OmniChannel.Admin") ? "admin" : "staff";
    
    // Resolve tenantId: priority to custom:tenant_id (Cognito), then tenant_id, tid (Azure AD), or default
    const tenantId = claims["custom:tenant_id"] || claims.tenant_id || claims.tid || "TEN-001";

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