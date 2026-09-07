#!/usr/bin/env bash
# Install the Hermes Bot Kit desktop plugins: Bubble Mode + Computer viewer
# + Bot Sections + Task Dock. Safe for agents to run unattended: idempotent,
# no prompts, no sudo, backs up any existing copy before overwriting.
#
#   curl -fsSL https://raw.githubusercontent.com/thomasbek3/hermes-bot-kit/v2026.09.07/install.sh | bash
#
# or from a clone:  bash install.sh
#
# Env knobs:
#   HERMES_HOME            Hermes home dir (default ~/.hermes)
#   KIT_REF                git ref to fetch (default v2026.09.07)
#   KIT_SOURCE_DIR         local checkout to copy from (auto-detected from a clone)
#   KIT_SKIP_VERIFY=1      skip digest checks (developer use only)
#   KIT_SKIP_BUBBLES=1     skip Bubble Mode
#   KIT_SKIP_COMPUTER=1    skip the Computer viewer
#   KIT_SKIP_SECTIONS=1    skip Bot Sections
#   KIT_SKIP_TASK_DOCK=1   skip Task Dock
set -euo pipefail

KIT_REF="${KIT_REF:-v2026.09.07}"
RAW_BASE="https://raw.githubusercontent.com/thomasbek3/hermes-bot-kit/${KIT_REF}"
PLUGIN_ROOT="${HERMES_HOME:-$HOME/.hermes}/desktop-plugins"

usage() {
  cat <<'EOF'
Install the Hermes Bot Kit desktop plugins.

  curl -fsSL https://raw.githubusercontent.com/thomasbek3/hermes-bot-kit/v2026.09.07/install.sh | bash

or from a clone:  bash install.sh

Env knobs:
  HERMES_HOME            Hermes home dir (default ~/.hermes)
  KIT_REF                git ref to fetch (default v2026.09.07)
  KIT_SOURCE_DIR         local checkout to copy from
  KIT_SKIP_VERIFY=1      skip digest checks (developer use only)
  KIT_SKIP_BUBBLES=1     skip Bubble Mode
  KIT_SKIP_COMPUTER=1    skip the Computer viewer
  KIT_SKIP_SECTIONS=1    skip Bot Sections
  KIT_SKIP_TASK_DOCK=1   skip Task Dock
EOF
}

if [ "${1:-}" = "-h" ] || [ "${1:-}" = "--help" ]; then
  usage
  exit 0
fi

case "${KIT_REF}" in
  v*) ;;
  *)
    echo "WARNING: installing from mutable ref '${KIT_REF}'; no release manifest guarantees apply." >&2
    ;;
esac

SCRIPT_DIR=""
if [ -n "${BASH_SOURCE:-}" ] && [ -f "${BASH_SOURCE[0]:-}" ]; then
  SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
fi

SOURCE_DIR=""
if [ -n "${KIT_SOURCE_DIR:-}" ]; then
  SOURCE_DIR=$(CDPATH= cd -- "${KIT_SOURCE_DIR}" && pwd)
elif [ -n "${SCRIPT_DIR}" ] && [ -f "${SCRIPT_DIR}/bubble-mode/plugin.js" ]; then
  SOURCE_DIR="${SCRIPT_DIR}"
fi

TMP_DIR=$(mktemp -d)
NEEDED_FILE="${TMP_DIR}/.needed"
CREATED_FILE="${TMP_DIR}/.created"
BACKUPS_FILE="${TMP_DIR}/.backups"
MANIFEST="${TMP_DIR}/MANIFEST.sha256"
INSTALL_OK=1
: > "${NEEDED_FILE}"
: > "${CREATED_FILE}"
: > "${BACKUPS_FILE}"

trap '
  if [ "${INSTALL_OK}" = 0 ]; then
    echo "install.sh: copy failed; rolling back this run" >&2
    rollback_this_run
  fi
  rm -rf "${TMP_DIR}"
' EXIT

need() {
  printf '%s\n' "$1" >> "${NEEDED_FILE}"
}

file_sha256() {
  if command -v shasum >/dev/null 2>&1; then
    shasum -a 256 -- "$1" | awk '{print $1}'
  elif command -v sha256sum >/dev/null 2>&1; then
    sha256sum -- "$1" | awk '{print $1}'
  else
    echo "install.sh: need shasum or sha256sum" >&2
    exit 1
  fi
}

manifest_hash() {
  awk -v p="$1" '$2 == p { print $1; found=1; exit } END { if (!found) exit 1 }' "${MANIFEST}"
}

manifest_has() {
  awk -v p="$1" '$2 == p { found=1; exit } END { exit found ? 0 : 1 }' "${MANIFEST}"
}

