variable "environment" {
  type        = string
  description = "Deployment environment name"
}

variable "rate_limit" {
  type        = number
  description = "Steady-state rate limit (requests per second)"
  default     = 100
}

variable "burst_limit" {
  type        = string
  description = "Maximum burst limit (number of requests)"
  default     = "200"
}

variable "tenant_router_lambda_invoke_arn" {
  type        = string
  description = "Invocation ARN of the Tenant Router Lambda function"
  default     = ""
}

