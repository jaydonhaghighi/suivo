#!/usr/bin/env bash
set -euo pipefail

echo "[dev:restart] Stopping docker services (preserving volumes)..."
pnpm infra:down >/dev/null 2>&1 || true
pnpm infra:down:local >/dev/null 2>&1 || true

echo "[dev:restart] Stopping local dev processes..."
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

# Stop known dev commands for this repository only.
pkill -f "$REPO_ROOT/apps/api/src/main" >/dev/null 2>&1 || true
pkill -f "$REPO_ROOT/apps/worker/src/main.ts" >/dev/null 2>&1 || true
pkill -f "$REPO_ROOT/apps/web-admin/node_modules/.bin/../next/dist/bin/next dev -p 3002" >/dev/null 2>&1 || true
pkill -f "$REPO_ROOT/apps/mobile/node_modules/.bin/../expo/bin/cli start --ios" >/dev/null 2>&1 || true
pkill -f "$REPO_ROOT/apps/mobile/node_modules/.bin/../expo/bin/cli start" >/dev/null 2>&1 || true

# Kill listeners on common local dev ports as a safety net.
for port in 3001 3002 8081; do
  pids="$(lsof -tiTCP:${port} -sTCP:LISTEN 2>/dev/null || true)"
  if [[ -n "$pids" ]]; then
    kill $pids >/dev/null 2>&1 || true
  fi
done

echo "[dev:restart] Starting local stack without wiping DB..."
MOBILE_FOREGROUND=1 pnpm dev:local
