output "api_gateway_rest_api_id" {
  description = "API Gateway REST API ID"
  value       = module.api_gateway.rest_api_id
}

output "api_gateway_health_invoke_url" {
  description = "Invoke URL for health check endpoint"
  value       = module.api_gateway.invoke_url
}

output "api_gateway_route_invoke_url" {
  description = "Invoke URL for Tenant Router endpoint"
  value       = module.api_gateway.route_invoke_url
}

# ------------------------------------------------------------------------------
# Cognito Identity Outputs — REACTIVATED 
# ------------------------------------------------------------------------------
output "cognito_user_pool_id" {
  description = "Cognito User Pool ID"
  value       = module.cognito.user_pool_id
}

output "cognito_app_client_id" {
  description = "Cognito App Client ID"
  value       = module.cognito.client_id
}

output "cognito_groups" {
  description = "Cognito user groups"
  value = {
    staff      = module.cognito.staff_group_name
    admin      = module.cognito.admin_group_name
    live_agent = module.cognito.live_agent_group_name
  }
}

output "secrets_tenant_template_arn" {
  description = "Secrets Manager template secret ARN"
  value       = module.secrets.secret_arn
}

output "waf_web_acl_arn" {
  description = "WAF Web ACL ARN (null if enable_waf = false)"
  value       = length(module.waf) > 0 ? module.waf[0].web_acl_arn : null
}

# ------------------------------------------------------------------------------
# Company Onboarding Outputs
# ------------------------------------------------------------------------------
output "onboarding_state_machine_arn" {
  description = "ARN of the company onboarding Step Functions state machine"
  value       = module.step_functions.state_machine_arn
}

output "onboarding_endpoint_url" {
  description = "Invoke URL for POST /tenants/register"
  value       = module.api_gateway.onboarding_invoke_url
}