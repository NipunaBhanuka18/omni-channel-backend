output "secret_arn" {
  description = "ARN of the tenant tokens template secret"
  value       = aws_secretsmanager_secret.tenant_tokens_template.arn
}

output "secret_name" {
  description = "Name of the tenant tokens template secret"
  value       = aws_secretsmanager_secret.tenant_tokens_template.name
}

output "secret_id" {
  description = "ID of the tenant tokens template secret"
  value       = aws_secretsmanager_secret.tenant_tokens_template.id
}
