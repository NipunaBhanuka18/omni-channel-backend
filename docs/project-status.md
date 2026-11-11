# Omni Channel Platform — Current Project Status
**Date**: November 11, 2026  
**Status**: Development Checkpoint Baseline  
**Branch**: `integration/auth-onboarding-reconciliation` (`checkpoint/recovery-2026-11-11`)  
**Commit**: `8f8293bb9905f0e98cf0d25c5d92353abb354f3e`

---

## 1. Executive Overview

The **SLT Mobitel Omni Channel Platform** is a multi-tenant AI customer engagement platform engineered to handle enterprise customer interactions across multiple channels (Web Chat, WhatsApp, SMS, Messenger). It routes customer intents dynamically through domain-specialist AI agents (Billing, Usage, Technical Support) backed by tenant-partitioned knowledge bases, with automated escalation to human agents when needed.

This document describes the exact implementation status of the TypeScript backend as of the November 11, 2026 recovery checkpoint.

---

## 2. Implemented Features in the TypeScript Backend

The following subsystems are verified and functional in the current integration codebase:

1. **[TESTED] Zero-Trust Tenant Resolution (`services/tenant-resolver/`)**:
   - Validates incoming requests against AWS Cognito user pool tokens.
   - Extracts tenant identity from `custom:tenant_id` and derives roles (`superadmin`, `company`, `live_agent`, `guest`) from `cognito:groups`.
   - Fails closed on missing tenant claims or mismatched `x-tenant-id` client headers.
2. **[TESTED] Dual-Mode Authentication Middleware (`services/auth/`)**:
   - **Production**: Native Node.js `node:crypto` RS256 JWKS token verifier (`cognito-jwt-verifier.ts`), validating cryptographic signatures against AWS Cognito public keys.
   - **Local / Test**: HMAC-SHA256 session token service (`local-session-token.ts`), signing `v1.` session tokens with bounded lifetimes and tenant scoping.
   - **Password Security**: Native `scrypt` hashing with 128-bit salt (`password-hashing.ts`) with automatic legacy credential upgrade on login.
   - **Rate Limiting**: Bounded memory fixed-window rate limiter (`bounded-rate-limiter.ts`) protecting registration endpoints against automated abuse.
3. **[TESTED] Multi-Tenant Onboarding Pipeline (`services/onboarding/`)**:
   - Provisions DynamoDB tenant partition records (`TENANT#<id>`), Cognito user accounts, and S3 knowledge-base prefixes (`tenants/<tenantId>/`).
   - Implements automated rollback across DynamoDB, Cognito, and S3 if any provisioning step fails.
   - Normalizes company names to prevent duplicate or conflicting tenant registrations.
4. **[TESTED] Administrative Approval Workflow (`services/onboarding/approval-workflow.ts`)**:
   - Safely transforms pending inbound company registrations into provisioned tenants with one-time credentials.
   - Enforces fail-closed behavior: errors during provisioning keep the registration in `Pending` state and prevent credential leakage.
   - Idempotency guard rejects repeat approval requests with HTTP 409 Conflict.
5. **[TESTED] Dynamic Tenant Router (`services/tenant-router/`)**:
   - Queries DynamoDB `omni-channel-tenants` table to verify tenant status (`ACTIVE` vs `SUSPENDED`).
   - Dispatches authorized requests to designated default agents; rejects suspended or non-existent tenants.
6. **[TESTED] AI Plane B Supervisor Delegation (`services/agent-core/`)**:
   - Bedrock AgentCore supervisor dispatches customer requests to specialist sub-agents (`Billing Specialist`, `Usage Specialist`, `Support Specialist`).
   - Scopes Knowledge Base document retrieval strictly to the authenticated tenant's S3 folder prefix.
7. **[TESTED] UI Express API Server (`server.ts`)**:
   - Implements REST endpoints for platform dashboard statistics, notifications, registration approval, customer escalation, presence status, and hosted chat configuration.

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
