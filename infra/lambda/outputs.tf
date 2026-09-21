output "function_name" {
  value       = aws_lambda_function.tenant_router.function_name
  description = "Name of the Tenant Router Lambda function"
}

output "invoke_arn" {
  value       = aws_lambda_function.tenant_router.invoke_arn
  description = "Invocation ARN of the Tenant Router Lambda function"
}

output "onboarding_function_name" {
  value       = aws_lambda_function.onboarding.function_name
  description = "Name of the Onboarding Lambda function"
}

output "onboarding_invoke_arn" {
  value       = aws_lambda_function.onboarding.invoke_arn
  description = "Invocation ARN of the Onboarding Lambda function (for API Gateway)"
}

output "onboarding_function_arn" {
  value       = aws_lambda_function.onboarding.arn
  description = "ARN of the Onboarding Lambda function (for Step Functions)"
}