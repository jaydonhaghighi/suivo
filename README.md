# Suivo

Monorepo for Suivo, a privacy-first real estate execution platform.

## Stack

- Backend: NestJS (`apps/api`) + NestJS worker (`apps/worker`)
- Frontend: Expo React Native (`apps/mobile`) + Next.js (`apps/web-admin`)
- Data: PostgreSQL + Redis (`packages/db` migrations + RLS)
- Infra: Terraform for GCP Cloud Run baseline (`infra/gcp`)

## Repository Layout

```text
apps/
  api/
  worker/
  mobile/
  web-admin/
packages/
  db/
  shared-types/
  config/
infra/
  gcp/
docs/
  adr/
  api/
```

## Zero-Drift Dev Workflow

### One-time bootstrap

```bash
pnpm setup
```

`pnpm setup` performs:

1. tool checks (`node`, `pnpm`, `docker`, `gcloud`)
2. `pnpm gcp:check`
3. `pnpm env:pull`
4. `pnpm env:check`
5. `pnpm db:doctor`
6. `pnpm infra:up`

### Daily workflow

```bash
pnpm env:pull
pnpm db:doctor
pnpm dev
```

`pnpm dev` runs:

1. DB drift check (`db:doctor`)
2. backend infra boot (`cloud-sql-proxy`, `redis`, `api`, `worker`) in Docker
3. host UI runtime (`web-admin`, `iOS simulator mobile`)

### Useful commands

- `pnpm infra:up` - start Cloud SQL proxy + Redis + API + Worker
- `pnpm infra:down` - stop backend containers
- `pnpm infra:logs` - follow backend container logs
- `pnpm dev:ui` - run only web-admin + mobile on host
- `pnpm env:pull` - sync `.env` files from GCP Secret Manager
- `pnpm env:check` - validate environment contracts
- `pnpm gcp:check` - validate gcloud project and auth
- `pnpm db:doctor` - validate migration history and checksums
- `pnpm db:migrate:shared` - sanctioned migration command for shared dev DB
- `pnpm checks:all` - run all local gate checks (GCP + env + DB + fast lint/type/test)
- `pnpm doctor` - alias for `pnpm checks:all`

## GCP Secrets and Auth

### Secret names (canonical)

- `mvp-dev-api-env` -> `.env`
- `mvp-dev-mobile-env` -> `apps/mobile/.env`
- `mvp-dev-web-env` -> `apps/web-admin/.env`

### Required IAM roles for each dev

- `Secret Manager Secret Accessor`
- `Cloud SQL Client`

### Auth method

Use gcloud user auth (no local service-account key files):

```bash
gcloud auth login
gcloud auth application-default login
gcloud config set project "$(cat config/gcp/project-id)"
```

## Shared DB Runbook

### When schema changed

1. Dev A opens PR with migration SQL.
2. After merge, Dev A runs `pnpm db:migrate:shared`.
3. Dev A posts migration confirmation in team channel (migration filename + timestamp).
4. Dev B pulls latest and runs `pnpm db:doctor`.
5. Dev B should see `doctor passed`; if not, investigate before coding.

### Secrets rotated

1. Rotate secret values in GCP Secret Manager.
2. Both devs run `pnpm env:pull`.
3. Both devs run `pnpm env:check`.

## Git and CI Guardrails

- Local pre-push hook (`.husky/pre-push`) runs:
  - `pnpm checks:all`
- Hooks are installed by `pnpm setup` via `pnpm hooks:install`.
- CI runs on:
  - every pull request
  - pushes to `main`, `development`, and `dev/**`
- CI validates:
  - env contracts
  - migrations + DB doctor
  - typecheck, lint, test, build

## Branch protection (manual GitHub setting)

Apply in GitHub repository settings:

1. Require status checks to pass before merging.
2. Require branches to be up to date before merging.
3. Disable force pushes on shared integration branches.

## Security Model

- API-level RBAC and ownership/stale-state guards in `apps/api`
- DB-level RLS policies in `packages/db/migrations/002_rls.sql`
- Team Leads get raw content only for stale leads; every raw access writes `AuditLog`

## Key API Endpoints

- `POST /v1/webhooks/email/gmail`
- `POST /v1/webhooks/email/outlook`
- `POST /v1/webhooks/twilio/sms`
- `POST /v1/webhooks/twilio/call`
- `GET /v1/task-deck`
- `GET /v1/leads/:id/derived`
- `GET /v1/leads/:id/events/metadata`
- `GET /v1/leads/:id/events/raw?reason=...`
- `POST /v1/messages/email/reply`
- `POST /v1/messages/sms/send`
- `POST /v1/calls/intent`
- `POST /v1/calls/:eventId/outcome`
- `GET|POST|PUT|DELETE /v1/team/templates`
- `GET|PUT /v1/team/rescue-sequences`
- `GET /v1/team/sla-dashboard`
- `PUT /v1/team/rules`
