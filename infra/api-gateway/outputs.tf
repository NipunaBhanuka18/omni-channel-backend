output "rest_api_id" {
  description = "ID of the API Gateway REST API"
  value       = aws_api_gateway_rest_api.omni_channel.id
}

output "rest_api_arn" {
  description = "ARN of the API Gateway REST API"
  value       = aws_api_gateway_rest_api.omni_channel.arn
}

output "stage_name" {
  description = "Name of the API Gateway stage"
  value       = aws_api_gateway_stage.stage.stage_name
}

output "execution_arn" {
  description = "Execution ARN of the API Gateway stage"
  value       = aws_api_gateway_stage.stage.execution_arn
}

output "stage_arn" {
  description = "ARN of the API Gateway stage (for WAF association)"
  value       = aws_api_gateway_stage.stage.arn
}

output "invoke_url" {
  description = "Invoke URL for the health check endpoint"
  value       = "${aws_api_gateway_stage.stage.invoke_url}/health"
}

output "route_invoke_url" {
  description = "Invoke URL for the Tenant Router endpoint"
  value       = "${aws_api_gateway_stage.stage.invoke_url}/route"
}
