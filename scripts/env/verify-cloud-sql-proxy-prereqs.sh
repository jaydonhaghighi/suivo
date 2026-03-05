#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
ENV_FILE="$ROOT_DIR/.env"
ADC_FILE="${HOME}/.config/gcloud/application_default_credentials.json"

if [ ! -f "$ENV_FILE" ]; then
  echo "ERROR: Missing $ENV_FILE. Run: pnpm env:pull" >&2
  exit 1
fi

connection_name="$(
  awk -F= '/^CLOUD_SQL_INSTANCE_CONNECTION_NAME=/{print substr($0, index($0, "=") + 1)}' "$ENV_FILE" \
    | tail -n1
)"

connection_name="$(printf '%s' "$connection_name" | tr -d '\r' | sed -e "s/^[[:space:]]*//" -e "s/[[:space:]]*$//")"
connection_name="${connection_name%\"}"
connection_name="${connection_name#\"}"
connection_name="${connection_name%\'}"
connection_name="${connection_name#\'}"

if [ -z "$connection_name" ]; then
  echo "ERROR: CLOUD_SQL_INSTANCE_CONNECTION_NAME is empty in .env." >&2
  echo "Expected format: <project>:<region>:<instance>" >&2
  exit 1
fi

if [[ ! "$connection_name" =~ ^[^:]+:[^:]+:[^:]+$ ]]; then
  echo "ERROR: CLOUD_SQL_INSTANCE_CONNECTION_NAME has invalid format: '$connection_name'" >&2
  echo "Expected format: <project>:<region>:<instance>" >&2
  exit 1
fi

project_name="${connection_name%%:*}"
region_and_instance="${connection_name#*:}"
region_name="${region_and_instance%%:*}"
instance_name="${connection_name##*:}"

if [[ "$region_name" =~ -[a-z]$ ]]; then
  echo "ERROR: CLOUD_SQL_INSTANCE_CONNECTION_NAME appears to use a zone ('$region_name'), not a region." >&2
  echo "Expected region format like 'northamerica-northeast1' (without '-a/-b/-c')." >&2
  exit 1
fi

if [ ! -r "$ADC_FILE" ]; then
  echo "ERROR: ADC file not readable at $ADC_FILE" >&2
  echo "Run: gcloud auth application-default login" >&2
  exit 1
fi

if command -v gcloud >/dev/null 2>&1; then
  described_connection_name="$(
    gcloud sql instances describe "$instance_name" \
      --project "$project_name" \
      --format="value(connectionName)" 2>/dev/null || true
  )"

  described_connection_name="$(printf '%s' "$described_connection_name" | tr -d '\r' | sed -e "s/^[[:space:]]*//" -e "s/[[:space:]]*$//")"

  if [ -z "$described_connection_name" ]; then
    echo "WARN: Could not verify Cloud SQL instance '$instance_name' in project '$project_name'." >&2
    echo "Proceeding without remote verification. If proxy fails, confirm the exact connection name in Cloud SQL." >&2
  elif [ "$described_connection_name" != "$connection_name" ]; then
    echo "ERROR: CLOUD_SQL_INSTANCE_CONNECTION_NAME mismatch." >&2
    echo "Configured: $connection_name" >&2
    echo "Expected:   $described_connection_name" >&2
    exit 1
  fi
fi

echo "Cloud SQL proxy prerequisites passed."
