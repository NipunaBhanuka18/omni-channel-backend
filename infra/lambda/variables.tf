variable "environment" {
  type        = string
  description = "Deployment environment (e.g. dev, prod)"
}

variable "aws_region" {
  type        = string
  description = "AWS region for Cognito issuer validation and SDK clients"
  default     = "us-east-1"
}

variable "use_localstack" {
  type        = bool
  description = "Whether Lambda is executing against LocalStack endpoints"
  default     = false
}

variable "allow_mock_auth" {
  type        = bool
  description = "Allow dev-only unsigned JWT fallback in non-production environments"
  default     = false
}

variable "api_gateway_execution_arn" {
  type        = string
  description = "Execution ARN of the API Gateway REST API"
}

variable "cognito_user_pool_id" {
  type        = string
  description = "Cognito User Pool ID, wired into the Lambda functions for JWT verification and onboarding"
}

variable "cognito_client_id" {
  type        = string
  description = "Cognito App Client ID used to verify aud/client_id on incoming JWTs"
}