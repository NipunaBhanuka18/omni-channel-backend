# Git Workflow & Branching Guidelines

## 1. Branching Strategy
- **Never Push Directly to `main` or `dev`**: All active feature development must occur on dedicated feature branches (`feature/<feature-name>`).
- **Feature Branch Creation**: Always branch off the latest updated `dev` (`git checkout dev && git pull origin dev && git checkout -b feature/<name>`).
- **Pushing Work**: Push commits exclusively to `origin/feature/<name>`.

## 2. Shared Infrastructure Files
- **Additive Configuration**: In shared files like `docker-compose.yml`, `package.json`, and environment configurations, never overwrite or strip services added by teammates. Always maintain a unified superset (e.g., `SERVICES=apigateway,wafv2,secretsmanager,cognito,iam,s3,sqs,dynamodb,events,sts,kms,lambda`).
- **Environment Variables**: Retain mandatory environment variables like `LOCALSTACK_AUTH_TOKEN=${LOCALSTACK_AUTH_TOKEN}` across all edits.

## 3. Pull Request Protocol
- Merge code into `dev` via Pull Requests.
- Test full end-to-end integration before merging feature branches into `dev`.
