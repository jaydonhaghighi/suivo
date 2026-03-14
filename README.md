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

1. local DB migrations (`db:migrate:dev`) + drift check (`db:doctor:dev`)
2. backend infra boot (`postgres`, `redis`, `api`, `worker`) in Docker
3. host UI runtime (`web-admin`, mobile prompt: simulator or physical device)

`pnpm prod` runs:

1. Cloud SQL proxy prerequisite checks
2. DB drift check (`db:doctor`)
3. backend infra boot (`cloud-sql-proxy`, `redis`, `api`, `worker`) in Docker
4. host UI runtime (`web-admin`, mobile prompt: simulator or physical device)

### Local setup (no Cloud SQL)

Use this flow when you want everything in local development mode (local Postgres + local Redis + host app processes).

1. Ensure Docker Desktop is running.
2. Ensure `.env` points to local services:

```bash
DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:5432/suivo
REDIS_URL=redis://localhost:6379
```

3. Start the full local stack in simulator mode:

```bash
pnpm dev:local:simulator
```

Or start the full local stack for a physical device on your local network:

```bash
pnpm dev:local:device
```

`pnpm dev:local:simulator` and `pnpm dev:local:device` run local infra (`postgres`, `redis`), apply migrations, verify DB state, and start `api`, `worker`, `web-admin`, and `mobile`.
`pnpm dev:local` remains an alias for `pnpm dev:local:simulator`.

4. Optional clean restart if ports/processes are stuck:

```bash
pnpm dev:reset
```

5. Stop local infra when done:

```bash
pnpm infra:down:local
```

### Useful commands

- `pnpm infra:up` - start Cloud SQL proxy + Redis + API + Worker
- `pnpm infra:up:local` - start local Postgres + Redis (no Cloud SQL proxy)
- `pnpm infra:down` - stop backend containers
- `pnpm infra:down:local` - stop local Postgres + Redis
- `pnpm infra:logs` - follow backend container logs
- `pnpm infra:logs:local` - follow local Postgres + Redis logs
- `pnpm dev:ui` - run only web-admin + mobile on host
- `pnpm dev:local` - alias for `pnpm dev:local:simulator`
- `pnpm dev:local:simulator` - run full local stack with iOS simulator mobile flow
- `pnpm dev:local:device` - run full local stack with physical-device (LAN) mobile flow
- `pnpm dev:reset` - stop existing local/docker dev state and restart `dev:local`
- `pnpm env:pull` - sync `.env` files from GCP Secret Manager
- `pnpm env:check` - validate environment contracts
- `pnpm gcp:check` - validate gcloud project and auth
- `pnpm db:doctor` - validate migration history and checksums
- `pnpm db:migrate:shared` - sanctioned migration command for shared dev DB
- `pnpm checks:all` - run all local gate checks (GCP + env + DB + fast lint/type/test)
- `pnpm doctor` - alias for `pnpm checks:all`

## pnpm Command Cheat Sheet

### Command patterns

- `pnpm <script>` - run a root `package.json` script
- `pnpm --filter <package-name> <script>` - run a workspace package script
- `pnpm --filter @mvp/api dev` - example filtered run

### Root scripts (complete)

