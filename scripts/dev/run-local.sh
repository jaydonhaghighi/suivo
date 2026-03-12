#!/usr/bin/env bash
set -euo pipefail

MOBILE_MODE="${1:-dev:ios}"

pnpm --filter @mvp/api dev &
API_PID=$!

pnpm --filter @mvp/worker dev &
WORKER_PID=$!

pnpm --filter @mvp/web-admin dev &
WEB_PID=$!

pnpm --filter @mvp/mobile "$MOBILE_MODE" &
MOBILE_PID=$!

cleanup() {
  kill "$API_PID" "$WORKER_PID" "$WEB_PID" "$MOBILE_PID" >/dev/null 2>&1 || true
}

trap cleanup EXIT INT TERM

set +e
# Bash 3.2 (default on macOS) does not support `wait -n`, so poll for the
# first process that exits and then return that exit status.
if [ "${BASH_VERSINFO[0]:-0}" -ge 5 ]; then
  wait -n "$API_PID" "$WORKER_PID" "$WEB_PID" "$MOBILE_PID"
  STATUS=$?
else
  STATUS=0
  while true; do
    for PID in "$API_PID" "$WORKER_PID" "$WEB_PID" "$MOBILE_PID"; do
      if ! kill -0 "$PID" >/dev/null 2>&1; then
        wait "$PID"
        STATUS=$?
        break 2
      fi
    done
    sleep 1
  done
fi
set -e

exit "$STATUS"
