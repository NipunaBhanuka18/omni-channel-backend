output "api_gateway_rest_api_id" {
  description = "API Gateway REST API ID"
  value       = module.api_gateway.rest_api_id
}

output "api_gateway_health_invoke_url" {
  description = "Invoke URL for health check endpoint"
  value       = module.api_gateway.invoke_url
}

output "cognito_user_pool_id" {
  description = "Cognito User Pool ID"
  value       = module.cognito.user_pool_id
}

output "cognito_app_client_id" {
  description = "Cognito App Client ID"
  value       = module.cognito.client_id
}

output "cognito_groups" {
  description = "Cognito internal pilot groups"
  value = {
    staff = module.cognito.staff_group_name
    admin = module.cognito.admin_group_name
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
