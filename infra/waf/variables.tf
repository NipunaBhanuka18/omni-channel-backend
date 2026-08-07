variable "environment" {
  type        = string
  description = "Deployment environment"
}

variable "api_gateway_stage_arn" {
  type        = string
  description = "ARN of the API Gateway stage to attach the WAF Web ACL to"
}

variable "rate_limit_per_ip" {
  type        = number
  description = "Max requests per 5-minute window per IP address"
  default     = 2000
}
