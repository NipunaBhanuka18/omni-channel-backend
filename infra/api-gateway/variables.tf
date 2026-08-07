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
  type        = number
  description = "Maximum burst limit (number of requests)"
  default     = 200
}
