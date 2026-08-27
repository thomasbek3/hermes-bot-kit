#!/usr/bin/env bash
# Install Bubble Mode into Hermes Desktop's disk-plugin folder.
# Safe for agents to run unattended: idempotent, no prompts, no sudo,
# backs up any existing copy before overwriting.
#
#   curl -fsSL https://raw.githubusercontent.com/thomasbek3/hermes-bubble-mode/main/install.sh | bash
#
# or from a clone:  bash install.sh
set -euo pipefail

RAW_URL="https://raw.githubusercontent.com/thomasbek3/hermes-bubble-mode/main/plugin.js"
DEST_DIR="${HERMES_HOME:-$HOME/.hermes}/desktop-plugins/bubble-mode"
DEST="${DEST_DIR}/plugin.js"

SCRIPT_DIR=""
if [ -n "${BASH_SOURCE:-}" ] && [ -f "${BASH_SOURCE[0]:-}" ]; then
  SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
fi

mkdir -p "${DEST_DIR}"

TMP=$(mktemp)
trap 'rm -f "${TMP}"' EXIT

if [ -n "${SCRIPT_DIR}" ] && [ -f "${SCRIPT_DIR}/plugin.js" ]; then
  cp "${SCRIPT_DIR}/plugin.js" "${TMP}"
  SRC="local clone"
else
  curl -fsSL "${RAW_URL}" -o "${TMP}"
  SRC="${RAW_URL}"
fi

# Sanity: refuse to install something that isn't this plugin.
grep -q "hermes-bubble-mode-style" "${TMP}" || {
  echo "install.sh: downloaded file does not look like Bubble Mode; aborting" >&2
  exit 1
}
if command -v node >/dev/null 2>&1; then
  node --check "${TMP}" || {
    echo "install.sh: plugin failed syntax check; aborting" >&2
    exit 1
  }
fi

if [ -f "${DEST}" ] && ! cmp -s "${TMP}" "${DEST}"; then
  cp "${DEST}" "${DEST}.bak.$(date +%Y%m%d%H%M%S)"
fi

cp "${TMP}" "${DEST}"

echo "Bubble Mode installed to ${DEST} (from ${SRC})."
echo "Finish: in Hermes Desktop press Cmd+Shift+P -> 'Reload plugins' (or restart the app)."
echo "Toggle any time: Cmd+Shift+P -> 'Bubble Mode: toggle'."
