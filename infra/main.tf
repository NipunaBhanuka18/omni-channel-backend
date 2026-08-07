# ==============================================================================
# Omni Channel Backend Infrastructure Root Module (Phase 1)
# ==============================================================================
# Modular composition for API Gateway, WAF, Cognito, and Secrets Manager.
# Designed for LocalStack local development with effortless migration to real AWS.
# ==============================================================================

module "api_gateway" {
  source      = "./api-gateway"
  environment = var.environment
}

module "waf" {
  count                 = var.enable_waf ? 1 : 0
  source                = "./waf"
  environment           = var.environment
  api_gateway_stage_arn = module.api_gateway.stage_arn
}

module "cognito" {
  source      = "./cognito"
  environment = var.environment
}

module "secrets" {
  source      = "./secrets"
  environment = var.environment
}
