#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
ENV_FILE="$ROOT_DIR/.env"

if [ ! -f "$ENV_FILE" ]; then
  echo "ERROR: Missing $ENV_FILE. Run: pnpm env:pull" >&2
  exit 1
fi

read_env_value() {
  local key="$1"
  awk -F= -v k="$key" '$1 == k {print substr($0, index($0, "=") + 1)}' "$ENV_FILE" | tail -n1
}

normalize_value() {
  local value="$1"
  value="$(printf '%s' "$value" | tr -d '\r' | sed -e "s/^[[:space:]]*//" -e "s/[[:space:]]*$//")"
  value="${value%\"}"
  value="${value#\"}"
  value="${value%\'}"
  value="${value#\'}"
  printf '%s' "$value"
}

parse_host_port() {
  local url="$1"
  local authority
  authority="$(printf '%s' "$url" | sed -E 's#^[a-zA-Z][a-zA-Z0-9+.-]*://##; s#[/?#].*$##')"
  authority="${authority##*@}"

  if [[ "$authority" == \[* ]]; then
    echo "ERROR: IPv6 URL authority is not supported by this guard: '$authority'" >&2
    exit 1
  fi

  local host="$authority"
  local port="5432"
  if [[ "$authority" == *:* ]]; then
    host="${authority%:*}"
    port="${authority##*:}"
  fi

  printf '%s %s' "$host" "$port"
}

assert_allowed_host() {
  local host="$1"
  shift

  for allowed in "$@"; do
    if [ "$host" = "$allowed" ]; then
      return 0
    fi
  done

  return 1
}

validate_local_url() {
  local label="$1"
  local value="$2"
  shift 2

  if [ -z "$value" ]; then
    echo "ERROR: $label is required in .env." >&2
    exit 1
  fi

  if ! printf '%s' "$value" | grep -Eq '^postgres(ql)?://'; then
    echo "ERROR: $label must be a postgres:// URL. Found: $value" >&2
    exit 1
  fi

  if printf '%s' "$value" | grep -Eiq 'cloudsql|googleapis|shared_dev|shared-dev'; then
    echo "ERROR: $label appears to target a shared/cloud DB. Refusing to continue: $value" >&2
    exit 1
  fi

  local host port
  read -r host port <<<"$(parse_host_port "$value")"

  if ! assert_allowed_host "$host" "$@"; then
    echo "ERROR: $label host '$host' is not allowed for local dev." >&2
    echo "Allowed hosts: $*" >&2
    exit 1
  fi

  if [ "$port" != "5432" ] && [ "$port" != "6432" ]; then
    echo "ERROR: $label port '$port' is not allowed for local dev (expected 5432 or 6432)." >&2
    exit 1
  fi
}

database_url="$(normalize_value "$(read_env_value DATABASE_URL)")"
docker_database_url="$(normalize_value "$(read_env_value DOCKER_DATABASE_URL)")"
shared_dev_database_url="$(normalize_value "$(read_env_value SHARED_DEV_DATABASE_URL)")"

if [ -n "$shared_dev_database_url" ] && [ "$database_url" = "$shared_dev_database_url" ]; then
  echo "ERROR: DATABASE_URL matches SHARED_DEV_DATABASE_URL. Refusing to run local dev against shared DB." >&2
  exit 1
fi

validate_local_url "DATABASE_URL" "$database_url" "127.0.0.1" "localhost"
validate_local_url "DOCKER_DATABASE_URL" "$docker_database_url" "host.docker.internal" "postgres" "127.0.0.1" "localhost"

echo "Local Postgres prerequisites passed."
