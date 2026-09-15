output "function_name" {
  value       = aws_lambda_function.tenant_router.function_name
  description = "Name of the Tenant Router Lambda function"
}

output "invoke_arn" {
  value       = aws_lambda_function.tenant_router.invoke_arn
  description = "Invocation ARN of the Tenant Router Lambda function"
}
