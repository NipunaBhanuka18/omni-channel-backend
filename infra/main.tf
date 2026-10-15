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
# DEPRECATED: Cognito Identity Module
# Deprecated as of 2026-08-07 — replaced by Azure AD per supervisor + BRD confirmation.
# Retained for reference only in ./cognito/, not included in active root module.
# ------------------------------------------------------------------------------
module "cognito" {
  source      = "./cognito"
  environment = var.environment
}

module "secrets" {
  source      = "./secrets"
  environment = var.environment
}
