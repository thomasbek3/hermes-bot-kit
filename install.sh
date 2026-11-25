#!/usr/bin/env bash
# Install the Hermes Bot Kit desktop plugins: Grokbot Override (switched on;
# the command palette switches back to stock Bot Mode) + the Computer viewer.
# Safe for agents to run unattended:
# idempotent, no prompts, no sudo, backs up any existing copy before overwriting.
#
#   ( set -e; f=$(mktemp); trap 'rm -f "$f"' EXIT; curl -fsSL https://raw.githubusercontent.com/thomasbek3/hermes-bot-kit/v2026.11.22/install.sh -o "$f"; test -s "$f"; bash "$f" )
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
#                          falling back to v2026.11.22)
#   KIT_SOURCE_DIR         local checkout to copy from (auto-detected from a clone)
#   KIT_SKIP_VERIFY=1      skip digest checks (developer use only)
#   KIT_SKIP_COMPUTER=1    skip the Computer viewer
#   KIT_SKIP_GROKBOT=1     skip Grokbot Override
#   KIT_REMOVE_RETIRED=1   move this kit's retired plugin folders (Bubble Mode,
#                          Task Dock, Bot Sections) out of desktop-plugins/
#   KIT_CARDS_SKILL=1      also install the agent-cards skill (off by default)
#   KIT_CARDS_SKILL=remove remove the agent-cards skill this kit installed, then stop
#   KIT_CARDS_PROFILES     comma-separated profiles for the skill (default: all)
#
# Daily auto-update (macOS and Linux):  bash install.sh --auto-update on|off|status|run
#   `on` remembers HERMES_HOME, KIT_SKIP_GROKBOT, KIT_SKIP_COMPUTER,
#   KIT_TEXTING_STYLE=1 (also refresh texting-style copies) and
#   KIT_POST_UPDATE_HOOK=/abs/path (your own script, run after each update).
#
# Uninstall:  bash install.sh --uninstall   (auto-update off first, then the
#   desktop plugins and the kit's records moved aside; nothing is deleted)
set -euo pipefail

# The tag this script was released with (scripts/release.sh rewrites it).
KIT_FALLBACK_REF="v2026.11.22"
KIT_REPO="thomasbek3/hermes-bot-kit"
# This installer has --auto-update: the updater only ever replaces its own
# copy (update.sh) with an install.sh that carries this exact line.
KIT_AUTO_UPDATE_API=1
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

  ( set -e; f=$(mktemp); trap 'rm -f "$f"' EXIT; curl -fsSL https://raw.githubusercontent.com/thomasbek3/hermes-bot-kit/v2026.11.22/install.sh -o "$f"; test -s "$f"; bash "$f" )

or from a clone:  bash install.sh

Not working?  bash install.sh --doctor   (read-only checks; changes nothing)
Keep it updated:  bash install.sh --auto-update on   (daily, newest release;
                  also off, status, run; macOS and Linux)
Uninstall:        bash install.sh --uninstall   (auto-update off, then the desktop
                  plugins and records moved aside; agent plugins are listed, not touched)

Installs the newest GitHub release (falls back to v2026.11.22 when the
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

# --- Auto-update: install.sh --auto-update on|off|status|run -------------------
# Hermes's own plugin auto-update never touches desktop-plugins/, so the kit
# keeps itself current: `on` stores the knobs that apply (no secrets) in
# <home>/hermes-bot-kit/auto-update.env, copies this script to
# <home>/hermes-bot-kit/update.sh and installs a per-user daily job (macOS
# LaunchAgent, Linux systemd user timer, else a crontab line to add) that runs
# `update.sh --auto-update run` at 04:20 local time. `run` installs the newest
# release when it is newer than <home>/hermes-bot-kit/installed-release, with
# KIT_REF=<tag> and the same per-file manifest checks as a manual install. It
# never restarts Hermes, the gateway or Desktop. One line per run goes to
# <home>/logs/hermes-bot-kit-update.log.
#
# Test overrides (never needed in normal use): KIT_LAUNCHCTL, KIT_SYSTEMCTL
# (commands to use instead of launchctl / systemctl), KIT_UPDATE_OS (mac,
# linux, wsl or windows instead of asking uname), KIT_UPDATE_NOW (the time,
# in epoch seconds, for log lines and the next-run time).
AU_LABEL="io.github.thomasbek3.hermes-bot-kit.update"
AU_UNIT="hermes-bot-kit-update"
AU_HOUR=4
AU_MIN=20
AU_LOG_MAX=1048576

au_paths() {
  KIT_STATE_DIR="${HERMES_ROOT}/hermes-bot-kit"
  AU_ENV="${KIT_STATE_DIR}/auto-update.env"
  AU_SCRIPT="${KIT_STATE_DIR}/update.sh"
  AU_LOCK="${KIT_STATE_DIR}/update.lock"
  INSTALLED_RELEASE="${KIT_STATE_DIR}/installed-release"
  AU_LOG="${HERMES_ROOT}/logs/hermes-bot-kit-update.log"
  AU_OUT="${HERMES_ROOT}/logs/hermes-bot-kit-update.last-run.log"
  AU_PLIST="${HOME}/Library/LaunchAgents/${AU_LABEL}.plist"
  AU_UNIT_DIR="${XDG_CONFIG_HOME:-${HOME}/.config}/systemd/user"
}
au_paths

# The one place HERMES_HOME is normalised for on, off, status and run: no
# trailing slash, and the physical path (symlinks, . and .. resolved) when
# the folder exists, so every subcommand, whichever spelling of the home it
# is given, names the same files and the same job.
au_norm_home() {
  local h="${HERMES_ROOT}"
  while [ "${#h}" -gt 1 ] && [ "${h%/}" != "${h}" ]; do h="${h%/}"; done
  if [ -d "${h}" ]; then
    h=$(CDPATH= cd -P -- "${h}" && pwd -P)
  fi
  HERMES_ROOT="${h}"
  PLUGIN_ROOT="${h}/desktop-plugins"
  au_paths
}

# Written on every successful install, manual or automatic: the release tag,
# or "local" for a copy from a checkout. The updater compares against it.
write_installed_release() {
  local tmp
  mkdir -p "${KIT_STATE_DIR}" || return 1
  tmp=$(mktemp "${KIT_STATE_DIR}/.installed-release.XXXXXX") || return 1
  printf '%s\n' "$1" > "${tmp}" && chmod 0644 "${tmp}" && mv -f "${tmp}" "${INSTALLED_RELEASE}"
}

au_installed() {
  # The last installed release: installed-release, else (an install from
  # before the updater existed) the desktop-plugins install record.
  local r=""
  [ -f "${INSTALLED_RELEASE}" ] && r=$(head -n 1 "${INSTALLED_RELEASE}")
  if [ -z "${r}" ] && [ -f "${PLUGIN_ROOT}/.hermes-bot-kit-install" ]; then
    r=$(sed -n 's/^release=//p' "${PLUGIN_ROOT}/.hermes-bot-kit-install" | head -n 1)
  fi
  printf '%s\n' "${r}"
}

au_now() {
  case "${KIT_UPDATE_NOW:-}" in
    '') date +%s ;;
    *[!0-9]*) echo "install.sh: KIT_UPDATE_NOW must be epoch seconds" >&2; date +%s ;;
    *) printf '%s\n' "${KIT_UPDATE_NOW}" ;;
  esac
}
au_fmt() {
  # au_fmt <epoch seconds> <date format>, local time (BSD date, then GNU date).
  date -r "$1" "+$2" 2>/dev/null || date -d "@$1" "+$2"
}

