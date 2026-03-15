#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/../.." && pwd)"

PROJECT_FILE="$ROOT_DIR/config/gcp/project-id"
ENV_FILE="${ENV_FILE:-$ROOT_DIR/.env.api.prod}"
PROJECT_ID="${PROJECT_ID:-${GCP_PROJECT_ID:-}}"
REGION="${REGION:-northamerica-northeast1}"
REPOSITORY="${REPOSITORY:-suivo}"
SERVICE_NAME="${SERVICE_NAME:-suivo-api}"
PORT="${PORT:-3001}"
ALLOW_UNAUTH="${ALLOW_UNAUTH:-true}"
IMAGE_TAG="${IMAGE_TAG:-$(date -u +"%Y%m%d-%H%M%S")}"

if ! command -v gcloud >/dev/null 2>&1; then
  echo "ERROR: gcloud is not installed." >&2
  exit 1
fi

if [ -z "$PROJECT_ID" ]; then
  if [ -f "$PROJECT_FILE" ]; then
    PROJECT_ID="$(tr -d '[:space:]' < "$PROJECT_FILE")"
  fi
fi

if [ -z "$PROJECT_ID" ]; then
  echo "ERROR: Could not determine PROJECT_ID. Set PROJECT_ID or GCP_PROJECT_ID." >&2
  exit 1
fi

if [ ! -f "$ENV_FILE" ]; then
  echo "ERROR: Missing env file: $ENV_FILE" >&2
  exit 1
fi

sanitize_env_file() {
  local input_file="$1"
  local output_file="$2"

  awk -F= '
    /^[[:space:]]*#/ { next }
    /^[[:space:]]*$/ { next }
    {
      key=$1
      sub(/^[[:space:]]+/, "", key)
      sub(/[[:space:]]+$/, "", key)
      if (key == "" || key == "PORT") next
      value=substr($0, index($0, "=") + 1)
      data[key]=value
    }
    END {
      for (k in data) {
        v=data[k]
        gsub(/\\/, "\\\\", v)
        gsub(/"/, "\\\"", v)
        printf "%s: \"%s\"\n", k, v
      }
    }
  ' "$input_file" > "$output_file"
}

active_account="$(gcloud auth list --filter=status:ACTIVE --format='value(account)' 2>/dev/null || true)"
if [ -z "$active_account" ]; then
  cat >&2 <<'EOF'
ERROR: No active gcloud account.
Run:
  gcloud auth login
  gcloud auth application-default login
EOF
  exit 1
fi

read_env_value() {
  local key="$1"
  awk -F= -v key="$key" '
    $0 !~ /^[[:space:]]*#/ && $1 == key {
      print substr($0, index($0, "=") + 1)
    }
  ' "$ENV_FILE" | tail -n1
}

cloud_sql_instance="$(read_env_value "CLOUD_SQL_INSTANCE_CONNECTION_NAME" | tr -d '[:space:]')"
if [ -z "$cloud_sql_instance" ]; then
  echo "WARNING: CLOUD_SQL_INSTANCE_CONNECTION_NAME is empty in $ENV_FILE."
fi

echo "Using project: $PROJECT_ID"
echo "Using region: $REGION"
echo "Using service: $SERVICE_NAME"
echo "Using env file: $ENV_FILE"

gcloud config set project "$PROJECT_ID" >/dev/null

echo "Enabling required APIs..."
gcloud services enable \
  run.googleapis.com \
  cloudbuild.googleapis.com \
  artifactregistry.googleapis.com \
  secretmanager.googleapis.com >/dev/null

echo "Ensuring Artifact Registry repository exists..."
if ! gcloud artifacts repositories describe "$REPOSITORY" \
  --location="$REGION" \
  --project="$PROJECT_ID" >/dev/null 2>&1; then
  gcloud artifacts repositories create "$REPOSITORY" \
    --project="$PROJECT_ID" \
    --location="$REGION" \
    --repository-format=docker \
    --description="Suivo API images"
fi

IMAGE_URI="${REGION}-docker.pkg.dev/${PROJECT_ID}/${REPOSITORY}/api:${IMAGE_TAG}"
echo "Building image: $IMAGE_URI"
cloudbuild_file="$(mktemp)"
cat > "$cloudbuild_file" <<EOF
steps:
  - name: gcr.io/cloud-builders/docker
    args:
      - build
      - -f
      - apps/api/Dockerfile
      - -t
      - $IMAGE_URI
      - .
images:
  - $IMAGE_URI
EOF

gcloud builds submit "$ROOT_DIR" \
  --project="$PROJECT_ID" \
  --config="$cloudbuild_file"

rm -f "$cloudbuild_file"

deploy_args=(
  "$SERVICE_NAME"
  "--project=$PROJECT_ID"
  "--region=$REGION"
  "--image=$IMAGE_URI"
  "--port=$PORT"
)

deploy_env_file="$(mktemp)"
sanitize_env_file "$ENV_FILE" "$deploy_env_file"
deploy_args+=("--env-vars-file=$deploy_env_file")

if [ "$ALLOW_UNAUTH" = "true" ]; then
  deploy_args+=("--allow-unauthenticated")
else
  deploy_args+=("--no-allow-unauthenticated")
fi

if [ -n "$cloud_sql_instance" ]; then
  deploy_args+=("--add-cloudsql-instances=$cloud_sql_instance")
fi

echo "Deploying Cloud Run service..."
gcloud run deploy "${deploy_args[@]}"

service_url="$(gcloud run services describe "$SERVICE_NAME" \
  --project="$PROJECT_ID" \
  --region="$REGION" \
  --format='value(status.url)')"

echo
echo "Deploy complete."
echo "Cloud Run URL: $service_url"
echo "Telnyx webhook URL: ${service_url}/v1/webhooks/telnyx/voice"
