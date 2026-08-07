terraform {
  required_version = ">= 1.5.0"
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
  }
}

provider "aws" {
  region                      = var.aws_region
  access_key                  = var.use_localstack ? "mock_access_key" : null
  secret_key                  = var.use_localstack ? "mock_secret_key" : null
  s3_use_path_style           = var.use_localstack ? true : false
  skip_credentials_validation = var.use_localstack ? true : false
  skip_metadata_api_check     = var.use_localstack ? true : false
  skip_requesting_account_id  = var.use_localstack ? true : false

  dynamic "endpoints" {
    for_each = var.use_localstack ? [1] : []
    content {
      apigateway              = var.localstack_url
      cognitoidentityprovider = var.localstack_url
      dynamodb                = var.localstack_url
      events                  = var.localstack_url
      iam                     = var.localstack_url
      kms                     = var.localstack_url
      s3                      = var.localstack_url
      secretsmanager          = var.localstack_url
      sqs                     = var.localstack_url
      sts                     = var.localstack_url
      wafv2                   = var.localstack_url
    }
  }
}
