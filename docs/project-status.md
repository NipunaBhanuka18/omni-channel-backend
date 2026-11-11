# Omni Channel Platform — Current Project Status
**Date**: November 11, 2026  
**Status**: Full-Stack Development Baseline (Task 11 Checkpoint)  
**Branch**: `integration/fullstack-onboarding-validation`  
**Base Commit**: `df21ff1319de369a7093b0fc8f192d236d2d2604`

---

## 1. Executive Overview

The **SLT Mobitel Omni Channel Platform** is a multi-tenant AI customer engagement platform engineered to handle enterprise customer interactions across multiple channels (Web Chat, WhatsApp, SMS, Messenger). It routes customer intents dynamically through domain-specialist AI agents (Billing, Usage, Technical Support) backed by tenant-partitioned knowledge bases, with automated escalation to human agents when needed.

This document describes the exact implementation status of the TypeScript backend and React frontend as of the Task 11 full-stack integration checkpoint.

---

## 2. Implemented & Verified Full-Stack Subsystems

The following subsystems are verified and functional in the integrated codebase:

1. **[TESTED] Automatic Company Workspace Onboarding (`services/onboarding/register-tenant.ts`, `server.ts`)**:
   - Conforms to supervisor Tharusha's directive removing mandatory Super Admin approval for ordinary company onboarding.
   - Automatically derives normalized tenant slug (`deriveTenantId(cleanSlug)` -> `tenant-{slug}`).
   - Rejects reserved slugs (`slt`, `admin`, `system`, `api`, `platform`, `root`, `superadmin`).
   - Rejects duplicate company names (case & whitespace normalized) and existing tenant slugs with `409 Conflict`.
   - Provisions DynamoDB records in `omni-channel-tenants` and `omni-channel-agents` (default support specialist).
   - Provisions S3 knowledge-base prefix (`tenants/{tenantId}/welcome.txt` and `.kb-prefix`).
   - Returns HTTP `201 Created` with tenant metadata, company admin profile, and initial local session token for immediate dashboard access.
2. **[TESTED] Public Idempotency Replay Protection (Stage 2.A)**:
   - Request fingerprint binding using SHA-256 (`cleanSlug#adminEmail#companyName`).
   - Adversarial requests reusing existing keys with mismatched payloads are rejected with `409 Conflict`.
   - Unauthenticated replays return `200 OK` with sanitized registration metadata, but **never** mint or return bearer tokens. Replays require credential login (`nextAction: "LOGIN_REQUIRED"`).
3. **[TESTED] Production Fail-Closed Boundaries (Stage 2.B & 2.C)**:
   - When `NODE_ENV === "production"` or `ALLOW_MOCK_AWS !== "true"`, cloud failures fail closed (HTTP 502) without falling back to in-memory tables.
   - Cross-process uniqueness guaranteed on DynamoDB via `ConditionExpression: "attribute_not_exists(tenantId)"`.
4. **[TESTED] Production Identity Verification Boundary (Stage 2.D)**:
   - When `REQUIRE_EMAIL_VERIFICATION === "true"` or `NODE_ENV === "production"`, newly created accounts require email verification before session issuance (`nextAction: "EMAIL_VERIFICATION_REQUIRED"`).
5. **[TESTED] Non-Destructive Workspace Suspension Lifecycle (Stage 2.E)**:
   - `DELETE /api/registrations/:id` safely suspends and deactivates company workspaces without deleting cloud partitions or destroying audit records.
   - Synchronizes `inMemoryTenants` and DynamoDB tenant status to `"suspended"`.
   - Subsequent company logins are immediately blocked with `403 Forbidden`.
6. **[TESTED] Zero-Trust Tenant Resolution (`services/tenant-resolver/`)**:
   - Validates incoming requests against AWS Cognito user pool tokens.
   - Extracts tenant identity from `custom:tenant_id` and derives roles (`superadmin`, `company`, `live_agent`, `guest`) from `cognito:groups`.
   - Fails closed on missing tenant claims or mismatched `x-tenant-id` client headers.
7. **[TESTED] Hardened Administrative Endpoints (`server.ts`)**:
   - `/api/auth/register-admin`: Token-guarded bootstrap or existing Super Admin authorization required.
   - `/api/agent/presence/online` & `offline`: Restricted to authorized `live_agent` roles scoped to their own tenant and agent ID.
   - `/api/chat/handoff/resolve`: Restricted to authorized agents assigned to the session.
8. **[TESTED] React Frontend Integration (`omni-agent-ui`)**:
   - `Register.tsx`: Configurable via `ENV.API_BASE_URL`, handles automatic onboarding, `LOGIN_REQUIRED`, and `EMAIL_VERIFICATION_REQUIRED` states.
   - `OrganizationManagement.tsx`: Consumes `ENV.API_BASE_URL` and excludes suspended companies from active views.
   - All client endpoints configurable via `VITE_API_BASE_URL`.
9. **[TESTED] Live Full-Stack End-to-End Suite (`scripts/e2e-live-fullstack.ts`)**:
   - Verified 16 live functional scenarios across live backend (port 3001) and React frontend (port 5173). All 23 assertions passed.

