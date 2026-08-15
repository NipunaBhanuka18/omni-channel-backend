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
# Phase 3 Endpoint: Tenant Resolver & Runtime Router (/route)
# ------------------------------------------------------------------------------

resource "aws_api_gateway_resource" "route" {
  rest_api_id = aws_api_gateway_rest_api.omni_channel.id
  parent_id   = aws_api_gateway_rest_api.omni_channel.root_resource_id
  path_part   = "route"
}

resource "aws_api_gateway_method" "route_get" {
  rest_api_id   = aws_api_gateway_rest_api.omni_channel.id
  resource_id   = aws_api_gateway_resource.route.id
  http_method   = "GET"
  authorization = "NONE"

  request_parameters = {
    "method.request.header.Authorization"     = false
    "method.request.header.x-tenant-id"       = false
    "method.request.header.x-channel"         = false
    "method.request.header.x-session-id"     = false
    "method.request.header.x-conversation-id" = false
  }
}

resource "aws_api_gateway_integration" "route_mock" {
  rest_api_id = aws_api_gateway_rest_api.omni_channel.id
  resource_id = aws_api_gateway_resource.route.id
  http_method = aws_api_gateway_method.route_get.http_method
  type        = "MOCK"

  request_templates = {
    "application/json" = <<EOF
#set($auth = $input.params('Authorization'))
#set($tenant = $input.params('x-tenant-id'))
#if($auth == "")
  {"statusCode": 401}
#elseif($tenant == "")
  {"statusCode": 400}
#else
  {"statusCode": 200}
#end
EOF
  }
}

resource "aws_api_gateway_method_response" "route_200" {
  rest_api_id = aws_api_gateway_rest_api.omni_channel.id
  resource_id = aws_api_gateway_resource.route.id
  http_method = aws_api_gateway_method.route_get.http_method
  status_code = "200"

  response_models = {
    "application/json" = "Empty"
  }
}

resource "aws_api_gateway_method_response" "route_400" {
  rest_api_id = aws_api_gateway_rest_api.omni_channel.id
  resource_id = aws_api_gateway_resource.route.id
  http_method = aws_api_gateway_method.route_get.http_method
  status_code = "400"

  response_models = {
    "application/json" = "Empty"
  }
}

resource "aws_api_gateway_method_response" "route_401" {
  rest_api_id = aws_api_gateway_rest_api.omni_channel.id
  resource_id = aws_api_gateway_resource.route.id
  http_method = aws_api_gateway_method.route_get.http_method
  status_code = "401"

  response_models = {
    "application/json" = "Empty"
  }
}

resource "aws_api_gateway_integration_response" "route_mock_200" {
  rest_api_id = aws_api_gateway_rest_api.omni_channel.id
  resource_id = aws_api_gateway_resource.route.id
  http_method = aws_api_gateway_method.route_get.http_method
  status_code = aws_api_gateway_method_response.route_200.status_code

  response_templates = {
    "application/json" = <<EOF
#set($channel = $input.params('x-channel'))
#if($channel == "")#set($channel = "web")#end
#set($session = $input.params('x-session-id'))
#if($session == "")#set($session = "sess-default-8832-47a1")#end
#set($conv = $input.params('x-conversation-id'))
#if($conv == "")#set($conv = "conv-default-9412-23b9")#end
{
  "success": true,
  "data": {
    "targetAgent": "main-agent",
    "tenantContext": {
      "tenantId": "$input.params('x-tenant-id')",
      "userId": "dev-user-001",
      "role": "staff",
      "permissions": ["billing:read", "usage:read", "faults:read"],
      "channel": "$channel",
      "sessionId": "$session",
      "conversationId": "$conv"
    },
    "routedAt": "$context.requestTime"
  }
}
EOF
  }

  depends_on = [aws_api_gateway_integration.route_mock]
}