au_os() {
  if [ -n "${KIT_UPDATE_OS:-}" ]; then
    printf '%s\n' "${KIT_UPDATE_OS}"
    return 0
  fi
  case "$(uname -s 2>/dev/null)" in
    Darwin) echo mac ;;
    Linux)
      if grep -qiE 'microsoft|wsl' /proc/version 2>/dev/null; then echo wsl; else echo linux; fi
      ;;
    MINGW*|MSYS*|CYGWIN*) echo windows ;;
    *) echo other ;;
  esac
}

au_flag() {
  # au_flag <name> <value>: prints 0 or 1, fails on anything else.
  case "$2" in
    ''|0) echo 0 ;;
    1) echo 1 ;;
    *) echo "install.sh: $1 must be 0 or 1 (got '$2')" >&2; return 1 ;;
  esac
}

# A path that goes into a plist, a systemd unit or a crontab line unquoted
# by anything smarter: absolute, no control characters, no quotes, $, %, \,
# backquote or XML specials.
au_safe_path() {
  case "$1" in /*) ;; *) return 1 ;; esac
  case "$1" in *[[:cntrl:]]*|*[\"\\\$%\'\`\<\>\&]*) return 1 ;; esac
  return 0
}

au_mode() {
  stat -c %a -- "$1" 2>/dev/null || stat -f %Lp -- "$1" 2>/dev/null
}
au_mtime() {
  stat -c %Y -- "$1" 2>/dev/null || stat -f %m -- "$1" 2>/dev/null
}
# Owner uid and mode of what a path points at (symlinks followed).
au_uid_l() {
  stat -L -c %u -- "$1" 2>/dev/null || stat -L -f %u -- "$1" 2>/dev/null
}
au_mode_l() {
  stat -L -c %a -- "$1" 2>/dev/null || stat -L -f %Lp -- "$1" 2>/dev/null
}

# au_dir_problem <dir>: prints why someone else could change what is in the
# folder, or nothing: it must be owned by you or root and not writable by
# group or others, unless it is sticky (like /tmp: others can't rename or
# delete what you own in it, and the next folder down is checked as well).
au_dir_problem() {
  local d="$1" uid mode me
  me=$(id -u)
  uid=$(au_uid_l "${d}")
  mode=$(au_mode_l "${d}")
  case "${uid}:${mode}" in
    *[!0-9:]*|:*|*:) echo "has a folder above it whose owner or permissions could not be read (${d})"; return 0 ;;
  esac
  if [ "${uid}" != "${me}" ] && [ "${uid}" != 0 ]; then
    echo "has a folder above it owned by someone else (${d})"
    return 0
  fi
  if [ $((8#${mode} & 022)) -ne 0 ] && [ $((8#${mode} & 01000)) -eq 0 ]; then
    echo "has a folder above it that group or others can write to (${d}, mode ${mode})"
    return 0
  fi
  return 0
}

# au_hook_problem <path>: prints why the post-update hook can't be used, or
# nothing when it can (an absolute path to an existing regular file you own,
# executable, not a symlink, not writable by group or others).
au_hook_problem() {
  local p="$1" mode
  case "${p}" in /*) ;; *) echo "is not an absolute path"; return 0 ;; esac
  case "${p}" in *[[:cntrl:]]*) echo "has a control character in it"; return 0 ;; esac
  if [ -L "${p}" ]; then echo "is a symlink (point at the file itself)"; return 0; fi
  if [ ! -f "${p}" ]; then echo "is not an existing file"; return 0; fi
  if [ ! -O "${p}" ]; then echo "is not owned by you"; return 0; fi
  mode=$(au_mode "${p}")
  case "${mode}" in
    ''|*[!0-7]*) echo "has permissions that could not be read"; return 0 ;;
  esac
  if [ $((8#${mode} & 022)) -ne 0 ]; then echo "is writable by group or others (mode ${mode}; chmod go-w it)"; return 0; fi
  if [ ! -x "${p}" ]; then echo "is not executable (chmod u+x it)"; return 0; fi
  # Every folder above it, up to /, on the path as written AND on the path
  # it resolves to (a symlinked folder leads elsewhere: the folders above its
  # target count too): nobody else may be able to swap the file or a folder
  # on the way to it between this check and the run.
  local d problem real
  real=$(CDPATH= cd -P -- "$(dirname -- "${p}")" 2>/dev/null && pwd -P) || {
    echo "is in a folder that could not be resolved"
    return 0
  }
  for d in "$(dirname -- "${p}")" "${real}"; do
    while :; do
      problem=$(au_dir_problem "${d}")
      if [ -n "${problem}" ]; then echo "${problem}"; return 0; fi
      [ "${d}" = / ] && break
      d=$(dirname -- "${d}")
    done
  done
  return 0
}

# au_hook_run <tag>: run the post-update hook. It is checked, copied into a
# private 0700 folder under <home>/hermes-bot-kit, checked again and compared
# with the copy, and the copy is what runs: the file that runs is the one
# that was checked, whatever happens to the path afterwards. Prints the
# phrase for the log line.
au_hook_run() {
  local tag="$1" problem hdir rc=0
  problem=$(au_hook_problem "${AU_HOOK}")
  if [ -n "${problem}" ]; then
    echo "post-update hook not run: it ${problem}"
    return 0
  fi
  hdir=$(mktemp -d "${KIT_STATE_DIR}/.hook.XXXXXX") || { echo "post-update hook not run: no private folder for it"; return 0; }
  chmod 0700 "${hdir}"
  if ! cp -- "${AU_HOOK}" "${hdir}/hook" 2>/dev/null; then
    rm -rf "${hdir}"
    echo "post-update hook not run: it could not be copied"
    return 0
  fi
  chmod 0700 "${hdir}/hook"
  problem=$(au_hook_problem "${AU_HOOK}")
  if [ -n "${problem}" ] || ! cmp -s "${AU_HOOK}" "${hdir}/hook"; then
    rm -rf "${hdir}"
    echo "post-update hook not run: it changed while it was being checked${problem:+ (it ${problem})}"
    return 0
  fi
  ( export KIT_REF="${tag}" HERMES_HOME="${HERMES_ROOT}" KIT_POST_UPDATE_HOOK="${AU_HOOK}"; exec "${hdir}/hook" </dev/null 9>&- ) >> "${AU_OUT}" 2>&1 || rc=$?
  rm -rf "${hdir}"
  echo "post-update hook exited ${rc}"
}

au_get() {
  # au_get <KEY>: the value from auto-update.env (no shell evaluation).
  [ -f "${AU_ENV}" ] || return 0
  sed -n "s/^$1=//p" "${AU_ENV}" | head -n 1
}

# The knobs a run uses: the ones `on` remembered, or (a manual run with
# auto-update off) the ones in the environment.
au_load() {
  if [ -f "${AU_ENV}" ]; then
    AU_ON=1
    AU_SKIP_GROKBOT=$(au_flag KIT_SKIP_GROKBOT "$(au_get KIT_SKIP_GROKBOT)") || return 1
    AU_SKIP_COMPUTER=$(au_flag KIT_SKIP_COMPUTER "$(au_get KIT_SKIP_COMPUTER)") || return 1
    AU_TEXTING=$(au_flag KIT_TEXTING_STYLE "$(au_get KIT_TEXTING_STYLE)") || return 1
    AU_HOOK=$(au_get KIT_POST_UPDATE_HOOK)
    AU_SCHED=$(au_get SCHEDULER)
  else
    AU_ON=0
    AU_SKIP_GROKBOT=$(au_flag KIT_SKIP_GROKBOT "${KIT_SKIP_GROKBOT:-}") || return 1
    AU_SKIP_COMPUTER=$(au_flag KIT_SKIP_COMPUTER "${KIT_SKIP_COMPUTER:-}") || return 1
    AU_TEXTING=$(au_flag KIT_TEXTING_STYLE "${KIT_TEXTING_STYLE:-}") || return 1
    AU_HOOK="${KIT_POST_UPDATE_HOOK:-}"
    AU_SCHED=""
  fi
}

au_next_run() {
  local now secs day
  now=$(au_now)
  secs=$((10#$(au_fmt "${now}" %H) * 3600 + 10#$(au_fmt "${now}" %M) * 60 + 10#$(au_fmt "${now}" %S)))
  day="${now}"
  [ "${secs}" -lt $((AU_HOUR * 3600 + AU_MIN * 60)) ] || day=$((now + 86400))
  printf '%s %02d:%02d local time\n' "$(au_fmt "${day}" %Y-%m-%d)" "${AU_HOUR}" "${AU_MIN}"
}

au_log() {
  # au_log <message>: one line, with the time, to the update log (rotated at
  # 1 MB, one old file kept as .1) and to stdout.
  local line size
  mkdir -p "$(dirname -- "${AU_LOG}")"
  if [ -f "${AU_LOG}" ]; then
    size=$(wc -c < "${AU_LOG}" | tr -d '[:space:]')
    if [ "${size:-0}" -ge "${AU_LOG_MAX}" ]; then
      mv -f "${AU_LOG}" "${AU_LOG}.1"
    fi
  fi
  line="$(au_fmt "$(au_now)" '%Y-%m-%d %H:%M:%S') $*"
  printf '%s\n' "${line}" >> "${AU_LOG}"
  printf '%s\n' "${line}"
}

au_last_line() {
  local f
  for f in "${AU_LOG}" "${AU_LOG}.1"; do
    if [ -s "${f}" ]; then
      tail -n 1 "${f}"
      return 0
    fi
  done
  return 0
}

# Single instance: an exclusive flock(2) on <home>/hermes-bot-kit/update.flock,
# held on file descriptor 9 for the whole run. The kernel drops it when the
# run exits, however it exits, so there is no stale lock to detect, take over
# or race on. flock(1) takes it on Linux; elsewhere (macOS has no flock(1))
# perl locks the same open file (flock locks belong to the open file, which
# this shell keeps, so the lock outlives the perl process). Children never
# inherit descriptor 9. update.flock.pid only names the holder for the log.
au_lock() {
  local rc
  AU_LOCK_FILE="${KIT_STATE_DIR}/update.flock"
  AU_LOCK_PID="unknown"
  mkdir -p "${KIT_STATE_DIR}"
  if [ -L "${AU_LOCK_FILE}" ] || ! : >> "${AU_LOCK_FILE}" 2>/dev/null; then
    AU_LOCK_ERR="cannot open ${AU_LOCK_FILE}"
    return 2
  fi
  exec 9>>"${AU_LOCK_FILE}"
  if command -v flock >/dev/null 2>&1; then
    rc=0
    flock -n 9 || rc=$?
  elif command -v perl >/dev/null 2>&1; then
    rc=0
    perl -MFcntl=:flock -e 'open(my $fh, ">&=", 9) or exit 2; flock($fh, LOCK_EX | LOCK_NB) or exit 1; exit 0' || rc=$?
  else
    exec 9>&-
    AU_LOCK_ERR="neither flock nor perl is installed, so a run can't be made single-instance"
    return 2
  fi
  if [ "${rc}" -ne 0 ]; then
    exec 9>&-
    if [ "${rc}" = 1 ]; then
      AU_LOCK_PID=$(head -n 1 "${AU_LOCK_FILE}.pid" 2>/dev/null || true)
      case "${AU_LOCK_PID}" in ''|*[!0-9]*) AU_LOCK_PID="unknown" ;; esac
      return 1
    fi
    AU_LOCK_ERR="could not lock ${AU_LOCK_FILE}"
    return 2
  fi
  printf '%s\n' "$$" > "${AU_LOCK_FILE}.pid"
  return 0
}
au_unlock() {
  exec 9>&- 2>/dev/null || true
}

AU_CURL=(curl -fsSL --connect-timeout 10 --max-time 120 --retry 2 --retry-delay 2 --max-filesize 1048576)

au_verify() {
  # au_verify <repo path> <file> <manifest>: the file matches the manifest.
  local want
  want=$(awk -v p="$1" '$2 == p { print $1; exit }' "$3")
  [ -n "${want}" ] && [ "$(sha256_of "$2")" = "${want}" ]
}

# au_plain_path <path under HERMES_ROOT>: no part of it below HERMES_ROOT is a
# symlink, and its folder resolves inside HERMES_ROOT.
au_plain_path() {
  local rel="${1#"${HERMES_ROOT}"/}" cur="${HERMES_ROOT}" part root_p dir_p
  [ "${rel}" != "$1" ] || return 1
  while [ -n "${rel}" ]; do
    part="${rel%%/*}"
    if [ "${part}" = "${rel}" ]; then rel=""; else rel="${rel#*/}"; fi
    case "${part}" in ''|.|..) return 1 ;; esac
    cur="${cur}/${part}"
    [ -L "${cur}" ] && return 1
  done
  [ -d "$(dirname -- "$1")" ] || return 0
  root_p=$(CDPATH= cd -P -- "${HERMES_ROOT}" && pwd -P) || return 1
  dir_p=$(CDPATH= cd -P -- "$(dirname -- "$1")" && pwd -P) || return 1
  case "${dir_p}/" in "${root_p}"/*) return 0 ;; esac
  return 1
}

# After an update, only when KIT_TEXTING_STYLE=1 was set at `on`: refresh
# texting-style where it is already installed as a plain copy. Never replaces
# a symlink, never installs into a profile that lacks it, never edits
# config.yaml. Prints one summary phrase for the log line.
au_texting_style() {
  local tag="$1" dir="$2" t="$2/texting-style" base home dest f n=0 links=0 stamp bad nbad=0 failed=""
  base="https://raw.githubusercontent.com/${KIT_REPO}/${tag}"
  mkdir -p "${t}"
  for f in plugin.yaml __init__.py; do
    if ! "${AU_CURL[@]}" "${base}/texting-style/${f}" -o "${t}/${f}" 2>/dev/null; then
      echo "texting-style not refreshed (download failed)"
      return 0
    fi
    if ! au_verify "texting-style/${f}" "${t}/${f}" "${dir}/MANIFEST.sha256"; then
      echo "texting-style not refreshed (texting-style/${f} does not match the manifest)"
      return 0
    fi
  done
  if ! grep -q "texting-style.sms-register" "${t}/__init__.py"; then
    echo "texting-style not refreshed (download does not look like texting-style)"
    return 0
  fi
  stamp=$(date +%Y%m%d%H%M%S)
  for home in "${HERMES_ROOT}" "${HERMES_ROOT}"/profiles/*; do
    [ -d "${home}" ] || continue
    dest="${home}/plugins/texting-style"
    # A symlink anywhere from the Hermes home down (the profile, plugins/,
    # the plugin folder or a file) means it is not a plain copy: left alone.
    if ! au_plain_path "${dest}/plugin.yaml" || ! au_plain_path "${dest}/__init__.py"; then
      links=$((links + 1))
      continue
    fi
    [ -d "${dest}" ] && [ -f "${dest}/plugin.yaml" ] && [ -f "${dest}/__init__.py" ] || continue
    # Each step is checked (this runs with errexit off): a file is replaced
    # only after its backup was made, and a failure is reported per profile.
    bad=""
    for f in plugin.yaml __init__.py; do
      cmp -s "${t}/${f}" "${dest}/${f}" && continue
      if ! cp "${dest}/${f}" "${dest}/${f}.bak.${stamp}" 2>/dev/null; then
        bad="${bad:+${bad}, }${f} (backup failed)"
        continue
      fi
      if ! cp "${t}/${f}" "${dest}/.${f}.new.$$" 2>/dev/null; then
        rm -f "${dest}/.${f}.new.$$" 2>/dev/null
        bad="${bad:+${bad}, }${f} (copy failed)"
        continue
      fi
      if ! mv -f "${dest}/.${f}.new.$$" "${dest}/${f}" 2>/dev/null; then
        rm -f "${dest}/.${f}.new.$$" 2>/dev/null
        bad="${bad:+${bad}, }${f} (replace failed)"
        continue
      fi
    done
    if [ -n "${bad}" ]; then
      nbad=$((nbad + 1))
      failed="${failed:+${failed}; }${dest}: ${bad}"
    else
      n=$((n + 1))
    fi
  done
  if [ "${nbad}" -gt 0 ]; then
    echo "texting-style FAILED: could not refresh ${nbad} profile(s) (${failed}); refreshed in ${n} profile(s), ${links} with a symlink in the path left alone"
    return 1
  fi
  echo "texting-style refreshed in ${n} profile(s), ${links} with a symlink in the path left alone (new code loads at the next agent/gateway restart)"
}

au_run() {
  local tag installed tmp rc msg base ts_msg ts_rc extra=""
  # Only with the settings `on` saved: a run never guesses the knobs.
  if [ ! -f "${AU_ENV}" ]; then
    au_log "skipped: auto-update is off (no ${AU_ENV}); turn it on with --auto-update on"
    return 0
  fi
  au_load || { au_log "FAILED: bad settings in ${AU_ENV}"; return 1; }
  rc=0
  au_lock || rc=$?
  if [ "${rc}" = 1 ]; then
    au_log "skipped: another update is running (pid ${AU_LOCK_PID:-unknown})"
    return 0
  elif [ "${rc}" != 0 ]; then
    au_log "FAILED: ${AU_LOCK_ERR:-could not take the update lock}; nothing done"
    return 1
  fi
  tmp=$(mktemp -d)
  # shellcheck disable=SC2064 # expand now: these paths are fixed for the run
  trap "rm -rf '${tmp}'; au_unlock" EXIT
  if ! tag=$(latest_release_tag); then
    au_log "skipped: GitHub API not reachable or rate-limited; will try again next run"
    return 0
  fi
  installed=$(au_installed)
  if is_release_tag "${installed}" && ! tag_older_than "${installed}" "${tag}"; then
    au_log "up to date (${installed})"
    return 0
  fi
  base="https://raw.githubusercontent.com/${KIT_REPO}/${tag}"
  if ! "${AU_CURL[@]}" "${base}/MANIFEST.sha256" -o "${tmp}/MANIFEST.sha256" 2>/dev/null ||
    ! "${AU_CURL[@]}" "${base}/install.sh" -o "${tmp}/install.sh" 2>/dev/null; then
    au_log "skipped: could not download ${tag}; will try again next run"
    return 0
  fi
  if awk '$2 == "install.sh" { found=1 } END { exit found ? 0 : 1 }' "${tmp}/MANIFEST.sha256"; then
    if ! au_verify install.sh "${tmp}/install.sh" "${tmp}/MANIFEST.sha256"; then
      au_log "FAILED: ${tag} install.sh does not match its MANIFEST.sha256; nothing installed"
      return 1
    fi
  fi
  # Not listed: install.sh checks every file it installs against the manifest
  # itself. Still, it must be the installer released as that tag.
  if ! grep -qxF "KIT_FALLBACK_REF=\"${tag}\"" "${tmp}/install.sh" || ! bash -n "${tmp}/install.sh" 2>/dev/null; then
    au_log "FAILED: the downloaded ${tag} install.sh does not look like that release's installer; nothing installed"
    return 1
  fi
  rc=0
  # The first run that updates may come before any log line was written.
  mkdir -p "$(dirname -- "${AU_OUT}")"
  (
    unset KIT_SKIP_VERIFY KIT_SOURCE_DIR KIT_CARDS_SKILL KIT_CARDS_PROFILES KIT_REMOVE_RETIRED
    export HERMES_HOME="${HERMES_ROOT}" KIT_REF="${tag}" KIT_SKIP_GROKBOT="${AU_SKIP_GROKBOT}" KIT_SKIP_COMPUTER="${AU_SKIP_COMPUTER}"
    exec "${BASH:-bash}" "${tmp}/install.sh" </dev/null 9>&-
  ) > "${AU_OUT}" 2>&1 || rc=$?
  if [ "${rc}" -ne 0 ]; then
    au_log "FAILED: installing ${tag} exited ${rc} (still on ${installed:-nothing}; its output: ${AU_OUT})"
    return 1
  fi
  write_installed_release "${tag}" || true
  # The job runs the newest release's own updater from now on, but only when
  # that installer has --auto-update: an older one (no KIT_AUTO_UPDATE_API=1
  # line) ran above only as an installer, and the current updater stays.
  if [ "${AU_ON}" = 1 ] && ! grep -qx 'KIT_AUTO_UPDATE_API=1' "${tmp}/install.sh"; then
    extra="${extra}; kept the current updater (the ${tag} installer has no auto-update)"
  elif [ "${AU_ON}" = 1 ]; then
    cp "${tmp}/install.sh" "${KIT_STATE_DIR}/.update.sh.new.$$"
    chmod 0700 "${KIT_STATE_DIR}/.update.sh.new.$$"
    mv -f "${KIT_STATE_DIR}/.update.sh.new.$$" "${AU_SCRIPT}"
  fi
  if [ "${AU_TEXTING}" = 1 ]; then
    # Not fatal to the update, but recorded as a failure in the log line
    # ("texting-style FAILED: ..."), which status and the doctor show.
    ts_rc=0
    ts_msg=$(au_texting_style "${tag}" "${tmp}") || ts_rc=$?
    if [ "${ts_rc}" -ne 0 ]; then
      case "${ts_msg}" in
        "texting-style FAILED: "*) ;;
        *) ts_msg="texting-style FAILED: the refresh stopped part-way (${ts_msg:-no output}); see the .bak.<timestamp> files in each plugins/texting-style/" ;;
      esac
    fi
    extra="${extra}; ${ts_msg}"
  fi
  if [ -n "${AU_HOOK}" ]; then
    extra="${extra}; $(au_hook_run "${tag}")"
  fi
  msg="updated ${installed:-nothing} -> ${tag}${extra}. Reload desktop plugins (Cmd+K) to pick up ${tag}"
  au_log "${msg}"
  return 0
}

au_plist() {
  cat <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${AU_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/bash</string>
    <string>${AU_SCRIPT}</string>
    <string>--auto-update</string>
    <string>run</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>HERMES_HOME</key>
    <string>${HERMES_ROOT}</string>
    <key>PATH</key>
    <string>/usr/bin:/bin:/usr/sbin:/sbin:/opt/homebrew/bin:/usr/local/bin</string>
  </dict>
  <key>StartCalendarInterval</key>
  <dict>
    <key>Hour</key>
    <integer>${AU_HOUR}</integer>
    <key>Minute</key>
    <integer>${AU_MIN}</integer>
  </dict>
  <key>RunAtLoad</key>
  <false/>
  <key>ProcessType</key>
  <string>Background</string>
  <key>Nice</key>
  <integer>10</integer>
  <key>StandardOutPath</key>
  <string>/dev/null</string>
  <key>StandardErrorPath</key>
  <string>/dev/null</string>
</dict>
</plist>
EOF
}

au_service() {
  cat <<EOF
[Unit]
Description=Hermes Bot Kit daily update (install.sh --auto-update)

[Service]
Type=oneshot
Environment="HERMES_HOME=${HERMES_ROOT}"
ExecStart=${AU_BASH} "${AU_SCRIPT}" --auto-update run
Nice=10
StandardOutput=null
StandardError=null
EOF
}

au_timer() {
  cat <<EOF
[Unit]
Description=Hermes Bot Kit daily update (install.sh --auto-update)

[Timer]
OnCalendar=*-*-* $(printf '%02d:%02d' "${AU_HOUR}" "${AU_MIN}")
Persistent=true

[Install]
WantedBy=timers.target
EOF
}

au_cron_line() {
  printf '%s %s * * * HERMES_HOME='"'"'%s'"'"' %s '"'"'%s'"'"' --auto-update run >/dev/null 2>&1\n' \
    "${AU_MIN}" "${AU_HOUR}" "${HERMES_ROOT}" "${AU_BASH}" "${AU_SCRIPT}"
}

au_write() {
  # au_write <dest> <mode>: stdin to dest, atomically (temp file beside it).
  local tmp
  mkdir -p "$(dirname -- "$1")"
  tmp=$(mktemp "$1.XXXXXX")
  cat > "${tmp}"
  chmod "$2" "${tmp}"
  mv -f "${tmp}" "$1"
}

au_systemctl_ok() {
  command -v "${AU_SYSTEMCTL%% *}" >/dev/null 2>&1 && ${AU_SYSTEMCTL} --user show-environment >/dev/null 2>&1
}

au_on() {
  local os self g c ts hook problem uid sched
  os=$(au_os)
  case "${os}" in
    mac|linux) ;;
    wsl|windows)
      echo "install.sh: --auto-update is not supported on Windows or WSL yet." >&2
      echo "  Hermes Desktop for Windows reads its plugins from %LOCALAPPDATA%\\hermes\\desktop-plugins; update them by" >&2
      echo "  copying a newer release in by hand (README: Troubleshooting, Hermes Desktop on Windows). Nothing was changed." >&2
      return 1
      ;;
    *)
      echo "install.sh: --auto-update supports macOS and Linux only. Nothing was changed." >&2
      return 1
      ;;
  esac
  if [ ! -d "${HERMES_ROOT}" ]; then
    echo "install.sh: no Hermes home at ${HERMES_ROOT}; install Hermes (and the kit) first. Nothing was changed." >&2
    return 1
  fi
  if ! au_safe_path "${HERMES_ROOT}" || ! au_safe_path "${HOME}"; then
    echo "install.sh: --auto-update needs a Hermes home and HOME path without quotes, \$, %, \\, \` or < > &. Nothing was changed." >&2
    return 1
  fi
  g=$(au_flag KIT_SKIP_GROKBOT "${KIT_SKIP_GROKBOT:-}") || return 2
  c=$(au_flag KIT_SKIP_COMPUTER "${KIT_SKIP_COMPUTER:-}") || return 2
  ts=$(au_flag KIT_TEXTING_STYLE "${KIT_TEXTING_STYLE:-}") || return 2
  hook="${KIT_POST_UPDATE_HOOK:-}"
  if [ -n "${hook}" ]; then
    problem=$(au_hook_problem "${hook}")
    if [ -n "${problem}" ]; then
      echo "install.sh: KIT_POST_UPDATE_HOOK ${hook} ${problem}. Nothing was changed." >&2
      return 2
    fi
  fi
  self="${BASH_SOURCE[0]:-}"
  if [ -z "${self}" ] || [ ! -f "${self}" ] || ! grep -q '^KIT_FALLBACK_REF="' "${self}" || ! grep -qx 'KIT_AUTO_UPDATE_API=1' "${self}"; then
    echo "install.sh: run --auto-update on from a downloaded install.sh file (the one-liner in the README), not a pipe. Nothing was changed." >&2
    return 1
  fi
  AU_BASH=$(command -v bash 2>/dev/null || echo /bin/bash)
  case "${os}" in mac) AU_BASH=/bin/bash ;; esac
  au_safe_path "${AU_BASH}" && case "${AU_BASH}" in *' '*) false ;; esac || AU_BASH=/bin/bash

  # Settings and the updater are saved (each atomically: temp file + rename)
  # BEFORE the job is installed or loaded, so a run that fires while it is
  # being enabled already sees this command's knobs.
  case "${os}" in
    mac) sched=launchd ;;
    linux)
      AU_SYSTEMCTL="${KIT_SYSTEMCTL:-systemctl}"
      if au_systemctl_ok; then sched=systemd; else sched=cron; fi
      ;;
  esac
  mkdir -p "${KIT_STATE_DIR}" "${HERMES_ROOT}/logs"
  chmod 0700 "${KIT_STATE_DIR}"
  au_write "${AU_SCRIPT}" 0700 < "${self}"
  {
    echo "# hermes-bot-kit auto-update settings (install.sh --auto-update on). No secrets."
    echo "HERMES_HOME=${HERMES_ROOT}"
    echo "KIT_SKIP_GROKBOT=${g}"
    echo "KIT_SKIP_COMPUTER=${c}"
    echo "KIT_TEXTING_STYLE=${ts}"
    echo "KIT_POST_UPDATE_HOOK=${hook}"
    echo "SCHEDULER=${sched}"
  } | au_write "${AU_ENV}" 0600

  case "${sched}" in
    launchd)
      au_plist | au_write "${AU_PLIST}" 0644
      uid=$(id -u)
      AU_LAUNCHCTL="${KIT_LAUNCHCTL:-launchctl}"
      ${AU_LAUNCHCTL} bootout "gui/${uid}/${AU_LABEL}" >/dev/null 2>&1 || true
      if ${AU_LAUNCHCTL} bootstrap "gui/${uid}" "${AU_PLIST}" >/dev/null 2>&1; then
        echo "Auto-update      -> on: daily at 04:20 (LaunchAgent ${AU_PLIST})"
      else
        echo "Auto-update      -> on, but the job could not be loaded now (normal over ssh). It loads by itself at your"
        echo "                    next login, or run this in Terminal on this Mac:"
        echo "                    launchctl bootstrap gui/${uid} '${AU_PLIST}'"
      fi
      ;;
    systemd)
        au_service | au_write "${AU_UNIT_DIR}/${AU_UNIT}.service" 0644
        au_timer | au_write "${AU_UNIT_DIR}/${AU_UNIT}.timer" 0644
        if ${AU_SYSTEMCTL} --user daemon-reload >/dev/null 2>&1 &&
          ${AU_SYSTEMCTL} --user enable --now "${AU_UNIT}.timer" >/dev/null 2>&1; then
          echo "Auto-update      -> on: daily at 04:20 (systemd user timer ${AU_UNIT}.timer)"
        else
          echo "Auto-update      -> units written, but the timer could not be started. Run:"
          echo "                    systemctl --user daemon-reload && systemctl --user enable --now ${AU_UNIT}.timer"
        fi
      ;;
    cron)
        echo "Auto-update      -> no systemd user session here. Add this line with 'crontab -e' to run it daily at 04:20:"
        echo
        au_cron_line
        echo
      ;;
  esac
  echo "                    settings: ${AU_ENV}"
  echo "                    updater:  ${AU_SCRIPT}"
  echo "                    log:      ${AU_LOG}"
  echo "                    next run: $(au_next_run)"
  echo "It never restarts Hermes: after an update, reload desktop plugins (Cmd+K -> 'Reload desktop plugins')."
  echo "Check it: bash install.sh --auto-update status. Turn it off: bash install.sh --auto-update off."
}

au_off() {
  local uid sched left="" sc="${KIT_SYSTEMCTL:-systemctl}"
  sched=$(au_get SCHEDULER)
  uid=$(id -u)
  if [ -f "${AU_PLIST}" ] && ! grep -qF "<string>${AU_SCRIPT}</string>" "${AU_PLIST}"; then
    echo "Auto-update      -- the LaunchAgent belongs to another Hermes home's auto-update; left alone (turn it off with that HERMES_HOME)"
  elif [ -f "${AU_PLIST}" ]; then
    ${KIT_LAUNCHCTL:-launchctl} bootout "gui/${uid}/${AU_LABEL}" >/dev/null 2>&1 || true
    rm -f "${AU_PLIST}"
    if ${KIT_LAUNCHCTL:-launchctl} print "gui/${uid}/${AU_LABEL}" >/dev/null 2>&1; then
      left="${left} launchd"
      echo "install.sh: the LaunchAgent file is removed but the job is still loaded. Run this in Terminal on this Mac:" >&2
      echo "  launchctl bootout gui/${uid}/${AU_LABEL}" >&2
    else
      echo "Auto-update      -- LaunchAgent unloaded and removed"
    fi
  elif [ "${sched}" = launchd ] && ${KIT_LAUNCHCTL:-launchctl} print "gui/${uid}/${AU_LABEL}" >/dev/null 2>&1; then
    # A retry after an unload that failed: the file is gone, the job is still
    # loaded, and no other home's LaunchAgent file claims it.
    ${KIT_LAUNCHCTL:-launchctl} bootout "gui/${uid}/${AU_LABEL}" >/dev/null 2>&1 || true
    if ${KIT_LAUNCHCTL:-launchctl} print "gui/${uid}/${AU_LABEL}" >/dev/null 2>&1; then
      left="${left} launchd"
      echo "install.sh: the job is still loaded. Run this in Terminal on this Mac:" >&2
      echo "  launchctl bootout gui/${uid}/${AU_LABEL}" >&2
    else
      echo "Auto-update      -- LaunchAgent unloaded"
    fi
  fi
  if [ -f "${AU_UNIT_DIR}/${AU_UNIT}.service" ] && ! grep -qF "\"${AU_SCRIPT}\"" "${AU_UNIT_DIR}/${AU_UNIT}.service"; then
    echo "Auto-update      -- the systemd user timer belongs to another Hermes home's auto-update; left alone"
  elif [ -f "${AU_UNIT_DIR}/${AU_UNIT}.timer" ] || [ -f "${AU_UNIT_DIR}/${AU_UNIT}.service" ]; then
    # Stop and disable, check it really is inactive and disabled, and only
    # then remove the units and reload. Any failure keeps the units and the
    # settings and names the command to run.
    if ! ${sc} --user disable --now "${AU_UNIT}.timer" >/dev/null 2>&1; then
      left="${left} systemd"
      echo "install.sh: could not stop the timer. Run: systemctl --user disable --now ${AU_UNIT}.timer" >&2
    elif ${sc} --user is-active --quiet "${AU_UNIT}.timer" >/dev/null 2>&1 ||
      ${sc} --user is-enabled --quiet "${AU_UNIT}.timer" >/dev/null 2>&1; then
      left="${left} systemd"
      echo "install.sh: the timer is still active or enabled. Run: systemctl --user disable --now ${AU_UNIT}.timer" >&2
    elif ! rm -f "${AU_UNIT_DIR}/${AU_UNIT}.timer" "${AU_UNIT_DIR}/${AU_UNIT}.service" ||
      [ -e "${AU_UNIT_DIR}/${AU_UNIT}.timer" ] || [ -e "${AU_UNIT_DIR}/${AU_UNIT}.service" ]; then
      left="${left} systemd"
      echo "install.sh: could not remove the unit files in ${AU_UNIT_DIR}" >&2
    elif ! ${sc} --user daemon-reload >/dev/null 2>&1; then
      left="${left} systemd-reload"
      echo "install.sh: the timer is stopped and its files removed, but systemd was not reloaded. Run: systemctl --user daemon-reload" >&2
    else
      echo "Auto-update      -- systemd user timer stopped and removed"
    fi
  elif [ "${sched}" = systemd ]; then
    # A retry: the units are gone; make sure systemd forgot the timer too.
    if ! ${sc} --user daemon-reload >/dev/null 2>&1; then
      left="${left} systemd-reload"
      echo "install.sh: systemd was not reloaded. Run: systemctl --user daemon-reload" >&2
    elif ${sc} --user is-active --quiet "${AU_UNIT}.timer" >/dev/null 2>&1; then
      left="${left} systemd"
      echo "install.sh: the timer is still active. Run: systemctl --user stop ${AU_UNIT}.timer" >&2
    fi
  fi
  # Never report off while a job for this home remains.
  if [ -f "${AU_PLIST}" ] && grep -qF "<string>${AU_SCRIPT}</string>" "${AU_PLIST}"; then
    left="${left} launchd-file"
  fi
  if [ -n "${left}" ]; then
    echo "install.sh: auto-update is NOT off: a daily job for ${HERMES_ROOT} is still scheduled (${left# }). Settings kept; fix the above and run --auto-update off again." >&2
    return 1
  fi
  if [ "${sched}" = cron ]; then
    echo "Auto-update      -- remove the hermes-bot-kit line from 'crontab -e' yourself (it now finds nothing to run)"
  fi
  rm -f "${AU_ENV}" "${AU_SCRIPT}"
  echo "Auto-update      -- off. Installed plugins, backups, installed-release and the log are kept."
}

au_status() {
  local installed newest last uid loaded="" n
  au_load || return 1
  installed=$(au_installed)
  if [ "${AU_ON}" = 1 ]; then
    case "${AU_SCHED}" in
      launchd)
        uid=$(id -u)
        if [ ! -f "${AU_PLIST}" ]; then
          loaded=" - but the LaunchAgent is missing: run --auto-update on again"
        elif ! grep -qF "<string>${AU_SCRIPT}</string>" "${AU_PLIST}"; then
          loaded=" - but the LaunchAgent now runs another Hermes home's updater"
        elif ${KIT_LAUNCHCTL:-launchctl} print "gui/${uid}/${AU_LABEL}" >/dev/null 2>&1; then
          loaded=" (LaunchAgent loaded)"
        else
          loaded=" (LaunchAgent not loaded yet: it loads at your next login, or: launchctl bootstrap gui/${uid} '${AU_PLIST}')"
        fi
        ;;
      systemd)
        if ${KIT_SYSTEMCTL:-systemctl} --user is-enabled "${AU_UNIT}.timer" >/dev/null 2>&1; then
          loaded=" (systemd user timer enabled)"
        else
          loaded=" (systemd user timer not enabled: systemctl --user enable --now ${AU_UNIT}.timer)"
        fi
        ;;
      cron) loaded=" (crontab line you added by hand)" ;;
    esac
    echo "Auto-update      : on, daily at 04:20 local time via ${AU_SCHED:-unknown}${loaded}"
    echo "Next run         : $(au_next_run) (a Mac asleep then runs it when it wakes)"
  else
    echo "Auto-update      : off (turn it on: bash install.sh --auto-update on)"
  fi
  echo "Installed release: ${installed:-unknown}"
  if newest=$(latest_release_tag); then
    echo "Newest release   : ${newest}"
  else
    echo "Newest release   : unknown (GitHub API not reachable or rate-limited)"
  fi
  last=$(au_last_line)
  echo "Last run         : ${last:-never}"
  case "${last}" in
    *" updated "*) echo "                   Reload desktop plugins (Cmd+K) to pick up ${installed} if you haven't yet." ;;
  esac
  if [ "${AU_ON}" = 1 ]; then
    echo "Remembered knobs : KIT_SKIP_GROKBOT=${AU_SKIP_GROKBOT} KIT_SKIP_COMPUTER=${AU_SKIP_COMPUTER} KIT_TEXTING_STYLE=${AU_TEXTING}${AU_HOOK:+ KIT_POST_UPDATE_HOOK=${AU_HOOK}}"
  fi
  n=0
  [ -d "${PLUGIN_ROOT}" ] && n=$( { find "${PLUGIN_ROOT}" -name '*.bak.[0-9]*' -type f 2>/dev/null || true; } | wc -l | tr -d '[:space:]')
  echo "Backups          : ${n:-0} file(s), each replaced file is kept beside it as <file>.bak.<timestamp> in ${PLUGIN_ROOT}/"
  echo "Log              : ${AU_LOG} (output of the last update: ${AU_OUT})"
}

if [ "${1:-}" = "--auto-update" ]; then
  au_norm_home
  case "${2:-}" in
    on) au_on; exit $? ;;
    off) au_off; exit $? ;;
    status) au_status; exit $? ;;
    run) au_run; exit $? ;;
    *)
      echo "Usage: install.sh --auto-update on|off|status|run" >&2
      exit 2
      ;;
  esac
fi

# --- Uninstall: install.sh --uninstall -------------------------------------------
# Order matters: the daily job is turned off FIRST (the --auto-update off code
# path), because a job left behind reinstalls the plugins at its next run. If
# that fails nothing else is changed. Then the kit's desktop plugin folders
# move out of desktop-plugins/ to <home>/desktop-plugins-removed-<ts>-<name>,
# and the kit's records (desktop-plugins/.hermes-bot-kit-install and
# MANIFEST.sha256, and the <home>/hermes-bot-kit/ folder with installed-release)
# move to <home>/hermes-bot-kit-removed-<ts>/. Nothing is deleted. Agent
# plugins (per profile, maybe enabled in config.yaml) and config.yaml are never
# touched: they are listed with how to remove each. Never restarts anything.
KIT_DESKTOP_PLUGINS="computer-viewer grokbot-override"
KIT_DOCS="https://github.com/${KIT_REPO}/blob/${KIT_FALLBACK_REF}"

# Something of this home's auto-update is still there (settings, the updater
# copy, or a job file that runs this home's updater).
un_au_present() {
  [ -f "${AU_ENV}" ] && return 0
  [ -f "${AU_SCRIPT}" ] && return 0
  if [ -f "${AU_PLIST}" ] && grep -qF "<string>${AU_SCRIPT}</string>" "${AU_PLIST}"; then return 0; fi
  if [ -f "${AU_UNIT_DIR}/${AU_UNIT}.service" ] && grep -qF "\"${AU_SCRIPT}\"" "${AU_UNIT_DIR}/${AU_UNIT}.service"; then return 0; fi
  return 1
}

# The kit's agent plugins found in this Hermes home and its profiles, each with
# the removal steps its README documents. Only reads.
un_agent_report() {
  local dir name how home where any=0
  while IFS='|' read -r dir name how; do
    [ -n "${dir}" ] || continue
    where=""
    for home in "${HERMES_ROOT}" "${HERMES_ROOT}"/profiles/*; do
      [ -d "${home}" ] || continue
      case "${dir}" in
        platforms/slack) [ -f "${home}/plugins/platforms/slack/http_adapter.py" ] || continue ;;
        *) [ -e "${home}/plugins/${dir}" ] || [ -L "${home}/plugins/${dir}" ] || continue ;;
      esac
      where="${where:+${where}, }${home}"
    done
    [ -n "${where}" ] || continue
    if [ "${any}" = 0 ]; then
      echo
      echo "Agent plugins from the kit are still installed. They live per profile and may be enabled in"
      echo "config.yaml, so --uninstall leaves them (and every config.yaml) alone. To remove one:"
      any=1
    fi
    echo "  ${name} (plugins/${dir} in ${where})"
    echo "    ${how}"
  done <<EOF
texting-style|texting-style|move plugins/texting-style out of that Hermes home and take texting-style out of plugins.enabled in its config.yaml (${KIT_DOCS}/texting-style/README.md)
email-drafts|email-drafts|move plugins/email-drafts out of that Hermes home and take email-drafts out of plugins.enabled in its config.yaml (${KIT_DOCS}/email-drafts/README.md)
remote-cua|remote-cua|move plugins/remote-cua out, take remote-cua out of plugins.enabled and remove the computer_use.backend / remote_cua lines in its config.yaml (${KIT_DOCS}/remote-cua/README.md#uninstall)
slack-check|slack-check|move plugins/slack-check out and take slack-check out of plugins.enabled in its config.yaml (${KIT_DOCS}/slack-check/README.md)
slack-connect|slack-connect|from a clone: bash slack-connect/install.sh --uninstall --dry-run, then without --dry-run (${KIT_DOCS}/slack-connect/README.md#uninstall)
platforms/slack|slack-http (the Slack platform shadow)|move plugins/platforms/slack out of that Hermes home (${KIT_DOCS}/slack-http/README.md)
EOF
  for home in "${HERMES_ROOT}" "${HERMES_ROOT}"/profiles/*; do
    [ -f "${home}/skills/agent-cards/SKILL.md" ] && grep -qF "${CARDS_MARKER}" "${home}/skills/agent-cards/SKILL.md" || continue
    echo
    echo "The kit's agent-cards skill is still installed: run the installer again with KIT_CARDS_SKILL=remove in front of bash."
    break
  done
  return 0
}

kit_uninstall() {
  local ts p dest n moved="" rc removed="" installed=0
  au_norm_home
  if [ ! -d "${HERMES_ROOT}" ]; then
    echo "Uninstall        -- nothing is installed: there is no Hermes home at ${HERMES_ROOT}. Nothing changed."
    return 0
  fi
  un_au_present && installed=1
  for p in ${KIT_DESKTOP_PLUGINS}; do
    if [ -e "${PLUGIN_ROOT}/${p}" ] || [ -L "${PLUGIN_ROOT}/${p}" ]; then installed=1; fi
  done
  [ -f "${PLUGIN_ROOT}/.hermes-bot-kit-install" ] && installed=1
  [ -d "${KIT_STATE_DIR}" ] && installed=1
  if [ "${installed}" = 0 ]; then
    echo "Uninstall        -- nothing is installed in ${HERMES_ROOT} (no kit desktop plugins, install records or auto-update). Nothing changed."
    un_agent_report
    return 0
  fi

  # 1. The daily job first: left behind, it would install the plugins again.
  if un_au_present; then
    if ! au_off; then
      echo "install.sh: --uninstall stopped: auto-update could not be turned off (see above), so nothing else was changed. Fix that, then run --uninstall again." >&2
      return 1
    fi
  fi
  # 2. Never under an update that is running now.
  if [ -d "${KIT_STATE_DIR}" ]; then
    rc=0
    au_lock || rc=$?
    if [ "${rc}" = 1 ]; then
      echo "install.sh: --uninstall stopped: an update is running right now (pid ${AU_LOCK_PID:-unknown}). Auto-update is off; nothing else was changed. Run --uninstall again in a minute." >&2
      return 1
    elif [ "${rc}" != 0 ]; then
      echo "install.sh: --uninstall stopped: ${AU_LOCK_ERR:-could not take the update lock}. Auto-update is off; nothing else was changed." >&2
      return 1
    fi
  fi

  # 3. The desktop plugins, moved out (nothing deleted).
  ts=$(date +%Y%m%d%H%M%S)
  for p in ${KIT_DESKTOP_PLUGINS}; do
    [ -e "${PLUGIN_ROOT}/${p}" ] || [ -L "${PLUGIN_ROOT}/${p}" ] || continue
    dest="${HERMES_ROOT}/desktop-plugins-removed-${ts}-${p}"
    n=1
    while [ -e "${dest}" ] || [ -L "${dest}" ]; do
      n=$((n + 1))
      dest="${HERMES_ROOT}/desktop-plugins-removed-${ts}-${p}.${n}"
    done
    if ! mv -- "${PLUGIN_ROOT}/${p}" "${dest}" 2>/dev/null; then
      au_unlock
      echo "install.sh: --uninstall stopped: could not move ${PLUGIN_ROOT}/${p} out (permissions?)${moved:+; already moved:${moved}}. Auto-update is off. Fix that, then run --uninstall again." >&2
      return 1
    fi
    moved="${moved} ${p}"
    echo "Uninstall        -- moved ${p} to ${dest}"
  done

  # 4. The kit's records, moved to one hermes-bot-kit-removed-<ts> folder.
  removed="${HERMES_ROOT}/hermes-bot-kit-removed-${ts}"
  n=1
  while [ -e "${removed}" ] || [ -L "${removed}" ]; do
    n=$((n + 1))
    removed="${HERMES_ROOT}/hermes-bot-kit-removed-${ts}.${n}"
  done
  if [ -d "${KIT_STATE_DIR}" ]; then
    if ! mv -- "${KIT_STATE_DIR}" "${removed}" 2>/dev/null; then
      au_unlock
      echo "install.sh: --uninstall stopped: could not move ${KIT_STATE_DIR} out. Auto-update is off${moved:+ and the plugins are moved out}. Fix that, then run --uninstall again." >&2
      return 1
    fi
  else
    mkdir -p "${removed}"
  fi
  au_unlock
  rm -f "${removed}/update.flock" "${removed}/update.flock.pid"
  for p in .hermes-bot-kit-install MANIFEST.sha256; do
    [ -f "${PLUGIN_ROOT}/${p}" ] || continue
    if ! mv -- "${PLUGIN_ROOT}/${p}" "${removed}/${p#.}" 2>/dev/null; then
      echo "install.sh: --uninstall: could not move ${PLUGIN_ROOT}/${p} out; remove it by hand." >&2
      return 1
    fi
  done
  printf 'removed=%s\nplugins=%s\n' "${ts}" "${moved# }" > "${removed}/UNINSTALLED"
  echo "Uninstall        -- install records (installed-release, the install record, the manifest) moved to ${removed}"
  un_agent_report
  echo
  echo "Done: the kit's desktop plugins are uninstalled and auto-update is off (nothing was deleted; nothing was restarted)."
  echo "Reload desktop plugins (Cmd+K) or restart Hermes Desktop"
  return 0
}

if [ "${1:-}" = "--uninstall" ]; then
  if [ "$#" -ne 1 ]; then
    echo "Usage: install.sh --uninstall" >&2
    exit 2
  fi
  kit_uninstall
  exit $?
fi

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
  # For the auto-updater (and its status): which release is installed now.
  if [ -n "${SOURCE_DIR}" ]; then installed_as="local"; else installed_as="${KIT_REF}"; fi
  write_installed_release "${installed_as}" ||
    echo "install.sh: could not write ${INSTALLED_RELEASE} (the auto-updater reads it)" >&2

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