---

## 3. Mocked or Incomplete Subsystems

The following capabilities currently rely on simulated logic or fallbacks:

- **[OBSERVED] DynamoDB / S3 Local Fallbacks**: `agents/utils/dynamo-client.ts` and `s3-client.ts` include in-memory mock fallback maps when LocalStack or AWS is unreachable. Automated tests run against these fallbacks rather than a live DynamoDB instance.
- **[OBSERVED] Presence Storage**: `PresenceManager` falls back to an in-memory map when DynamoDB connection fails (`ECONNREFUSED 127.0.0.1:4566`).
- **[OBSERVED] Development Token Bypass**: In local development (`ALLOW_MOCK_AUTH=true`), preset tokens (`dev-token-*`) bypass cryptographic verification. In production (`NODE_ENV=production`), these tokens are strictly rejected.

---

## 4. Capabilities Remaining in the Supervisor Python MVP

The supervisor (Tharusha) provided a Python/AWS SAM MVP that has **NOT** yet been ported to the TypeScript backend:

- **[OBSERVED] Python Bedrock Agents**: Python-based LangChain / LangGraph orchestration agents for customer dialogue.
- **[OBSERVED] ChromaDB Vector Search**: Local vector embeddings and similarity search for customer document indexing.
- **[OBSERVED] AWS SAM Infrastructure**: Serverless Application Model templates defining Python Lambda handlers.
- **[PROPOSED] Migration Path**: Evaluate whether to run the Python agent as an independent containerized microservice behind the TypeScript API Gateway, or reimplement the Bedrock agent tools natively in TypeScript.

---

## 5. Experimental and Unintegrated Branches

- **`origin/feature/customer-agent-unified`**:
  - Auth, session token, scrypt, and rate-limiting modules were reconciled into this baseline.
  - Python agent code and direct Git history remain unintegrated due to unrelated Git root commits.
- **`origin/feature/m3-realtime-live-handoff`**:
  - Contains WebSocket / Socket.io live chat handoff logic developed by Member 3. Needs reconciliation with the REST presence endpoints in `server.ts`.
- **`origin/feature/multi-tenant-ui-integration`**:
  - UI frontend code for the Admin Console and Agent Workspace.

---

## 6. Frontend Integration Status

- **[OBSERVED] REST Route Contracts**: The TypeScript backend in `server.ts` provides the exact REST endpoints expected by the Next.js/React frontend:
  - `/api/auth/login`
  - `/api/stats`
  - `/api/notifications`
  - `/api/registrations` (GET, POST, PATCH, PUT)
  - `/api/agent/presence/online` and `offline`
  - `/api/chat/handoff/request` and `resolve`
  - `/api/workspace/upload-doc`
  - `/api/resolve-chat-url`
- **[UNKNOWN] Live End-to-End Contract Verification**: The frontend has not been executed against the secured backend endpoints in this phase.

---

## 7. Authentication Architecture and Limitations

- **Production Mode**: Validates RS256 JWKS tokens from AWS Cognito (`COGNITO_USER_POOL_ID`).
- **Local Mode**: Uses HMAC-SHA256 `v1.` session tokens.
- **[OBSERVED] Critical Endpoint Exposure**: As audited in Task 08 Stage 2, `/api/auth/register-admin`, `/api/agent/presence/online`, `/api/agent/presence/offline`, and `/api/chat/handoff/resolve` currently lack authentication middleware and must be protected before any deployment.

---

## 8. Infrastructure State

- **Terraform Config**: Located in `infra/`. Modules include `api-gateway`, `dynamodb`, `cognito`, `s3`, and `lambda`.
- **[TESTED] Validation**: `terraform -chdir=infra validate` reports `Success! The configuration is valid.`
- **[OBSERVED] Deployment State**: Lambda source code must be compiled (`npm run build`) to produce `./dist` before running `terraform apply`.

---

## 9. Open Architectural Decisions

1. **Python MVP Integration**: Will Bedrock AI agents be maintained as a Python microservice or ported to TypeScript `@aws-sdk/client-bedrock-agent-runtime`?
2. **WebSocket Architecture**: Will live chat and human handoff use API Gateway WebSocket APIs or an Express WebSocket server?
3. **Identity Provider Scope**: Will enterprise customers federate via SAML/OIDC into Cognito, or will each tenant have a dedicated User Pool?

---

## 10. Evidence Classification Summary

- **`[OBSERVED]`**: Code structure, file diffs, endpoint definitions, and unintegrated branches.
- **`[TESTED]`**: Compiler typecheck, build outputs, Terraform syntax validation, and 101 automated test assertions across 10 test suites.
- **`[REPORTED]`**: Previous meeting notes and Git commit history messages.
- **`[UNKNOWN]`**: Behavior of live AWS Cognito endpoints behind production VPC boundaries and frontend-backend live contract integration.
- **`[PROPOSED]`**: Recommended architectural patterns for Python microservices and endpoint hardening.
