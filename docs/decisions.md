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

---

## ADR-009: RBAC Permission Map Extension for Usage and Support Specialists

- **Status**: Accepted
- **Date**: 2026-08-21
- **Scope**: Ingress Router (`services/tenant-router/permission-map.ts`), Mock Token Validator (`services/tenant-resolver/mock-jwt-validator.ts`), Integration Test Suite (`scripts/test-requests/`)

### Context

Following the integration of teammate Pubudini's newly added Usage Specialist (`agents/specialists/usage/handler.ts`) and Support Specialist (`agents/specialists/support/handler.ts`), the RBAC enforcement layer at the Tenant Router needed to be extended to cover the new business intents (`check_usage` and `troubleshoot_router`).

---

### Decisions & Rationale

#### 1. Extension of `INTENT_PERMISSION_MAP` Using Existing Shared Contract Constants

- **Decision**: Mapped newly integrated intents to pre-existing permission constants in `shared/constants/permissions.ts`:
  - `check_usage` -> `PERMISSIONS.USAGE_READ` (`"usage:read"`)
  - `troubleshoot_router` -> `PERMISSIONS.FAULTS_READ` (`"faults:read"`)
  - `pay_bill` -> `PERMISSIONS.BILLING_PURCHASE` (`"billing:purchase"`)
  - `create_fault` -> `PERMISSIONS.FAULTS_CREATE` (`"faults:create"`)
- **Rationale**: All new intents were fully covered by existing contract permissions defined in `PERMISSIONS`. No new contract constants needed to be added to `shared/constants/permissions.ts`.

#### 2. Mock Token Expansion for Granular Permission Testing

- **Decision**: Added `dev-token-billing-only` to `services/tenant-resolver/mock-jwt-validator.ts` containing `["billing:read"]` permission.
- **Rationale**: Enables explicit denial test cases for usage and support requests (`check_usage` and `troubleshoot_router`) without modifying existing staff/guest token permissions.

#### 3. Fail-Closed Default Verification & Test Suite Expansion

- **Decision**: Expanded the automated test suite in `scripts/test-requests/run-tests.ps1` from 4 to 8 test cases, validating HTTP 200 (allow) and HTTP 403 (deny) responses for all billing, usage, and support intents.
- **Verification**: Verified 8/8 automated test cases passing against live LocalStack API Gateway proxy integration.

---

## ADR-010: Identity Provider Reversal — Azure AD back to Cognito

- **Status**: Accepted
- **Date**: 2026-09-16
- **Scope**: Identity Provider (`infra/cognito/`), Root Module Wiring (`infra/main.tf`, `infra/outputs.tf`)

### Context

The multi-tenant platform's task allocation requires Cognito as the identity provider: the Admin Console and Live Agent Console (Member 1) authenticate via Cognito, and tenant identity is carried as a `custom:tenant_id` claim rather than resolved from an Azure AD JWT. This reverses ADR-002.

### Decisions & Rationale

#### 1. Reactivation of `infra/cognito/` Module

- **Decision**: Removed the deprecation banner from `infra/cognito/main.tf`, uncommented `module "cognito"` in `infra/main.tf`, and restored the corresponding outputs in `infra/outputs.tf`.
- **Rationale**: The module was retained (not deleted) at ADR-002 time specifically to allow this kind of reversal without rebuilding from scratch.

#### 2. `live_agent` User Group

- **Decision**: Added `aws_cognito_user_group.live_agent` alongside the existing `staff` and `admin` groups.
- **Rationale**: The Live Agent Console needs a distinct login role from company admins and internal pilot staff.

#### 3. `custom:tenant_id` Exposed on the App Client

- **Decision**: Added `custom:tenant_id` to both `read_attributes` and `write_attributes` on `aws_cognito_user_pool_client.client`.
- **Rationale**: A custom schema attribute existing on the user pool is not sufficient for it to appear in issued tokens — Cognito also requires it to be explicitly whitelisted per app client. Without this, the frontend cannot read `custom:tenant_id` after login as the task allocation assumes.

#### 4. `tenant_id` Schema Left Optional

- **Decision**: Kept `required = false` on the `tenant_id` schema attribute rather than making it mandatory pool-wide.
- **Rationale**: Enforcing tenant binding at the schema level would also block the pre-existing internal-pilot `staff`/`admin` users that don't go through the onboarding flow. Enforcement instead belongs in the tenant resolver (see ADR-011): any token whose claimed role requires tenant scoping but carries no `custom:tenant_id` should be rejected there, not by Cognito.

---

## ADR-011: Zero-Trust Tenant Resolution (Spoofing Guard)

