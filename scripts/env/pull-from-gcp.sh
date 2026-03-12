#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT_DIR"

bash "$ROOT_DIR/scripts/env/gcp-check.sh"

PROJECT_ID="${GCP_PROJECT_ID:-$(tr -d '[:space:]' < "$ROOT_DIR/config/gcp/project-id")}"
FETCHED_AT="$(date -u +"%Y-%m-%dT%H:%M:%SZ")"

pull_secret() {
  local secret_name="$1"
  local target_path="$2"

  local secret_value
  secret_value="$(gcloud secrets versions access latest --secret "$secret_name" --project "$PROJECT_ID")"

  local secret_version
  secret_version="$(
    gcloud secrets versions list "$secret_name" \
      --project "$PROJECT_ID" \
      --sort-by="~name" \
      --limit=1 \
      --format="value(name)"
  )"

  local target_dir
  target_dir="$(dirname "$target_path")"
  mkdir -p "$target_dir"

  local temp_file
  temp_file="$(mktemp "$target_dir/.env.tmp.XXXXXX")"

  {
    echo "# source: gcp-secret-manager"
    echo "# fetched_at: $FETCHED_AT"
    echo "# secret_version: ${secret_version:-latest}"
    echo
    printf "%s\n" "$secret_value"
  } > "$temp_file"

  mv "$temp_file" "$target_path"
  chmod 600 "$target_path"

  echo "Wrote $target_path from secret '$secret_name' (version ${secret_version:-latest})"
}

pull_secret "mvp-dev-mobile-env" "$ROOT_DIR/apps/mobile/.env"
pull_secret "mvp-dev-env" "$ROOT_DIR/.env"
pull_secret "suivo-dev-vm" "$ROOT_DIR/.env.vm"

echo "Environment pull complete."
