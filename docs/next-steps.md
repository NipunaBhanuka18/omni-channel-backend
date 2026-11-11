# Omni Channel Platform — Ordered Implementation Roadmap (Next Steps)
**Date**: November 11, 2026  
**Reference Checkpoint**: `checkpoint/recovery-2026-11-11` (`8f8293b`)

---

## Continuation Plan Overview

This document provides a prioritized, actionable roadmap for resuming development on the Omni Channel Platform backend. Each milestone defines explicit dependencies and measurable acceptance criteria.

```
 Milestone 1: Endpoint Security Hardening & Bootstrap Authorization
      │
      ▼
 Milestone 2: RBAC Test Harness Repair & `pay_bill` Test Coverage
      │
      ▼
 Milestone 3: Script Compilation & TypeScript Cleanliness
      │
      ▼
 Milestone 4: Company & Agent Domain API Reconciliation
      │
      ▼
 Milestone 5: Supervisor MVP (Python Bedrock Agent) Integration
      │
      ▼
 Milestone 6: Live Contract Alignment with Next.js Frontend
      │
      ▼
 Milestone 7: LocalStack Infrastructure Emulation & Verification
      │
      ▼
 Milestone 8: Supervisor Architecture Sign-off & ADR Updates
      │
      ▼
 Milestone 9: Branch Merges, Worktree Cleanup & Shared Baseline
```

---

## Milestone 1: Endpoint Security Hardening & Bootstrap Authorization

- **Objective**: Close the security gaps identified during the Task 08 Stage 2 audit in `server.ts`.
- **Target Endpoints**:
  1. `POST /api/auth/register-admin`: Require a one-time bootstrap secret token (e.g. `BOOTSTRAP_TOKEN` environment variable) or disable endpoint when at least one `superadmin` exists in `db.json`. Ensure plaintext password is never returned in response.
  2. `POST /api/agent/presence/online` & `offline`: Protect with `requireAgentOrCompany` middleware, ensuring caller cannot spoof another agent or tenant.
  3. `POST /api/chat/handoff/resolve`: Protect with `requireAgentOrCompany` middleware and verify caller's authorization to resolve the specific session.
- **Dependencies**: Current checkpoint (`8f8293b`).
- **Acceptance Criteria**:
  - `POST /api/auth/register-admin` returns HTTP 403 / 401 when called without bootstrap authorization.
  - Presence and resolve endpoints return HTTP 401 when called without Bearer token.
  - Regression tests added to `scripts/test-auth-security.ts`.

---

## Milestone 2: RBAC Test Harness Repair & `pay_bill` Authorization Tests

- **Objective**: Correct the false-positive 403 test masking flaw in `scripts/test-requests/run-tests.ps1` and add test coverage for `pay_bill`.
- **Tasks**:
  1. Update `services/tenant-resolver/mock-jwt-validator.ts` so `dev-token-guest` carries a valid tenant claim (e.g. `custom:tenant_id: "slt"`).
  2. Verify that `check_balance` called with `dev-token-guest` reaches the tenant router and is rejected by the RBAC policy engine (`INSUFFICIENT_PERMISSIONS`) rather than being rejected at step 1 by the tenant resolver (`TENANT_CLAIM_MISSING`).
  3. Add test payload `scripts/test-requests/pay_bill.json` and add Test 4 to `run-tests.ps1` verifying that `pay_bill` requires `admin` role and rejects non-admin callers.
- **Dependencies**: Milestone 1.
- **Acceptance Criteria**:
  - `run-tests.ps1` asserts specific error reasons (`INSUFFICIENT_PERMISSIONS` vs `TENANT_CLAIM_MISSING`).
  - `pay_bill` test passes with `dev-token-admin` and fails with `dev-token-guest` with HTTP 403.

---

## Milestone 3: Script Compilation & TypeScript Cleanliness

- **Objective**: Ensure that all helper scripts under `scripts/` typecheck cleanly under the project's root `tsconfig.json`.
- **Tasks**:
  1. Audit any type mismatches or missing module declarations across legacy test scripts.
  2. Ensure `npx tsc --noEmit` checks both `services/` and `scripts/` without requiring exclusions.
- **Dependencies**: Milestone 2.
- **Acceptance Criteria**:
  - Full TypeScript typecheck passes across entire repository root with zero errors.

---

## Milestone 4: Company & Agent Domain API Reconciliation

