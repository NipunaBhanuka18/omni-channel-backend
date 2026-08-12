# Azure Active Directory (Azure AD) Identity Provider Scaffolding

This directory serves as the architectural scaffold and deployment guide for integrating **Azure Active Directory (Azure AD)** as the primary Identity Provider (IdP) for the Omni Channel Multi-Tenant Platform, adhering to the original Business Requirements Document (BRD) and supervisor directive for internal pilot users.

---

## 1. Prerequisites & Required Azure Configuration (Pending Credentials)

Once Azure AD tenant access and administrative credentials are provided by the supervisor, the following resources must be provisioned in the Azure Portal or via the `azuread` Terraform provider:

### App Registration
- **Application (Client) ID**: Unique identifier for the registered Omni Channel application.
- **Directory (Tenant) ID**: Azure AD tenant ID hosting pilot staff and admin users.
- **Supported Account Types**: Single tenant (My organization only) for internal pilot.

### OAuth2 / OIDC Settings
- **Redirect URIs**: SPA / Web redirect URIs for authentication flow (e.g. `http://localhost:3000/callback` in local dev, staging/prod URLs in deployed environments).
- **Allowed Token Types**: Access Tokens and ID Tokens (v2.0 endpoint).
- **API Permissions**: `User.Read` (delegated permissions) + custom app roles / scopes.
- **App Roles**:
  - `OmniChannel.Staff`: Assigned to internal pilot staff members (`role: "staff"`).
  - `OmniChannel.Admin`: Assigned to platform administrators (`role: "admin"`).

---

## 2. API Gateway & Token Validation Strategy

When real Azure AD credentials are fully wired:

1. **Token Format**: Clients present standard Bearer JWTs issued by Azure AD in the HTTP `Authorization` header: `Authorization: Bearer <Azure_AD_JWT>`.
2. **Verification Endpoint**: Public key certificates (JWKS) are dynamically fetched from:
   `https://login.microsoftonline.com/{tenant_id}/discovery/v2.0/keys`
3. **Claims Validation**:
   - `iss` (Issuer): `https://login.microsoftonline.com/{tenant_id}/v2.0`
   - `aud` (Audience): Application (Client) ID of the Omni Channel App Registration.
   - `exp` (Expiration): Current timestamp must be before token expiration.
   - `roles` / `groups`: Mapped to `TenantContext` role & permissions.

---

## 3. LocalStack & Local Development Strategy

> [!IMPORTANT]
> **Local development without Azure AD access**: Use a mock JWT validator or hardcoded test tokens until real Azure AD credentials are available. **Do not block LocalStack development on this.**

During Phase 1 local development:
- API Gateway acts as a header & token passthrough without attempting external Microsoft JWKS verification against LocalStack.
- The `tenant-resolver` service includes a development-only JWT decoder (`services/tenant-resolver/mock-jwt-validator.ts`) that extracts claims for testing without validating remote signatures.
