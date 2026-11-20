#!/usr/bin/env bash
# Install the Hermes Bot Kit desktop plugins: Grokbot Override (switched on;
# the command palette switches back to stock Bot Mode) + the Computer viewer.
# Safe for agents to run unattended:
# idempotent, no prompts, no sudo, backs up any existing copy before overwriting.
#
#   ( set -e; f=$(mktemp); trap 'rm -f "$f"' EXIT; curl -fsSL https://raw.githubusercontent.com/thomasbek3/hermes-bot-kit/v2026.11.16.3/install.sh -o "$f"; test -s "$f"; bash "$f" )
#
# or from a clone:  bash install.sh
#
# Which release: the newest GitHub release (asked of the GitHub API), or the
# tag this script was published with when the API cannot be reached. Every file
# is checked against that release's MANIFEST.sha256 before anything is copied.
#
# Env knobs:
#   HERMES_HOME            Hermes home dir (default ~/.hermes)
#   KIT_REF                release tag to install (default: newest release,
#                          falling back to v2026.11.16.3)
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

# The tag this script was released with (scripts/release.sh rewrites it).
KIT_FALLBACK_REF="v2026.11.16.3"
KIT_REPO="thomasbek3/hermes-bot-kit"
KIT_RELEASES_API="${KIT_RELEASES_API:-https://api.github.com/repos/${KIT_REPO}/releases/latest}"
KIT_REF_FROM_USER="${KIT_REF:-}"
KIT_REF="${KIT_REF:-${KIT_FALLBACK_REF}}"
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

  ( set -e; f=$(mktemp); trap 'rm -f "$f"' EXIT; curl -fsSL https://raw.githubusercontent.com/thomasbek3/hermes-bot-kit/v2026.11.16.3/install.sh -o "$f"; test -s "$f"; bash "$f" )

or from a clone:  bash install.sh

Not working?  bash install.sh --doctor   (read-only checks; changes nothing)

Installs the newest GitHub release (falls back to v2026.11.16.3 when the
GitHub API cannot be reached) and checks every file against that release's
MANIFEST.sha256 before copying anything.

Env knobs:
  HERMES_HOME            Hermes home dir (default ~/.hermes)
  KIT_REF                release tag to install (default: newest release)
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

sha256_of() {
  if command -v shasum >/dev/null 2>&1; then
    shasum -a 256 -- "$1" | awk '{print $1}'
  else
    sha256sum -- "$1" | awk '{print $1}'
  fi
}

# --doctor: read-only checks (scripts/doctor.sh), changes nothing. From a real
# checkout (a .git beside this script, and the checkout's own doctor.sh owned
# by you and matching its MANIFEST.sha256) it runs that copy. Otherwise (the
# one-liner downloads this script alone into a temp dir, which can be a shared
# /tmp) it never runs anything sitting beside it: it downloads doctor.sh from
# the release this script came with (or KIT_REF) and runs it only if it matches
# that release's MANIFEST.sha256.
if [ "${1:-}" = "--doctor" ]; then
  shift
  # The doctor's fixes name only this release's pinned one-liners, never a
  # local file: it is told the tag and never looks for a checkout itself.
  doc_ref="${KIT_REF_FROM_USER:-${KIT_FALLBACK_REF}}"
  [ "${doc_ref}" = "latest" ] && doc_ref="${KIT_FALLBACK_REF}"
  export DOCTOR_KIT_REF="${doc_ref}" DOCTOR_NO_CHECKOUT=1
  doc_dir=""
  if [ -n "${KIT_SOURCE_DIR:-}" ]; then
    doc_dir=$(CDPATH= cd -- "${KIT_SOURCE_DIR}" && pwd)
  elif [ -n "${BASH_SOURCE:-}" ] && [ -f "${BASH_SOURCE[0]:-}" ]; then
    doc_dir=$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
  fi
  if [ -n "${doc_dir}" ] && [ -e "${doc_dir}/.git" ] && [ -O "${doc_dir}/scripts/doctor.sh" ] && [ -O "${doc_dir}/MANIFEST.sha256" ]; then
    doc_want=$(awk '$2 == "scripts/doctor.sh" { print $1; exit }' "${doc_dir}/MANIFEST.sha256")
    if [ -n "${doc_want}" ] && [ "$(sha256_of "${doc_dir}/scripts/doctor.sh")" = "${doc_want}" ]; then
      exec bash "${doc_dir}/scripts/doctor.sh" "$@"
    fi
  fi
  doc_tmp=$(mktemp -d)
  trap 'rm -rf "${doc_tmp}"' EXIT
  doc_base="https://raw.githubusercontent.com/${KIT_REPO}/${doc_ref}"
  curl -fsSL --connect-timeout 10 --max-time 60 --retry 2 --retry-delay 2 --max-filesize 1048576 \
    "${doc_base}/MANIFEST.sha256" -o "${doc_tmp}/MANIFEST.sha256" || {
    echo "install.sh: could not download MANIFEST.sha256 for ${doc_ref}" >&2
    exit 1
  }
  doc_want=$(awk '$2 == "scripts/doctor.sh" { print $1; exit }' "${doc_tmp}/MANIFEST.sha256")
  if [ -z "${doc_want}" ]; then
    echo "install.sh: release ${doc_ref} has no doctor; run it from a newer release: KIT_REF=<tag> bash install.sh --doctor" >&2
    exit 1
  fi
  curl -fsSL --connect-timeout 10 --max-time 60 --retry 2 --retry-delay 2 --max-filesize 1048576 \
    "${doc_base}/scripts/doctor.sh" -o "${doc_tmp}/doctor.sh" || {
    echo "install.sh: could not download scripts/doctor.sh for ${doc_ref}" >&2
    exit 1
  }
  if [ "$(sha256_of "${doc_tmp}/doctor.sh")" != "${doc_want}" ]; then
    echo "install.sh: sha256 mismatch for scripts/doctor.sh (${doc_ref}); not running it" >&2
    exit 1
  fi
  doc_rc=0
  bash "${doc_tmp}/doctor.sh" "$@" || doc_rc=$?
  exit "${doc_rc}"
fi

# vYYYY.MM.DD or vYYYY.MM.DD.N: the only shape a release tag has.
is_release_tag() {
  printf '%s\n' "$1" | grep -Eqx 'v[0-9]{4}\.[0-9]{2}\.[0-9]{2}(\.[0-9]{1,3})?'
}

# Numeric compare of two release tags: true when $1 is older than $2.
tag_older_than() {
  awk -v a="${1#v}" -v b="${2#v}" 'BEGIN {
    na = split(a, x, "."); nb = split(b, y, ".")
    for (i = 1; i <= 4; i++) { p = (i <= na) ? x[i] + 0 : 0; q = (i <= nb) ? y[i] + 0 : 0
      if (p < q) exit 0; if (p > q) exit 1 }
    exit 1 }'
}

