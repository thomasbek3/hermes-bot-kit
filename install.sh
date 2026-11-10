#!/usr/bin/env bash
# Install the Hermes Bot Kit desktop plugins: Grokbot Override (switched on;
# the command palette switches back to stock Bot Mode) + the Computer viewer.
# Safe for agents to run unattended:
# idempotent, no prompts, no sudo, backs up any existing copy before overwriting.
#
#   curl -fsSL https://raw.githubusercontent.com/thomasbek3/hermes-bot-kit/v2026.11.10.3/install.sh | bash
#
# or from a clone:  bash install.sh
#
# Env knobs:
#   HERMES_HOME            Hermes home dir (default ~/.hermes)
#   KIT_REF                git ref to fetch (default v2026.11.10.3)
#   KIT_SOURCE_DIR         local checkout to copy from (auto-detected from a clone)
#   KIT_SKIP_VERIFY=1      skip digest checks (developer use only)
#   KIT_SKIP_COMPUTER=1    skip the Computer viewer
#   KIT_SKIP_GROKBOT=1     skip Grokbot Override
#   KIT_REMOVE_RETIRED=1   move this kit's retired plugin folders (Bubble Mode,
#                          Task Dock, Bot Sections) out of desktop-plugins/
#   KIT_CARDS_SKILL=1      also install the agent-cards skill (off by default)
#   KIT_CARDS_SKILL=remove remove the agent-cards skill this kit installed, then stop
#   KIT_CARDS_PROFILES     comma-separated profiles for the skill (default: all)
set -euo pipefail

KIT_REF="${KIT_REF:-v2026.11.10.3}"
RAW_BASE="https://raw.githubusercontent.com/thomasbek3/hermes-bot-kit/${KIT_REF}"
PLUGIN_ROOT="${HERMES_HOME:-$HOME/.hermes}/desktop-plugins"
GROKBOT_REL="grokbot-override/plugin.js"
HERMES_ROOT="${HERMES_HOME:-$HOME/.hermes}"
CARDS_REL="grokbot-override/skills/agent-cards/SKILL.md"
# The kit's copy says so in its front matter; any other agent-cards skill is
# the user's own and is never replaced or removed.
CARDS_MARKER="hermes-bot-kit:"

usage() {
  cat <<'EOF'
Install the Hermes Bot Kit desktop plugins.

  curl -fsSL https://raw.githubusercontent.com/thomasbek3/hermes-bot-kit/v2026.11.10.3/install.sh | bash

or from a clone:  bash install.sh

Env knobs:
  HERMES_HOME            Hermes home dir (default ~/.hermes)
  KIT_REF                git ref to fetch (default v2026.11.10.3)
  KIT_SOURCE_DIR         local checkout to copy from
  KIT_SKIP_VERIFY=1      skip digest checks (developer use only)
  KIT_SKIP_COMPUTER=1    skip the Computer viewer
  KIT_SKIP_GROKBOT=1     skip Grokbot Override (installed switched on)
  KIT_REMOVE_RETIRED=1   move this kit's retired plugin folders (bubble-mode,
                         task-dock, bot-sections; only copies carrying this
                         kit's marker) to desktop-plugins-retired-<YYYYMMDD>/
                         next to desktop-plugins/ (nothing is deleted)
  KIT_CARDS_SKILL=1      also install the agent-cards skill (cards in the
                         Grokbot Override chat) into the skills folder of the
                         default profile and every profile (off by default)
  KIT_CARDS_SKILL=remove remove the agent-cards skill this kit installed from
                         those folders, then stop (installs nothing)
  KIT_CARDS_PROFILES     comma-separated profiles for the skill, e.g.
                         default,helper ("default" is the root Hermes home)
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

case "${KIT_CARDS_SKILL:-0}" in
  0|1|remove) ;;
  *)
    echo "install.sh: KIT_CARDS_SKILL must be 1 or remove (got '${KIT_CARDS_SKILL}')" >&2
    exit 2
    ;;
esac

