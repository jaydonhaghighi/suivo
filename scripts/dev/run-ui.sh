#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Usage: scripts/dev/run-ui.sh [simulator|device]

Targets:
  simulator  Start Expo in iOS simulator mode (default)
  device     Start Expo for a physical device (Expo Go)
EOF
}

resolve_mobile_target() {
  local requested_target="${1:-${MOBILE_TARGET:-}}"

  case "$requested_target" in
    "" )
      if [ -t 0 ]; then
        echo "Choose mobile target:"
        echo "  1) iOS simulator"
        echo "  2) Physical device (Expo Go)"
        read -r -p "Select [1-2] (default 1): " selection
        case "${selection:-1}" in
          1) echo "simulator" ;;
          2) echo "device" ;;
          *) echo "ERROR: Invalid selection '$selection'." >&2; return 1 ;;
        esac
      else
        echo "simulator"
      fi
      ;;
    simulator|ios) echo "simulator" ;;
    device|physical) echo "device" ;;
    *)
      echo "ERROR: Unknown target '$requested_target'." >&2
      usage >&2
      return 1
      ;;
  esac
}

if [ "${1:-}" = "-h" ] || [ "${1:-}" = "--help" ]; then
  usage
  exit 0
fi

set +e
MOBILE_TARGET_RESOLVED="$(resolve_mobile_target "${1:-}")"
TARGET_RESOLUTION_STATUS=$?
set -e

case "$TARGET_RESOLUTION_STATUS" in
  0) ;;
  *) exit 1 ;;
esac

pnpm --filter @mvp/web-admin dev &
WEB_PID=$!

if [ "$MOBILE_TARGET_RESOLVED" = "device" ]; then
  echo "Starting mobile UI for physical device (Expo Go)..."
  pnpm --filter @mvp/mobile dev:lan &
else
  echo "Starting mobile UI in iOS simulator..."
  pnpm --filter @mvp/mobile dev:ios:clean &
fi
MOBILE_PID=$!

cleanup() {
  kill "$WEB_PID" "$MOBILE_PID" >/dev/null 2>&1 || true
}

trap cleanup EXIT INT TERM
wait
