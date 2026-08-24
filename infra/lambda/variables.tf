variable "environment" {
  type        = string
  description = "Deployment environment (e.g. dev, prod)"
}

variable "api_gateway_execution_arn" {
  type        = string
  description = "Execution ARN of the API Gateway REST API"
}
