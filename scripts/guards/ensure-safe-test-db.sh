#!/usr/bin/env bash
set -euo pipefail

if [ "${NODE_ENV:-}" != "test" ]; then
  exit 0
fi

DATABASE_URL_VALUE="${DATABASE_URL:-}"
SHARED_DB_VALUE="${SHARED_DEV_DATABASE_URL:-}"

if [ -z "$DATABASE_URL_VALUE" ]; then
  echo "ERROR: DATABASE_URL is required when NODE_ENV=test." >&2
  exit 1
fi

if [ -n "$SHARED_DB_VALUE" ] && [ "$DATABASE_URL_VALUE" = "$SHARED_DB_VALUE" ]; then
  echo "ERROR: Refusing to run tests against SHARED_DEV_DATABASE_URL." >&2
  exit 1
fi

if echo "$DATABASE_URL_VALUE" | grep -Eiq "cloudsql|googleapis|shared_dev|shared-dev"; then
  echo "ERROR: Refusing to run tests against a likely shared database URL: $DATABASE_URL_VALUE" >&2
  exit 1
fi