# Hermes homes that get the agent-cards skill: the root home ("default") and
# each profile home under profiles/, or just KIT_CARDS_PROFILES.
cards_homes() {
  local name dir
  if [ -n "${KIT_CARDS_PROFILES:-}" ]; then
    printf '%s\n' "${KIT_CARDS_PROFILES}" | tr ',' '\n' | while IFS= read -r name; do
      name=$(printf '%s' "${name}" | tr -d '[:space:]')
      [ -n "${name}" ] || continue
      case "${name}" in
        default) printf '%s\n' "${HERMES_ROOT}" ;;
        *[!A-Za-z0-9._-]*|.|..)
          echo "install.sh: skipping profile name '${name}' (letters, digits, . _ - only)" >&2
          ;;
        *)
          if [ -d "${HERMES_ROOT}/profiles/${name}" ]; then
            printf '%s\n' "${HERMES_ROOT}/profiles/${name}"
          else
            echo "install.sh: no profile '${name}' under ${HERMES_ROOT}/profiles; skipping it" >&2
          fi
          ;;
      esac
    done
    return 0
  fi
  printf '%s\n' "${HERMES_ROOT}"
  if [ -d "${HERMES_ROOT}/profiles" ]; then
    for dir in "${HERMES_ROOT}/profiles"/*/; do
      [ -d "${dir}" ] || continue
      printf '%s\n' "${dir%/}"
    done
  fi
}

if [ "${KIT_CARDS_SKILL:-0}" = "remove" ]; then
  cards_homes | while IFS= read -r home; do
    [ -n "${home}" ] || continue
    dest="${home}/skills/agent-cards/SKILL.md"
    if [ ! -f "${dest}" ]; then
      echo "Cards skill      -- not installed in ${home}"
    elif grep -qF "${CARDS_MARKER}" "${dest}"; then
      rm -f "${dest}"
      rmdir "${home}/skills/agent-cards" 2>/dev/null || true
      echo "Cards skill      -- removed from ${home}"
    else
      echo "Cards skill      -- ${dest} is not this kit's copy; left alone"
    fi
  done
  echo
  echo "Done. Chats started before this keep the skill until their session restarts."
  exit 0
fi

SCRIPT_DIR=""
if [ -n "${BASH_SOURCE:-}" ] && [ -f "${BASH_SOURCE[0]:-}" ]; then
  SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
fi

SOURCE_DIR=""
if [ -n "${KIT_SOURCE_DIR:-}" ]; then
  SOURCE_DIR=$(CDPATH= cd -- "${KIT_SOURCE_DIR}" && pwd)
elif [ -n "${SCRIPT_DIR}" ] && [ -f "${SCRIPT_DIR}/computer-viewer/plugin.js" ]; then
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
    computer-viewer/plugin.js) printf '%s\n' "computer-viewer" ;;
    "${GROKBOT_REL}") printf '%s\n' "grokbot-override-style" ;;
  esac
}

js_label() {
  case "$1" in
    computer-viewer/plugin.js) printf '%s\n' "Computer viewer" ;;
    "${GROKBOT_REL}") printf '%s\n' "Grokbot Override" ;;
    *) printf '%s\n' "$1" ;;
  esac
}

# Where a staged file lands under desktop-plugins/: the same path.
dest_rel() {
  printf '%s\n' "$1"
}

# Plugins this kit used to install, with the marker their plugin.js carried.
# A folder without that marker is someone else's and is never touched.
RETIRED_PLUGINS="bubble-mode:hermes-bubble-mode-style task-dock:hermes-task-dock-style bot-sections:hermes-bot-sections-style"

retired_report() {
  local entry name marker file dest n found="" moved_to=""
  for entry in ${RETIRED_PLUGINS}; do
    name="${entry%%:*}"
    marker="${entry#*:}"
    file="${PLUGIN_ROOT}/${name}/plugin.js"
    [ -f "${file}" ] || continue
    grep -qF "${marker}" "${file}" || continue
    found="${found} ${name}"
  done
  [ -n "${found}" ] || return 0
  if [ "${KIT_REMOVE_RETIRED:-0}" = "1" ]; then
    moved_to="$(dirname -- "${PLUGIN_ROOT}")/desktop-plugins-retired-$(date +%Y%m%d)"
    mkdir -p "${moved_to}"
    for name in ${found}; do
      # Never into or over an earlier move from the same day.
      dest="${moved_to}/${name}"
      n=1
      while [ -e "${dest}" ]; do
        n=$((n + 1))
        dest="${moved_to}/${name}.${n}"
      done
      mv "${PLUGIN_ROOT}/${name}" "${dest}"
      echo "Retired          -- moved ${name} to ${dest}"
    done
  else
    echo
    echo "Retired plugins still installed:${found}. Bubble Mode, Task Dock and Bot Sections are no longer"
    echo "part of the kit (Grokbot Override has its own sections and work-rows setting)."
    echo "To move them out: KIT_REMOVE_RETIRED=1 bash install.sh (to desktop-plugins-retired-<date>/; nothing is deleted)."
  fi
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
  rmdir "${PLUGIN_ROOT}/grokbot-override" 2>/dev/null || true
  rmdir "${PLUGIN_ROOT}/computer-viewer/vendor" 2>/dev/null || true
  rmdir "${PLUGIN_ROOT}/computer-viewer" 2>/dev/null || true
  rmdir "${PLUGIN_ROOT}" 2>/dev/null || true
  if [ "${CARDS_INSTALLED:-0}" = "1" ]; then
    cards_homes 2>/dev/null | while IFS= read -r home; do
      [ -n "${home}" ] && rmdir "${home}/skills/agent-cards" 2>/dev/null || true
    done
  fi
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
if [ "${KIT_SKIP_GROKBOT:-0}" != "1" ]; then
  need "${GROKBOT_REL}"
fi
if [ "${KIT_CARDS_SKILL:-0}" = "1" ]; then
  need "${CARDS_REL}"
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

  # Releases before Grokbot Override joined the installer do not list it.
  GROKBOT_INSTALLED=0
  if grep -qxF "${GROKBOT_REL}" "${NEEDED_FILE}"; then
    if manifest_has "${GROKBOT_REL}"; then
      GROKBOT_INSTALLED=1
    else
      echo "install.sh: ${KIT_REF} has no Grokbot Override in its manifest; skipping it." >&2
      grep -vxF "${GROKBOT_REL}" "${NEEDED_FILE}" > "${NEEDED_FILE}.next" || true
      mv "${NEEDED_FILE}.next" "${NEEDED_FILE}"
    fi
  fi

  # Releases before the cards skill joined the installer do not list it.
  CARDS_INSTALLED=0
  if grep -qxF "${CARDS_REL}" "${NEEDED_FILE}"; then
    if manifest_has "${CARDS_REL}"; then
      CARDS_INSTALLED=1
    else
      echo "install.sh: ${KIT_REF} has no agent-cards skill in its manifest; skipping it." >&2
      grep -vxF "${CARDS_REL}" "${NEEDED_FILE}" > "${NEEDED_FILE}.next" || true
      mv "${NEEDED_FILE}.next" "${NEEDED_FILE}"
    fi
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
      "${CARDS_REL}")
        if [ "$(head -n 1 "${staged}")" != "---" ] || ! grep -qx 'name: agent-cards' "${staged}" || ! grep -qF "${CARDS_MARKER}" "${staged}"; then
          echo "install.sh: downloaded agent-cards skill does not look right; aborting" >&2
          exit 1
        fi
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
      [ "${rel}" = "${CARDS_REL}" ] && continue
      install_file "${TMP_DIR}/${rel}" "${PLUGIN_ROOT}/$(dest_rel "${rel}")"
    done < "${NEEDED_FILE}"
    if [ "${CARDS_INSTALLED}" = "1" ]; then
      cards_homes > "${TMP_DIR}/.cards-homes"
      : > "${TMP_DIR}/.cards-report"
      while IFS= read -r home; do
        [ -n "${home}" ] || continue
        dest="${home}/skills/agent-cards/SKILL.md"
        if [ -f "${dest}" ] && ! grep -qF "${CARDS_MARKER}" "${dest}"; then
          printf 'Cards skill      -- %s is your own agent-cards skill; left alone\n' "${dest}" >> "${TMP_DIR}/.cards-report"
          continue
        fi
        install_file "${TMP_DIR}/${CARDS_REL}" "${dest}"
        printf 'Cards skill      -> %s\n' "${dest}" >> "${TMP_DIR}/.cards-report"
      done < "${TMP_DIR}/.cards-homes"
    fi
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

  if [ "${KIT_SKIP_COMPUTER:-0}" != "1" ]; then
    echo "Computer viewer  -> ${PLUGIN_ROOT}/computer-viewer/plugin.js (+ helper scripts)"
  fi
  if [ "${GROKBOT_INSTALLED}" = "1" ]; then
    echo "Grokbot Override -> ${PLUGIN_ROOT}/grokbot-override/plugin.js (switched on unless you turned it off before)"
  fi
  if [ "${CARDS_INSTALLED}" = "1" ]; then
    cat "${TMP_DIR}/.cards-report"
  fi
fi

retired_report

echo
echo "Finish: in Hermes Desktop press Cmd+Shift+P -> 'Reload plugins' (or restart the app)."
if [ "${GROKBOT_INSTALLED:-0}" = "1" ]; then
  echo "Grokbot Override is on: Cmd+Shift+P -> 'Grokbot Override: toggle' switches back to stock Bot Mode (and on again)."
  echo "Sections: Bots roster + -> 'New section'. Work rows: Cmd+Shift+P -> 'Grokbot Override: show work rows'."
fi
echo "Computer pane: enable 'Computer' in Settings -> Plugins, then add a computer."
if [ "${CARDS_INSTALLED:-0}" = "1" ]; then
  echo "Cards skill: new chats load it; a chat started before keeps its old mode until its session restarts."
fi