- **Status**: Accepted
- **Date**: 2026-09-16
- **Scope**: `services/tenant-resolver/mock-jwt-validator.ts`, `services/tenant-resolver/resolver.ts`, `shared/types/tenant-context.ts`, `scripts/test-tenant-resolver.ts`

### Context

Prior to this change, `resolveTenantContext` took `tenantId` directly from the client-supplied `x-tenant-id` header and never cross-checked it against the authenticated token. Any caller with a valid token for tenant A could set `x-tenant-id: tenant-b` and be resolved into tenant B's context — a full tenant-isolation bypass, directly contradicting the DoD requirement that Company A cannot access Company B's data.

### Decisions & Rationale

#### 1. `mock-jwt-validator.ts` speaks Cognito claim shapes

- **Decision**: Decodes `cognito:groups` (`admin` / `live_agent` / `staff`) and `custom:tenant_id`, with no fallback default value for the tenant claim.
- **Rationale**: Previously simulated Azure AD's `tid`/`oid`/`roles` shape, which no longer matches the reactivated Cognito provider (ADR-010).

#### 2. Token is the sole source of tenant identity

- **Decision**: `resolveTenantContext` takes `tenantId` exclusively from the decoded token's `custom:tenant_id` claim. The `x-tenant-id` header is optional and, when present, is validated for agreement only — never used to set tenant identity.
- **Rationale**: This is the actual fix for the spoofing hole described above.

#### 3. Two fail-closed cases, both `403 FORBIDDEN`

- **Decision**: `details.reason = "TENANT_MISMATCH"` when a supplied `x-tenant-id` header disagrees with the token's tenant; `details.reason = "TENANT_CLAIM_MISSING"` when the token has no tenant claim at all.
- **Rationale**: Matches the task doc's `403 FORBIDDEN (TENANT_MISMATCH)` contract. A missing header is no longer a `400 BAD_REQUEST` since the header is now optional by design.

#### 4. `live_agent` added to `TenantContext["role"]`

- **Decision**: Extended the role union from `"staff" | "admin"` to `"staff" | "admin" | "live_agent"`.
- **Verification**: `scripts/test-tenant-resolver.ts` — 7/7 checks passing, including the actual spoofing case (mismatched header rejected) and the missing-claim case.

---

## ADR-012: DynamoDB Tenant Partitioning Tables & Seed Data

- **Status**: Accepted
- **Date**: 2026-09-16
- **Scope**: `scripts/create-tenants-table.ts`

### Decisions & Rationale

#### 1. Three tables, matching the task doc's schema

- `omni-channel-tenants` — PK `tenantId`. `omni-channel-agents` — PK `tenantId`, SK `agentId`. `omni-channel-tools` — PK `tenantId`, SK `toolId` (created empty; owned by Member 4).

#### 2. Seed data for `slt` and `tenant-test-123`

- **Decision**: Both baseline companies seeded with `status: "active"` and all four channels allowed, plus one `main-agent` record each in `omni-channel-agents`.
- **Rationale**: Gives `services/tenant-router/router.ts` (ADR-014) real data to query immediately.

### Explicit Deferral

At the time this ADR was written, `router.ts` still read from an in-memory `TENANT_REGISTRY`, not this table — closed by ADR-014 below.

---

## ADR-013: Company Onboarding Pipeline (Step Functions / Lambda)

- **Status**: Accepted
- **Date**: 2026-09-16
- **Scope**: `services/onboarding/` (new), `shared/types/onboarding.ts` (new), `agents/utils/cognito-client.ts` (new), `scripts/test-onboarding.ts` (new), `infra/step-functions/`, `infra/lambda/main.tf`, `infra/api-gateway/main.tf`, `package.json` (+`@aws-sdk/client-cognito-identity-provider`)

### Decisions & Rationale

#### 1. Pipeline logic lives in a plain async function, wrapped by a single-Task state machine

- **Decision**: `services/onboarding/onboarding.ts` exports `onboardCompany()`, running all pipeline steps sequentially in one Lambda invocation. `infra/step-functions/main.tf` wraps this Lambda in a single Task state rather than decomposing each step into its own Step Functions state.
- **Rationale**: Real Step Functions orchestration exists (genuinely invoked via `aws_sfn_state_machine`, with retry/catch), sized to what a Phase 1 deadline allows. Decomposing into per-step states (to later insert a manual-review step, for example) is a clearly flagged follow-up, not a silent simplification.

#### 2. Onboarding auth does NOT go through `resolveTenantContext`

