# ==============================================================================
# WAFv2 Security Module (Phase 1 Baseline Protection)
# ==============================================================================
# LOCALSTACK COMPATIBILITY NOTICE:
# WAFv2 managed rule evaluation and resource association are supported in LocalStack Pro.
# If running LocalStack Community (free tier), setting 'enable_waf = false' in root
# variables allows testing all other services without encountering WAF API stubs.
#
# ARCHITECTURAL NOTE ON PER-IP VS PER-TENANT RATE LIMITING:
# The rate-based rule defined below operates at the IP ADDRESS level for baseline DDoS defense.
# It DOES NOT enforce per-tenant quotas. Multi-tenant quota isolation must be handled at the
# API Gateway Usage Plan level (via per-tenant API keys) or inside the Tenant Runtime Router,
# so one high-volume tenant's network IP does not accidentally block other tenants.
# ==============================================================================

resource "aws_wafv2_web_acl" "main" {
  name        = "omni-channel-waf-${var.environment}"
  description = "WAFv2 baseline ruleset for API Gateway ingress"
  scope       = "REGIONAL"

  default_action {
    allow {}
  }

  # ----------------------------------------------------------------------------
  # Rule 1: IP-Based Rate Limiting (DDoS Baseline)
  # ----------------------------------------------------------------------------
  rule {
    name     = "IPRateLimit"
    priority = 1

    action {
      block {}
    }

    statement {
      rate_based_statement {
        limit              = var.rate_limit_per_ip
        aggregate_key_type = "IP"
      }
    }

    visibility_config {
      cloudwatch_metrics_enabled = true
      metric_name                = "IPRateLimit"
      sampled_requests_enabled   = true
    }
  }

  # ----------------------------------------------------------------------------
  # Rule 2: Common Bad Inputs Managed Rule Set
  # ----------------------------------------------------------------------------
  rule {
    name     = "AWSManagedRulesCommonRuleSet"
    priority = 2

    override_action {
      none {}
    }

    statement {
      managed_rule_group_statement {
        name        = "AWSManagedRulesCommonRuleSet"
        vendor_name = "AWS"
      }
    }

    visibility_config {
      cloudwatch_metrics_enabled = true
      metric_name                = "AWSManagedRulesCommonRuleSet"
      sampled_requests_enabled   = true
    }
  }

  # ----------------------------------------------------------------------------
  # Rule 3: SQL Injection Baseline Managed Rule Set
  # ----------------------------------------------------------------------------
  rule {
    name     = "AWSManagedRulesSQLiRuleSet"
    priority = 3

    override_action {
      none {}
    }

    statement {
      managed_rule_group_statement {
        name        = "AWSManagedRulesSQLiRuleSet"
        vendor_name = "AWS"
      }
    }

    visibility_config {
      cloudwatch_metrics_enabled = true
      metric_name                = "AWSManagedRulesSQLiRuleSet"
      sampled_requests_enabled   = true
    }
  }

  visibility_config {
    cloudwatch_metrics_enabled = true
    metric_name                = "omni-channel-waf-${var.environment}"
    sampled_requests_enabled   = true
  }
}

resource "aws_wafv2_web_acl_association" "api_gateway" {
  resource_arn = var.api_gateway_stage_arn
  web_acl_arn  = aws_wafv2_web_acl.main.arn
}
