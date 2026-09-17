# ==============================================================================
# Cognito Identity Module — REACTIVATED (ADR-010)
# ==============================================================================
# Deprecated 2026-08-07 in favor of Azure AD (ADR-002); reactivated 2026-09-16 per
# revised multi-tenant task allocation, which requires Cognito as the identity
# provider for Admin Console and Live Agent Console logins with per-user
# `custom:tenant_id` claims. See docs/decisions.md ADR-010 for full rationale.
#
# ARCHITECTURAL NOTE ON TENANT ISOLATION IN AUTHENTICATION:
# `custom:tenant_id` is set on each user at creation time (company onboarding for
# admins, agent invite for live agents) and is what services/tenant-resolver must
# treat as the source of truth for tenant identity — never the `x-tenant-id`
# request header, which is client-supplied and unverified.
#
# FUTURE CAPABILITY NOTICE:
# Enterprise SSO federation (SAML 2.0 / OIDC) is planned for a future phase and is
# not configured here.
# ==============================================================================

resource "aws_cognito_user_pool" "pool" {
  name = "omni-channel-user-pool-${var.environment}"

  username_attributes      = ["email"]
  auto_verified_attributes = ["email"]

  password_policy {
    minimum_length    = 8
    require_lowercase = true
    require_numbers   = true
    require_symbols   = true
    require_uppercase = true
  }

  schema {
    attribute_data_type      = "String"
    name                     = "email"
    required                 = true
    mutable                  = true
    developer_only_attribute = false

    string_attribute_constraints {
      min_length = 5
      max_length = 256
    }
  }

  # Tenant binding attribute. Populated by the onboarding pipeline (admin users)
  # and the agent-invite flow (live_agent users). Left schema-optional rather than
  # required=true so a fresh pool doesn't reject the bootstrap/internal 'staff'
  # and 'admin' pilot users that predate multi-tenant onboarding; the resolver
  # must still fail closed if it's missing on a token that claims a tenant-scoped
  # role.

  schema {
    attribute_data_type      = "String"
    name                     = "tenant_id"
    required                 = false
    mutable                  = true
    developer_only_attribute = false

    string_attribute_constraints {
      min_length = 1
      max_length = 64
    }
  }

  tags = {
    Environment = var.environment
    Platform    = "omni-channel"
  }
}

resource "aws_cognito_user_pool_client" "client" {
  name         = "omni-channel-frontend-client"
  user_pool_id = aws_cognito_user_pool.pool.id

  generate_secret     = false
  explicit_auth_flows = [
    "ALLOW_USER_PASSWORD_AUTH",
    "ALLOW_REFRESH_TOKEN_AUTH",
    "ALLOW_USER_SRP_AUTH"
  ]

  prevent_user_existence_errors = "ENABLED"

  # Custom: tenant_id must be explicitly whitelisted per app Client or Cognito
  # Omits it from issued ID tokens even though it's in the pool schema.
  read_attributes = ["email", "custom:tenant_id"]
  write_attributes = ["email", "custom:tenant_id"]
}

# User groups. 'staff' and 'admin' are the Phase 1 internal-pilot groups;
# 'live_agent' is added for Member 3's Live Agent Console logins per the
# revised task allocation. Groups remain global (not tenant-scoped) — tenant
# isolation is enforced via the custom:tenant_id claim + resolver check, not
# via per-tenant groups. See ADR-010.
resource "aws_cognito_user_group" "staff" {
  name         = "staff"
  user_pool_id = aws_cognito_user_pool.pool.id
  description  = "Internal pilot staff users"
  precedence   = 10
}

resource "aws_cognito_user_group" "admin" {
  name         = "admin"
  user_pool_id = aws_cognito_user_pool.pool.id
  description  = "Company admin users (Admin Console)"
  precedence   = 1
}

resource "aws_cognito_user_group" "live_agent" {
  name         = "live_agent"
  user_pool_id = aws_cognito_user_pool.pool.id
  description  = "Live human agents (Live Agent Console)"
  precedence   = 5
}