resource "aws_api_gateway_integration_response" "route_mock_400" {
  rest_api_id = aws_api_gateway_rest_api.omni_channel.id
  resource_id = aws_api_gateway_resource.route.id
  http_method = aws_api_gateway_method.route_get.http_method
  status_code = aws_api_gateway_method_response.route_400.status_code
  selection_pattern = "400"

  response_templates = {
    "application/json" = jsonencode({
      success = false
      error = {
        code      = "BAD_REQUEST"
        message   = "Missing or empty x-tenant-id header"
        retryable = false
        details   = { requiredHeader = "x-tenant-id" }
      }
    })
  }

  depends_on = [aws_api_gateway_integration.route_mock]
}

resource "aws_api_gateway_integration_response" "route_mock_401" {
  rest_api_id = aws_api_gateway_rest_api.omni_channel.id
  resource_id = aws_api_gateway_resource.route.id
  http_method = aws_api_gateway_method.route_get.http_method
  status_code = aws_api_gateway_method_response.route_401.status_code
  selection_pattern = "401"

  response_templates = {
    "application/json" = jsonencode({
      success = false
      error = {
        code      = "UNAUTHORIZED"
        message   = "Missing or empty Authorization header. Expected format: 'Bearer <token>'"
        retryable = false
        details   = { requiredHeader = "Authorization" }
      }
    })
  }

  depends_on = [aws_api_gateway_integration.route_mock]
}

# ------------------------------------------------------------------------------
# POST Method for /route Resource
# ------------------------------------------------------------------------------

resource "aws_api_gateway_method" "route_post" {
  rest_api_id   = aws_api_gateway_rest_api.omni_channel.id
  resource_id   = aws_api_gateway_resource.route.id
  http_method   = "POST"
  authorization = "NONE"

  request_parameters = {
    "method.request.header.Authorization"     = false
    "method.request.header.x-tenant-id"       = false
    "method.request.header.x-channel"         = false
    "method.request.header.x-session-id"     = false
    "method.request.header.x-conversation-id" = false
  }
}

resource "aws_api_gateway_integration" "route_post_mock" {
  rest_api_id = aws_api_gateway_rest_api.omni_channel.id
  resource_id = aws_api_gateway_resource.route.id
  http_method = aws_api_gateway_method.route_post.http_method
  type        = "MOCK"

  request_templates = {
    "application/json" = <<EOF
#set($auth = $input.params('Authorization'))
#set($tenant = $input.params('x-tenant-id'))
#set($rawBody = $input.body)
#if($auth == "")
  {"statusCode": 401}
#elseif($tenant == "")
  {"statusCode": 400}
#elseif(!$rawBody.contains('"intent"'))
  {"statusCode": 422}
#else
  {"statusCode": 200}
#end
EOF
  }
}

resource "aws_api_gateway_method_response" "route_post_200" {
  rest_api_id = aws_api_gateway_rest_api.omni_channel.id
  resource_id = aws_api_gateway_resource.route.id
  http_method = aws_api_gateway_method.route_post.http_method
  status_code = "200"

  response_models = {
    "application/json" = "Empty"
  }
}

resource "aws_api_gateway_method_response" "route_post_400" {
  rest_api_id = aws_api_gateway_rest_api.omni_channel.id
  resource_id = aws_api_gateway_resource.route.id
  http_method = aws_api_gateway_method.route_post.http_method
  status_code = "400"

  response_models = {
    "application/json" = "Empty"
  }
}

resource "aws_api_gateway_method_response" "route_post_401" {
  rest_api_id = aws_api_gateway_rest_api.omni_channel.id
  resource_id = aws_api_gateway_resource.route.id
  http_method = aws_api_gateway_method.route_post.http_method
  status_code = "401"

  response_models = {
    "application/json" = "Empty"
  }
}