stage_file() {
  local rel="$1" out="${TMP_DIR}/$1"
  mkdir -p "$(dirname -- "${out}")"
  if [ -n "${SOURCE_DIR}" ]; then
    if [ ! -f "${SOURCE_DIR}/${rel}" ]; then
      echo "install.sh: missing ${rel} in ${SOURCE_DIR}" >&2
      exit 1
    fi
    cp "${SOURCE_DIR}/${rel}" "${out}"
  else
    curl -fsSL "${RAW_BASE}/${rel}" -o "${out}"
  fi
}

js_marker() {
  case "$1" in
    bubble-mode/plugin.js) printf '%s\n' "hermes-bubble-mode-style" ;;
    computer-viewer/plugin.js) printf '%s\n' "computer-viewer" ;;
    bot-sections/plugin.js) printf '%s\n' "hermes-bot-sections-style" ;;
    task-dock/plugin.js) printf '%s\n' "hermes-task-dock-style" ;;
  esac
}

js_label() {
  case "$1" in
    bubble-mode/plugin.js) printf '%s\n' "Bubble Mode" ;;
    computer-viewer/plugin.js) printf '%s\n' "Computer viewer" ;;
    bot-sections/plugin.js) printf '%s\n' "Bot Sections" ;;
    task-dock/plugin.js) printf '%s\n' "Task Dock" ;;
    *) printf '%s\n' "$1" ;;
  esac
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

rollback_this_run() {
  local dest bak
  if [ -s "${BACKUPS_FILE}" ]; then
    while IFS="$(printf '\t')" read -r dest bak; do
      if [ -n "${dest}" ] && [ -f "${bak}" ]; then
        cp "${bak}" "${dest}"
        rm -f "${bak}"
      fi
    done < "${BACKUPS_FILE}"
  fi
  if [ -s "${CREATED_FILE}" ]; then
    while IFS= read -r dest; do
      [ -n "${dest}" ] || continue
      rm -f "${dest}"
    done < "${CREATED_FILE}"
  fi
  rmdir "${PLUGIN_ROOT}/bubble-mode" 2>/dev/null || true
  rmdir "${PLUGIN_ROOT}/bot-sections" 2>/dev/null || true
  rmdir "${PLUGIN_ROOT}/task-dock" 2>/dev/null || true
  rmdir "${PLUGIN_ROOT}/computer-viewer/vendor" 2>/dev/null || true
  rmdir "${PLUGIN_ROOT}/computer-viewer" 2>/dev/null || true
  rmdir "${PLUGIN_ROOT}" 2>/dev/null || true
}

install_file() {
  local src="$1" dest="$2" bak
  mkdir -p "$(dirname -- "${dest}")"
  if [ -f "${dest}" ]; then
    if ! cmp -s "${src}" "${dest}"; then
      bak="${dest}.bak.$(date +%Y%m%d%H%M%S)"
      cp "${dest}" "${bak}"
      printf '%s\t%s\n' "${dest}" "${bak}" >> "${BACKUPS_FILE}"
    fi
  else
    printf '%s\n' "${dest}" >> "${CREATED_FILE}"
  fi
  cp "${src}" "${dest}"
}

if [ "${KIT_SKIP_BUBBLES:-0}" != "1" ]; then
  need "bubble-mode/plugin.js"
fi
if [ "${KIT_SKIP_COMPUTER:-0}" != "1" ]; then
  need "computer-viewer/plugin.js"
  need "computer-viewer/connect-mac.sh"
  need "computer-viewer/connect-linux.sh"
  need "computer-viewer/hiperf-mac.sh"
  need "computer-viewer/hiperf-linux.sh"
  need "computer-viewer/connect-windows.ps1"
  need "computer-viewer/hiperf-windows.ps1"
  need "computer-viewer/hiperf-agent.py"
fi
if [ "${KIT_SKIP_SECTIONS:-0}" != "1" ]; then
  need "bot-sections/plugin.js"
fi
if [ "${KIT_SKIP_TASK_DOCK:-0}" != "1" ]; then
  need "task-dock/plugin.js"
fi

if [ ! -s "${NEEDED_FILE}" ]; then
  echo "install.sh: nothing to install (all plugins skipped)"
