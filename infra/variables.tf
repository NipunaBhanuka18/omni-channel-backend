variable "aws_region" {
  type        = string
  description = "AWS region for deployment"
  default     = "us-east-1"
}

variable "environment" {
  type        = string
  description = "Target environment (e.g. dev, staging, prod)"
  default     = "dev"
}

variable "use_localstack" {
  type        = bool
  description = "Flag to direct AWS provider calls to LocalStack"
  default     = true
}

variable "localstack_url" {
  type        = string
  description = "LocalStack endpoint URL"
  default     = "http://localhost:4566"
}

variable "enable_waf" {
  type        = bool
  description = "Toggle WAF deployment (set to false if using LocalStack Community tier without WAFv2 emulation support)"
  default     = false
}
