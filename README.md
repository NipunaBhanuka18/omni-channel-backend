# Omni Channel Backend Platform

The Omni Channel Backend Platform is an enterprise multi-tenant customer engagement backend designed for AWS serverless execution with local development supported via LocalStack.

## Architecture & Identity Direction

- **Target Cloud Architecture**: AWS Lambda, API Gateway REST API, DynamoDB partitioned per tenant, S3 tenant-isolated knowledge bases, and Step Functions orchestration.
- **Identity Provider**: **AWS Cognito** is the official Identity Provider for the multi-tenant architecture. User pools enforce multi-tenant isolation through `custom:tenant_id` claims and role-based groups (`admin`, `live_agent`, `staff`).
  *(Note: Early Phase 1 prototypes explored Azure AD under ADR-002; the architecture officially standardized on AWS Cognito under ADR-010).*

## Getting Started

### Prerequisites

- Node.js 20.x
- Docker & Docker Compose (for LocalStack)
- Terraform CLI (>= 1.5.0)

### Installation & Build

Install project dependencies:

```bash
npm ci
```

Compile TypeScript application code to `./dist`:

```bash
npm run build
```

Run typechecking across application code:

```bash
npx tsc --noEmit
```

### Automated Testing

Run the full automated test suite:

```bash
npm test
```

Individual test suites:

- `npm run test:agents`: Main agent intent routing and specialist delegation (`check_balance`, `check_usage`, `troubleshoot_router`).
- `npm run test:tenant-resolver`: Zero-trust JWT verification and `403 TENANT_MISMATCH` spoofing guard.
- `npm run test:tenant-onboarding`: Multi-tenant onboarding pipeline and duplicate slug/name verification.
- `npm run test:onboarding`: Step Functions onboarding pipeline, duplicate name normalization, and rollback.
- `npm run test:router`: DynamoDB-backed router lookups.
- `npm run test:ui-server`: Express mock backend server endpoints.
- `npm run test:member4`: Bedrock AgentCore supervisor adapter, S3 RAG prefix isolation, and hosted chat URL resolver.

### LocalStack & Infrastructure Deployment

1. Start LocalStack:

```bash
docker compose up -d
```

2. Deploy Terraform infrastructure:

```bash
cd infra
terraform init
terraform apply -auto-approve -var-file="terraform.tfvars.example"
```

3. Run live integration & RBAC ingress tests against LocalStack:

```powershell
powershell.exe -ExecutionPolicy Bypass -File .\scripts\test-requests\run-tests.ps1
```

## Branch & Contribution Workflow

Active development follows standard Git branch hygiene:

```text
feature/<feature-name>  -->  dev  -->  main
```

- Direct commits to `dev` and `main` are strictly forbidden.
- All contributions require Pull Requests passing `npm run build` and `npm test`.
- See [CONTRIBUTING.md](CONTRIBUTING.md) for full development rules and review requirements.

## Architecture Decision Records & Tracking

- [Architecture Decision Records (docs/decisions.md)](docs/decisions.md)
- [Known Issues & Technical Debt (docs/known-issues.md)](docs/known-issues.md)

