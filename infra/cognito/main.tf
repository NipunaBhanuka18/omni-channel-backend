# ==============================================================================
# AWS Cognito Identity Module (Active per ADR-010)
# ==============================================================================
# ARCHITECTURAL NOTE ON TENANT ISOLATION IN AUTHENTICATION:
# - `superadmin` (precedence 0): Platform super administrators (must NOT carry custom:tenant_id).
# - `admin` (precedence 1): Company tenant administrators (bound via custom:tenant_id).
# - `live_agent` (precedence 5): Live human support agents (bound via custom:tenant_id).
# - `staff` (precedence 10): Internal platform onboarding staff (unscoped).
#
# FUTURE CAPABILITY NOTICE:
# Enterprise SSO federation (SAML 2.0 / OIDC) is planned for a future phase.
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

  # Custom tenant ID attribute schema (reserved for future multi-tenant context binding)
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

# Platform super administrators (global, unscoped — never carry custom:tenant_id)
resource "aws_cognito_user_group" "superadmin" {
  name         = "superadmin"
  user_pool_id = aws_cognito_user_pool.pool.id
  description  = "Platform super administrators without tenant scoping"
  precedence   = 0
}

# Internal pilot user groups
resource "aws_cognito_user_group" "staff" {
  name         = "staff"
  user_pool_id = aws_cognito_user_pool.pool.id
  description  = "Internal platform staff users"
  precedence   = 10
}

resource "aws_cognito_user_group" "admin" {
  name         = "admin"
  user_pool_id = aws_cognito_user_pool.pool.id
  description  = "Company tenant administrators (scoped via custom:tenant_id)"
  precedence   = 1
}

# Live Agent user group for real-time human customer support agents
resource "aws_cognito_user_group" "live_agent" {
  name         = "live_agent"
  user_pool_id = aws_cognito_user_pool.pool.id
  description  = "Live human support agents handling chat escalations"
  precedence   = 5
}

