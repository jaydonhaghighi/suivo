#!/usr/bin/env bash
set -euo pipefail

pnpm --filter @mvp/web-admin dev &
WEB_PID=$!

pnpm --filter @mvp/mobile dev:ios &
MOBILE_PID=$!

cleanup() {
  kill "$WEB_PID" "$MOBILE_PID" >/dev/null 2>&1 || true
}

trap cleanup EXIT INT TERM
wait
