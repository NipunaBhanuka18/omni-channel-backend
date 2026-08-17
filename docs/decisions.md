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

---

## ADR-002: Identity Provider Correction — Cognito to Azure AD

- **Status**: Accepted
- **Date**: 2026-08-07
- **Scope**: Identity Provider (Cognito -> Azure AD Migration & Mock Strategy), Shared Contract Types

### Context
Following direct supervisor confirmation aligning with the original Business Requirements Document (BRD), the primary identity provider for internal pilot users is confirmed as Azure Active Directory (Azure AD), replacing the earlier Phase 1 assumption of AWS Cognito.

---

### Decisions & Rationale

#### 1. Cognito Module Deprecation
- **Decision**: Deprecated the `/infra/cognito/` module. Added a deprecation notice header to `infra/cognito/main.tf` and commented out module instantiation and outputs in `infra/main.tf` and `infra/outputs.tf`.
- **Rationale**: Retains the Cognito module for technical reference while excluding it from active root infrastructure provisioning.

#### 2. Azure AD Architecture & LocalStack Development Strategy
- **Decision**: Created `/infra/azure-ad/README.md` documenting required Azure App Registration, OAuth2/OIDC scopes, and production JWKS validation (`https://login.microsoftonline.com/{tenant_id}/discovery/v2.0/keys`).
- **Mock Auth Strategy**: Provisioned a DEV-ONLY mock JWT validator in `/services/tenant-resolver/mock-jwt-validator.ts` equipped with structural environment checks (`NODE_ENV === "production"` throwing a fatal error) to allow offline and LocalStack development without blocking on Azure AD credential delivery.

#### 3. API Gateway Header Realignment
- **Decision**: Updated API Gateway `/health` endpoint configuration to accept `Authorization` Bearer headers alongside `x-tenant-id`, passing both through mock response logging.

#### 4. Commitment of Shared Contract Definitions
- **Decision**: Finalized and committed real TypeScript contract types and constants across team members:
  - `TenantContext` (`/shared/types/tenant-context.ts`)
  - `AgentActionRequest` & `AgentActionResponse` (`/shared/types/agent-action.ts`)
  - `PERMISSIONS` constants (`/shared/constants/permissions.ts`)

---

## ADR-003: Shared Contract Refinement — conversationId and structured error object

- **Status**: Accepted
- **Date**: 2026-08-07
- **Scope**: Shared Contracts (`TenantContext`, `AgentActionResponse`)

### Context
Cross-team review between agent-side and ingress-side workstreams identified the need for finer-grained thread tracking and structured error reporting ahead of Phase 2 implementation.

---

### Decisions & Rationale

#### 1. Added `conversationId` to `TenantContext`
- **Decision**: Added `conversationId: string` to `TenantContext` with explanatory inline documentation.
- **Rationale**: Distinguishes a single conversation thread from the broader auth session (`sessionId`), allowing a single user session to span multiple conversation threads over time without conflating session state with thread context.

#### 2. Structured Error Object in `AgentActionResponse`
- **Decision**: Replaced flat `error?: string` and `errorCode?: string` fields in `AgentActionResponse` with a structured `error` object (`code`, `message`, `retryable`, `details`).
- **Rationale**: Replaces fragile string-parsing with typed error attributes, providing callers with explicit retry guidance (`retryable: boolean`) and contextual data payloads (`details?: Record<string, any>`, e.g. current balance on an insufficient-balance error). Both changes proposed by the agent-side workstream and confirmed by the ingress-side workstream prior to merge.

---

## ADR-004: Phase 1 Infrastructure Sign-Off & LocalStack Validation

- **Status**: Accepted
- **Date**: 2026-08-08
- **Scope**: Phase 1 Infrastructure Verification, End-to-End LocalStack Deployment, Hand-Off to Phase 2

### Context
Phase 1 foundational infrastructure scaffolding—encompassing API Gateway REST ingress with Azure AD header passthrough, WAF security baseline, Secrets Manager template secret, development-only mock JWT validation strategy, and finalized cross-team TypeScript contract definitions—has been fully implemented, deployed via Terraform, and verified against LocalStack.

---

### Decisions & Rationale