resource "aws_api_gateway_method_response" "route_post_422" {
  rest_api_id = aws_api_gateway_rest_api.omni_channel.id
  resource_id = aws_api_gateway_resource.route.id
  http_method = aws_api_gateway_method.route_post.http_method
  status_code = "422"

  response_models = {
    "application/json" = "Empty"
  }
}

resource "aws_api_gateway_integration_response" "route_post_mock_200" {
  rest_api_id = aws_api_gateway_rest_api.omni_channel.id
  resource_id = aws_api_gateway_resource.route.id
  http_method = aws_api_gateway_method.route_post.http_method
  status_code = aws_api_gateway_method_response.route_post_200.status_code

  response_templates = {
    "application/json" = jsonencode({
      success = true
      data = {
        accountNumber      = "SLT-9982-555"
        outstandingBalance = 1500.5
        currency           = "LKR"
        dueDate            = "2026-09-15"
        status             = "active"
      }
    })
  }

  depends_on = [aws_api_gateway_integration.route_post_mock]
}

resource "aws_api_gateway_integration_response" "route_post_mock_400" {
  rest_api_id = aws_api_gateway_rest_api.omni_channel.id
  resource_id = aws_api_gateway_resource.route.id
  http_method = aws_api_gateway_method.route_post.http_method
  status_code = aws_api_gateway_method_response.route_post_400.status_code
  selection_pattern = "400"

  response_templates = {
    "application/json" = jsonencode({
      success = false
      error = {
        code      = "BAD_REQUEST"
        message   = "Missing or empty x-tenant-id header"
        retryable = false
        details   = { requiredHeader = "x-tenant-id" }
      }
    })
  }

  depends_on = [aws_api_gateway_integration.route_post_mock]
}

resource "aws_api_gateway_integration_response" "route_post_mock_401" {
  rest_api_id = aws_api_gateway_rest_api.omni_channel.id
  resource_id = aws_api_gateway_resource.route.id
  http_method = aws_api_gateway_method.route_post.http_method
  status_code = aws_api_gateway_method_response.route_post_401.status_code
  selection_pattern = "401"

  response_templates = {
    "application/json" = jsonencode({
      success = false
      error = {
        code      = "UNAUTHORIZED"
        message   = "Missing or empty Authorization header. Expected format: 'Bearer <token>'"
        retryable = false
        details   = { requiredHeader = "Authorization" }
      }
    })
  }

  depends_on = [aws_api_gateway_integration.route_post_mock]
}

resource "aws_api_gateway_integration_response" "route_post_mock_422" {
  rest_api_id = aws_api_gateway_rest_api.omni_channel.id
  resource_id = aws_api_gateway_resource.route.id
  http_method = aws_api_gateway_method.route_post.http_method
  status_code = aws_api_gateway_method_response.route_post_422.status_code
  selection_pattern = "422"

  response_templates = {
    "application/json" = jsonencode({
      success = false
      error = {
        code      = "BAD_REQUEST"
        message   = "Missing required request body field: 'intent'"
        retryable = false
        details   = { requiredField = "intent" }
      }
    })
  }

  depends_on = [aws_api_gateway_integration.route_post_mock]
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
      aws_api_gateway_resource.route.id,
      aws_api_gateway_method.route_get.id,
      aws_api_gateway_integration.route_mock.id,
      aws_api_gateway_method.route_post.id,
      aws_api_gateway_integration.route_post_mock.id,
    ]))
  }

  lifecycle {
    create_before_destroy = true
  }

  depends_on = [
    aws_api_gateway_integration_response.health_mock_200,
    aws_api_gateway_integration_response.route_mock_200,
    aws_api_gateway_integration_response.route_mock_400,
    aws_api_gateway_integration_response.route_mock_401,
    aws_api_gateway_integration_response.route_post_mock_200,
    aws_api_gateway_integration_response.route_post_mock_400,
    aws_api_gateway_integration_response.route_post_mock_401,
    aws_api_gateway_integration_response.route_post_mock_422,
  ]
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
