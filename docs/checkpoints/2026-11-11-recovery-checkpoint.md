# Omni Channel Platform — Recovery Development Checkpoint
**Date**: November 11, 2026  
**Type**: Development Checkpoint (Non-Deployable Development Baseline)  
**Repository**: `omni-channel-backend` (`https://github.com/NipunaBhanuka18/omni-channel-backend.git`)  
**Active Worktree**: `D:\Omni Channel\omni-runtime-auth`  
**Base Integration Commit**: `8f8293bb9905f0e98cf0d25c5d92353abb354f3e`  
**Pushed Checkpoint Branch**: `checkpoint/recovery-2026-11-11`

---

## 1. Reason for Checkpoint
Following Tasks 01 through 07, the Omni Channel Platform backend has reached a stable, tested, and security-reconciled milestone. Implementation is paused at this point to:
1. Safely publish the integrated TypeScript backend baseline to GitHub.
2. Preserve all historical commits, team contributions, and existing Git worktrees.
3. Formally document the exact project state, verified capabilities, known technical debt, and remaining security vulnerabilities before subsequent developer onboarding or supervisor reviews.

> [!WARNING]
> This checkpoint represents an active **DEVELOPMENT CANDIDATE** and is **NOT** a production release or production-ready deployment. Sensitive endpoints identified during Stage 2 security audit require authorization hardening before any live cloud deployment.

---

## 2. Summary of Completed Tasks (Tasks 01–07)

- **Task 01 (Repository State Inspection)**: Performed read-only audit of Git trees, uncommitted changes, and toolchain baselines across remote branches `origin/main` (`dc1ddb6`) and `origin/dev` (`c69c111`).
- **Task 02 (Historical Inventory & Synchronization)**: Reconciled 17 remote branches, mapping all developer contributions across Nipuna, Pubudini, Kawya, and Member 4 since October 2026.
- **Task 03 (Supervisor MVP & Architecture Analysis)**: Analyzed supervisor Tharusha's Python/SAM/FastAPI agent MVP and evaluated Pubudini's migration branch (`feature/customer-agent-unified`).
- **Task 04 (Recovery Baseline Verification)**: Validated `recovery/clean-baseline` at `ffa8bc2`. Confirmed clean TypeScript build and identified test runner import side-effects in `scripts/create-tenants-table.ts`.
- **Task 05 (Test Stability & DB Isolation)**: Repaired test runner isolation in `fix/recovery-test-stability` (`41e7cb8`), eliminating side-effects and ensuring test runs never mutate the real `db.json`. Verified 61/61 tests passing.
- **Task 06 (Registration & Approval Integration)**: Selectively incorporated company registration persistence, normalization, and auto-provisioning from `origin/feature/multi-tenant-ui-integration` (`784dc5a`). Verified 78/78 tests passing across 9 suites.
- **Task 07 (Authentication, Authorization & Security Reconciliation)**: Reconciled authentication architecture from `customer-agent-unified` into `8f8293b`. Fixed a critical tenant-spoofing vulnerability in dev-token handling, secured platform administrative endpoints (`/api/stats`, `/api/notifications`, `/api/registrations/:id`), attached `scrypt` password hashing, implemented rate limiting, and authored a 23-assertion security regression test suite (`test-auth-security.ts`). Verified 101/101 tests passing across 10 suites twice.

---

## 3. Features Integrated into this Baseline

1. **Zero-Trust Tenant Resolver**:
   - `services/tenant-resolver/resolver.ts` extracts `custom:tenant_id` claims from Cognito tokens.
   - Enforces strict validation: missing tenant claims or header/token tenant mismatches immediately fail closed with HTTP 403 `TENANT_MISMATCH`.
2. **Cognito RS256 JWKS Cryptographic Token Verifier**:
   - `services/auth/cognito-jwt-verifier.ts` validates AWS Cognito JWT signatures, issuer (`iss`), client audience (`aud`), `token_use`, and expiration using pure Node.js `node:crypto`.
3. **Local Session Token Service**:
   - `services/auth/local-session-token.ts` issues and verifies HMAC-SHA256 `v1.` session tokens with strict TTL and role boundaries for local development and integration tests.
4. **Multi-Tenant Onboarding Pipeline**:
   - `services/onboarding/onboarding.ts` automates tenant partition initialization, Cognito user group assignment, S3 prefix reservation, and DynamoDB record creation with automatic rollback on failure.
5. **Registration & Approval Workflow**:
   - `services/onboarding/approval-workflow.ts` converts pending inbound registrations into provisioned tenants with one-time credentials, role authorization guards, and idempotency protection.
6. **Dynamic Tenant Router**:
   - `services/tenant-router/router.ts` routes requests based on active DynamoDB tenant partition state (`ACTIVE` vs `SUSPENDED`).