- **Decision**: `services/onboarding/handler.ts` decodes the token directly and requires `role === "staff"`, rather than calling the ADR-011 resolver.
- **Rationale**: ADR-011's zero-trust resolver correctly rejects any token with no `custom:tenant_id` claim. Onboarding is inherently cross-tenant — internal staff creating a _brand-new_ tenant have no tenant of their own by definition. Routing this through the resolver would make onboarding permanently unusable.

#### 3. Idempotency via `GetItem` pre-check + `ConditionExpression`

- **Decision**: Checks for an existing tenant before writing, and sets `ConditionExpression: attribute_not_exists(tenantId)` on the write itself, closing the race window between check and write.

#### 4. Best-effort rollback, not a real saga

- **Decision**: If a later step fails, earlier DynamoDB writes (and the S3 prefix marker, see ADR-015) are deleted on a best-effort basis. If the rollback itself fails, it's logged, not retried.
- **Rationale**: A real distributed-transaction pattern is more machinery than a Phase 1 deadline allows; explicitly documented as best-effort so nobody assumes stronger guarantees than exist.

#### 5. IAM permissions added — closing a pre-existing gap

- **Decision**: `infra/lambda/main.tf`'s `lambda_exec` role previously had no attached policy at all (not even `AWSLambdaBasicExecutionRole`). Added that plus an inline policy granting `dynamodb:GetItem/PutItem/DeleteItem` and `cognito-idp:AdminCreateUser/AdminAddUserToGroup`, scoped to `Resource: "*"` since none of the DynamoDB tables here are Terraform-managed (ADR-012).
- **Deferral**: Tighten to specific resource ARNs before any real (non-LocalStack) AWS deployment.

### Verification

`scripts/test-onboarding.ts` — all checks pass (see ADR-015 for the current full count after the S3/credentials additions); `tsc --noEmit` clean project-wide.

---

## ADR-014: `router.ts` Migrated to DynamoDB-Backed Tenant Lookup

- **Status**: Accepted
- **Date**: 2026-09-16
- **Scope**: `services/tenant-router/router.ts`, `services/tenant-router/handler.ts`, `scripts/create-tenants-table.ts` (comment only), `scripts/test-router.ts` (new)

### Context

ADR-012 created and seeded the `omni-channel-tenants` table but `router.ts` still read from a hardcoded in-memory `TENANT_REGISTRY` object — the one remaining place where the task doc's "Current Baseline" claim (router already queries DynamoDB) didn't match reality.

### Decisions & Rationale

#### 1. `TENANT_REGISTRY` removed entirely, no in-memory fallback

- **Decision**: `routeRequest` now does a `GetCommand` against `omni-channel-tenants` on every call, with no fallback if DynamoDB is unreachable.
- **Rationale**: A fallback would silently reintroduce the exact staleness problem this migration exists to fix. If DynamoDB is down, routing fails loudly (`INTERNAL_ERROR`, `retryable: true`) rather than serving stale data.

#### 2. `routeRequest` is now `async`; its one caller updated

- **Decision**: `services/tenant-router/handler.ts` now does `await routeRequest(...)`.

#### 3. Dependency injection added for testability

- **Decision**: `routeRequest(context, deps?)` takes an optional `TenantRouterDeps`, defaulting to the real shared `docClient` when omitted — same pattern as `OnboardingDeps` in ADR-013.

### Verification

`scripts/test-router.ts` — 4/4 checks passing: active tenant routes correctly, unknown tenant → `TENANT_NOT_FOUND`, suspended tenant → `TENANT_INACTIVE`, simulated DynamoDB outage → retryable `INTERNAL_ERROR`. Re-ran the full existing script suite after this change — all still pass.

---

## ADR-015: Onboarding Response Completeness — S3 Prefix & Temporary Credentials

- **Status**: Accepted
- **Date**: 2026-09-17
- **Scope**: `services/onboarding/onboarding.ts`, `shared/types/onboarding.ts`, `scripts/test-onboarding.ts`

### Context

ADR-013 shipped a working onboarding pipeline, but a line-by-line check against the task doc's 5 numbered sub-steps found two gaps: step 3 ("Provisions isolated S3 prefix: `s3://platform-kb/{tenantId}/`") wasn't implemented at all, and step 5 ("Sends response with temporary login credentials") only returned `adminUsername` — no password was ever returned, since Cognito was left to auto-generate and email one via `DesiredDeliveryMediums: ["EMAIL"]`.

### Decisions & Rationale

#### 1. S3 prefix provisioned via a marker object, in the existing KB bucket

