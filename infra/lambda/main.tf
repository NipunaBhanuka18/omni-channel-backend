data "archive_file" "tenant_router_zip" {
  type        = "zip"
  source_dir  = "${path.module}/../../dist"
  output_path = "${path.module}/tenant_router.zip"
}

resource "aws_iam_role" "lambda_exec" {
  name = "omni-channel-lambda-exec-${var.environment}"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Action = "sts:AssumeRole"
        Effect = "Allow"
        Principal = {
          Service = "lambda.amazonaws.com"
        }
      }
    ]
  })
}

# ------------------------------------------------------------------------------
# NOTE: prior to this change, lambda_exec had NO attached policy at all — not even
# CloudWatch Logs write access. That gap predates the onboarding work and also
# affects aws_lambda_function.tenant_router; LocalStack Community doesn't strictly
# enforce IAM by default so this went unnoticed locally. Fixing it here because the
# onboarding Lambda genuinely needs DynamoDB + Cognito admin permissions to function
# at all, not scoped down further (wildcard resource "*") since none of the tables
# in this repo are Terraform-managed (they're created by scripts/create-tenants-
# table.ts directly against LocalStack) — tighten this before any real AWS deploy.
# ------------------------------------------------------------------------------
resource "aws_iam_role_policy_attachment" "lambda_basic_execution" {
  role       = aws_iam_role.lambda_exec.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
}

resource "aws_iam_role_policy" "lambda_permissions" {
  name = "omni-channel-lambda-permissions-${var.environment}"
  role = aws_iam_role.lambda_exec.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid    = "TenantTableAccess"
        Effect = "Allow"
        Action = [
          "dynamodb:GetItem",
          "dynamodb:PutItem",
          "dynamodb:DeleteItem",
        ]
        Resource = "*"
      },
      {
        Sid    = "OnboardingCognitoAdminActions"
        Effect = "Allow"
        Action = [
          "cognito-idp:AdminCreateUser",
          "cognito-idp:AdminAddUserToGroup",
        ]
        Resource = "*"
      },
    ]
  })
}

resource "aws_lambda_function" "tenant_router" {
  filename         = data.archive_file.tenant_router_zip.output_path
  function_name    = "omni-channel-tenant-router-${var.environment}"
  role             = aws_iam_role.lambda_exec.arn
  handler          = "services/tenant-router/lambda-adapter.handler"
  source_code_hash = data.archive_file.tenant_router_zip.output_base64sha256
  runtime          = "nodejs20.x"

  environment {
    variables = {
      NODE_ENV        = var.environment
      ALLOW_MOCK_AUTH = "true"
    }
  }
}

resource "aws_lambda_permission" "apigw_lambda" {
  statement_id  = "AllowExecutionFromAPIGateway"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.tenant_router.function_name
  principal     = "apigateway.amazonaws.com"
  source_arn    = "${var.api_gateway_execution_arn}/*/*"
}

# ------------------------------------------------------------------------------
# Company Onboarding Pipeline Lambda
# ------------------------------------------------------------------------------
# Reuses the same compiled ./dist bundle as tenant_router (data.archive_file.
# tenant_router_zip), just pointed at a different handler entry point — no separate
# build step needed, matching how tenant_router itself is packaged.
resource "aws_lambda_function" "onboarding" {
  filename         = data.archive_file.tenant_router_zip.output_path
  function_name    = "omni-channel-onboarding-${var.environment}"
  role             = aws_iam_role.lambda_exec.arn
  handler          = "services/onboarding/lambda-adapter.handler"
  source_code_hash = data.archive_file.tenant_router_zip.output_base64sha256
  runtime          = "nodejs20.x"
  timeout          = 30 # Cognito admin calls are slower than the tenant-router's simple lookups.

  environment {
    variables = {
      NODE_ENV             = var.environment
      ALLOW_MOCK_AUTH       = "true"
      COGNITO_USER_POOL_ID  = var.cognito_user_pool_id
    }
  }
}

resource "aws_lambda_permission" "apigw_onboarding" {
  statement_id  = "AllowExecutionFromAPIGateway"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.onboarding.function_name
  principal     = "apigateway.amazonaws.com"
  source_arn    = "${var.api_gateway_execution_arn}/*/*"
}

resource "aws_lambda_permission" "step_functions_onboarding" {
  statement_id  = "AllowExecutionFromStepFunctions"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.onboarding.function_name
  principal     = "states.amazonaws.com"
}