# The newest release's tag from the GitHub API, or nothing (no network, rate
# limit, an unexpected answer). Only a well-formed release tag is accepted.
latest_release_tag() {
  local body tag
  command -v curl >/dev/null 2>&1 || return 1
  body=$(curl -fsSL --connect-timeout 5 --max-time 15 -H 'Accept: application/vnd.github+json' "${KIT_RELEASES_API}" 2>/dev/null) || return 1
  tag=$(printf '%s' "${body}" | tr -d '\r\n' | sed -n 's/.*"tag_name"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p')
  is_release_tag "${tag}" || return 1
  printf '%s\n' "${tag}"
}

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
elif [ -n "${SCRIPT_DIR}" ] && [ -f "${SCRIPT_DIR}/computer-viewer/plugin.js" ] &&
  [ -e "${SCRIPT_DIR}/.git" ] && [ -O "${SCRIPT_DIR}/.git" ] && [ -O "${SCRIPT_DIR}/MANIFEST.sha256" ]; then
  # Only a real checkout you own copies from the files beside this script.
  # The one-liner downloads install.sh alone into a temp dir, which can be a
  # shared /tmp: plugin files someone else put next to it are never used
  # (set KIT_SOURCE_DIR to copy from an unpacked zip on purpose).
  SOURCE_DIR="${SCRIPT_DIR}"
fi

