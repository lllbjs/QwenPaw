#!/usr/bin/env bash
# Install Model Accordion into QwenPaw.
# Primary path: hot-load via the running backend's plugin API (no restart).
# Fallback: symlink into the plugins directory (requires app restart).
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WORKING_DIR="${QWENPAW_WORKING_DIR:-$HOME/.qwenpaw}"
PORT_FILE="$WORKING_DIR/desktop_port"

if [[ -f "$PORT_FILE" ]]; then
  PORT="$(tr -d '[:space:]' < "$PORT_FILE")"
  if curl -fsS -X POST "http://127.0.0.1:$PORT/api/plugins/install" \
      -H 'Content-Type: application/json' \
      -d "{\"source\":\"$SCRIPT_DIR\",\"force\":true}"; then
    echo
    echo "Installed via plugin API. Refresh the console page to load the frontend bundle."
    exit 0
  fi
  echo "API install failed; falling back to symlink (requires app restart)." >&2
fi

mkdir -p "$WORKING_DIR/plugins"
ln -sfn "$SCRIPT_DIR" "$WORKING_DIR/plugins/model-accordion"
echo "Linked to $WORKING_DIR/plugins/model-accordion — restart QwenPaw to load."