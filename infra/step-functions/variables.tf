variable "environment" {
  type        = string
  description = "Deployment environment (e.g. dev, prod)"
}

variable "onboarding_lambda_arn" {
  type        = string
  description = "ARN of the onboarding Lambda function this state machine invokes"
}