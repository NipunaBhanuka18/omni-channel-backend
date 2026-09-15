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
