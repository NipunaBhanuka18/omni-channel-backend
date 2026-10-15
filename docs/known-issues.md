# Known Issues & Technical Debt

## Open Issues

- [ ] [2026-08-24] OPEN: agents/utils/s3-client.ts and agents/utils/dynamo-client.ts have hardcoded 127.0.0.1:4566 endpoints that break inside Lambda's network-isolated container. Temporary workaround exists in services/tenant-router/lambda-adapter.ts. Owner: Pubudini. Once fixed upstream, remove the workaround patch in lambda-adapter.ts and re-run full test suite to confirm.