7. **AI Plane B Supervisor & S3 RAG**:
   - `services/agent-core/` delegates customer intents to specialist sub-agents with tenant-partitioned S3 knowledge-base document scoping.
8. **Express UI API Server**:
   - `server.ts` exposes 18 REST endpoints supporting the Super Admin Console, Company Workspace Portal, and Public Hosted Chat Widget.

---

## 4. Build and Test Evidence

| Verification Check | Tool / Command | Exit Code | Observed Evidence |
| :--- | :--- | :--- | :--- |
| **Project Build** | `npm run build` | `0` | Clean compilation via `tsc` to `./dist` |
| **Core Typecheck** | `npx tsc --noEmit` | `0` | Zero compiler diagnostics across all modules |
| **Terraform Validation**| `terraform -chdir=infra validate` | `0` | `Success! The configuration is valid.` |
| **Automated Test Run 1**| `npm test` | `0` | 101/101 assertions passing across 10 suites |
| **Automated Test Run 2**| `npm test` | `0` | 101/101 assertions passing across 10 suites |
| **Database State Check**| `git diff db.json` | `0` | Zero lines added or modified in real `db.json` |

---

## 5. Unresolved Security Issues (Stage 2 Gate Findings)

The following vulnerabilities remain open on the Express server and must be resolved before this backend is deployed:

1. **Unauthenticated Admin Registration (`POST /api/auth/register-admin`)**:
   - *Issue*: Any unauthenticated external HTTP caller can create a new platform `superadmin` user by sending `{ fullName, email, password }`.
   - *Impact*: Complete platform administrative takeover.
   - *Status*: Open. Requires bootstrap authorization guard or one-time initialization secret.
2. **Unauthenticated Agent Presence Controls (`POST /api/agent/presence/online` & `offline`)**:
   - *Issue*: Callers can alter agent availability status in DynamoDB/in-memory state without presenting a Bearer token or validating agent identity.
   - *Impact*: Spoofing agent availability, denial-of-service on live handoff queue.
   - *Status*: Open. Requires `requireAgentOrCompany` middleware.
3. **Unauthenticated Session Resolution (`POST /api/chat/handoff/resolve`)**:
   - *Issue*: Any caller can close any customer session by supplying a `sessionId` and `agentId` without authentication.
   - *Impact*: Unauthorized termination of live customer conversations.
   - *Status*: Open. Requires agent authentication and session-ownership verification.
4. **Plaintext Password Serialization in `register-admin`**:
   - *Issue*: The endpoint response returns the full user record including the plaintext password.
   - *Status*: Open. Must redact credentials before sending response.

---

## 6. Known Test Limitations & Test Harness Deficiencies

1. **LocalStack / AWS Offline Mocks**: Tests execute against offline fallbacks (in-memory maps for DynamoDB and mock buffers for S3). Live AWS or LocalStack runtime behavior has not been validated in this run.
2. **RBAC PowerShell Harness False Positive**: In `scripts/test-requests/run-tests.ps1`, Test 2 tests `check_balance` with `dev-token-guest`. The test passes because `dev-token-guest` lacks a tenant claim (rejected at tenant resolution with 403), masking that the router RBAC permission was never exercised.
3. **Missing `pay_bill` Test Coverage**: `pay_bill` is registered in `permission-map.ts` under `PERMISSIONS.BILLING_PURCHASE`, but no test request payload or execution script exists in `scripts/test-requests/`.

---

## 7. Supervisor MVP & Experimental Branches State

- **Supervisor Python MVP**: The Python/SAM/FastAPI customer-agent MVP provided by Tharusha contains LangChain, ChromaDB vector search, and Bedrock AgentCore logic. These capabilities have not been ported into the TypeScript backend.
- **Unintegrated Branches**:
  - `origin/feature/customer-agent-unified`: Cannot be merged directly via Git due to unrelated history roots. Useful auth and registration logic was manually reconciled; Python agent files remain on that branch.
  - `origin/feature/m3-realtime-live-handoff`: Contains WebSocket and Socket.io experiments that require reconciliation with the HTTP presence endpoints.
  - `origin/feature/multi-tenant-ui-integration`: React frontend components reside in frontend repositories/directories and require contract alignment.

---

## 8. Instructions for Resuming Development Safely

To resume development from this checkpoint without disturbing other team members or worktrees:

```bash
# 1. Clone or navigate to the repository
cd "D:\Omni Channel"

# 2. Fetch the latest checkpoint
git fetch origin checkpoint/recovery-2026-11-11

# 3. Create a new isolated working branch
git checkout -b resume/platform-hardening origin/checkpoint/recovery-2026-11-11

# 4. Install exact dependencies
npm ci

# 5. Verify the baseline health
npm run build
npm test
terraform -chdir=infra validate

# 6. Begin with Milestone 1 from docs/next-steps.md (harden remaining endpoints)
```
