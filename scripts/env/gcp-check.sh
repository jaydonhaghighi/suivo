#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
PROJECT_FILE="$ROOT_DIR/config/gcp/project-id"

if ! command -v gcloud >/dev/null 2>&1; then
  echo "ERROR: gcloud is not installed. Install Google Cloud SDK first." >&2
  exit 1
fi

if [ ! -f "$PROJECT_FILE" ]; then
  echo "ERROR: Missing $PROJECT_FILE (expected GCP project id)." >&2
  exit 1
fi

EXPECTED_PROJECT="$(tr -d '[:space:]' < "$PROJECT_FILE")"
if [ -n "${GCP_PROJECT_ID:-}" ]; then
  EXPECTED_PROJECT="$GCP_PROJECT_ID"
fi

if [ -z "$EXPECTED_PROJECT" ]; then
  echo "ERROR: Expected GCP project id is empty." >&2
  exit 1
fi

CURRENT_PROJECT="$(gcloud config get-value project 2>/dev/null | tr -d '[:space:]')"
if [ -z "$CURRENT_PROJECT" ]; then
  echo "ERROR: No active gcloud project is set. Run: gcloud config set project $EXPECTED_PROJECT" >&2
  exit 1
fi

if [ "$CURRENT_PROJECT" != "$EXPECTED_PROJECT" ]; then
  echo "ERROR: gcloud active project '$CURRENT_PROJECT' does not match expected '$EXPECTED_PROJECT'." >&2
  exit 1
fi

if ! gcloud auth application-default print-access-token >/dev/null 2>&1; then
  echo "ERROR: Application Default Credentials are not configured. Run: gcloud auth application-default login" >&2
  exit 1
fi

if ! gcloud auth print-access-token >/dev/null 2>&1; then
  echo "ERROR: gcloud user auth is not active. Run: gcloud auth login" >&2
  exit 1
fi

echo "GCP check passed (project: $EXPECTED_PROJECT)."
echo "Required IAM roles: Secret Manager Secret Accessor, Cloud SQL Client."
