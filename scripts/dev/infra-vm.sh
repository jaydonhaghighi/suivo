#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
VM_ENV_FILE="$ROOT_DIR/.env.vm"

if [ -f "$VM_ENV_FILE" ]; then
  # shellcheck source=/dev/null
  source "$VM_ENV_FILE"
fi

usage() {
  cat <<'EOF'
Usage: scripts/dev/infra-vm.sh [up|down|logs|ps|restart|tunnel]

Opt-in remote Docker helper for a Linux VM.
This does not change any existing local Docker workflow.

Configuration (via env vars or .env.vm at repo root):
  DEV_VM_SSH_TARGET    Required. Example: your-user@192.168.2.24
  DEV_VM_PROJECT_DIR   Optional. Default: ~/projects/suivo
  DEV_VM_COMPOSE_FILE  Optional. Default: docker-compose.dev.yml
  DEV_VM_FORWARD_PORTS Optional. Default: "3001 6432:5432 6379"
                       Format: "<port>" or "<local_port>:<remote_port>"

Examples:
  pnpm infra:vm:up
  pnpm infra:vm:logs
  pnpm infra:vm:tunnel
EOF
}

require_vm_target() {
  if [ -z "${DEV_VM_SSH_TARGET:-}" ]; then
    echo "ERROR: DEV_VM_SSH_TARGET is required (or set it in .env.vm)." >&2
    usage >&2
    exit 1
  fi
}

ensure_port() {
  local port="$1"
  if ! printf '%s' "$port" | grep -Eq '^[0-9]+$'; then
    echo "ERROR: Invalid port '$port' in DEV_VM_FORWARD_PORTS." >&2
    exit 1
  fi
}

normalize_vm_project_dir() {
  local dir="$1"

  # Default if unset
  if [ -z "$dir" ]; then
    printf '%s' '~/projects/suivo'
    return 0
  fi

  # If already using ~ syntax, keep it
  case "$dir" in
    "~"|"~/"*)
      printf '%s' "$dir"
      return 0
      ;;
  esac

  # If absolute path, keep it exactly as provided
  if [[ "$dir" = /* ]]; then
    printf '%s' "$dir"
    return 0
  fi

  # Fallback
  printf '%s' "$dir"
}

remote_project_dir_expr() {
  local dir="$1"
  case "$dir" in
    "~")
      printf '%s' '$HOME'
      ;;
    "~/"*)
      printf '%s' "\$HOME/${dir#~/}"
      ;;
    *)
      printf '%q' "$dir"
      ;;
  esac
}

run_remote_compose() {
  local compose_args="$1"
  local vm_project_dir="${DEV_VM_PROJECT_DIR:-~/projects/suivo}"
  local vm_compose_file="${DEV_VM_COMPOSE_FILE:-docker-compose.dev.yml}"
  local remote_dir
  local remote_compose_file

  vm_project_dir="$(normalize_vm_project_dir "$vm_project_dir")"
  remote_dir="$(remote_project_dir_expr "$vm_project_dir")"
  remote_compose_file="$(printf '%q' "$vm_compose_file")"

  ssh "${DEV_VM_SSH_TARGET}" "cd ${remote_dir} && docker compose -f ${remote_compose_file} ${compose_args}"
}

open_tunnel() {
  local vm_forward_ports="${DEV_VM_FORWARD_PORTS:-3001 6432:5432 6379}"
  local ssh_args=()
  local spec local_port remote_port

  vm_forward_ports="$(printf '%s' "$vm_forward_ports" | tr ',' ' ')"

  for spec in $vm_forward_ports; do
    if [[ "$spec" == *:* ]]; then
      local_port="${spec%%:*}"
      remote_port="${spec##*:}"
    else
      local_port="$spec"
      remote_port="$spec"
    fi

    ensure_port "$local_port"
    ensure_port "$remote_port"
    ssh_args+=("-L" "${local_port}:127.0.0.1:${remote_port}")
  done

  if [ "${#ssh_args[@]}" -eq 0 ]; then
    echo "ERROR: DEV_VM_FORWARD_PORTS did not contain any ports." >&2
    exit 1
  fi

  echo "Opening SSH tunnel to ${DEV_VM_SSH_TARGET} for ports: ${vm_forward_ports}"
  echo "Press Ctrl+C to close the tunnel."
  exec ssh -N -o ExitOnForwardFailure=yes "${ssh_args[@]}" "${DEV_VM_SSH_TARGET}"
}

if [ "${1:-}" = "-h" ] || [ "${1:-}" = "--help" ] || [ "${1:-}" = "help" ]; then
  usage
  exit 0
fi

action="${1:-up}"
require_vm_target

case "$action" in
  up)
    run_remote_compose "up -d --remove-orphans --wait --wait-timeout 120 postgres redis api worker"
    ;;
  down)
    run_remote_compose "down"
    ;;
  logs)
    run_remote_compose "logs -f --tail=100 postgres redis api worker"
    ;;
  ps)
    run_remote_compose "ps"
    ;;
  restart)
    run_remote_compose "restart postgres redis api worker"
    ;;
  tunnel)
    open_tunnel
    ;;
  *)
    echo "ERROR: Unknown action '$action'." >&2
    usage >&2
    exit 1
    ;;
esac
