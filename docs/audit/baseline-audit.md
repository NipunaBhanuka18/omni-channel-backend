# Verified Repository Baseline Audit

- **Audit Date**: 2026-10-29
- **Auditor**: Repository Documentation & Project Tracking Lead
- **Baseline Checkpoint**: `origin/dev` at commit `98f8ca1` (2026-08-24 16:01:03 +0530)
- **Current Target Branch Audited**: `origin/dev` at commit `c69c111` (2026-09-16 04:18:18 +0530)
- **Repository Location**: `d:\Omni Channel\omni-channel-backend`

---

## Executive Summary

This audit establishes a verified, evidence-backed baseline of the `omni-channel-backend` repository against the last verified checkpoint at commit `98f8ca1` (2026-08-24). 

Key findings across the codebase:
1. **Critical Branch Divergence & Protocol Breach**: Pull Request #15 merged branch `feature/multi-tenant-isolation-final` directly into `origin/main` without ever merging into `origin/dev`. As a result, `origin/main` is 4 commits ahead of `origin/dev` and contains major architectural decisions (ADR-010 through ADR-017, reverting Azure AD to AWS Cognito, Step Functions onboarding, and DynamoDB-backed routing).
2. **Unverified Merge Plan & Standalone Code**: The proposed merge plan referencing `customer-agent-mvp-source` is an independent Python/AWS SAM prototype. In this repository, `customer-agent-mvp-source/` exists solely on two disconnected/orphan branches (`feature/customer-agent-standalone` and `feature/customer-agent-unified`). Zero Python files, zero SAM `template.yaml` files, and zero frontend directories exist on `origin/dev`.
3. **Build Script Regression**: `npm ci` installs cleanly, but `npm run build` fails immediately with `Missing script: "build"` because the `"build": "tsc"` script was inadvertently removed from `package.json` when adding test runner commands. Running `npx tsc --noEmit` verifies that the TypeScript codebase compiles without syntax or type errors.
4. **LocalStack Status**: LocalStack is currently offline/stopped. In accordance with audit rules, the integration test suite (`scripts/test-requests/run-tests.ps1`) was halted rather than claiming unverified results.
5. **Decisions & Identity Provider Contradiction**: While `origin/dev` still retains documentation stating Azure AD is the IdP (ADR-002), zero Azure AD code is implemented (only a DEV-ONLY mock JWT parser exists). Meanwhile, `origin/main` and branch `customer-agent-unified` formally reversed the decision back to Cognito (ADR-010) and implemented real Cognito SDK integration. Furthermore, commit `89cef12` claimed to add an "ADR-005" in its commit message, but committed no documentation file, colliding conceptually with the preexisting ADR-005.
6. **Resolved Known Issues**: The hardcoded `127.0.0.1:4566` endpoints in `agents/utils/s3-client.ts` and `dynamo-client.ts` were fixed via commit `d23f62c` (`LOCALSTACK_HOSTNAME`), and the temporary workaround in `services/tenant-router/lambda-adapter.ts` was cleaned up via commit `e23f6d2`. However, `docs/known-issues.md` was never updated to reflect this resolution.

---

## PART 1 - Branches and Contributors

### 1.1 Git Fetch & Branch Inventory

Command executed:
```powershell
git fetch --all --prune
git branch -a -v
```

Raw output:
```text
From https://github.com/NipunaBhanuka18/omni-channel-backend
 - [deleted]         (none)     -> origin/feature/multi-tenant-isolation-fix
 - [deleted]         (none)     -> origin/master
 * [new branch]      feature/customer-agent-standalone -> origin/feature/customer-agent-standalone
 * [new branch]      feature/customer-agent-unified -> origin/feature/customer-agent-unified
 + 4f38bf6...db310e9 feature/multi-tenant-isolation -> origin/feature/multi-tenant-isolation  (forced update)
 * [new branch]      feature/multi-tenant-isolation-final -> origin/feature/multi-tenant-isolation-final
 * [new branch]      feature/multi-tenant-ui-integration -> origin/feature/multi-tenant-ui-integration
   46a9c08..dc1ddb6  main       -> origin/main
* dev                                                 c69c111 Merge branch 'dev' of https://github.com/NipunaBhanuka18/omni-channel-backend into dev
  feature/rbac-usage-support-coverage                 e23f6d2 [ahead 6] fix(tenant-router): remove temporary S3 endpoint patch in lambda-adapter.ts
  feature/tenant-middleware                           d01ca66 feat(testing): add automated PowerShell test suite in scripts/test-requests/ and debug logging in lambda-adapter.ts
  main                                                a73ebe0 [behind 61] feat(phase-1): complete Phase 1 infrastructure, Azure AD identity alignment, shared contracts, and LocalStack verification
  remotes/origin/KawyaDissanayaka                     317642e Initial commit
  remotes/origin/dev                                  c69c111 Merge branch 'dev' of https://github.com/NipunaBhanuka18/omni-channel-backend into dev
  remotes/origin/feature/agent-dynamic-slice          9f3acd2 feat: implement dynamic agent registry and check_balance vertical slice
  remotes/origin/feature/conversation-db-localstack   2114088 feat: integrate localstack dynamodb for conversation state
  remotes/origin/feature/customer-agent-standalone    a7c35e6 Initial commit - Customer Agent MVP source
  remotes/origin/feature/customer-agent-unified       b716805 Add offline hashed credential verifier and compatibility tests
  remotes/origin/feature/m3-realtime-live-handoff     10a655e feat(handoff): implement live agent presence and escalation engine
  remotes/origin/feature/multi-tenant-isolation       db310e9 Initial commit from multi-tenant-isolation
  remotes/origin/feature/multi-tenant-isolation-final 0572d3a feat(security): Cognito reactivation, zero-trust tenant resolver, DynamoDB-backed router, and company onboarding pipeline with S3 + duplicate-name checks
  remotes/origin/feature/multi-tenant-ui-integration  4fe4075 test(e2e): record approved Dialog Axiata test tenant in db.json
  remotes/origin/feature/project-setup                5450f46 Merge pull request #8 from NipunaBhanuka18/dev
  remotes/origin/feature/rbac-usage-support-coverage  98f8ca1 docs(known-issues): add tracking entry for upstream hardcoded endpoints in agents/utils/
  remotes/origin/feature/tenant-middleware            d01ca66 feat(testing): add automated PowerShell test suite in scripts/test-requests/ and debug logging in lambda-adapter.ts
  remotes/origin/feature/ui-integration               7b67a94 feat(ui): UI backend API server with live agent and onboarding endpoints
  remotes/origin/feature/usage-agent-and-tools        3159fba Merge remote-tracking branch 'origin/dev' into feature/usage-agent-and-tools
  remotes/origin/main                                 dc1ddb6 Merge pull request #15 from NipunaBhanuka18/feature/multi-tenant-isolation-final
```

