# ==============================================================================
# Secrets Manager Scaffold (Phase 1 Template)
# ==============================================================================
# ARCHITECTURAL NOTE ON PER-TENANT SECRETS STRUCTURE:
# 'omni-channel/tenants/tokens-template' below is a single placeholder secret structure for scaffolding.
#
# IMPORTANT: In full production multi-tenancy, per-tenant credentials will be provisioned
# programmatically under a parameterized path pattern:
#   omni-channel/tenants/{tenant_id}/tokens
#
# This template defines the standardized key-value JSON schema that tenant secret instances must fulfill.
# ==============================================================================

resource "aws_secretsmanager_secret" "tenant_tokens_template" {
  name        = "omni-channel/tenants/tokens-template-${var.environment}"
  description = "Template JSON schema for tenant API tokens and webhook secrets (Phase 1 Scaffold)"

  tags = {
    Environment = var.environment
    Platform    = "omni-channel"
    Type        = "template"
  }
}

resource "aws_secretsmanager_secret_version" "tenant_tokens_template_version" {
  secret_id = aws_secretsmanager_secret.tenant_tokens_template.id

  # Placeholder key-value structure matching expected tenant token fields
  secret_string = jsonencode({
    api_key        = "PLACEHOLDER_TENANT_API_KEY"
    webhook_secret = "PLACEHOLDER_TENANT_WEBHOOK_SECRET"
    provider_token = "PLACEHOLDER_THIRD_PARTY_TOKEN"
  })
}

# ------------------------------------------------------------------------------
# Rotation Policy Scaffold / Stub
# ------------------------------------------------------------------------------
# Rotation policy can be attached once a dedicated rotation Lambda function is deployed.
# Example stub structure for future enablement:
#
# resource "aws_secretsmanager_secret_rotation" "rotation_stub" {
#   secret_id           = aws_secretsmanager_secret.tenant_tokens_template.id
#   rotation_lambda_arn = "arn:aws:lambda:${var.aws_region}:123456789012:function:token-rotator-stub"
#
#   rotation_rules {
#     automatically_after_days = 90
#   }
# }
# ------------------------------------------------------------------------------