#### 1. End-to-End LocalStack Deployment & Sign-Off Verification
- **Decision**: Formally sign off Phase 1 infrastructure scaffolding based on successful Terraform execution and API Gateway health check validation.
- **Verification Evidence**:
  - `terraform apply -auto-approve -var-file="terraform.tfvars.example"` executed cleanly, provisioning API Gateway REST API, WAF rules, and Secrets Manager tenant template (`omni-channel/tenants/tokens-template-dev-*`).
  - End-to-end endpoint test `GET http://localhost:4566/restapis/{api_id}/dev/_user_request_/health` with `Authorization: Bearer <token>` and `x-tenant-id: <tenant_id>` returned HTTP `200 OK` with JSON response confirming `auth_provider: "azure-ad"`, header passthrough, and healthy status.

#### 2. Finalization of Identity Provider Scaffolding (Azure AD)
- **Decision**: Deprecation of `/infra/cognito/` module is complete and verified. Active root Terraform config provisions Azure AD-compatible header passthrough, backed by the mock JWT validator (`/services/tenant-resolver/mock-jwt-validator.ts`) for offline and LocalStack development.

#### 3. Commitment of Shared Contract Interfaces
- **Decision**: Contract interface definitions for `TenantContext`, `AgentActionRequest`, `AgentActionResponse`, and `PERMISSIONS` constants are finalized and committed under `/shared/`.

#### 4. Transition to Phase 2 (Tenant Runtime Router & Context Middleware)
- **Decision**: Phase 1 is frozen as complete. Phase 2 development can begin with the following hand-off requirements:
  - Implement the Tenant Runtime Router service and context resolution middleware.
  - Parse and validate incoming Azure AD Bearer JWTs into typed `TenantContext` instances.
  - Enforce tenant isolation and route action requests to specialized agent microservices using the shared contracts.

---

## ADR-005: Phase 3 Tenant Resolver & Tenant Runtime Router Scaffolding

- **Status**: Accepted
- **Date**: 2026-08-13
- **Scope**: Tenant Context Resolution, Multi-Tenant Runtime Routing, Hand-Off Boundary to Main Agent

### Context
Phase 3 establishes the Tenant Resolver and Tenant Runtime Router services directly downstream of API Gateway ingress. These components transform incoming request headers into a strictly-typed `TenantContext` and emit a routing decision for downstream agent microservices.

---

### Decisions & Rationale

#### 1. Dev-Only Mock JWT Validator Scope & Guard Enforcement
- **Decision**: `resolveTenantContext` utilizes the development-only mock validator (`services/tenant-resolver/mock-jwt-validator.ts`) to extract user claims without requiring remote Azure AD JWKS key fetching during LocalStack testing.
- **Security Constraint**: Structural safety checks (`assertMockAuthPermitted`) throw a fatal runtime error if executed under `NODE_ENV === "production"`.

#### 2. Separation of `sessionId` vs `conversationId`
- **Decision**: `TenantContext` explicitly resolves both `sessionId` and `conversationId`:
  - `sessionId`: Broad authenticated user session (persists across multiple actions and user interactions).
  - `conversationId`: Granular interactive thread. Generated as `conv-<uuid>` if omitted, or reused when explicitly passed in headers (`x-conversation-id`).

#### 3. Structured Error Response Alignment
- **Decision**: All header resolution, token parsing, and tenant routing failures return errors matching the system-wide `AgentActionResponse["error"]` contract (`code`, `message`, `retryable`, `details`).

#### 4. Defined Handoff Boundary to Main Agent (Phase 4)
- **Decision**: The Tenant Runtime Router outputs a structured `RoutingDecisionResult` (`{ targetAgent: "main-agent", tenantContext: ... }`) without calling or executing agent logic, preserving a clear handoff boundary for Phase 4 Main Agent development.

---

## ADR-006: Ingress Correction — API Gateway Transition from MOCK to Live Lambda Proxy Integration

- **Status**: Accepted
- **Date**: 2026-08-15
- **Scope**: Ingress (`infra/api-gateway/`), Lambda Module (`infra/lambda/`), Runtime Adapter (`services/tenant-router/lambda-adapter.ts`)

### Context
During initial Phase 1 and Phase 3 infrastructure scaffolding, API Gateway endpoints (`/health` and `/route`) were deployed using static `MOCK` integrations evaluated via Velocity Template Language (VTL) templates. While this allowed early verification of API Gateway parameter validation, static `MOCK` integrations do not invoke application code in LocalStack or AWS.

---

### Decisions & Rationale