- **Decision**: Writes a small marker object to `{tenantId}/.kb-prefix` in the `omni-channel-kb-docs` bucket (via `KB_BUCKET_NAME` env var, defaulting to that name) rather than the task doc's illustrative `platform-kb` bucket name.
- **Rationale**: `omni-channel-kb-docs` is the bucket that actually exists elsewhere in this codebase (`scripts/create-kb-bucket.ts`, `agents/utils/s3-client.ts`, Member 4's KB retrieval). Using the task doc's literal example name would have created a second, disconnected bucket nothing else references. S3 has no native "create folder" operation — a prefix only becomes visible once something is written under it, which is what the marker object is for.

#### 2. Real generated temporary password, returned in the response, not emailed

- **Decision**: `AdminCreateUserCommand` now sets an explicit `TemporaryPassword` (generated to satisfy the pool's password policy: 8+ chars, upper, lower, digit, symbol) and `MessageAction: "SUPPRESS"` instead of `DesiredDeliveryMediums: ["EMAIL"]`. The password is returned directly in `OnboardingResult.temporaryPassword`.
- **Rationale**: The task explicitly asks the API response to carry temporary login credentials — an auto-sent email satisfies neither the letter nor the practical need (Member 1's Admin Console has nothing to display on successful onboarding without this). Cognito still forces a password change on first login regardless of how the temporary password was set.

#### 3. Rollback extended to the S3 marker

- **Decision**: `bestEffortRollback` now also attempts to delete the S3 marker object if a later step fails. A failed S3 rollback is logged as non-fatal (a leftover marker with no tenant/agent record is harmless clutter, not a security issue).

### Verification

`scripts/test-onboarding.ts` — 21/21 checks passing, including new checks for the S3 marker being written and rolled back correctly, the response's `kbPrefix` field, the returned temporary password meeting the pool's password policy, and a new S3-failure-triggers-rollback case confirming Cognito is never called if the S3 step fails first. `tsc --noEmit` clean project-wide; full regression pass against `test-tenant-resolver.ts`, `test-router.ts`, `test-check-usage.ts`, `test-check-balance.ts` — all still green.

---

## ADR-016: Case/Spacing-Insensitive Company Name Duplicate Check

- **Status**: Accepted
- **Date**: 2026-09-18
- **Scope**: `shared/utils/tenant-name.ts` (new), `services/onboarding/onboarding.ts`, `services/tenant-router/router.ts` (type only), `scripts/create-tenants-table.ts`, `scripts/test-onboarding.ts`

### Context

Onboarding's existing duplicate check only compared `tenantId` (the slug). It never compared `companyName`, so the same company could be onboarded multiple times as separate tenants just by varying capitalization or spacing — e.g. `"Acme Corp"` (tenantId `acme-corp`) and `"ACME CORP"` (tenantId `acme-corp-2`) would both succeed as if they were different companies.

### Decisions & Rationale

#### 1. Normalize, don't compare raw strings

- **Decision**: Added `normalizeCompanyName()` — lowercases, trims, and collapses internal whitespace (`"  ACME   Corp "` → `"acme corp"`).
- **Rationale**: DynamoDB has no case-insensitive comparison operator, so matching has to happen on a precomputed, canonical form stored alongside the raw name.

#### 2. A GSI, not a table Scan

- **Decision**: Added a `NormalizedNameIndex` Global Secondary Index on `omni-channel-tenants`, keyed on the new `normalizedName` attribute, and query it (`QueryCommand`) instead of scanning every tenant row.
- **Rationale**: A `Scan` would work at the current tiny seed-data scale but degrades linearly as tenants grow, and costs more per request. A GSI keeps the duplicate check O(1) regardless of tenant count — the right choice for something checked on every onboarding call, not a one-off script.
- **Deferral**: DynamoDB does not add a GSI to an already-existing table via `CreateTableCommand` — if `omni-channel-tenants` was created before this ADR, it must be deleted (or LocalStack restarted) so it gets recreated with the GSI. Documented directly in `create-tenants-table.ts`'s header comment.

#### 3. New error code, not a reused one

- **Decision**: A name conflict returns `COMPANY_NAME_ALREADY_EXISTS` (distinct from `TENANT_ALREADY_EXISTS`), with `details.existingTenantId` naming the conflicting tenant.
- **Rationale**: These are different failure reasons from the caller's point of view — one says "that slug is taken," the other says "that company is already registered under a different slug" — and collapsing them into one code would make the response harder to act on.

### Verification

`scripts/test-onboarding.ts` — extended to 24/24 checks, including the exact reported case (`"  ACME    CORP  "` correctly rejected against an existing `"Acme Corp"`) and a negative control confirming an unrelated company name is never falsely blocked. `tsc --noEmit` clean; full regression (`test-tenant-resolver.ts`, `test-router.ts`, `test-check-usage.ts`) still passing.

---

## ADR-017: Onboarding S3 Prefix Aligned to Member 4's Real KB Key Convention

- **Status**: Accepted
- **Date**: 2026-09-20
- **Scope**: `services/onboarding/onboarding.ts`, `scripts/test-onboarding.ts`

### Context

ADR-015 provisioned an S3 marker object at `{tenantId}/.kb-prefix` to mark a tenant's knowledge-base prefix as provisioned. Since then, `agents/utils/s3-client.ts` (Member 4's KB retrieval/upload code) was built with its own tenant-isolation key convention via `buildTenantS3Key()`, which actually nests documents under `tenants/{tenantId}/{docName}` — one path segment different from what onboarding was provisioning. The two conventions coexisted without conflicting, but the onboarding marker wasn't actually sitting inside the prefix Member 4's code reads from.

### Decision

`onboardCompany()` now imports and calls the same `buildTenantS3Key()` helper Member 4's code already uses, rather than constructing its own key. The marker object now lives at `tenants/{tenantId}/.kb-prefix`, and `OnboardingResult.kbPrefix` reports `tenants/{tenantId}/` to match.

### Rationale

Two independently-built "tenant prefix" conventions in the same bucket is exactly the kind of drift this project's isolation work is supposed to prevent. Reusing the existing helper instead of asserting a second convention keeps there being exactly one definition of "where does tenant X's knowledge base live" — the one Member 4's retrieval code actually queries.

### Verification

`scripts/test-onboarding.ts` updated to assert the new `tenants/acme-corp/.kb-prefix` key and `tenants/acme-corp/` prefix; still 24/24 passing. `tsc --noEmit` clean (excluding the 4 pre-existing unrelated errors in Member 3/4's `create-handoff-resources.ts`, `test-fetch-kb-doc.ts`, `test-member4-ai-engine.ts`, `test-ui-api-server.ts`, which predate this change and are outside this scope).

---

## ADR-018: Automatic Company Workspace Onboarding & Tenant Provisioning (Supervisor Directive)

- **Status**: Accepted
- **Date**: 2026-11-11
- **Scope**: `server.ts`, `services/onboarding/register-tenant.ts`, `shared/types/onboarding.ts`, `shared/utils/tenant-name.ts`, `scripts/test-automatic-onboarding.ts`
- **Source**: Project owner's authoritative report of supervisor Tharusha's steering meeting direction.

### Context

Prior to this decision (Tasks 06–09), new company workspace registrations entered a mandatory manual review state (`status: "Pending"`). A platform Super Admin was required to review and approve each application via `PATCH /api/registrations/:id` before tenant infrastructure was provisioned or the company administrator was permitted to log in.

Supervisor Tharusha instructed the team that ordinary companies must no longer wait for manual Super Admin approval. The target platform onboarding pipeline requires:
`Company Registration -> Automated Validation -> Secure Identity/Account Setup -> Tenant Provisioning -> Active Workspace -> Company Admin Dashboard`.

### Decision

1. **Autonomous Provisioning Pipeline**:
   - `POST /api/registrations` now executes automatic tenant provisioning immediately upon validating company inputs.
   - Automatically derives normalized tenant slug (`deriveTenantId(cleanSlug)` -> `tenant-{slug}`).
   - Rejects reserved slugs (`slt`, `admin`, `system`, `api`, `platform`, `root`, `superadmin`).
   - Rejects duplicate company names (case & whitespace normalized) and existing tenant slugs with `409 Conflict`.
   - Provisions DynamoDB records in `omni-channel-tenants` and `omni-channel-agents` (default support specialist).
   - Provisions S3 knowledge-base prefix (`tenants/{tenantId}/welcome.txt` and `.kb-prefix`).
   - Hashes administrator passwords using `scrypt-v2` with cryptographically random salts. Plaintext passwords and hashes are never returned in responses.
   - Activates the tenant partition immediately with `status: "Active"` and `provisioningStatus: "ACTIVE"`.
   - Returns HTTP `201 Created` with tenant metadata, company admin profile, and initial local session token so the frontend can redirect the administrator directly to their workspace dashboard.

2. **Concurrency & Idempotency Safeguards**:
   - In-memory concurrency locks (`inFlightRegistrations`) ensure simultaneous registration attempts on identical slugs produce exactly one `201 Created` and one `409 Conflict`.
   - Idempotency keys (`idempotency-key` header) replay previously provisioned workspace responses without duplicating resources.
   - Bounded sliding-window rate limiting (`registrationLimiter`) prevents unauthenticated flood attacks.

3. **Super Admin Operational Role Retained**:
   - Super Admin manual approval is removed from the critical onboarding path for ordinary companies.
   - Administrative endpoints (`GET /api/registrations`, `PATCH /api/registrations/:id`, `DELETE /api/registrations/:id`) are retained for operational governance: suspending rogue tenants (`status: "Suspended"`), reactivating accounts (`status: "Active"`), rejecting spam, and reviewing enterprise manual compliance applications (`requireApproval: true`).
   - Historical pending registrations in `db.json` remain untouched and are not silently auto-activated.

4. **Lifecycle States Defined**:
   - `REGISTERING`: Initial receipt, rate-check, and syntactic validation.
   - `PROVISIONING`: Resource partitioning across DynamoDB, S3, and identity stores.
   - `ACTIVE`: Fully provisioned, tenant active, admin account authenticated.
   - `SUSPENDED`: Administratively halted by Super Admin; access blocked.
   - `FAILED`: Provisioning failed; partial writes rolled back; fails closed.
   - `PENDING`: Historical or enterprise manual review registrations.

5. **Local vs AWS Behavior**:
   - Local: Synchronous in-process orchestration using mock AWS clients or LocalStack with fallback to in-memory tables.
   - AWS: Step Functions state machine (`infra/step-functions/tenant-onboarding.asl.json`) invokes Lambda tasks with Cognito AdminCreateUser and DynamoDB conditional puts.

### Frontend Contract Impact

- `POST /api/registrations` returns `{ success: true, registration, token, user, nextAction: "WORKSPACE_DASHBOARD" }`.
- Modern frontend (`Register.tsx`) checks `if (data.token && data.user) { login(data.user, data.token); navigate('/dashboard'); }`, entering the dashboard immediately without landing on `/register-success`.
- `POST /api/auth/login` permits company admins to log in once `status === "Active" || status === "Approved"`.

### Verification

- Comprehensive test suite `scripts/test-automatic-onboarding.ts` verifying all 18 requirements: 30/30 passed.
- Full 12-suite regression harness (`npm test`): 152/152 assertions passed across all 12 suites, executed twice consecutively with exit code 0.
- `terraform -chdir=infra validate` clean.
- Real `db.json` unmutated (`git diff db.json` empty).

---

## ADR-019: Public Idempotency Replay Protection, Production Fallback Boundaries, Non-Destructive Workspace Suspension Lifecycle, and Full-Stack Contract Alignment

- **Status**: Accepted
- **Date**: 2026-11-11
- **Scope**: `server.ts`, `services/onboarding/register-tenant.ts`, `omni-agent-ui` React integration, `scripts/test-automatic-onboarding.ts`, `scripts/e2e-live-fullstack.ts`

### Context

Following the implementation of automatic company workspace onboarding in Task 10, several critical multi-tenant SaaS security vulnerabilities and frontend contract mismatches required resolution before full-stack validation:

1. **Public Idempotency Key Replay Vulnerability**:
   The previous `idempotency-key` handling re-minted a live session bearer token and returned the company administrator profile to any caller presenting the same key. This created a high-severity privilege escalation risk where an unauthenticated attacker or adversary could hijack an existing company's active session by reusing or guessing an idempotency key.
2. **Implicit Production Fallbacks**:
   `services/onboarding/register-tenant.ts` previously caught cloud errors from DynamoDB and S3 and fell back to in-memory mock structures without failing closed when running in production mode (`NODE_ENV === "production"`).
3. **Destructive Workspace Deletion**:
   `DELETE /api/registrations/:id` previously purged registration records from `db.json` but left DynamoDB tables, in-memory caches, and S3 knowledge base prefixes active, creating orphaned cloud partitions and destroying audit trails.
4. **Hardcoded Frontend Endpoints**:
   Multiple frontend views (`Register.tsx`, `OrganizationManagement.tsx`, `Agents.tsx`, `Notifications.tsx`, `Channels.tsx`, `ToolsManagement.tsx`, `HostedChatWidget.tsx`) hardcoded `http://localhost:3001` instead of consuming `ENV.API_BASE_URL`.

### Decision

1. **Idempotency Fingerprint Binding & Token Stripping (Stage 2.A)**:
   - Every registration with an `idempotency-key` computes a SHA-256 request payload fingerprint: `crypto.createHash("sha256").update(`${cleanSlug}#${rawEmail}#${rawCompanyName}`).digest("hex")`.
   - The key, fingerprint, and a 24-hour expiration timestamp (`idempotencyExpiresAt`) are persisted.
   - An adversarial request presenting an existing key with a different payload is rejected with `409 Conflict` (idempotency key collision).
   - An unauthenticated replay presenting an identical key and fingerprint returns `200 OK` with sanitized registration metadata, but **never** mints or returns a bearer token. It sets `nextAction: "LOGIN_REQUIRED"`, requiring credential authentication via `/api/auth/login`.
2. **Production Fail-Closed Boundaries (Stage 2.B & 2.C)**:
   - When `NODE_ENV === "production"` or `ALLOW_MOCK_AWS !== "true"`, `register-tenant.ts` disallows in-memory fallback. If DynamoDB or S3 operations fail, provisioning fails closed with HTTP 502 without modifying state.
   - Cross-process uniqueness is guaranteed on DynamoDB via `ConditionExpression: "attribute_not_exists(tenantId)"`.
   - Production error messages are sanitized to prevent cloud configuration leakage.
3. **Production-Facing Activation Boundary (Stage 2.D)**:
   - When `REQUIRE_EMAIL_VERIFICATION === "true"` or `NODE_ENV === "production"`, newly provisioned workspaces enter `provisioningStatus: "AWAITING_VERIFICATION"` and return `nextAction: "EMAIL_VERIFICATION_REQUIRED"`. Active session tokens are not minted prior to identity confirmation.
   - Local development mode (`NODE_ENV !== "production"` and `ALLOW_MOCK_AUTH === "true"`) maintains immediate token issuance for seamless local DX.
4. **Non-Destructive Workspace Suspension Lifecycle (Stage 2.E)**:
   - `DELETE /api/registrations/:id` transitions workspaces to `status: "Suspended"` and `provisioningStatus: "SUSPENDED"`.
   - Synchronizes `inMemoryTenants` and DynamoDB tenant status to `"suspended"`.
   - Preserves all cloud partitions, S3 documents, and audit metadata.
   - Blocks subsequent authentication attempts via `POST /api/auth/login` with `403 Forbidden`.
5. **Full-Stack React Contract Alignment (Stage 3 & 4)**:
   - All frontend components updated to utilize `ENV.API_BASE_URL`.
   - `Register.tsx` dynamically responds to `token`, `LOGIN_REQUIRED`, and `EMAIL_VERIFICATION_REQUIRED`.
   - Super Admin Organization Management safely excludes suspended workspaces from active tabs.
   - Executed live full-stack E2E suite (`scripts/e2e-live-fullstack.ts`) verifying live backend (port 3001) and frontend (port 5173).

### Verification

- Backend regression harness: 155/155 assertions passed across 12 suites, twice consecutively (exit code 0).
- Frontend production build: Vite production bundle built in 603ms with 0 errors.
- Frontend typecheck: `npx tsc --noEmit` exited with code 0.
- Live full-stack E2E suite: 23/23 assertions passed live over real HTTP (exit code 0).
- Immutability check: `git diff db.json` is completely clean.

---

## ADR-020: Supervisor MVP Feature Reconciliation, Native TypeScript AI Runtime Architecture & Amazon Bedrock Converse Integration

- **Status**: Accepted
- **Date**: 2026-11-11
- **Scope**: `services/ai-runtime/`, `server.ts`, `package.json`, `scripts/test-ai-runtime.ts`

### Context

Prior to Task 12, the Omni Channel Platform possessed a verified SaaS control plane, automatic workspace onboarding, and robust tenant isolation. However, the AI conversation execution path was only stubbed with static specialist mocks (`agents/specialists/billing`, `usage`, `support`). 

Supervisor Tharusha's authoritative customer-engagement MVP was developed in Python/AWS SAM (`origin/feature/customer-agent-unified:customer-agent-mvp-source/`) featuring:
1. Amazon Bedrock `Converse` API invocation with configurable foundation models (`anthropic.claude-3-sonnet`, `amazon.nova-lite-v1:0`, etc.).
2. Bedrock Guardrails propagation (`guardrailIdentifier`, `guardrailVersion`).
3. Short-term multi-turn conversation memory (last 12 turns) partitioned by `sessionId`.
4. Tenant-scoped Knowledge Base vector retrieval with shared-KB tenant filtering (`equals: { key: "tenant_id", value: agent.tenantId }`).
5. Allowlisted tool execution (OpenAPI HTTPS endpoints and MCP JSON-RPC 2.0 with SigV4/secret headers).
6. Intent routing (`billing`, `technical`, `sales`, `lead`, `general`) and dynamic lead form triggers.
7. Customer human handoff regex detection (`\b(human|person|representative|live agent)\b`) and session escalation (`HANDOFF_REQUESTED`).
8. Public agent profile resolution and DynamoDB session management.

Pubudini's branch had checked in the supervisor's Python source under `customer-agent-mvp-source/`, but had not integrated the real Bedrock conversation orchestrator into the TypeScript server runtime.

### Architectural Decision

We evaluated two architectural integration paths:
1. **Separately deployed Python agent service behind a TypeScript gateway**:
   - *Drawbacks*: Requires managing dual runtimes (Node.js + Python 3.12), cross-process HTTP serialization latency, duplicated authentication middleware, separate CI/CD environments, and complex Docker multi-container local testing.
2. **Native TypeScript AWS Bedrock SDK adaptation adapted from Python reference logic** (SELECTED):
   - *Advantages*:
     - Single unified runtime aligning with the verified TypeScript control plane and Express server.
     - 100% logic and formula fidelity to supervisor's `bedrock_service.py`, `orchestrator.py`, `tool_executor.py`, and `repository.py`.
     - Direct deterministic mock adapter (`DeterministicMockBedrockAdapter`) enabling fast, offline, reliable CI/CD testing without calling live AWS.
     - Strict production fail-closed boundaries: in `NODE_ENV === "production"`, mock mode is strictly prohibited and fails closed.
     - Direct integration with `TenantContext`, `LocalSessionTokenService`, and DynamoDB DocumentClient.

### Implementation Details

1. **AI Runtime Domain Modules (`services/ai-runtime/`)**:
   - `types.ts`: Strictly-typed data models for `AgentConfig`, `PublicMapping`, `ConversationSession`, `ChatMessage`, `ToolDefinition`, `FormDefinition`, and `TurnResult`.
   - `agent-repository.ts`: Repository managing public URL mappings, agent configs, sessions, and messages with transparent DynamoDB DocumentClient backing and in-memory test fallback.
   - `bedrock-provider.ts`: `IBedrockRuntime` provider interface with two concrete implementations:
     - `AwsBedrockRuntimeAdapter`: Uses `@aws-sdk/client-bedrock-runtime` (`ConverseCommand`). Executes 4-turn tool use loop, applies guardrails, configures inference settings, and handles timeouts/errors.
     - `DeterministicMockBedrockAdapter`: Deterministic offline mock engine for local testing.
     - `getBedrockRuntime()`: Factory enforcing fail-closed behavior in production.
   - `knowledge-retriever.ts`: Multi-tier tenant-scoped KB retriever. Enforces shared-KB vector filtering, dedicated KB tenant tag verification, and S3 tenant partition scoping. Guarantees explicit empty KB behavior (no cross-tenant leakage).
   - `tool-executor.ts`: Strict tool allowlist enforcement (`agent.tools`). Defends against prototype pollution, validates HTTPS-only URLs without embedded credentials, clamps timeouts (2-25s), and executes API / MCP calls safely.
   - `orchestrator.ts`: Conversation orchestrator porting supervisor's keyword scoring, handoff detection, system prompt compilation with untrusted input boundaries (<180 words, no prompt leakage), dynamic lead form triggers, and multi-turn execution.
2. **Server Endpoints (`server.ts`)**:
   - Public Chat API: `GET /v1/public/agents/:key`, `POST /v1/public/sessions`, `POST /v1/public/sessions/:id/messages`, `GET /v1/public/sessions/:id/messages`, `POST /v1/public/sessions/:id/feedback`.
   - Admin Management: `GET|POST /api/dev/admin/agents`, `GET /api/dev/admin/agents/:id`, `POST /api/dev/admin/agents/:id/publish`, `GET|POST /api/dev/admin/knowledge-bases`, `GET|POST /api/dev/admin/tools`.
   - Hosted Chat URL Resolver: `GET /api/resolve-chat-url` dynamically resolves published agents from `agentRepository`.
3. **Automated Verification**:
   - Authoring `scripts/test-ai-runtime.ts` covering 32 distinct assertions across resolution, loading, cross-tenant denial, Bedrock converse, fail-closed boundaries, KB isolation, multi-turn memory, tools, and handoffs.

### Verification

- AI Runtime test suite (`scripts/test-ai-runtime.ts`): 32/32 assertions passed (exit code 0).
- Full 13-suite regression test harness (`npm test`): 187/187 assertions passed across all 13 suites, executed twice consecutively with exit code 0.
- TypeScript typecheck (`npx tsc --noEmit`): 0 errors.
- Production build (`npm run build`): 0 errors.
- Terraform configuration (`terraform -chdir=infra validate`): Clean / valid.
- Real database immutability: Tracked `db.json` unmutated (`git diff db.json` empty).


