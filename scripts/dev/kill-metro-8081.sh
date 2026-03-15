#!/usr/bin/env bash
set -euo pipefail

PIDS="$(lsof -tiTCP:8081 -sTCP:LISTEN 2>/dev/null || true)"

if [ -z "$PIDS" ]; then
  exit 0
fi

echo "Stopping existing process(es) on port 8081: $PIDS"
for PID in $PIDS; do
  kill "$PID" 2>/dev/null || true
done

sleep 1
