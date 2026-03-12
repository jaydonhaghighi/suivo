#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT_DIR"

red()   { printf "\033[0;31m%s\033[0m\n" "$1"; }
green() { printf "\033[0;32m%s\033[0m\n" "$1"; }
blue()  { printf "\033[0;34m%s\033[0m\n" "$1"; }

fail() { red "ERROR: $1"; exit 1; }

blue "=== Suivo Zero-Drift Setup ==="

blue "Checking prerequisites..."
command -v node >/dev/null 2>&1 || fail "Node.js is not installed. Expected Node 22 (see .nvmrc)."
NODE_MAJOR=$(node -v | sed 's/v//' | cut -d. -f1)
[ "$NODE_MAJOR" -ge 20 ] || fail "Node.js 20+ required (found $(node -v))."
command -v pnpm >/dev/null 2>&1 || fail "pnpm is not installed. Install pnpm@9.12.0."
command -v docker >/dev/null 2>&1 || fail "Docker is not installed."
command -v gcloud >/dev/null 2>&1 || fail "gcloud CLI is not installed."
docker info >/dev/null 2>&1 || fail "Docker is not running."
green "All prerequisites found."

blue "Installing dependencies..."
pnpm install

blue "Installing repository git hooks..."
pnpm hooks:install

blue "Validating GCP auth/project..."
pnpm gcp:check

blue "Pulling .env files from GCP Secret Manager..."
pnpm env:pull

blue "Checking environment contracts..."
pnpm env:check

blue "Checking database migration drift..."
pnpm db:doctor

blue "Starting backend infra (local Postgres + Redis + API + Worker)..."
pnpm infra:up

green ""
green "=== Setup complete ==="
green ""
green "Next steps:"
green "  1) Run 'pnpm dev' for daily workflow (doctor + infra + UI)."
green "  2) Run 'pnpm prod' when you need Cloud SQL proxy mode."
green "  3) Or run 'pnpm ui:host' if infra is already running."