#### 1. Transition of `/route` Endpoint to `AWS_PROXY` Integration
- **Decision**: Replaced static `MOCK` integrations on the `/route` resource with `AWS_PROXY` Lambda Proxy integrations.
- **Rationale**: Forwards raw HTTP request events (`APIGatewayProxyEvent`) directly to a live Node.js Lambda function execution on LocalStack/AWS, enabling true end-to-end runtime execution of `services/tenant-router/handler.ts`, `agents/main-agent/handler.ts`, and specialist microservices.

#### 2. Provisioning of Tenant Router Lambda Function (`infra/lambda/`)
- **Decision**: Provisioned `aws_lambda_function.tenant_router` (`omni-channel-tenant-router-${env}`) running Node.js runtime targeting `./dist`.
- **Lambda Adapter**: Implemented `services/tenant-router/lambda-adapter.ts` to translate `APIGatewayProxyEvent` into `handleTenantRequest` input and map structured responses into `APIGatewayProxyResult`.

#### 3. LocalStack Service Configuration Update
- **Decision**: Added `lambda` to the `SERVICES` environment variable in `docker-compose.yml` and configured `lambda = var.localstack_url` under Terraform's LocalStack provider endpoints block.

---

## ADR-007: Multi-Developer Environment Alignment & `docker-compose.yml` Service Specification

- **Status**: Accepted
- **Date**: 2026-08-17
- **Scope**: Local Environment (`docker-compose.yml`), Infrastructure Composition

### Context
During parallel infrastructure development, parallel commits modified `docker-compose.yml` independently to satisfy individual feature requirements (e.g. adding `lambda` for API Gateway Ingress vs. focusing on `dynamodb` for Main Agent state persistence). This resulted in service reduction conflicts where necessary LocalStack services (`apigateway`, `lambda`, `secretsmanager`, `iam`, `wafv2`, etc.) and mandatory environment variables (`LOCALSTACK_AUTH_TOKEN`) were omitted.

---

### Decisions & Rationale

#### 1. Unified Service Manifest in `docker-compose.yml`
- **Decision**: `SERVICES` in `docker-compose.yml` must explicitly declare the complete superset of all platform services required across all active modules:
  `SERVICES=apigateway,wafv2,secretsmanager,cognito,iam,s3,sqs,dynamodb,events,sts,kms,lambda`
- **Mandatory Environment Variables**: Preserved `LOCALSTACK_AUTH_TOKEN=${LOCALSTACK_AUTH_TOKEN}` to prevent license activation failures when operating with LocalStack Pro image tags (`localstack/localstack:3.0`).

#### 2. Cross-Team Coordination Protocol for Environment Manifests
- **Decision**: `docker-compose.yml` is classified as a shared infrastructure asset. Developers adding or modifying service dependencies must merge additions additively into the unified `SERVICES` list rather than replacing the variable wholesale.

---

## ADR-008: Role-Based Access Control (RBAC) Permission Enforcement at Ingress Router Layer

- **Status**: Accepted
- **Date**: 2026-08-17
- **Scope**: Ingress Router (`services/tenant-router/handler.ts`), Permission Matrix (`services/tenant-router/permission-map.ts`), Security Hardening (Phase 6)

### Context
Prior to Phase 6 security hardening, the `TenantContext` carried fine-grained permissions (e.g., `billing:read`, `usage:read`, `faults:create`), but access enforcement was not applied before dispatching requests to the Main Agent. Any authenticated request could trigger any intent, posing a privilege escalation risk.

---

### Decisions & Rationale

#### 1. Ingress Router Layer Enforcement (Pre-Main Agent Handoff)
- **Decision**: RBAC permission checks are enforced directly in `services/tenant-router/handler.ts` after tenant routing resolution but prior to invoking `mainAgentHandler`.
- **Rationale**: Prevents unauthorized requests from reaching downstream agent logic or triggering state logging (e.g. DynamoDB conversation writes) when access is denied.

#### 2. Intent-to-Permission Mapping Matrix (`permission-map.ts`)
- **Decision**: Implemented a central lookup mapping business intents to required fine-grained permissions (e.g., `check_balance` -> `PERMISSIONS.BILLING_READ`).
- **Single-Line Extensibility**: Adding new intent mappings requires a single line addition to `INTENT_PERMISSION_MAP`.

#### 3. Fail-Closed Security Policy for Unmapped Intents
- **Decision**: Any intent not explicitly registered in `INTENT_PERMISSION_MAP` is denied by default (`getRequiredPermissionForIntent` returns `undefined`), returning a structured `403 FORBIDDEN` response.
- **Rationale**: Enforces strict security defaults to guarantee that future or unmapped intents cannot be silently executed without explicit authorization rules.







