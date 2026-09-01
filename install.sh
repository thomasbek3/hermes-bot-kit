#!/usr/bin/env bash
# Install the Hermes Bot Kit desktop plugins: Bubble Mode + Computer viewer
# + Bot Sections + Task Dock. Safe for agents to run unattended: idempotent,
# no prompts, no sudo, backs up any existing copy before overwriting.
#
#   curl -fsSL https://raw.githubusercontent.com/thomasbek3/hermes-bot-kit/master/install.sh | bash
#
# or from a clone:  bash install.sh
#
# Env knobs:
#   HERMES_HOME            Hermes home dir (default ~/.hermes)
#   KIT_SKIP_BUBBLES=1     skip Bubble Mode
#   KIT_SKIP_COMPUTER=1    skip the Computer viewer
#   KIT_SKIP_SECTIONS=1    skip Bot Sections
#   KIT_SKIP_TASK_DOCK=1   skip Task Dock
set -euo pipefail

RAW_BASE="https://raw.githubusercontent.com/thomasbek3/hermes-bot-kit/master"
PLUGIN_ROOT="${HERMES_HOME:-$HOME/.hermes}/desktop-plugins"

SCRIPT_DIR=""
if [ -n "${BASH_SOURCE:-}" ] && [ -f "${BASH_SOURCE[0]:-}" ]; then
  SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
fi

TMP_DIR=$(mktemp -d)
trap 'rm -rf "${TMP_DIR}"' EXIT

# fetch <repo-relative-path> <tmp-name> -> echoes tmp path
fetch() {
  local rel="$1" name="$2" out="${TMP_DIR}/$2"
  if [ -n "${SCRIPT_DIR}" ] && [ -f "${SCRIPT_DIR}/${rel}" ]; then
    cp "${SCRIPT_DIR}/${rel}" "${out}"
  else
    curl -fsSL "${RAW_BASE}/${rel}" -o "${out}"
  fi
  printf '%s\n' "${out}"
}

# install_file <tmp-path> <dest-path>
install_file() {
  local src="$1" dest="$2"
  mkdir -p "$(dirname -- "${dest}")"
  if [ -f "${dest}" ] && ! cmp -s "${src}" "${dest}"; then
    cp "${dest}" "${dest}.bak.$(date +%Y%m%d%H%M%S)"
  fi
  cp "${src}" "${dest}"
}

check_js() {
  local file="$1" marker="$2" label="$3"
  grep -q "${marker}" "${file}" || {
    echo "install.sh: downloaded ${label} does not look right; aborting" >&2
    exit 1
  }
  if command -v node >/dev/null 2>&1; then
    node --check "${file}" || {
      echo "install.sh: ${label} failed syntax check; aborting" >&2
      exit 1
    }
  fi
}

if [ "${KIT_SKIP_BUBBLES:-0}" != "1" ]; then
  bubbles=$(fetch "bubble-mode/plugin.js" "bubble-plugin.js")
  check_js "${bubbles}" "hermes-bubble-mode-style" "Bubble Mode"
  install_file "${bubbles}" "${PLUGIN_ROOT}/bubble-mode/plugin.js"
  echo "Bubble Mode      -> ${PLUGIN_ROOT}/bubble-mode/plugin.js"
fi

if [ "${KIT_SKIP_COMPUTER:-0}" != "1" ]; then
  viewer=$(fetch "computer-viewer/plugin.js" "viewer-plugin.js")
  check_js "${viewer}" "computer-viewer" "Computer viewer"
  install_file "${viewer}" "${PLUGIN_ROOT}/computer-viewer/plugin.js"
  # Helper scripts the viewer offers to hand out (macOS/Linux hosts).
  for helper in connect-mac.sh connect-linux.sh hiperf-mac.sh hiperf-agent.py; do
    h=$(fetch "computer-viewer/${helper}" "${helper}")
    install_file "${h}" "${PLUGIN_ROOT}/computer-viewer/${helper}"
  done
  chmod +x "${PLUGIN_ROOT}/computer-viewer/"*.sh
  echo "Computer viewer  -> ${PLUGIN_ROOT}/computer-viewer/plugin.js (+ helper scripts)"
fi

if [ "${KIT_SKIP_SECTIONS:-0}" != "1" ]; then
  sections=$(fetch "bot-sections/plugin.js" "sections-plugin.js")
  check_js "${sections}" "hermes-bot-sections-style" "Bot Sections"
  install_file "${sections}" "${PLUGIN_ROOT}/bot-sections/plugin.js"
  echo "Bot Sections     -> ${PLUGIN_ROOT}/bot-sections/plugin.js"
fi

if [ "${KIT_SKIP_TASK_DOCK:-0}" != "1" ]; then
  taskdock=$(fetch "task-dock/plugin.js" "task-dock-plugin.js")
  check_js "${taskdock}" "hermes-task-dock-style" "Task Dock"
  install_file "${taskdock}" "${PLUGIN_ROOT}/task-dock/plugin.js"
  echo "Task Dock        -> ${PLUGIN_ROOT}/task-dock/plugin.js"
fi

echo
echo "Finish: in Hermes Desktop press Cmd+Shift+P -> 'Reload plugins' (or restart the app)."
echo "Bubble Mode toggle: Cmd+Shift+P -> 'Bubble Mode: toggle'."
echo "Bot Sections toggle: Cmd+Shift+P -> 'Bot Sections: toggle'."
echo "Task Dock toggle: Cmd+Shift+P -> 'Task Dock: toggle'."
echo "Computer pane: enable 'Computer' in Settings -> Plugins, then add a computer."
