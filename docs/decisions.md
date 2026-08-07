# Architecture Decision Records (ADRs)

This document records key technical and architectural decisions made during the evolution of the Omni Channel Platform backend.

---

## ADR-001: Phase 1 Ingress, Identity, and Secrets Scaffolding

- **Status**: Accepted
- **Date**: 2026-08-07
- **Scope**: Ingress (API Gateway), Identity (Cognito), Safety (WAF), Secrets (Secrets Manager)

### Context
Phase 1 establishes foundational infrastructure scaffolding for local development against LocalStack and eventual deployment to AWS. Agent execution logic, tenant resolution middleware, and specialist agent routing are out of scope for this phase.

---

### Decisions & Rationale

#### 1. WAF & Rate Limiting: IP-Based Baseline vs. Per-Tenant Quotas
- **Decision**: WAFv2 is configured with IP-based rate limiting (2000 req / 5-min window per IP) and AWS managed rule sets (`AWSManagedRulesCommonRuleSet`, `AWSManagedRulesSQLiRuleSet`).
- **Rationale**: IP-level rate limiting provides perimeter defense against generic DDoS attacks.
- **Explicit Deferral**: IP-based rate limits **do not** enforce per-tenant quotas. Multi-tenant quota isolation (preventing noisy neighbors from impacting each other) will be implemented in subsequent phases using API Gateway Usage Plans (per-tenant API keys) or dynamic rate limiting in the Tenant Runtime Router.
- **LocalStack Compatibility**: Controlled via an `enable_waf` toggle (`default = false` in `terraform.tfvars.example`) to allow clean deployments on LocalStack Community while maintaining full WAF readiness for LocalStack Pro / real AWS.

#### 2. Identity & Authentication Scope
- **Decision**: Cognito User Pool created with `staff` and `admin` groups for the internal pilot. Added a custom schema attribute `tenant_id`.
- **Rationale**: Meets Phase 1 internal pilot requirements without over-engineering auth before multi-tenant onboarding flows are built.
- **Explicit Deferral**: User groups are global in Phase 1. Tenant-scoped authorization (e.g. tenant-bound user pools/groups) and Enterprise SSO federation (SAML 2.0 / OIDC) are deferred to future identity phases.

#### 3. Secrets Manager Template Structure
- **Decision**: Provisioned `omni-channel/tenants/tokens-template-${var.environment}` containing a JSON schema template (`api_key`, `webhook_secret`, `provider_token`).
- **Rationale**: Establishes the expected credential schema for tenant integrations.
- **Explicit Deferral**: This is a static template secret. Production multi-tenancy will provision isolated secret instances under `omni-channel/tenants/{tenant_id}/tokens` during tenant onboarding.

#### 4. API Gateway Ingress & Header Passthrough
- **Decision**: Configured REST API with `/health` endpoint and `x-tenant-id` header request parameter passthrough.
- **Rationale**: Provides a light health check baseline without binding to specific tenant context shapes.
- **Explicit Deferral**: Real tenant resolution logic, token validation, and workspace isolation will be integrated in Phase 2 pending team schema finalization.