- **Objective**: Reconcile company-specific workspace endpoints in `server.ts` with domain logic in `services/onboarding/` and `services/tenant-router/`.
- **Tasks**:
  1. Add CRUD endpoints for managing tenant specialist agents (`GET/POST /api/company/agents`).
  2. Implement Knowledge Base indexing triggers after S3 document upload (`POST /api/workspace/upload-doc`).
  3. Add conversation history retrieval with tenant filtering (`GET /api/workspace/conversations`).
- **Dependencies**: Milestone 1 & 3.
- **Acceptance Criteria**:
  - Company admins can list and configure specialist agents for their tenant.
  - Uploaded KB documents trigger metadata registration in DynamoDB.

---

## Milestone 5: Supervisor MVP (Python Bedrock Agent) Integration

- **Objective**: Harmonize supervisor Tharusha's Python/AWS SAM MVP with the TypeScript backend.
- **Tasks**:
  1. Evaluate architecture: Decide between a containerized Python FastAPI microservice or native TypeScript Bedrock runtime client (`@aws-sdk/client-bedrock-agent-runtime`).
  2. If Python sidecar is chosen: Configure API Gateway / Express reverse proxy routing `/api/agents/*` to the Python service with `x-tenant-id` injection.
  3. If TypeScript port is chosen: Port LangChain prompt templates and Chroma/OpenSearch vector retrieval into `services/agent-core/`.
- **Dependencies**: Milestone 4, Supervisor architecture sign-off.
- **Acceptance Criteria**:
  - Live customer prompts route to Bedrock agents and return streamed or buffered responses.
  - Knowledge base retrieval respects multi-tenant boundaries.

---

## Milestone 6: Live Contract Alignment with Next.js Frontend

- **Objective**: Validate the backend REST contracts against the Next.js Admin and Live Agent Console.
- **Tasks**:
  1. Start the backend on port 3001 and run the Next.js frontend in development mode.
  2. Verify login, dashboard statistics, company registration submission, approval modal, and live agent chat console.
  3. Resolve any CORS, cookie, or header discrepancies.
- **Dependencies**: Milestone 1 & 4.
- **Acceptance Criteria**:
  - Full end-to-end user journey succeeds: public registration -> superadmin approval -> tenant admin login -> document upload -> live customer chat.

---

## Milestone 7: LocalStack Infrastructure Emulation & Verification

- **Objective**: Validate the full backend stack against LocalStack Community / Pro.
- **Tasks**:
  1. Start LocalStack via `docker-compose up -d`.
  2. Apply Terraform modules (`terraform -chdir=infra apply -auto-approve`).
  3. Run integration tests against real LocalStack DynamoDB, S3, and API Gateway endpoints without in-memory fallbacks.
- **Dependencies**: Milestone 3 & 4.
- **Acceptance Criteria**:
  - Automated tests pass with `LOCALSTACK_HOSTNAME=localhost` without triggering in-memory fallbacks.

---

## Milestone 8: Supervisor Architecture Sign-off & ADR Updates

- **Objective**: Review the reconciled architecture with supervisor Tharusha and record final ADRs.
- **Tasks**:
  1. Present the Cognito multi-tenant identity model, zero-trust tenant resolver, and dual-mode auth architecture.
  2. Finalize ADR-004 formally adopting Cognito over Azure AD for the multi-tenant architecture.
  3. Finalize ADR-005 defining the AI agent execution strategy (Python microservice vs TypeScript native).
- **Dependencies**: Milestone 5 & 7.
- **Acceptance Criteria**:
  - ADR-004 and ADR-005 committed to `docs/decisions.md`.
  - Supervisor sign-off recorded.

---

## Milestone 9: Branch Merges, Worktree Cleanup & Shared Baseline

- **Objective**: Merge the hardened release candidate into `dev` and clean up obsolete temporary recovery worktrees.
- **Tasks**:
  1. Merge the final candidate branch into `origin/dev`.
  2. Validate that team members can pull `origin/dev` and run `npm test` cleanly.
  3. Archive and remove temporary recovery worktrees (`omni-runtime-dev`, `omni-runtime-main`, `omni-runtime-repair`, `omni-runtime-integration`, `omni-runtime-auth`).
- **Dependencies**: Milestones 1 through 8.
- **Acceptance Criteria**:
  - `origin/dev` contains the verified clean baseline.
  - Team development resumes on a single unified workflow.