### 1.2 Commits Ahead / Behind `origin/dev`

Command executed:
```powershell
git rev-list --left-right --count origin/dev...origin/<branch>
```

| Remote Branch | Behind `origin/dev` (Left) | Ahead of `origin/dev` (Right) | Merge Base Status with `origin/dev` |
| :--- | :---: | :---: | :--- |
| `origin/dev` | 0 | 0 | Base branch |
| `origin/main` | 0 | 4 | Merged PR #15 directly into `main` |
| `origin/KawyaDissanayaka` | 21 | 2 | Branched from early commit `46a9c08` |
| `origin/feature/agent-dynamic-slice` | 52 | 0 | Fully merged into dev |
| `origin/feature/conversation-db-localstack` | 50 | 0 | Fully merged into dev |
| `origin/feature/customer-agent-standalone` | 62 | 1 | **No merge base** (Orphan root commit `a7c35e6`) |
| `origin/feature/customer-agent-unified` | 62 | 29 | **No merge base** (Built on orphan `a7c35e6`) |
| `origin/feature/m3-realtime-live-handoff` | 13 | 0 | Fully merged into dev |
| `origin/feature/multi-tenant-isolation` | 62 | 1 | **No merge base** (Orphan root commit `db310e9`) |
| `origin/feature/multi-tenant-isolation-final` | 0 | 1 | Ahead of dev (Merged into `origin/main`) |
| `origin/feature/multi-tenant-ui-integration` | 0 | 7 | Ahead of dev (Branched off `origin/main`) |
| `origin/feature/project-setup` | 36 | 0 | Fully merged into dev |
| `origin/feature/rbac-usage-support-coverage` | 19 | 0 | Fully merged into dev |
| `origin/feature/tenant-middleware` | 34 | 0 | Fully merged into dev |
| `origin/feature/ui-integration` | 13 | 0 | Fully merged into dev |
| `origin/feature/usage-agent-and-tools` | 17 | 0 | Fully merged into dev |

### 1.3 Contributors and Commit Counts Since Baseline `98f8ca1`

#### Contributors on Baseline (`98f8ca1` and earlier):
- `NipunaBhanuka18 <bhanukakck2018@gmail.com>` / `Nipuna Bhanuka Samarasinghe <bhanukakck2018@gmail.com>` (29 commits)
- `pubudini-rathnayake <pubudini-rathnayake-pubudinithamali@gmail.com>` / `Pubudini Rathnayake <pubudinithamali@gmail.com>` (14 commits)

#### Overall Contributors Since `98f8ca1` across all branches:
Command executed: `git shortlog -sne 98f8ca1..origin/main origin/dev origin/feature/customer-agent-unified origin/feature/customer-agent-standalone origin/feature/multi-tenant-isolation origin/feature/multi-tenant-isolation-final origin/feature/multi-tenant-ui-integration origin/KawyaDissanayaka`
```text
    39  pubudini-rathnayake <pubudini-rathnayake-pubudinithamali@gmail.com>
     7  NipunaBhanuka18 <bhanukakck2018@gmail.com>
     5  Your Name <imesh2017@gmail.com>
     4  Nipuna Bhanuka Samarasinghe <bhanukakck2018@gmail.com>
     1  Imesh Erandaka <142596930+Imesh26@users.noreply.github.com>
     1  Kawya Dissanayaka <dissanayakadank@students.nsbm.ac.lk>
```

#### Contributors on `origin/dev` Since `98f8ca1`:
```text
     7  NipunaBhanuka18 <bhanukakck2018@gmail.com>
     7  pubudini-rathnayake <pubudini-rathnayake-pubudinithamali@gmail.com>
     3  Your Name <imesh2017@gmail.com>
     2  Nipuna Bhanuka Samarasinghe <bhanukakck2018@gmail.com>
```

#### Contributors per Unmerged Branch:
- `origin/KawyaDissanayaka`:
  - 1 Kawya Dissanayaka `<dissanayakadank@students.nsbm.ac.lk>`
  - 1 Nipuna Bhanuka Samarasinghe `<bhanukakck2018@gmail.com>`
- `origin/feature/customer-agent-standalone`:
  - 1 pubudini-rathnayake `<pubudini-rathnayake-pubudinithamali@gmail.com>`
- `origin/feature/customer-agent-unified`:
  - 29 pubudini-rathnayake `<pubudini-rathnayake-pubudinithamali@gmail.com>`
- `origin/feature/multi-tenant-isolation`:
  - 1 Your Name `<imesh2017@gmail.com>`
- `origin/feature/multi-tenant-isolation-final`:
  - 1 Your Name `<imesh2017@gmail.com>` (ahead of dev)
  - Full history since 98f8ca1: NipunaBhanuka18 (7), pubudini-rathnayake (7), Your Name (4), Nipuna Bhanuka Samarasinghe (2)