else
  # Phase 1: stage
  if [ -n "${SOURCE_DIR}" ]; then
    if [ ! -f "${SOURCE_DIR}/MANIFEST.sha256" ]; then
      echo "install.sh: MANIFEST.sha256 not found in ${SOURCE_DIR}" >&2
      exit 1
    fi
    cp "${SOURCE_DIR}/MANIFEST.sha256" "${MANIFEST}"
  else
    curl -fsSL "${RAW_BASE}/MANIFEST.sha256" -o "${MANIFEST}"
  fi

  if [ "${KIT_SKIP_COMPUTER:-0}" != "1" ] && manifest_has "computer-viewer/vendor/novnc-rfb.mjs"; then
    need "computer-viewer/vendor/novnc-rfb.mjs"
  fi

  while IFS= read -r rel; do
    [ -n "${rel}" ] || continue
    stage_file "${rel}"
  done < "${NEEDED_FILE}"

  # Phase 2: verify
  if [ "${KIT_SKIP_VERIFY:-0}" = "1" ]; then
    echo "WARNING: KIT_SKIP_VERIFY=1; skipping digest checks (developer use only)." >&2
  else
    while IFS= read -r rel; do
      [ -n "${rel}" ] || continue
      expected=$(manifest_hash "${rel}") || {
        echo "install.sh: ${rel} is missing from MANIFEST.sha256" >&2
        exit 1
      }
      actual=$(file_sha256 "${TMP_DIR}/${rel}")
      if [ "${expected}" != "${actual}" ]; then
        echo "install.sh: sha256 mismatch for ${rel}" >&2
        echo "  manifest: ${expected}" >&2
        echo "  staged:   ${actual}" >&2
        exit 1
      fi
    done < "${NEEDED_FILE}"
  fi

  # Phase 3: validate
  while IFS= read -r rel; do
    [ -n "${rel}" ] || continue
    staged="${TMP_DIR}/${rel}"
    case "${rel}" in
      *.js)
        marker=$(js_marker "${rel}")
        label=$(js_label "${rel}")
        if [ -n "${marker}" ]; then
          check_js "${staged}" "${marker}" "${label}"
        elif command -v node >/dev/null 2>&1; then
          node --check "${staged}" || {
            echo "install.sh: ${rel} failed syntax check; aborting" >&2
            exit 1
          }
        fi
        ;;
      *.sh)
        bash -n "${staged}" || {
          echo "install.sh: ${rel} failed bash -n; aborting" >&2
          exit 1
        }
        ;;
      *.py)
        if command -v python3 >/dev/null 2>&1; then
          PYTHONDONTWRITEBYTECODE=1 python3 -m py_compile "${staged}" || {
            echo "install.sh: ${rel} failed python compile; aborting" >&2
            exit 1
          }
        fi
        ;;
    esac
  done < "${NEEDED_FILE}"

  # Phase 4: install (atomic)
  install_all() {
    local rel
    while IFS= read -r rel; do
      [ -n "${rel}" ] || continue
      install_file "${TMP_DIR}/${rel}" "${PLUGIN_ROOT}/${rel}"
    done < "${NEEDED_FILE}"
    if [ "${KIT_SKIP_COMPUTER:-0}" != "1" ]; then
      # The hiperf helper scripts verify hiperf-agent.py against
      # MANIFEST.sha256, and fall back to a local copy when the network is
      # unavailable. Without this they had nothing to fall back to: put the
      # manifest one level above them, at desktop-plugins/MANIFEST.sha256.
      install_file "${MANIFEST}" "${PLUGIN_ROOT}/MANIFEST.sha256"
      chmod +x "${PLUGIN_ROOT}/computer-viewer/"*.sh
    fi
  }

  INSTALL_OK=0
  install_all
  INSTALL_OK=1

  if [ "${KIT_SKIP_BUBBLES:-0}" != "1" ]; then
    echo "Bubble Mode      -> ${PLUGIN_ROOT}/bubble-mode/plugin.js"
  fi
  if [ "${KIT_SKIP_COMPUTER:-0}" != "1" ]; then
    echo "Computer viewer  -> ${PLUGIN_ROOT}/computer-viewer/plugin.js (+ helper scripts)"
  fi
  if [ "${KIT_SKIP_SECTIONS:-0}" != "1" ]; then
    echo "Bot Sections     -> ${PLUGIN_ROOT}/bot-sections/plugin.js"
  fi
  if [ "${KIT_SKIP_TASK_DOCK:-0}" != "1" ]; then
    echo "Task Dock        -> ${PLUGIN_ROOT}/task-dock/plugin.js"
  fi
fi

echo
echo "Finish: in Hermes Desktop press Cmd+Shift+P -> 'Reload plugins' (or restart the app)."
echo "Bubble Mode toggle: Cmd+Shift+P -> 'Bubble Mode: toggle'."
echo "Bot Sections toggle: Cmd+Shift+P -> 'Bot Sections: toggle'."
echo "Task Dock toggle: Cmd+Shift+P -> 'Task Dock: toggle'."
echo "Computer pane: enable 'Computer' in Settings -> Plugins, then add a computer."
