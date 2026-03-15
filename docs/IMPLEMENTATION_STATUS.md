# Implementation Status

## Implemented in repo

- Monorepo scaffold (`pnpm` + Turbo + strict TS)
- PostgreSQL schema migration with exact PRD data model
- RLS policy migration and session-context helpers
- API endpoints for webhooks, task deck, leads, messages, calls, team templates/rules, AI, attachments
- Worker jobs for stale detection and task-only rescue automation
- Expo mobile execution UI scaffold
- Next.js Team Lead admin scaffold
- GCP Cloud Run Terraform baseline
- CI workflow for lint/typecheck/test and migration checks

## Remaining integration work (credentials/provider wiring)

- Real Gmail incremental sync and historical backfill API calls
- Real Microsoft Graph incremental sync and historical backfill API calls
- Real provider signature verification and send/call API invocation
- Real Cloud KMS envelope key implementation and Cloud Storage signed URLs
- Production auth provider claim mapping and user provisioning pipeline
