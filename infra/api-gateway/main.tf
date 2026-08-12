# ==============================================================================
# API Gateway Ingress Skeleton (Phase 1)
# ==============================================================================
# ARCHITECTURAL NOTE ON PER-TENANT RATE LIMITING:
# Rate limiting set here at the stage level (and via WAF IP limits) provides baseline
# denial-of-service protection for the overall infrastructure.
#
# IMPORTANT: Per-tenant rate limiting and quota enforcement (to prevent noisy-neighbor
# tenant issues) is NOT handled here. Per-tenant quotas will be implemented in subsequent
# phases using API Gateway Usage Plans with tenant-specific API Keys, or dynamically inside
# the Tenant Runtime Router middleware.
# ==============================================================================

resource "aws_api_gateway_rest_api" "omni_channel" {
  name        = "omni-channel-api-${var.environment}"
  description = "Omni Channel Multi-Tenant Platform API Ingress (Phase 1 Scaffold)"

  endpoint_configuration {
    types = ["REGIONAL"]
  }
}

# ------------------------------------------------------------------------------
# Placeholder: Tenant Header Extraction / Request Parameter Validation
# ------------------------------------------------------------------------------
# NOTE: In Phase 1, we accept the 'x-tenant-id' header parameter on incoming requests.
# Real tenant resolution logic, token validation, and tenant workspace routing
# will be integrated in Phase 2 pending final schema alignment.
# ------------------------------------------------------------------------------

resource "aws_api_gateway_resource" "health" {
  rest_api_id = aws_api_gateway_rest_api.omni_channel.id
  parent_id   = aws_api_gateway_rest_api.omni_channel.root_resource_id
  path_part   = "health"
}

resource "aws_api_gateway_method" "health_get" {
  rest_api_id   = aws_api_gateway_rest_api.omni_channel.id
  resource_id   = aws_api_gateway_resource.health.id
  http_method   = "GET"
  authorization = "NONE"

  # Header extraction placeholder for Azure AD Bearer JWT and x-tenant-id
  request_parameters = {
    "method.request.header.x-tenant-id"   = false # Optional tenant header
    "method.request.header.Authorization" = false # Optional Azure AD Bearer JWT token header
  }
}

resource "aws_api_gateway_integration" "health_mock" {
  rest_api_id = aws_api_gateway_rest_api.omni_channel.id
  resource_id = aws_api_gateway_resource.health.id
  http_method = aws_api_gateway_method.health_get.http_method
  type        = "MOCK"

  request_templates = {
    "application/json" = "{\"statusCode\": 200}"
  }
}

resource "aws_api_gateway_method_response" "health_200" {
  rest_api_id = aws_api_gateway_rest_api.omni_channel.id
  resource_id = aws_api_gateway_resource.health.id
  http_method = aws_api_gateway_method.health_get.http_method
  status_code = "200"

  response_models = {
    "application/json" = "Empty"
  }
}

resource "aws_api_gateway_integration_response" "health_mock_200" {
  rest_api_id = aws_api_gateway_rest_api.omni_channel.id
  resource_id = aws_api_gateway_resource.health.id
  http_method = aws_api_gateway_method.health_get.http_method
  status_code = aws_api_gateway_method_response.health_200.status_code

  response_templates = {
    "application/json" = jsonencode({
      status               = "healthy"
      environment          = var.environment
      phase                = "phase-1-scaffold"
      auth_provider        = "azure-ad"
      timestamp            = "$context.requestTime"
      tenant_id            = "$input.params('x-tenant-id')"
      authorization_header = "$input.params('Authorization')"
    })
  }

  depends_on = [aws_api_gateway_integration.health_mock]
}

# ------------------------------------------------------------------------------
# Deployment & Stage Settings (Throttling & Rate Limiting Baseline)
# ------------------------------------------------------------------------------

resource "aws_api_gateway_deployment" "deployment" {
  rest_api_id = aws_api_gateway_rest_api.omni_channel.id

  triggers = {
    redeployment = sha256(jsonencode([
      aws_api_gateway_resource.health.id,
      aws_api_gateway_method.health_get.id,
      aws_api_gateway_integration.health_mock.id,
    ]))
  }

  lifecycle {
    create_before_destroy = true
  }

  depends_on = [aws_api_gateway_integration_response.health_mock_200]
}

resource "aws_api_gateway_stage" "stage" {
  deployment_id = aws_api_gateway_deployment.deployment.id
  rest_api_id   = aws_api_gateway_rest_api.omni_channel.id
  stage_name    = var.environment
}

resource "aws_api_gateway_method_settings" "all" {
  rest_api_id = aws_api_gateway_rest_api.omni_channel.id
  stage_name  = aws_api_gateway_stage.stage.stage_name
  method_path = "*/*"

  settings {
    metrics_enabled        = true
    logging_level          = "OFF"
    data_trace_enabled     = false
    throttling_rate_limit  = var.rate_limit
    throttling_burst_limit = var.burst_limit
  }
}
