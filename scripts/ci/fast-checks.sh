#!/usr/bin/env bash
set -euo pipefail

BASE_REF="${MVP_AFFECTED_BASE_REF:-origin/main}"

echo "Running fast typecheck checks..."
pnpm typecheck

if git rev-parse --verify "$BASE_REF" >/dev/null 2>&1; then
  echo "Running affected tests against $BASE_REF..."
  pnpm turbo run test --filter="...[$BASE_REF]"
else
  echo "Base ref '$BASE_REF' not found; running full tests."
  pnpm test
fi
