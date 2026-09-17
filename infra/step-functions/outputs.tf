output "state_machine_arn" {
  description = "ARN of the company onboarding Step Functions state machine"
  value       = aws_sfn_state_machine.onboarding.arn
}

output "state_machine_name" {
  description = "Name of the company onboarding Step Functions state machine"
  value       = aws_sfn_state_machine.onboarding.name
}