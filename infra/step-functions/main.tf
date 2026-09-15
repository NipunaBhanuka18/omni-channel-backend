resource "aws_sfn_state_machine" "tenant_onboarding" {
  name     = "omni-channel-tenant-onboarding-${var.environment}"
  role_arn = aws_iam_role.sfn_role.arn

  definition = <<EOF
{
  "Comment": "Multi-Tenant Company Onboarding Pipeline",
  "StartAt": "ProvisionCompanyTenant",
  "States": {
    "ProvisionCompanyTenant": {
      "Type": "Task",
      "Resource": "${aws_lambda_function.onboarding_lambda.arn}",
      "End": true
    }
  }
}
EOF
}

resource "aws_iam_role" "sfn_role" {
  name = "omni-channel-sfn-role-${var.environment}"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Action = "sts:AssumeRole"
        Effect = "Allow"
        Principal = {
          Service = "states.amazonaws.com"
        }
      }
    ]
  })
}

resource "aws_lambda_function" "onboarding_lambda" {
  filename      = "tenant_onboarding.zip"
  function_name = "omni-channel-tenant-onboarding-${var.environment}"
  role          = aws_iam_role.sfn_role.arn
  handler       = "services/tenant-onboarding/handler.handleCompanyOnboarding"
  runtime       = "nodejs18.x"
}