- `origin/feature/multi-tenant-ui-integration`:
  - 3 pubudini-rathnayake `<pubudini-rathnayake-pubudinithamali@gmail.com>` (ahead of main)
  - 1 Imesh Erandaka (PR #15 merge into main)
  - 1 Your Name (0572d3a)
  - 2 Nipuna Bhanuka Samarasinghe
- `origin/main`:
  - 1 Imesh Erandaka `<142596930+Imesh26@users.noreply.github.com>`
  - 1 Your Name `<imesh2017@gmail.com>`
  - 2 Nipuna Bhanuka Samarasinghe `<bhanukakck2018@gmail.com>`

#### Previously Unseen Authors (Since `98f8ca1`):
1. **Imesh Erandaka** (`Your Name <imesh2017@gmail.com>`, `Imesh Erandaka <142596930+Imesh26@users.noreply.github.com>`)
2. **Kawya Dissanayaka** (`Kawya Dissanayaka <dissanayakadank@students.nsbm.ac.lk>`)

### 1.4 Branch Classification (as of 2026-10-29)

*Stale Threshold*: No commits in 14+ days (prior to 2026-10-15).

| Branch | Classification | Last Commit Date | Notes |
| :--- | :--- | :---: | :--- |
| `origin/dev` | **Active Base** | 2026-09-16 | Primary integration branch |
| `origin/main` | **Unmerged / Stale** | 2026-09-21 | Diverged from `dev`; ahead by 4 commits via direct PR #15 merge |
| `origin/KawyaDissanayaka` | **Unmerged / Stale** | 2026-09-15 | 44 days old; changes superseded by `server.ts` integration on `dev` |
| `origin/feature/customer-agent-standalone` | **Unmerged / Stale** | 2026-10-15 | 14 days old; isolated commit containing Python SAM MVP |
| `origin/feature/customer-agent-unified` | **Unmerged / Real Work** | 2026-10-23 | 6 days old; 29 commits combining Python MVP & TypeScript backend |
| `origin/feature/multi-tenant-isolation` | **Unmerged / Stale** | 2026-09-17 | 42 days old; orphan branch superseded by `-final` |
| `origin/feature/multi-tenant-isolation-final` | **Unmerged to dev / Stale** | 2026-09-21 | 38 days old; merged directly to `main` via PR #15 |
| `origin/feature/multi-tenant-ui-integration` | **Unmerged to dev / Stale** | 2026-09-22 | 37 days old; based on `main` |
| `origin/feature/agent-dynamic-slice` | **Merged** | 2026-08-14 | Commits present in `origin/dev` |
| `origin/feature/conversation-db-localstack` | **Merged** | 2026-08-17 | Commits present in `origin/dev` |
| `origin/feature/m3-realtime-live-handoff` | **Merged** | 2026-09-15 | Merged via PR #12 into `origin/dev` |
| `origin/feature/project-setup` | **Merged** | 2026-08-17 | Merged via PR #8 into `origin/dev` |
| `origin/feature/rbac-usage-support-coverage` | **Merged** | 2026-08-24 | Commits present in `origin/dev` |
| `origin/feature/tenant-middleware` | **Merged** | 2026-08-17 | Commits present in `origin/dev` |
| `origin/feature/ui-integration` | **Merged** | 2026-09-15 | Merged into `origin/dev` in commit `2b1070d` |
| `origin/feature/usage-agent-and-tools` | **Merged** | 2026-08-25 | Merged via PR #11 into `origin/dev` |

---

## PART 2 - Work That Exists Only on Unmerged Branches

### 2.1 Branch: `origin/KawyaDissanayaka`
- **Author**: Kawya Dissanayaka `<dissanayakadank@students.nsbm.ac.lk>`
- **Last Commit Date**: 2026-09-15 15:31:44 +0530 (Commit: `317642e`)
- **Status vs `origin/dev`**: 21 behind, 2 ahead

#### Changed Files & One-Line Purposes:
- `agents/utils/dynamo-client.ts`: Adds environment-aware endpoint handling for DynamoDB.
- `agents/utils/s3-client.ts`: Adds environment-aware endpoint handling for S3.
- `db.json`: Adds mock registration entries for Hemas Holdings and Ansell.
- `docs/decisions.md`: Updates architectural decision records.
- `docs/known-issues.md`: Tracks known issues.
- `docs/team_task_distribution.md`: Adds 4-member rapid execution guide.
- `infra/lambda/tenant_router.zip`: Pre-packaged lambda binary.
- `package-lock.json`: Dependency tree lock updates.
- `package.json`: Adds express, cors, and start script.
- `scripts/test-requests/*.json`: Test fixtures for usage and troubleshoot routes.
- `scripts/test-requests/run-tests.ps1`: Automated PowerShell test harness.
- `server.ts`: Initial Express mock server implementation.
- `services/tenant-resolver/mock-jwt-validator.ts`: JWT claim parser.
- `services/tenant-router/lambda-adapter.ts`: Lambda adapter for tenant router.
- `services/tenant-router/permission-map.ts`: Route permission mappings.
- `services/tenant-router/router.ts`: Router integration.

#### Actual Diff on Shared Surfaces:
```diff
diff --git a/infra/lambda/tenant_router.zip b/infra/lambda/tenant_router.zip
index 4d3e441..a8eaa99 100644
Binary files a/infra/lambda/tenant_router.zip and b/infra/lambda/tenant_router.zip differ
diff --git a/package.json b/package.json
index 724bd20..70230e7 100644
--- a/package.json
+++ b/package.json
@@ -6,6 +6,7 @@
     "doc": "docs"
   },
   "scripts": {
+    "start": "npx tsx server.ts",
     "build": "tsc",
     "test": "echo \"Error: no test specified\" && exit 1"
   },
@@ -24,10 +25,14 @@
   "dependencies": {
     "@aws-sdk/client-dynamodb": "^3.1108.0",
     "@aws-sdk/client-s3": "^3.1113.0",
-    "@aws-sdk/lib-dynamodb": "^3.1108.0"
+    "@aws-sdk/lib-dynamodb": "^3.1108.0",
+    "cors": "^2.8.5",
+    "express": "^4.19.2"
   },
   "devDependencies": {
     "@types/aws-lambda": "^8.10.162",
+    "@types/cors": "^2.8.17",
+    "@types/express": "^4.17.21",
     "@types/node": "^26.2.0",
     "ts-node": "^10.9.2",
     "tsx": "^4.23.12",
```

---

### 2.2 Branch: `origin/feature/customer-agent-standalone`
- **Author**: pubudini-rathnayake `<pubudini-rathnayake-pubudinithamali@gmail.com>`
- **Last Commit Date**: 2026-10-15 21:24:38 +0530 (Commit: `a7c35e6`)
- **Status vs `origin/dev`**: Orphan root commit (No merge base with `dev`). Contains exactly 33 files, all located within the `customer-agent-mvp-source/` directory.

#### Changed Files & One-Line Purposes:
- `customer-agent-mvp-source/README.md`: Documentation for Python SAM Customer Agent MVP.
- `customer-agent-mvp-source/infrastructure/template.yaml`: AWS SAM template provisioning API Gateway, Cognito, DynamoDB, Bedrock, and Lambdas.
- `customer-agent-mvp-source/backend/src/*.py` (12 files): Python Lambda handlers and services (`admin_handler`, `handler`, `live_handler`, `onboarding_handler`, `orchestrator`, `bedrock_service`, `repository`, `security`, `tool_executor`).
- `customer-agent-mvp-source/backend/tests/test_orchestrator.py`: Python unit tests.
- `customer-agent-mvp-source/frontend/*` (15 files): Static UI web pages and client JS (`admin.html`, `agent-console.html`, `chat.html`, `index.html`, `register.html`, `auth.js`, etc.).
- `customer-agent-mvp-source/scripts/*.py`: Demo agent seeding and admin creation scripts.

#### Actual Diff on Shared Surfaces:
None. Does not touch `/shared`, `/infra`, `docker-compose.yml`, `package.json`, or `.agents/rules/`.

---

### 2.3 Branch: `origin/feature/multi-tenant-isolation-final` and `origin/main`
- **Author**: Your Name `<imesh2017@gmail.com>` / Imesh Erandaka
- **Last Commit Date**: 2026-09-21 11:50:33 +0530 (Commit: `0572d3a`); merged to `main` via PR #15 (`dc1ddb6`)
- **Status vs `origin/dev`**: 1 commit ahead of `origin/dev` (0 behind)

#### Changed Files & One-Line Purposes:
- `agents/registry.ts`: Registry mapping updates for dynamic agent routing.
- `agents/utils/cognito-client.ts`: AWS SDK Cognito Identity Provider client helper.
- `docs/decisions.md`: Documents ADR-010 through ADR-017.
- `infra/api-gateway/main.tf`, `outputs.tf`: Provisions `POST /tenants/register` endpoint on API Gateway.
- `infra/cognito/main.tf`: Re-enables Cognito user pool with `custom:tenant_id` and user groups.
- `infra/lambda/main.tf`, `outputs.tf`, `variables.tf`: Lambda definitions for onboarding.
- `infra/main.tf`, `outputs.tf`: Re-activates `module "cognito"` in root Terraform configuration.
- `infra/step-functions/main.tf`, `outputs.tf`, `variables.tf`: Provisions Step Functions company onboarding pipeline.
- `package.json`, `package-lock.json`: Adds `@aws-sdk/client-cognito-identity-provider`; strips out test runner scripts.
- `scripts/create-tenants-table.ts`: Schema definition for partitioned DynamoDB tables.
- `scripts/test-onboarding.ts`: Tests the Step Functions onboarding flow.
- `scripts/test-router.ts`: Tests DynamoDB-backed router lookups.
- `scripts/test-tenant-resolver.ts`: Tests zero-trust tenant resolution.
- `services/onboarding/handler.ts`, `lambda-adapter.ts`, `onboarding.ts`: Implementation of multi-step onboarding logic.
- `services/tenant-resolver/mock-jwt-validator.ts`, `resolver.ts`: Zero-trust JWT verification and claim extraction.
- `services/tenant-router/handler.ts`, `router.ts`: Migrates router to DynamoDB tenant lookup.
- `shared/types/onboarding.ts`: TypeScript contracts for `OnboardingRequest` and `OnboardingResult`.
- `shared/types/tenant-context.ts`: Adds `live_agent` to allowed roles.
- `shared/utils/tenant-name.ts`: Helper for case/spacing-insensitive company name normalization.
- `tsconfig.json`: TypeScript configuration update.

#### Actual Diff on Shared Surfaces:
```diff
diff --git a/infra/main.tf b/infra/main.tf
index 585fa2f..ee6b683 100644
--- a/infra/main.tf
+++ b/infra/main.tf
@@ -37,13 +37,10 @@ module "secrets" {
 }
 
-# DEPRECATED: Cognito Identity Module
-# Retained for reference only in ./cognito/, not included in active root module.
-# module "cognito" {
-#   source      = "./cognito"
-#   environment = var.environment
-# }
+module "cognito" {
+  source      = "./cognito"
+  environment = var.environment
+}
diff --git a/package.json b/package.json
index c5ff0c2..9b5c96e 100644
--- a/package.json
+++ b/package.json
@@ -6,13 +6,8 @@
     "doc": "docs"
   },
   "scripts": {
-    "start": "npx tsx server.ts",
-    "test": "tsx ./scripts/test-all.ts && tsx ./scripts/test-tenant-resolver.ts && tsx ./scripts/test-tenant-onboarding.ts && tsx ./scripts/test-ui-api-server.ts && tsx ./scripts/test-member4-ai-engine.ts",
-    "test:agents": "tsx ./scripts/test-all.ts",
-    "test:tenant-resolver": "tsx ./scripts/test-tenant-resolver.ts",
-    "test:tenant-onboarding": "tsx ./scripts/test-tenant-onboarding.ts",
-    "test:ui-server": "tsx ./scripts/test-ui-api-server.ts",
-    "test:member4": "tsx ./scripts/test-member4-ai-engine.ts"
+    "build": "tsc",
+    "test": "echo \"Error: no test specified\" && exit 1"
   },
   "repository": {
     "type": "git",
@@ -27,6 +22,7 @@
   "homepage": "https://github.com/NipunaBhanuka18/omni-channel-backend#readme",
   "description": "",
   "dependencies": {
+    "@aws-sdk/client-cognito-identity-provider": "^3.1136.0",
     "@aws-sdk/client-dynamodb": "^3.1108.0",
     "@aws-sdk/client-s3": "^3.1113.0",
     "@aws-sdk/lib-dynamodb": "^3.1108.0",
diff --git a/shared/types/onboarding.ts b/shared/types/onboarding.ts
new file mode 100644
index 0000000..f7368a5
--- /dev/null
+++ b/shared/types/onboarding.ts
@@ -0,0 +1,24 @@
+export interface OnboardingRequest {
+  companyName: string;
+  tenantId: string;
+  adminEmail: string;
+  allowedChannels?: ("web" | "whatsapp" | "sms" | "messenger")[];
+}
+
+export interface OnboardingResult {
+  tenantId: string;
+  companyName: string;
+  adminUsername: string;
+  temporaryPassword: string;
+  kbPrefix: string;
+  status: "provisioned";
+  createdAt: string;
+}
diff --git a/shared/types/tenant-context.ts b/shared/types/tenant-context.ts
index 01ce5fa..ffc9208 100644
--- a/shared/types/tenant-context.ts
+++ b/shared/types/tenant-context.ts
@@ -1,7 +1,7 @@
 export interface TenantContext {
   tenantId: string;
   userId: string;
-  role: "staff" | "admin";
+  role: "staff" | "admin" | "live_agent";
   permissions: string[];
   channel: "web" | "whatsapp" | "sms" | "messenger";
   sessionId: string;
diff --git a/shared/utils/tenant-name.ts b/shared/utils/tenant-name.ts
new file mode 100644
index 0000000..db7ab69
--- /dev/null
+++ b/shared/utils/tenant-name.ts
@@ -0,0 +1,13 @@
+export function normalizeCompanyName(companyName: string): string {
+  return companyName.trim().toLowerCase().replace(/\s+/g, " ");
+}
```

---

### 2.4 Branch: `origin/feature/multi-tenant-ui-integration`
- **Author**: pubudini-rathnayake `<pubudini-rathnayake-pubudinithamali@gmail.com>`
- **Last Commit Date**: 2026-09-22 13:03:50 +0530 (Commit: `4fe4075`)
- **Status vs `origin/dev`**: Branched off `origin/main` after PR #15; 7 commits ahead of `origin/dev`.
- **Purpose**: Restores the `package.json` test and start scripts that were deleted in PR #15, adds company approval routes (`PATCH /api/v1/companies/:id/status`) and normalizers in `server.ts`, and adds Dialog Axiata demo records in `db.json`.

---

### 2.5 Branch: `origin/feature/customer-agent-unified`
- **Author**: pubudini-rathnayake `<pubudini-rathnayake-pubudinithamali@gmail.com>`
- **Last Commit Date**: 2026-10-23 23:01:15 +0530 (Commit: `b716805`)
- **Status vs `origin/dev`**: Orphan root tree; 29 commits ahead of `dev`.
- **Scope**: Copies the TypeScript backend into the Python MVP repository, expands `server.ts` to 1,436 lines, implements offline scrypt password hashing and credential verifiers, and deletes `.agents/rules/git-workflow.md`.

#### Actual Diff on `.agents/rules/`:
```diff
diff --git a/.agents/rules/git-workflow.md b/.agents/rules/git-workflow.md
deleted file mode 100644
index 00d034e..0000000
--- a/.agents/rules/git-workflow.md
+++ /dev/null
@@ -1,14 +0,0 @@
-# Git Workflow & Branching Guidelines
-
-## 1. Branching Strategy
-- **Never Push Directly to `main` or `dev`**: All active feature development must occur on dedicated feature branches (`feature/<feature-name>`).
-- **Feature Branch Creation**: Always branch off the latest updated `dev` (`git checkout dev && git pull origin dev && git checkout -b feature/<name>`).
-- **Pushing Work**: Push commits exclusively to `origin/feature/<name>`.
-
-## 2. Shared Infrastructure Files
-- **Additive Configuration**: In shared files like `docker-compose.yml`, `package.json`, and environment configurations, never overwrite or strip services added by teammates. Always maintain a unified superset.
-- **Environment Variables**: Retain mandatory environment variables like `LOCALSTACK_AUTH_TOKEN=${LOCALSTACK_AUTH_TOKEN}` across all edits.
-
-## 3. Pull Request Protocol
-- Merge code into `dev` via Pull Requests.
-- Test full end-to-end integration before merging feature branches into `dev`.
```

---

## PART 3 - Verify the Merge Plan's Claims

### 3.1 Verification Matrix for Paths Named in Merge Plan / README

| Path Named in Plan | Exists on `dev`? | Exists on Other Branch? | Status / Findings |
| :--- | :---: | :---: | :--- |
| `services/handoff/` | **YES** | `main`, `customer-agent-unified`, `multi-tenant-isolation-final` | Merged into `dev` via commit `2b1070d` (`handler.ts`, `presence-manager.ts`, `escalation-engine.ts`) |
| `services/onboarding/` | **YES** | `main`, `customer-agent-unified`, `multi-tenant-isolation-final` | Partial on `dev`: `register-tenant.ts` exists on `dev`. `handler.ts` & `onboarding.ts` exist on `main` |
| `services/tenant-onboarding/` | **YES** | `main`, `customer-agent-unified`, `multi-tenant-isolation-final` | Exists on `dev` (`services/tenant-onboarding/handler.ts` merged via commit `ec2f30b`) |
| `agents/main-agent/bedrock-adapter.ts` | **YES** | `main`, `customer-agent-unified`, `multi-tenant-isolation-final` | Exists on `dev` (Added in commit `3518033`) |
| `server.ts` | **YES** | `main`, `KawyaDissanayaka`, `customer-agent-unified`, `multi-tenant-ui-integration` | Exists on `dev` (Added in commit `2b1070d`, 451 lines) |
| `frontend/` | **NO** | `customer-agent-standalone`, `customer-agent-unified` | **Does not exist** at root of `dev` or any branch. Only exists inside `customer-agent-mvp-source/frontend/` |
| `customer-agent-mvp-source/` | **NO** | `customer-agent-standalone`, `customer-agent-unified` | Only exists on the two unmerged orphan branches |
| `customer-agent-mvp-source/frontend/` | **NO** | `customer-agent-standalone`, `customer-agent-unified` | Exists only within the Python MVP folder |
| `customer-agent-mvp-source/backend/` | **NO** | `customer-agent-standalone`, `customer-agent-unified` | Exists only within the Python MVP folder |
| `template.yaml` (root) | **NO** | None | **Not found anywhere at repo root**. Exists as `customer-agent-mvp-source/infrastructure/template.yaml` |

### 3.2 Top-Level Directory Inventory on `origin/dev`

| Directory on `dev` | Existed at `98f8ca1`? | Notes |
| :--- | :---: | :--- |
| `.agents/` | **YES** | Identical tree blob (`dd879a116b9cab0e...`) |
| `agents/` | **YES** | Tree modified (added `bedrock-adapter.ts`, updated `s3-client.ts`, `dynamo-client.ts`) |
| `docs/` | **YES** | Tree modified (added `team_task_distribution.md`) |
| `infra/` | **YES** | Tree modified |
| `scripts/` | **YES** | Tree modified (added test runners and table creation scripts) |
| `services/` | **YES** | Tree modified (added `handoff/`, `onboarding/`, `tenant-onboarding/`) |
| `shared/` | **YES** | Tree identical (`4dd187f1e62b60d8...`) |

*Top-level files added to `dev` since `98f8ca1`*:
- `db.json` (New mock database added in commit `2b1070d`)
- `server.ts` (New Express server added in commit `2b1070d`)

### 3.3 Presence of Python Code, `template.yaml`, and Frontend
- **Python Code**: **Zero** Python files exist on `origin/dev`. Python files exist exclusively under `customer-agent-mvp-source/` on branches `feature/customer-agent-standalone` and `feature/customer-agent-unified`.
- **`template.yaml`**: **Zero** SAM `template.yaml` files exist on `origin/dev`. It exists solely at `customer-agent-mvp-source/infrastructure/template.yaml` on the two orphan branches.
- **`frontend/`**: **Zero** frontend folders exist on `origin/dev`. The frontend referenced in the plan exists as static HTML/JS inside `customer-agent-mvp-source/frontend/` on the orphan branches, while the production React frontend lives in a completely separate workspace repository (`omni-agent-ui`).
- **Conclusion**: `customer-agent-mvp-source` is an external codebase imported as orphan branches; its merge plan claims do not describe the real architecture on `origin/dev`.

---

## PART 4 - Build and Regression

### 4.1 Build Verification

#### Command 1: `npm ci`
- **Exit Code**: 0
- **Raw Output**:
```text
added 141 packages, and audited 142 packages in 14s

17 packages are looking for funding
  run `npm fund` for details

2 vulnerabilities (1 moderate, 1 high)
```

#### Command 2: `npm run build`
- **Exit Code**: 1 (FAILED)
- **Raw Output**:
```text
npm error Missing script: "build"
npm error 
npm error To see a list of scripts, run:
npm error   npm run
```

#### TypeScript Direct Verification: `npx tsc --noEmit`
- **Exit Code**: 0 (Clean compile)
- **Analysis**: The TypeScript code compiles without errors. The failure of `npm run build` is a configuration regression in `package.json` where `"build": "tsc"` was accidentally removed when `scripts` was edited in `dev`.

### 4.2 LocalStack Execution & Integration Suite
- **Health Check Command**:
```powershell
docker ps
Invoke-RestMethod -Uri "http://127.0.0.1:4566/_localstack/health"
```
- **Result**:
```text
CONTAINER ID   IMAGE     COMMAND   CREATED   STATUS    PORTS     NAMES
LocalStack health check failed: Unable to connect to the remote server
```
- **Status**: **LocalStack is NOT running.**
- **Action**: Per strict instructions, `scripts/test-requests/run-tests.ps1` was **not executed** and no test results are claimed.

### 4.3 New Test Scripts Added Since `98f8ca1`

| Script Name | Scope / Intent / Feature Covered |
| :--- | :--- |
| `scripts/test-all.ts` | Combined test runner covering `check_balance`, `check_usage`, and `troubleshoot_router` |
| `scripts/test-live-agent-handoff.ts` | Human live-agent handoff lifecycle: presence heartbeats, escalation queueing, and resolution |
| `scripts/test-member4-ai-engine.ts` | Bedrock AgentCore Supervisor adapter, S3 RAG tenant path isolation, and hosted chat URL resolver |
| `scripts/test-onboarding.ts` | AWS Step Functions company onboarding workflow execution |
| `scripts/test-tenant-onboarding.ts` | Multi-tenant onboarding pipeline and duplicate slug/name verification |
| `scripts/test-tenant-resolver.ts` | Zero-trust tenant resolver: JWT claim extraction, rejecting header spoofing (`403 TENANT_MISMATCH`) |
| `scripts/test-ui-api-server.ts` | Express API server route validation (`server.ts` endpoints) |
| `scripts/create-handoff-resources.ts` | Setup script provisioning handoff DynamoDB tables and SQS escalation queue |
| `scripts/create-tenant-tables.ts` | Setup script provisioning tenant management tables |
| `scripts/create-tenants-table.ts` | Setup script provisioning `omni-channel-tenants`, `agents`, `tools` tables with GSIs |

---

## PART 5 - Decisions and Contradictions

### 5.1 Architecture Decision Records (ADRs)

| ADR # | Title | Date | File Location & Branch |
| :---: | :--- | :---: | :--- |
| **ADR-001** | Phase 1 Ingress, Identity, and Secrets Scaffolding | 2026-08-07 | `docs/decisions.md` (`dev`, `main`) |
| **ADR-002** | Identity Provider Correction — Cognito to Azure AD | 2026-08-07 | `docs/decisions.md` (`dev`, `main`) |
| **ADR-003** | Shared Contract Refinement — conversationId and structured error object | 2026-08-07 | `docs/decisions.md` (`dev`, `main`) |
| **ADR-004** | Phase 1 Infrastructure Sign-Off & LocalStack Validation | 2026-08-08 | `docs/decisions.md` (`dev`, `main`) |
| **ADR-005** | Phase 3 Tenant Resolver & Tenant Runtime Router Scaffolding | 2026-08-13 | `docs/decisions.md` (`dev`, `main`) |
| **ADR-006** | Ingress Correction — API Gateway Transition from MOCK to Live Lambda Proxy Integration | 2026-08-15 | `docs/decisions.md` (`dev`, `main`) |
| **ADR-007** | Multi-Developer Environment Alignment & `docker-compose.yml` Service Specification | 2026-08-17 | `docs/decisions.md` (`dev`, `main`) |
| **ADR-008** | Role-Based Access Control (RBAC) Permission Enforcement at Ingress Router Layer | 2026-08-17 | `docs/decisions.md` (`dev`, `main`) |
| **ADR-009** | RBAC Permission Map Extension for Usage and Support Specialists | 2026-08-21 | `docs/decisions.md` (`dev`, `main`) |
| **ADR-010** | Identity Provider Reversal — Azure AD back to Cognito | 2026-09-16 | `docs/decisions.md` (`origin/main` only) |
| **ADR-011** | Zero-Trust Tenant Resolution (Spoofing Guard) | 2026-09-16 | `docs/decisions.md` (`origin/main` only) |
| **ADR-012** | DynamoDB Tenant Partitioning Tables & Seed Data | 2026-09-16 | `docs/decisions.md` (`origin/main` only) |
| **ADR-013** | Company Onboarding Pipeline (Step Functions / Lambda) | 2026-09-16 | `docs/decisions.md` (`origin/main` only) |
| **ADR-014** | `router.ts` Migrated to DynamoDB-Backed Tenant Lookup | 2026-09-16 | `docs/decisions.md` (`origin/main` only) |
| **ADR-015** | Onboarding Response Completeness — S3 Prefix & Temporary Credentials | 2026-09-17 | `docs/decisions.md` (`origin/main` only) |
| **ADR-016** | Case/Spacing-Insensitive Company Name Duplicate Check | 2026-09-18 | `docs/decisions.md` (`origin/main` only) |
| **ADR-017** | Onboarding S3 Prefix Aligned to Member 4's Real KB Key Convention | 2026-09-20 | `docs/decisions.md` (`origin/main` only) |

#### Investigation of Commit `89cef12` ("ADR-005"):
- **Author**: pubudini-rathnayake (2026-08-21 11:17:58 +0530)
- **Commit Message**: `docs: add ADR-005, update plan, and add combined test suite`
- **Actual Diff**: Touched **only** `scripts/test-all.ts` (+55 lines). Zero markdown files were committed.
- **Collision Finding**: Pubudini's commit message referred to an "ADR-005" for the combined test runner, but never committed it to `docs/decisions.md`. The actual ADR-005 in `docs/decisions.md` is Nipuna's "Phase 3 Tenant Resolver & Tenant Runtime Router Scaffolding" dated 2026-08-13.

### 5.2 Identity Provider Contradiction: Cognito vs. Azure AD
- **Azure AD Status**: Mentioned prominently in `origin/dev` docs (`docs/decisions.md` ADR-002, `infra/azure-ad/README.md`) and API Gateway mock configurations. However, **zero real Azure AD authentication code is implemented**. The repo contains only a dev-only mock JWT validator (`mock-jwt-validator.ts`).
- **Cognito Status**: In `origin/dev`, `infra/main.tf` has the Cognito module commented out. However, `origin/main` and branch `customer-agent-unified` formally reversed the decision (ADR-010), re-enabled `infra/cognito/main.tf`, implemented `@aws-sdk/client-cognito-identity-provider` in `agents/utils/cognito-client.ts`, and implemented Cognito admin creation in `services/onboarding/onboarding.ts`.
- **Verdict**: Azure AD is **docs-only**. AWS Cognito is **implemented in active infrastructure and onboarding code** on `origin/main`.

### 5.3 Technical Debt Verification
1. **Hardcoded `127.0.0.1:4566` in S3 and DynamoDB clients**:
   - **FIXED**: In `agents/utils/s3-client.ts` and `agents/utils/dynamo-client.ts`, commit `d23f62c` introduced dynamic resolution:
     ```ts
     const localstackEndpoint = process.env.LOCALSTACK_HOSTNAME
       ? `http://${process.env.LOCALSTACK_HOSTNAME}:4566`
       : "http://127.0.0.1:4566";
     ```
2. **Temporary patch in `services/tenant-router/lambda-adapter.ts`**:
   - **REMOVED**: In commit `e23f6d2`, the temporary S3 endpoint patch was completely removed from `lambda-adapter.ts`.
3. **Current State of `docs/known-issues.md`**:
   - **OUT OF DATE**: The file still displays the issue as open:
     ```markdown
     # Known Issues & Technical Debt

     ## Open Issues

     - [ ] [2026-08-24] OPEN: agents/utils/s3-client.ts and agents/utils/dynamo-client.ts have hardcoded 127.0.0.1:4566 endpoints that break inside Lambda's network-isolated container. Temporary workaround exists in services/tenant-router/lambda-adapter.ts. Owner: Pubudini. Once fixed upstream, remove the workaround patch in lambda-adapter.ts and re-run full test suite to confirm.
     ```
   - The code fix was never marked as resolved in the documentation.

---

## PART 6 - Direction Signals (Code Reality)

Reporting strictly what is implemented in code:

| Component | Status in Code | Verified Location / Evidence |
| :--- | :---: | :--- |
| **Multi-Tenant Company Onboarding** | **IMPLEMENTED** | `services/tenant-onboarding/handler.ts` (dev), `services/onboarding/register-tenant.ts` (dev), `services/onboarding/onboarding.ts` (main), `infra/step-functions/tenant-onboarding.asl.json` |
| **Live-Agent / Handoff Services** | **IMPLEMENTED** | `services/handoff/handler.ts`, `presence-manager.ts` (online/offline tracking), `escalation-engine.ts` (queue management), `scripts/create-handoff-resources.ts` |
| **Admin Console** | **NOT IN BACKEND CODE** | No web interface exists on `dev`. Routes exist in `server.ts` to support an admin console. Static HTML exists in `customer-agent-mvp-source/frontend/admin.html` on orphan branches; full React console lives in `omni-agent-ui` |
| **Public Customer Chat** | **BACKEND ONLY** | Hosted chat URL resolver exists in `agents/main-agent/bedrock-adapter.ts` (`/chat/:company/:agent`). No frontend chat UI exists on `dev` |
| **Cognito Code** | **IMPLEMENTED** | Step Functions integration on `dev`; `@aws-sdk/client-cognito-identity-provider` in `agents/utils/cognito-client.ts` on `main` and `unified` |
| **SAM / `template.yaml`** | **ORPHAN BRANCH ONLY** | Does not exist on `dev`. Exists only at `customer-agent-mvp-source/infrastructure/template.yaml` |
| **Python Files** | **ORPHAN BRANCH ONLY** | 0 files on `dev`. 12 backend handlers, tests, and scripts exist under `customer-agent-mvp-source/` on orphan branches |
| **Express Server** | **IMPLEMENTED** | `server.ts` on `dev` (451 lines, Express 4.22.3, port 3001, routes for onboarding, presence, handoff, and mock DB) |

---

## PART 7 - Documentation and Tracking Inventory

| Standard Tracking Asset | Status | Current Repo Location / Notes |
| :--- | :---: | :--- |
| **`docs/` Tree** | **PRESENT** | `docs/decisions.md`, `docs/known-issues.md`, `docs/team_task_distribution.md`, `docs/.gitkeep` |
| **Root `README.md`** | **MISSING** | Missing from repo root on `dev` and all branches. (Only `infra/azure-ad/README.md` and `customer-agent-mvp-source/README.md` exist) |
| **Roadmap / Plan File** | **PRESENT** | `docs/team_task_distribution.md` inside repo; Word/PDF plans exist in parent directory |
| **`CONTRIBUTING.md`** | **MISSING** | Not present |
| **Pull Request Template** | **MISSING** | `.github/pull_request_template.md` does not exist |
| **`CODEOWNERS`** | **MISSING** | `.github/CODEOWNERS` does not exist |
| **Issue Templates** | **MISSING** | `.github/ISSUE_TEMPLATE/` does not exist |
| **`.github/workflows` (CI/CD)**| **MISSING** | No GitHub Actions workflows exist |

---

## PART 8 - Merge Readiness

### 8.1 Branch Readiness Matrix

| Remote Branch | Status | Why / Recommendation |
| :--- | :---: | :--- |
| `origin/main` | **BLOCKED / NEEDS COORDINATION** | Diverged from `dev`. Contains PR #15 merge (`0572d3a`) which re-enables Cognito, adds ADR-010..017, but removed `start` and `test` scripts from `package.json`. Must be reconciled with `dev` under team coordination. |
| `origin/feature/multi-tenant-isolation-final` | **SUPERSEDED** | Merged into `origin/main` via PR #15. Should not be merged into `dev` directly. |
| `origin/feature/multi-tenant-ui-integration` | **NEEDS REVIEW** | Branched off `main`, not `dev`. Restores test/start scripts in `package.json` and enhances `server.ts` with company approval routes. Needs cherry-picking/review after `dev` and `main` align. |
| `origin/feature/customer-agent-unified` | **BLOCKED** | Disjoint history (no merge base). Overwrites `server.ts`, deletes git workflow rules, adds Python SAM tree, and introduces offline mock credential hashing bypassing cloud auth. |
| `origin/feature/customer-agent-standalone` | **BLOCKED / ARCHIVE** | Disjoint history. Isolated dump of Python SAM prototype. Should remain an external reference, not merged. |
| `origin/KawyaDissanayaka` | **SUPERSEDED / STALE** | 44 days old. Branch changes to `server.ts` and `package.json` were already incorporated into `dev` in commit `2b1070d`. Can be safely archived/deleted. |
| `origin/feature/multi-tenant-isolation` | **SUPERSEDED / STALE** | 42 days old orphan branch. Fully superseded by `multi-tenant-isolation-final`. Can be safely deleted. |

### 8.2 Branches Touching Shared Surfaces

The following branches modify shared infrastructure, shared types, or project manifests and require strict coordination:
1. `origin/main`: Touches `shared/types/tenant-context.ts`, `shared/types/onboarding.ts`, `shared/utils/tenant-name.ts`, `infra/`, and `package.json`.
2. `origin/feature/multi-tenant-isolation-final`: Touches identical shared surfaces as `main`.
3. `origin/feature/multi-tenant-ui-integration`: Touches `shared/`, `infra/`, `package.json`, `server.ts`, and `db.json`.
4. `origin/feature/customer-agent-unified`: Touches `shared/`, `infra/`, `package.json`, `server.ts`, and deletes `.agents/rules/git-workflow.md`.
5. `origin/KawyaDissanayaka`: Touches `package.json` and `infra/lambda/tenant_router.zip`.
6. `origin/feature/multi-tenant-isolation`: Touches `shared/`, `infra/`, and `package.json`.

---

## PART 9 - Branch & Audit Artifact Verification

- **Branch Created**: `docs/baseline-audit` (branched off `origin/dev` at commit `c69c111`)
- **Report Location**: `docs/audit/baseline-audit.md`
- **Scope of Commit**: Only `docs/audit/baseline-audit.md` is staged and committed. Zero other files modified or merged.
