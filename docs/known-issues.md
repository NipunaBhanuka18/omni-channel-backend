# Known Issues & Technical Debt

## Open Issues

*(None currently open)*

## Resolved Issues

- [x] [2026-08-24] RESOLVED: agents/utils/s3-client.ts and agents/utils/dynamo-client.ts endpoint configuration fixed upstream via `LOCALSTACK_HOSTNAME` environment variable resolution (commit d23f62c). Workaround patch in services/tenant-router/lambda-adapter.ts removed (commit e23f6d2).
