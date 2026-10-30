# Contributing to Omni Channel Backend

Thank you for contributing to the Omni Channel Platform. To maintain platform stability, tenant isolation, and clean repository history, all contributors must adhere to these guidelines.

## 1. Branching Strategy

The repository follows a two-tier branch promotion lifecycle:

```text
feature/<feature-name>  -->  dev  -->  main
```

- **Feature Branches (`feature/*`)**: All active development, bug fixes, and feature additions must take place on dedicated branches branched off the latest `dev`.
- **Integration Branch (`dev`)**: The primary integration branch where all feature PRs are merged and regression-tested. **Direct pushes or direct commits to `dev` are strictly forbidden.**
- **Release Branch (`main`)**: The production-ready stable branch. Direct commits and direct feature merges to `main` are strictly forbidden. Only tested releases from `dev` are promoted to `main`.

## 2. Pull Request Guidelines

1. **Pull Requests Required**: Every change must be submitted as a Pull Request targeting `dev`.
2. **Quality Gates**:
   - `npm run build` must pass cleanly without compilation errors.
   - `npm test` must pass 100% of automated test suites.
   - Code must not introduce unhandled tenant isolation bypasses or unauthenticated endpoints.
3. **Review Requirements**:
   - **Shared Contracts (`/shared`)**: Any change to shared types, interfaces, or permissions (`shared/types/`, `shared/constants/`) requires explicit coordination across workstreams.
   - **Infrastructure & Security (`/infra`, `services/tenant-resolver/`, `agents/utils/cognito-client.ts`)**: Changes touching Terraform modules, IAM policies, Cognito configurations, or token resolution require security review.
4. **Clean Artifact Hygiene**:
   - Do **NOT** commit generated deployment artifacts, including `.zip` files, `./dist`, `node_modules`, `*.tfstate`, or local database files.

