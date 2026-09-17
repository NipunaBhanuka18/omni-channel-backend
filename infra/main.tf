# ==============================================================================
# Omni Channel Backend Infrastructure Root Module
# ==============================================================================
# Modular composition for API Gateway, Lambda, WAF, Cognito, and Secrets Manager.
# Designed for LocalStack local development with effortless migration to real AWS.
# ==============================================================================

module "lambda" {
  source                    = "./lambda"
  environment               = var.environment
  api_gateway_execution_arn = module.api_gateway.execution_arn
  cognito_user_pool_id      = module.cognito.user_pool_id
}

module "api_gateway" {
  source                           = "./api-gateway"
  environment                      = var.environment
  tenant_router_lambda_invoke_arn  = module.lambda.invoke_arn
  onboarding_lambda_invoke_arn     = module.lambda.onboarding_invoke_arn
}

# ------------------------------------------------------------------------------
# Company Onboarding State Machine (see infra/step-functions/main.tf header note
# and ADR-013 in docs/decisions.md for scope)
# ------------------------------------------------------------------------------
module "step_functions" {
  source                = "./step-functions"
  environment            = var.environment
  onboarding_lambda_arn = module.lambda.onboarding_function_arn
}

module "waf" {
  count                 = var.enable_waf ? 1 : 0
  source                = "./waf"
  environment           = var.environment
  api_gateway_stage_arn = module.api_gateway.stage_arn
}

# ------------------------------------------------------------------------------
# Cognito Identity Module — REACTIVATED (ADR-010)
# Deprecated 2026-08-07 in favor of Azure AD (ADR-002); reactivated 2026-09-16 for
# multi-tenant Admin Console / Live Agent Console auth. See docs/decisions.md.
# ------------------------------------------------------------------------------
module "cognito" {
  source      = "./cognito"
  environment = var.environment
}

module "secrets" {
  source      = "./secrets"
  environment = var.environment
}