# Which release to fetch (not needed when copying from a local checkout).
if [ -z "${SOURCE_DIR}" ]; then
  if [ -z "${KIT_REF_FROM_USER}" ] || [ "${KIT_REF_FROM_USER}" = "latest" ]; then
    if resolved=$(latest_release_tag) && ! tag_older_than "${resolved}" "${KIT_FALLBACK_REF}"; then
      KIT_REF="${resolved}"
      echo "Release          -> ${KIT_REF} (newest GitHub release)"
    elif [ -n "${resolved:-}" ]; then
      # Never install a release older than the one this script came with.
      KIT_REF="${KIT_FALLBACK_REF}"
      echo "Release          -> ${KIT_REF} (the newest GitHub release, ${resolved}, is older than this script's own)"
    else
      KIT_REF="${KIT_FALLBACK_REF}"
      echo "Release          -> ${KIT_REF} (GitHub API not reachable; using the tag this script was released with)"
    fi
  else
    KIT_REF="${KIT_REF_FROM_USER}"
    echo "Release          -> ${KIT_REF} (KIT_REF)"
    if ! is_release_tag "${KIT_REF}"; then
      echo "WARNING: installing from mutable ref '${KIT_REF}'; no release manifest guarantees apply." >&2
    fi
  fi
else
  echo "Release          -> local checkout ${SOURCE_DIR}"
fi
RAW_BASE="https://raw.githubusercontent.com/${KIT_REPO}/${KIT_REF}"

# What this kit installed last time (written atomically as the last step of a
# successful install):
# release=<tag or local> and plugins=<desktop plugins>.
INSTALL_RECORD="${PLUGIN_ROOT}/.hermes-bot-kit-install"
recorded_release() {
  [ -f "${INSTALL_RECORD}" ] || return 1
  sed -n 's/^release=//p' "${INSTALL_RECORD}" | head -n 1
}

# An automatic choice (no KIT_REF) never replaces a newer installed release:
# a stale API answer or the fallback tag would otherwise downgrade it. An
# explicit KIT_REF is the deliberate way to go back.
if [ -z "${SOURCE_DIR}" ] && { [ -z "${KIT_REF_FROM_USER}" ] || [ "${KIT_REF_FROM_USER}" = "latest" ]; }; then
  installed=$(recorded_release || true)
  if [ -n "${installed}" ] && is_release_tag "${installed}" && tag_older_than "${KIT_REF}" "${installed}"; then
    echo "Release          -- ${installed} is installed, newer than ${KIT_REF}; keeping it."
    echo "                    To go back on purpose: KIT_REF=${KIT_REF} bash install.sh"
    exit 0
  fi
fi

# Downloads are bounded in time and size; a stalled or huge answer fails.
CURL_MANIFEST=(curl -fsSL --connect-timeout 10 --max-time 60 --retry 2 --retry-delay 2 --max-filesize 1048576)
CURL_PAYLOAD=(curl -fsSL --connect-timeout 10 --max-time 300 --retry 2 --retry-delay 2 --max-filesize 52428800)

# The first release whose manifest lists each component. A release older than
# that may lack it (the component is skipped); any newer manifest that lacks a
# selected component is incomplete and nothing is installed.
FIRST_GROKBOT_REF="v2026.11.10"
FIRST_CARDS_REF="v2026.11.09.1"
FIRST_NOVNC_REF="v2026.09.06"
predates() {
  # predates <component's first release>: the ref being installed is a
  # release tag older than that.
  [ -z "${SOURCE_DIR}" ] && is_release_tag "${KIT_REF}" && tag_older_than "${KIT_REF}" "$1"
}

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

