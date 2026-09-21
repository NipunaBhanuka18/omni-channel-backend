# ==============================================================================
# Company Onboarding State Machine (Phase 1)
# ==============================================================================
# PHASE 1 SCOPE NOTE:
# This is a single-Task state machine: it invokes the onboarding Lambda
# (services/onboarding/onboarding.ts) once, and that Lambda runs all 5 pipeline
# steps (validate -> check duplicate -> create tenant -> create agent -> create
# Cognito admin) in-process. It does NOT decompose those steps into separate Step
# Functions Task states yet.
#
# It's still real Step Functions orchestration, not just a Lambda called directly
# from API Gateway — deliberately, so a manual-review/approval step (or a retry-
# with-backoff step, or per-step CloudWatch visibility) can be inserted between
# existing steps later without changing the Lambda's contract or the API surface.
# Splitting the 5 in-process steps into 5 real Task states is a follow-up, not done
# here — see docs/decisions.md ADR-013.
# ==============================================================================

resource "aws_iam_role" "step_functions_exec" {
  name = "omni-channel-onboarding-sfn-exec-${var.environment}"

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

resource "aws_iam_role_policy" "step_functions_invoke_lambda" {
  name = "omni-channel-onboarding-sfn-invoke-${var.environment}"
  role = aws_iam_role.step_functions_exec.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect   = "Allow"
        Action   = ["lambda:InvokeFunction"]
        Resource = var.onboarding_lambda_arn
      }
    ]
  })
}

resource "aws_sfn_state_machine" "onboarding" {
  name     = "omni-channel-onboarding-${var.environment}"
  role_arn = aws_iam_role.step_functions_exec.arn

  definition = jsonencode({
    Comment = "Company onboarding pipeline (Phase 1: single-task, see module header comment)"
    StartAt = "ProvisionTenant"
    States = {
      ProvisionTenant = {
        Type     = "Task"
        Resource = var.onboarding_lambda_arn
        Retry = [
          {
            # Only retry on Lambda-side infrastructure failures, not on business-logic
            # errors like TENANT_ALREADY_EXISTS returned as a normal 200/4xx payload
            # by the Lambda adapter — those are not thrown exceptions.
            ErrorEquals     = ["Lambda.ServiceException", "Lambda.AWSLambdaException", "Lambda.SdkClientException"]
            IntervalSeconds = 2
            MaxAttempts     = 2
            BackoffRate     = 2.0
          }
        ]
        Catch = [
          {
            ErrorEquals = ["States.ALL"]
            Next        = "OnboardingFailed"
          }
        ]
        End = true
      }
      OnboardingFailed = {
        Type  = "Fail"
        Error = "OnboardingPipelineFailed"
        Cause = "The onboarding Lambda invocation failed. Check CloudWatch Logs for the ProvisionTenant task."
      }
    }
  })
}