- `pnpm setup` - bootstrap local dev prerequisites and initial checks
- `pnpm hooks:install` - point git hooks to `.husky`
- `pnpm dev` - full local dev flow (deps + db doctor + backend apps + UIs)
- `pnpm dev:no-mobile` - local dev flow without mobile UI
- `pnpm dev:local` - alias for `pnpm dev:local:simulator`
- `pnpm dev:local:simulator` - local Postgres/Redis + host apps + mobile simulator mode
- `pnpm dev:local:device` - local Postgres/Redis + host apps + mobile device (LAN) mode
- `pnpm dev:reset` - clean restart into `dev:local`
- `pnpm dev:ui` - run host UIs only
- `pnpm infra:up` - start Cloud SQL proxy + Redis + API + Worker
- `pnpm infra:up:deps` - start Cloud SQL proxy + Redis only
- `pnpm infra:up:apps` - start API + Worker containers
- `pnpm infra:up:local` - start local Postgres + Redis
- `pnpm infra:down` - stop local containers
- `pnpm infra:down:local` - stop local Postgres + Redis
- `pnpm infra:logs` - tail local backend logs
- `pnpm infra:logs:local` - tail local Postgres + Redis logs
- `pnpm build` - build all workspaces via Turbo
- `pnpm lint` - lint all workspaces via Turbo
- `pnpm test` - run guarded tests across workspaces via Turbo
- `pnpm typecheck` - typecheck all workspaces via Turbo
- `pnpm checks:fast` - run fast CI-style checks script
- `pnpm checks:all` - run gcp/env/db checks plus fast checks
- `pnpm doctor` - alias of `pnpm checks:all`
- `pnpm env:pull` - pull env files from GCP Secret Manager
- `pnpm env:push` - push env files to GCP Secret Manager
- `pnpm env:check` - validate env contracts
- `pnpm gcp:check` - validate gcloud auth/project prerequisites
- `pnpm db:migrate` - run DB migration script in `@mvp/db`
- `pnpm db:migrate:shared` - run DB migration in shared mode
- `pnpm db:doctor` - run DB doctor script in `@mvp/db`
- `pnpm db:seed` - seed DB via `@mvp/db`
- `pnpm db:seed:admin` - seed admin routing via `@mvp/db`
- `pnpm format` - format workspaces via Turbo

### Common workflows

- First-time setup: `pnpm setup`
- Full local dev (api + worker + web + mobile): `pnpm dev`
- Full local dev without Cloud SQL proxy (simulator): `pnpm dev:local:simulator`
- Full local dev without Cloud SQL proxy (physical device): `pnpm dev:local:device`
- Clean local restart: `pnpm dev:reset`
- Local dev without mobile: `pnpm dev:no-mobile`
- Start only infra dependencies: `pnpm infra:up:deps`
- Start only backend app containers: `pnpm infra:up:apps`
- Run only host UIs: `pnpm dev:ui`
- Tail backend logs: `pnpm infra:logs`
- Stop local containers: `pnpm infra:down`

### Checks and quality

- Run lint everywhere: `pnpm lint`
- Run typecheck everywhere: `pnpm typecheck`
- Run tests everywhere: `pnpm test`
- Build all workspaces: `pnpm build`
- Format all workspaces: `pnpm format`
- Fast local CI checks: `pnpm checks:fast`
- Full local CI checks: `pnpm checks:all` (same as `pnpm doctor`)

### Env and GCP

- Pull `.env` values from GCP: `pnpm env:pull`
- Push local `.env` values to GCP: `pnpm env:push`
- Validate env contracts: `pnpm env:check`
- Verify gcloud auth/project setup: `pnpm gcp:check`

### Database

- Validate migration history/checksums: `pnpm db:doctor`
- Run shared migration flow: `pnpm db:migrate:shared`
- Run normal migration flow: `pnpm db:migrate`
- Seed database: `pnpm db:seed`
- Seed admin routing data: `pnpm db:seed:admin`

### Package-specific commands

- API (`@mvp/api`): `pnpm --filter @mvp/api dev`, `build`, `start`, `lint`, `typecheck`, `test`
- Worker (`@mvp/worker`): `pnpm --filter @mvp/worker dev`, `build`, `start`, `lint`, `typecheck`, `test`
- Web admin (`@mvp/web-admin`): `pnpm --filter @mvp/web-admin dev`, `build`, `start`, `lint`, `typecheck`, `test`
- Mobile (`@mvp/mobile`): `pnpm --filter @mvp/mobile dev`, `dev:ios`, `dev:lan`, `dev:tunnel`, `android`, `ios`, `build`, `lint`, `typecheck`, `test`
- DB package (`@mvp/db`): `pnpm --filter @mvp/db doctor`, `migrate`, `seed`, `seed:admin`, `build`, `lint`, `typecheck`, `test`
- Shared types (`@mvp/shared-types`): `pnpm --filter @mvp/shared-types build`, `lint`, `typecheck`, `test`
- Config package (`@mvp/config`): no scripts defined

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
- `POST /v1/webhooks/sms`
- `POST /v1/webhooks/call`
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