# The optional compile check of the HD helper needs a Python 3 that works.
# Apple's /usr/bin/python3 is a stub until the Command Line Tools are
# installed: running it pops an install dialog and fails, so it is never run
# then. Any other python3 gets a quick probe with a time limit.
KIT_CLT_STUB_PATHS="${KIT_CLT_STUB_PATHS:-/usr/bin/python3}"
KIT_PYTHON_TIMEOUT="${KIT_PYTHON_TIMEOUT:-10}"
PYTHON=""
PYTHON_CHECKED=0
# limited <command...>: run it with KIT_PYTHON_TIMEOUT seconds at most (macOS
# has no timeout(1); perl's alarm survives the exec and is always there).
limited() {
  if command -v timeout >/dev/null 2>&1; then
    timeout "${KIT_PYTHON_TIMEOUT}" "$@"
  elif command -v perl >/dev/null 2>&1; then
    perl -e 'alarm shift @ARGV; exec { $ARGV[0] } @ARGV or exit 127' "${KIT_PYTHON_TIMEOUT}" "$@"
  else
    "$@"
  fi
}
find_python() {
  # Sets PYTHON to a python3 that runs, or "" when there is none.
  local py stub
  [ "${PYTHON_CHECKED}" = 1 ] && return 0
  PYTHON_CHECKED=1
  py=$(command -v python3 2>/dev/null) || return 0
  if command -v xcode-select >/dev/null 2>&1 && ! xcode-select -p >/dev/null 2>&1; then
    for stub in ${KIT_CLT_STUB_PATHS}; do
      [ "${py}" = "${stub}" ] && return 0
    done
  fi
  limited "${py}" -c 'import sys' </dev/null >/dev/null 2>&1 || return 0
  PYTHON="${py}"
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
    "${CURL_PAYLOAD[@]}" "${RAW_BASE}/${rel}" -o "${out}"
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

# The kit's old agent plugin (per profile, under <home>/plugins/). The kit no
# longer ships it; its own remover undoes the install, so this only reports.
retired_agent_report() {
  local dir found=""
  for dir in "${HERMES_ROOT}" "${HERMES_ROOT}"/profiles/*; do
    [ -d "${dir}/plugins/orgo-computer" ] || continue
    found="${found} ${dir}"
  done
  [ -n "${found}" ] || return 0
  echo
  echo "Retired agent plugin still installed: orgo-computer (in${found})."
  echo "Bots now drive machines with Hermes's own computer_use tool. To remove it (dry run first, then --yes):"
  if [ -n "${SOURCE_DIR}" ] && [ -f "${SOURCE_DIR}/computer-viewer/remove-orgo-computer.sh" ]; then
    echo "  bash ${SOURCE_DIR}/computer-viewer/remove-orgo-computer.sh"
  else
    echo "  bash <(curl -fsSL https://raw.githubusercontent.com/thomasbek3/hermes-bot-kit/${KIT_REF}/computer-viewer/remove-orgo-computer.sh)"
  fi
}

check_js() {
  local file="$1" marker="$2" label="$3"
  grep -q "${marker}" "${file}" || {
    echo "install.sh: downloaded ${label} does not look right; aborting" >&2
    exit 1
  }
  # The plugins are ES modules: parse them as one whatever Node's default is
  # (older Node, or NODE_OPTIONS=--no-experimental-detect-module).
  if command -v node >/dev/null 2>&1; then
    node --input-type=module --check < "${file}" || {
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
    "${CURL_MANIFEST[@]}" "${RAW_BASE}/MANIFEST.sha256" -o "${MANIFEST}"
  fi
  if [ ! -s "${MANIFEST}" ]; then
    echo "install.sh: MANIFEST.sha256 for ${KIT_REF} is empty; nothing installed" >&2
    exit 1
  fi

  incomplete() {
    echo "install.sh: MANIFEST.sha256 for ${KIT_REF} does not list $1; it is incomplete, so nothing was installed" >&2
    exit 1
  }

  if [ "${KIT_SKIP_COMPUTER:-0}" != "1" ]; then
    if manifest_has "computer-viewer/vendor/novnc-rfb.mjs"; then
      need "computer-viewer/vendor/novnc-rfb.mjs"
    elif ! predates "${FIRST_NOVNC_REF}"; then
      incomplete "computer-viewer/vendor/novnc-rfb.mjs"
    fi
  fi

  # Releases before Grokbot Override joined the installer do not list it.
  GROKBOT_INSTALLED=0
  if grep -qxF "${GROKBOT_REL}" "${NEEDED_FILE}"; then
    if manifest_has "${GROKBOT_REL}"; then
      GROKBOT_INSTALLED=1
    elif ! predates "${FIRST_GROKBOT_REF}"; then
      incomplete "${GROKBOT_REL}"
    else
      echo "install.sh: ${KIT_REF} predates Grokbot Override; skipping it." >&2
      grep -vxF "${GROKBOT_REL}" "${NEEDED_FILE}" > "${NEEDED_FILE}.next" || true
      mv "${NEEDED_FILE}.next" "${NEEDED_FILE}"
    fi
  fi

  # Releases before the cards skill joined the installer do not list it.
  CARDS_INSTALLED=0
  if grep -qxF "${CARDS_REL}" "${NEEDED_FILE}"; then
    if manifest_has "${CARDS_REL}"; then
      CARDS_INSTALLED=1
    elif ! predates "${FIRST_CARDS_REF}"; then
      incomplete "${CARDS_REL}"
    else
      echo "install.sh: ${KIT_REF} predates the agent-cards skill; skipping it." >&2
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
          node --input-type=module --check < "${staged}" || {
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
        find_python
        if [ -n "${PYTHON}" ]; then
          PYTHONDONTWRITEBYTECODE=1 limited "${PYTHON}" -m py_compile "${staged}" </dev/null || {
            echo "install.sh: ${rel} failed python compile; aborting" >&2
            exit 1
          }
        else
          echo "INFO: no working Python 3 here, so the optional compile check of ${rel} (the HD helper) was skipped; the digest check does not need Python. To include it, install Python 3 or the Command Line Tools (xcode-select --install), then run the installer again."
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
    # The release's manifest sits next to the plugins (desktop-plugins/
    # MANIFEST.sha256): the hiperf helper scripts fall back to it offline,
    # and AGENTS.md's verify step checks the installed plugins against it.
    if [ "${KIT_SKIP_COMPUTER:-0}" != "1" ] || [ "${GROKBOT_INSTALLED}" = "1" ]; then
      install_file "${MANIFEST}" "${PLUGIN_ROOT}/MANIFEST.sha256"
    fi
    if [ "${KIT_SKIP_COMPUTER:-0}" != "1" ]; then
      chmod +x "${PLUGIN_ROOT}/computer-viewer/"*.sh
    fi
    write_record
  }

  # Last action of the protected step: record what was installed (release and
  # desktop plugins) for the verify step and the next run's downgrade check.
  # A temp file in the same folder, then one rename: the record is either the
  # previous one or the new one. The temp file is listed as created, so a
  # failure before the rename rolls it back with everything else.
  write_record() {
    local plugins="" release="${KIT_REF}" tmp
    [ "${KIT_SKIP_COMPUTER:-0}" != "1" ] && plugins="computer-viewer"
    [ "${GROKBOT_INSTALLED}" = "1" ] && plugins="${plugins:+${plugins} }grokbot-override"
    [ -n "${plugins}" ] || return 0
    [ -n "${SOURCE_DIR}" ] && release="local"
    tmp=$(mktemp "${PLUGIN_ROOT}/.hermes-bot-kit-install.XXXXXX")
    printf '%s\n' "${tmp}" >> "${CREATED_FILE}"
    printf 'release=%s\nplugins=%s\n' "${release}" "${plugins}" > "${tmp}"
    chmod 0644 "${tmp}"
    mv -f "${tmp}" "${INSTALL_RECORD}"
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
retired_agent_report

echo
echo "Finish: in Hermes Desktop press Cmd+K (Ctrl+K on Linux) -> 'Reload desktop plugins', or quit and reopen the app."
echo "Not working? Run the same install command with --doctor after it (see the README's Troubleshooting): it says what to fix."
if [ "${GROKBOT_INSTALLED:-0}" = "1" ]; then
  echo "Grokbot Override is on: Cmd+K -> 'Grokbot Override: toggle' switches back to stock Bot Mode (and on again)."
  echo "Sections: Bots roster + -> 'New section'. Work rows: Cmd+K -> 'Grokbot Override: show work rows'."
fi
if [ "${KIT_SKIP_COMPUTER:-0}" != "1" ]; then
  echo "Computer pane: on by default (Capabilities -> Plugins -> Computer if you switched it off); add a computer in the pane."
fi
if [ "${CARDS_INSTALLED:-0}" = "1" ]; then
  echo "Cards skill: new chats load it; a chat started before keeps its old mode until its session restarts."
fi
