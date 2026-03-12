#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT_DIR"

bash "$ROOT_DIR/scripts/env/gcp-check.sh"

PROJECT_ID="${GCP_PROJECT_ID:-$(tr -d '[:space:]' < "$ROOT_DIR/config/gcp/project-id")}"

push_secret() {
  local source_path="$1"
  local secret_name="$2"

  if [ ! -f "$source_path" ]; then
    echo "ERROR: Missing $source_path" >&2
    exit 1
  fi

  if ! gcloud secrets describe "$secret_name" --project "$PROJECT_ID" >/dev/null 2>&1; then
    echo "ERROR: Secret '$secret_name' not found in project '$PROJECT_ID'." >&2
    echo "Create it first:" >&2
    echo "  gcloud secrets create $secret_name --replication-policy=automatic --project $PROJECT_ID" >&2
    exit 1
  fi

  gcloud secrets versions add "$secret_name" \
    --project "$PROJECT_ID" \
    --data-file "$source_path" >/dev/null

  local secret_version
  secret_version="$(
    gcloud secrets versions list "$secret_name" \
      --project "$PROJECT_ID" \
      --sort-by="~name" \
      --limit=1 \
      --format="value(name)"
  )"

  echo "Uploaded $source_path to secret '$secret_name' (version ${secret_version:-latest})"
}

push_secret "$ROOT_DIR/apps/mobile/.env" "mvp-dev-mobile-env"
push_secret "$ROOT_DIR/.env" "mvp-dev-env"
push_secret "$ROOT_DIR/.env.vm" "suivo-dev-vm"

echo "Environment push complete."
