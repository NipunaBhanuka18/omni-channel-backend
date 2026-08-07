# ==============================================================================
# Cognito Identity Module (Phase 1 Scaffold - Internal Pilot)
# ==============================================================================
# ARCHITECTURAL NOTE ON TENANT ISOLATION IN AUTHENTICATION:
# In Phase 1 (internal pilot), user groups ('staff', 'admin') are global/generic.
# When expanding to external tenants or multi-tenant user isolation, tenant context must
# be enforced either via custom user pool attributes (e.g. 'custom:tenant_id'), tenant-scoped
# user pool groups, or separate Cognito User Pools per tenant tier.
#
# FUTURE CAPABILITY NOTICE:
# Enterprise SSO federation (SAML 2.0 / OIDC) is planned for a future phase and is not
# configured in Phase 1.
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
}

# Internal pilot user groups (Global context for Phase 1)
resource "aws_cognito_user_group" "staff" {
  name         = "staff"
  user_pool_id = aws_cognito_user_pool.pool.id
  description  = "Internal pilot staff users"
  precedence   = 10
}

resource "aws_cognito_user_group" "admin" {
  name         = "admin"
  user_pool_id = aws_cognito_user_pool.pool.id
  description  = "Internal pilot platform administrators"
  precedence   = 1
}
