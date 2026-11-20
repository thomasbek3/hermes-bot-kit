#!/usr/bin/env bash
# Hermes Bot Kit doctor: says why the kit's desktop plugins are not showing up.
# Read-only: it changes nothing, reads no .env, no tokens and no settings
# values. One line per check (OK, FIX or INFO); every FIX is followed by the
# exact fix. It ends with a summary you can paste into an issue, built only
# from closed-set values: OS name and version, Hermes Desktop version, kit
# release, kit plugin names, a fixed check ID with OK/FIX/INFO per check, and
# a path category for the home. No path, no free text, nothing read from files.
#
#   bash scripts/doctor.sh            (from a clone)
#   bash install.sh --doctor          (the same checks; fetched alone, it
#                                      downloads this script from the same
#                                      release and checks its digest first)
#
# Exit 0 when nothing needs fixing, 1 when any check says FIX, 2 when nothing
# says FIX but the home could not be verified (WSL without a view of Windows).
#
# Facts it relies on (Hermes v0.23.2, apps/desktop/):
#   - Desktop loads <HERMES_HOME>/desktop-plugins/<folder>/plugin.js, one level
#     deep, for the whole app, not per profile (electron/fs-ipc.ts:141-150,
#     src/contrib/runtime-loader.ts:590-595, 960-975).
#   - HERMES_HOME, else ~/.hermes; a HERMES_HOME inside profiles/ means its
#     parent. Windows: HERMES_HOME, else HKCU\Environment HERMES_HOME (only when
#     HERMES_HOME is unset), else %LOCALAPPDATA%\hermes, else a legacy
#     %USERPROFILE%\.hermes when the first is missing and the legacy one exists
#     (electron/data-paths.mjs:14-66, electron/windows-user-env.ts).
#   - A Dock or Finder launch on macOS takes only PATH from the login shell
#     (electron/shell-path.ts:5-21), so a HERMES_HOME set in ~/.zshrc does not
#     reach it; launchctl's environment does.
#   - profiles/<name>/desktop-plugins/<id> is moved up to the app root each
#     time Desktop resolves that root (every plugin scan) unless the root
#     already has <id>; then the profile copy stays and is never loaded
#     (electron/fs-ipc.ts:146-150, electron/desktop-plugins-root.ts:147-189).
#   - Plugin on/off choices live in the app's browser storage
#     (src/contrib/plugins-store.ts:47, src/contrib/plugin.ts:214-232), which a
#     script cannot read safely.
#   - The command palette is Cmd+K or Cmd+P (Ctrl elsewhere)
#     (src/lib/keybinds/actions.ts:202); Cmd+Shift+P is not a Hermes shortcut. The reload command is
#     "Reload desktop plugins" (src/app/contrib/controller.tsx:332-339).
#
# Test overrides (never needed in normal use):
#   DOCTOR_APP_PATH        Hermes app(s) to check instead of searching, separated
#                          by ':' (a .app folder or an .AppImage); "none" = none
#   DOCTOR_GUI_HERMES_HOME the HERMES_HOME a Dock launch sees, instead of asking
#                          launchctl ("" = not set)
#   DOCTOR_KIT_REF         the kit release for the fix commands (install.sh
#                          --doctor sets it)
#   DOCTOR_NO_CHECKOUT=1   never look for a checkout beside this script
#                          (install.sh --doctor sets it)
#   DOCTOR_WIN_REG_HOME    the HKCU\Environment HERMES_HOME (Windows and WSL)
#                          instead of asking reg ("" = not set)
#   DOCTOR_OS              mac, linux, wsl or windows instead of asking uname
set -uo pipefail

# The oldest Hermes Desktop this release supports.
# The oldest Hermes Desktop the plugins were verified on (docs/COMPATIBILITY.md:
# stable v0.23.0 and v0.23.2 pass the source contracts; v0.22.7 lacks
# groups.continue and v0.21.x several more APIs).
MIN_DESKTOP="0.23.0"
KIT_REPO="thomasbek3/hermes-bot-kit"
KIT_PLUGINS="computer-viewer grokbot-override"
# Keep in step with RETIRED_PLUGINS in install.sh (tests/test-doctor.sh checks).
RETIRED_PLUGINS="bubble-mode:hermes-bubble-mode-style task-dock:hermes-task-dock-style bot-sections:hermes-bot-sections-style"

# The checkout this script sits in (a .git you own beside install.sh), read
# only for the release tag. Never when install.sh --doctor runs it
# (DOCTOR_NO_CHECKOUT=1) or when it was fetched alone: no fix ever runs a
# local file.
SELF_DIR=$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
KIT_DIR=""
if [ "${DOCTOR_NO_CHECKOUT:-}" != 1 ] && [ -f "${SELF_DIR}/../install.sh" ] && [ -O "${SELF_DIR}/../.git" ]; then
  KIT_DIR=$(CDPATH= cd -- "${SELF_DIR}/.." && pwd)
fi

LINES=()   # "check <id> <STATUS>" for the summary: never the message
NFIX=0

# vis <text>: control characters shown as \n, \t, \r, \e (others as ?), so a
# folder name can never break a line or start a "fix:" line of its own.
vis() {
  local s="$1" nl=$'\n' tab=$'\t' cr=$'\r' esc=$'\033'
  s=${s//"${nl}"/"\\n"}; s=${s//"${tab}"/"\\t"}; s=${s//"${cr}"/"\\r"}; s=${s//"${esc}"/"\\e"}
  printf '%s' "${s}" | LC_ALL=C tr '\000-\037\177' '?'
}

# ok|info <check id> <message>; fix <check id> <message> <fix> [<fix> ...],
# each fix on its own "fix:" line: a command is always a line by itself. The id
# is a fixed word (letters, digits, -) and the only part that reaches the summary.
ok()   { printf 'OK    %s\n' "$(vis "$2")"; LINES+=("check $1 OK"); }
info() { printf 'INFO  %s\n' "$(vis "$2")"; LINES+=("check $1 INFO"); }
fix()  {
  local f
  printf 'FIX   %s\n' "$(vis "$2")"
  for f in "${@:3}"; do printf '      fix: %s\n' "$(vis "${f}")"; done
  LINES+=("check $1 FIX")
  NFIX=$((NFIX + 1))
}

# shq <path>: the path as one POSIX single-quoted word ('...', each ' written
# '\''), which bash and zsh read back exactly. Fails when the path holds a
# control character (a line break, tab, ESC...): no command is shown for it.
shq() {
  case "$1" in *[[:cntrl:]]*) return 1 ;; esac
  printf "'%s'" "$(printf '%s' "$1" | LC_ALL=C sed "s/'/'\\\\''/g")"
}
# cmd <instruction> <command> <path>...: the command with each path (its %s
# slots) quoted by shq, or, when a path has a control character, the plain
# instruction with the same slots. Every fix that holds a path goes through it.
cmd() {
  local text="$1" form="$2" p q
  local -a qs=()
  shift 2
  for p in "$@"; do
    q=$(shq "${p}") || {
      # shellcheck disable=SC2059 # our own fixed formats; paths are arguments
      printf "${text}, using Finder or a file manager (a name has a line break or another control character, so no command is shown)" "$@"
      return 0
    }
    qs+=("${q}")
  done
  # shellcheck disable=SC2059
  printf "${form}" "${qs[@]}"
}

# only <extended regex> <value>: the value when it matches the whole pattern,
# else "unknown". Everything in the summary goes through it or a fixed list.
only() {
  case "$2" in *$'\n'*|*$'\r'*) echo unknown; return 0 ;; esac
  if printf '%s\n' "$2" | grep -Eqx -- "$1"; then printf '%s\n' "$2"; else echo unknown; fi
}

# The marker line each kit plugin's built plugin.js carries (its plugin id).
plugin_of() {
  # plugin_of <plugin.js>: prints the kit plugin it is, or nothing.
  local f="$1"
  [ -f "${f}" ] || return 0
  if grep -Eq "PLUGIN_ID = ['\"]grokbot-override['\"]" "${f}" 2>/dev/null; then
    echo grokbot-override
  elif grep -Eq "PLUGIN_ID = ['\"]computer-viewer['\"]" "${f}" 2>/dev/null; then
    echo computer-viewer
  fi
}

file_sha256() {
  if command -v shasum >/dev/null 2>&1; then
    shasum -a 256 -- "$1" | awk '{print $1}'
  else
    sha256sum -- "$1" | awk '{print $1}'
  fi
}

# Numeric compare of dotted versions: true when $1 is older than $2.
version_older() {
  awk -v a="$1" -v b="$2" 'BEGIN {
    na = split(a, x, "."); nb = split(b, y, ".")
    for (i = 1; i <= 3; i++) { p = (i <= na) ? x[i] + 0 : 0; q = (i <= nb) ? y[i] + 0 : 0
      if (p < q) exit 0; if (p > q) exit 1 }
    exit 1 }'
}

# What Desktop does with a HERMES_HOME inside profiles/: uses the parent.
normalize_home() {
  local h="${1%/}"
  case "${h}" in
    */profiles/*) [ "$(basename -- "$(dirname -- "${h}")")" = "profiles" ] && h=$(dirname -- "$(dirname -- "${h}")") ;;
  esac
  printf '%s\n' "${h}"
}

# The release tag for the fix commands: install.sh --doctor passes its
# KIT_FALLBACK_REF (or KIT_REF); a clone's own install.sh names the release it
# came with. Only a release tag is used: anything else gives a plain instruction.
KIT_REF="${DOCTOR_KIT_REF:-}"
if [ -z "${KIT_REF}" ] && [ -n "${KIT_DIR}" ]; then
  KIT_REF=$(sed -n 's/^KIT_FALLBACK_REF="\(.*\)"/\1/p' "${KIT_DIR}/install.sh" | head -n 1)
fi
printf '%s\n' "${KIT_REF}" | grep -Eqx 'v[0-9]{4}\.[0-9]{2}\.[0-9]{2}(\.[0-9]{1,3})?' || KIT_REF=""
# pinned <path in the repo> [VAR=value]: download that file from the release
# tag to a temp file, then run it. Every fix that runs a script uses this. A
# value holding a path comes already quoted by shq.
pinned() {
  printf '( set -e; f=$(mktemp); trap '"'"'rm -f "$f"'"'"' EXIT; curl -fsSL https://raw.githubusercontent.com/%s/%s/%s -o "$f"; test -s "$f"; %sbash "$f" )' \
    "${KIT_REPO}" "${KIT_REF}" "$1" "${2:+$2 }"
}
WIN_TARGET=0   # 1 when the home checked is Hermes Desktop for Windows' own
installer_cmd() {
  # installer_cmd [VAR=value]: the exact command that (re)installs the kit.
  if [ "${WIN_TARGET}" = 1 ]; then
    printf 'on Windows: copy the grokbot-override and computer-viewer folders and MANIFEST.sha256 from the release'"'"'s source zip into %s, then reload (README: Troubleshooting, Hermes Desktop on Windows)' "${H}/desktop-plugins"
  elif [ -n "${KIT_REF}" ]; then
    pinned install.sh "${1:-}"
  else
    printf 're-run the install one-liner from the README%s' "${1:+, with $1 in front of bash}"
  fi
}

# --- The machine ------------------------------------------------------------
OS_KIND=other
UNAME_S=$(uname -s 2>/dev/null || echo unknown)
OS_VER=""
case "${UNAME_S}" in
  Darwin) OS_KIND=mac; OS_VER=$(sw_vers -productVersion 2>/dev/null) ;;
  Linux)
    OS_KIND=linux
    grep -qi microsoft /proc/sys/kernel/osrelease 2>/dev/null && OS_KIND=wsl
    OS_VER="$(sed -n 's/^ID="\{0,1\}\([^"]*\)"\{0,1\}$/\1/p' /etc/os-release 2>/dev/null | head -n 1) $(sed -n 's/^VERSION_ID="\{0,1\}\([^"]*\)"\{0,1\}$/\1/p' /etc/os-release 2>/dev/null | head -n 1)"
    ;;
  MINGW*|MSYS*|CYGWIN*) OS_KIND=windows ;;
esac
case "${DOCTOR_OS:-}" in mac|linux|wsl|windows) OS_KIND="${DOCTOR_OS}" ;; esac
OS_LINE="${OS_KIND} ${UNAME_S} $(uname -r 2>/dev/null) ${OS_VER}"
echo "Hermes Bot Kit doctor (read-only) on ${OS_LINE}"
echo

# --- Hermes Desktop -----------------------------------------------------------
app_version() {
  # app_version <app>: the version of a Hermes.app or a Hermes-<v>-....AppImage.
  local app="$1" plist v=""
  case "${app}" in
    *.app)
      plist="${app}/Contents/Info.plist"
      if command -v plutil >/dev/null 2>&1; then
        v=$(plutil -extract CFBundleShortVersionString raw -o - "${plist}" 2>/dev/null || true)
      fi
      if [ -z "${v}" ]; then
        v=$(awk '/<key>CFBundleShortVersionString<\/key>/ { getline; gsub(/.*<string>|<\/string>.*/, ""); print; exit }' "${plist}" 2>/dev/null || true)
      fi
      ;;
    *)
      v=$(basename -- "${app}" | sed -n 's/^[Hh]ermes[^0-9]*-\([0-9][0-9.]*[0-9]\)-.*/\1/p')
      ;;
  esac
  printf '%s\n' "${v}"
}

APPS=()
if [ -n "${DOCTOR_APP_PATH+set}" ]; then
  if [ "${DOCTOR_APP_PATH}" != "none" ]; then
    IFS=':' read -r -a APPS <<< "${DOCTOR_APP_PATH}"
  fi
else
  case "${OS_KIND}" in
    mac)
      for a in /Applications/Hermes*.app "${HOME}/Applications"/Hermes*.app; do
        [ -d "${a}" ] && APPS+=("${a}")
      done
      ;;
    linux|wsl)
      # Hermes ships Linux as an AppImage (apps/desktop/electron-builder.config.cjs:287).
      while IFS= read -r a; do
        [ -n "${a}" ] && APPS+=("${a}")
      done < <(find "${HOME}/Applications" "${HOME}/Downloads" "${HOME}/.local/bin" "${HOME}/bin" /opt \
        -maxdepth 2 -iname 'hermes*.appimage' 2>/dev/null | sort)
      ;;
  esac
fi

DESKTOP_VERSION="not found"
if [ ${#APPS[@]} -eq 0 ]; then
  case "${OS_KIND}" in
    mac) fix desktop "Hermes Desktop: not found in /Applications or ~/Applications" \
      "install it from https://github.com/NousResearch/hermes-agent (drag Hermes to Applications), open it once, then run this again" ;;
    *) info desktop "Hermes Desktop: no Hermes AppImage found in the usual folders; check its version in Settings -> About" ;;
  esac
else
  for a in "${APPS[@]}"; do
    v=$(app_version "${a}")
    name=$(basename -- "${a}")
    if [ -z "${v}" ]; then
      info desktop "Hermes Desktop: ${a} (version unknown; check Settings -> About)"
      continue
    fi
    [ "${DESKTOP_VERSION}" = "not found" ] && DESKTOP_VERSION="${v}"
    if version_older "${v}" "${MIN_DESKTOP}"; then
      fix desktop "Hermes Desktop ${v} (${a}) is older than ${MIN_DESKTOP}, the oldest this kit supports" \
        "update Hermes Desktop: Settings -> About -> Update now, or download the newest release"
    else
      ok desktop "Hermes Desktop ${v} (${a}), supported (${MIN_DESKTOP} or newer)"
    fi
    case "${name}" in
      Hermes.app|Hermes-*) ;;
      *) info desktop-build "${name} is not the stable app: Canary and per-commit builds can keep their own Hermes home" ;;
    esac
  done
  if [ ${#APPS[@]} -gt 1 ]; then
    info desktop-multiple "More than one Hermes app is installed; the plugins load in whichever one you open (all of them read the same Hermes home unless a build says otherwise)"
  fi
fi

# --- The Hermes home ------------------------------------------------------------
# HOME_CAT is the home's path category for the summary. HOME_VERIFIED=0 when
# the home Hermes Desktop reads could not be seen (WSL without a view of the
# Windows side, or of its registry HERMES_HOME): then nothing says OK for the
# home and the exit code is 2.
DEFAULT_HOME="${HOME}/.hermes"
HOME_CAT=default-home
HOME_SRC="the default; HERMES_HOME is not set"
HOME_VERIFIED=1
UNVERIFIED=""   # why, when HOME_VERIFIED=0
H=""

trim() { printf '%s\n' "$1" | sed 's/^[[:space:]]*//; s/[[:space:]]*$//'; }
# reg_value: the HERMES_HOME value in `reg query HKCU\Environment /v HERMES_HOME`
# output on stdin (windows-user-env.ts parseRegQueryValue).
reg_value() {
  tr -d '\r' | sed -n 's/^[[:space:]]*[Hh][Ee][Rr][Mm][Ee][Ss]_[Hh][Oo][Mm][Ee][[:space:]][[:space:]]*REG_[A-Z_]*[[:space:]][[:space:]]*\(.*\)$/\1/p' | head -n 1
}
# reg_home_of <reg exit code> <reg output, stderr included>: the value, or ""
# when reg says it is absent ("unable to find the specified registry key or
# value"). Fails when reg could not tell (access denied, a timeout, any other
# error or answer): then the home is unverified, never OK.
reg_home_of() {
  local v
  v=$(printf '%s\n' "$2" | reg_value)
  if [ -n "${v}" ]; then printf '%s\n' "${v}"; return 0; fi
  if [ "$1" != 0 ]; then
    case "$2" in *"unable to find the specified registry key or value"*) return 0 ;; esac
  fi
  return 1
}

# win_home <HERMES_HOME or ""> <LOCALAPPDATA dir> <user profile dir>: Hermes
# Desktop's Windows order (data-paths.mjs:41-66): HERMES_HOME, else
# %LOCALAPPDATA%\hermes, else the legacy <profile>\.hermes when the first is
# missing and the legacy one exists. Sets H, HOME_CAT and HOME_SRC.
win_home() {
  WIN_TARGET=1
  if [ -n "$1" ]; then
    H=$(normalize_home "$1")
    HOME_CAT=HERMES_HOME
    [ "${H}" != "${1%/}" ] && HOME_CAT=profile-scoped
    return 0
  fi
  H="${2%/}/hermes${HERMES_DATA_DIR_SUFFIX:-}"
  HOME_CAT=windows-localappdata
  HOME_SRC="%LOCALAPPDATA%\\hermes, the Windows default"
  if [ -z "${HERMES_DATA_DIR_SUFFIX:-}" ] && [ ! -d "${H}" ] && [ -n "$3" ] && [ -d "${3%/}/.hermes" ]; then
    H="${3%/}/.hermes"
    HOME_CAT=windows-legacy
    HOME_SRC="the legacy %USERPROFILE%\\.hermes; Desktop uses it because %LOCALAPPDATA%\\hermes does not exist"
  fi
}

case "${OS_KIND}" in
  windows)
    to_unix() { if command -v cygpath >/dev/null 2>&1; then cygpath -u "$1"; else printf '%s\n' "$1"; fi; }
    win_profile=$(to_unix "${USERPROFILE:-${HOME}}")
    win_lad=$(trim "${LOCALAPPDATA:-}")
    if [ -n "${win_lad}" ]; then win_lad=$(to_unix "${win_lad}"); else win_lad="${win_profile}/AppData/Local"; fi
    win_hh=""
    if [ -n "${HERMES_HOME:-}" ]; then
      win_hh=$(to_unix "${HERMES_HOME}")
      HOME_SRC="from HERMES_HOME"
    elif [ -z "${HERMES_HOME+set}" ]; then
      # Desktop also reads HKCU\Environment, where a setx after login lands
      # (windows-user-env.ts); an empty HERMES_HOME opts out of that.
      reg_home=""
      if [ -n "${DOCTOR_WIN_REG_HOME+set}" ]; then
        reg_home="${DOCTOR_WIN_REG_HOME}"
      elif command -v reg >/dev/null 2>&1; then
        reg_rc=0
        reg_out=$(MSYS2_ARG_CONV_EXCL='*' MSYS_NO_PATHCONV=1 reg query 'HKCU\Environment' /v HERMES_HOME 2>&1) || reg_rc=$?
        reg_home=$(reg_home_of "${reg_rc}" "${reg_out}") || {
          HOME_VERIFIED=0
          UNVERIFIED="unverified: Desktop may use a HERMES_HOME registry setting the doctor can't read"
        }
      fi
      # %VAR% references expand against the environment, case-insensitively.
      reg_home=$(printf '%s\n' "${reg_home}" | awk '{ out = ""; s = $0
        while (match(s, /%[^%]+%/)) { n = toupper(substr(s, RSTART + 1, RLENGTH - 2)); v = ""
          for (k in ENVIRON) if (toupper(k) == n) v = ENVIRON[k]
          out = out substr(s, 1, RSTART - 1) (v != "" ? v : substr(s, RSTART, RLENGTH)); s = substr(s, RSTART + RLENGTH) }
        print out s }')
      reg_home=$(trim "${reg_home}")
      if [ -n "${reg_home}" ]; then
        win_hh=$(to_unix "${reg_home}")
        HOME_SRC="from HERMES_HOME in the registry (HKCU\\Environment)"
      fi
    fi
    win_home "${win_hh}" "${win_lad}" "${win_profile}"
    info windows "Windows: diagnosing Hermes Desktop for Windows. This doctor checks files only; the kit's installer is for macOS and Linux, so copy the folders by hand (README: Troubleshooting, Hermes Desktop on Windows)"
    ;;
  wsl)
    # Only the current Windows user's own folders, as cmd.exe reports them;
    # never a scan of C:\Users.
    win_vars=""
    if [ -n "${DOCTOR_WIN_VARS+set}" ]; then
      win_vars="${DOCTOR_WIN_VARS}"
    elif command -v cmd.exe >/dev/null 2>&1; then
      t=""; command -v timeout >/dev/null 2>&1 && t="timeout 5"
      win_vars=$(cd /mnt/c 2>/dev/null; ${t} cmd.exe /d /c 'echo %HERMES_HOME%?%LOCALAPPDATA%?%USERPROFILE%' 2>/dev/null | tr -d '\r' | head -n 1)
    fi
    win2wsl() {
      # C:\Users\you -> /mnt/c/Users/you; anything else (UNC, unset) -> fails.
      case "$1" in
        [A-Za-z]:\\*|[A-Za-z]:/*)
          printf '%s/%s/%s\n' "${DOCTOR_WSL_MNT:-/mnt}" "$(printf '%s' "${1%%:*}" | tr 'A-Z' 'a-z')" "$(printf '%s' "${1#?:?}" | tr '\\' '/')" ;;
        *) return 1 ;;
      esac
    }
    IFS='?' read -r w_hh w_lad w_up <<< "${win_vars}"
    wl=$(win2wsl "$(trim "${w_lad:-}")") || wl=""
    wu=$(win2wsl "$(trim "${w_up:-}")") || wu=""
    wh=""
    w_hh=$(trim "${w_hh:-}")
    if [ -n "${w_hh}" ] && [ "${w_hh}" != "%HERMES_HOME%" ]; then
      wh=$(win2wsl "${w_hh}") || wl=""
      HOME_SRC="from HERMES_HOME on the Windows side"
    elif [ -n "${wl}" ]; then
      # Like Desktop, fall back to HKCU\Environment (a setx this cmd.exe
      # missed). A value the doctor can't read or map leaves the home unverified.
      reg_home=""
      reg_ok=1
      if [ -n "${DOCTOR_WIN_REG_HOME+set}" ]; then
        reg_home="${DOCTOR_WIN_REG_HOME}"
      elif command -v reg.exe >/dev/null 2>&1; then
        reg_rc=0
        reg_out=$(cd /mnt/c 2>/dev/null; ${t:-} reg.exe query 'HKCU\Environment' /v HERMES_HOME 2>&1) || reg_rc=$?
        reg_home=$(reg_home_of "${reg_rc}" "${reg_out}") || reg_ok=0
      else
        reg_ok=0
      fi
      reg_home=$(trim "${reg_home}")
      if [ -n "${reg_home}" ]; then
        wh=$(win2wsl "${reg_home}") || reg_ok=0
        case "${reg_home}" in *%*) reg_ok=0 ;; esac
        HOME_SRC="from HERMES_HOME in the registry (HKCU\\Environment)"
      fi
      if [ "${reg_ok}" = 0 ]; then
        wh=""
        HOME_VERIFIED=0
        UNVERIFIED="unverified: Desktop may use a HERMES_HOME registry setting the doctor can't read"
      fi
    fi
    if [ -n "${wl}" ] && [ -d "${wl}" ]; then
      win_home "${wh}" "${wl}" "${wu}"
      info wsl "WSL: diagnosing Hermes Desktop for Windows; its home, seen from WSL, is ${H}"
    else
      HOME_VERIFIED=0
      UNVERIFIED="WSL's; unverified: Windows Desktop reads its own home, not WSL's"
      info wsl "WSL: diagnosing WSL's own Linux home only. Hermes Desktop for Windows reads its own home (%LOCALAPPDATA%\\hermes on the Windows side), which this doctor could not see from here"
    fi
    ;;
esac

if [ "${WIN_TARGET}" = 0 ]; then
  if [ -n "${HERMES_HOME:-}" ]; then
    H=$(normalize_home "${HERMES_HOME}")
    HOME_CAT=HERMES_HOME
    HOME_SRC="from HERMES_HOME"
    if [ "${H}" != "${HERMES_HOME%/}" ]; then
      HOME_CAT=profile-scoped
    fi
  else
    H="${DEFAULT_HOME}"
  fi
fi
if [ "${HOME_CAT}" = profile-scoped ]; then
  fix home-profile "HERMES_HOME points at a profile (${HERMES_HOME:-the registry value}); Hermes Desktop uses its parent, ${H}: unset HERMES_HOME (or set it to that folder), then run the installer again" \
    "$(installer_cmd)"
fi
if [ "${HOME_VERIFIED}" = 0 ]; then
  info home "Hermes home: ${H} (${UNVERIFIED})"
else
  ok home "Hermes home: ${H} (${HOME_SRC})"
fi

if [ ! -d "${H}" ]; then
  fix home "No Hermes home at ${H}: open Hermes Desktop once (it creates the home), then install the kit" "$(installer_cmd)"
fi

# The home a Dock or Finder launch sees on macOS (only launchctl's environment).
GUI_KNOWN=0
GUI_RAW=""
case "${OS_KIND}" in
  windows|wsl) ;;
  *)
    if [ -n "${DOCTOR_GUI_HERMES_HOME+set}" ]; then
      GUI_RAW="${DOCTOR_GUI_HERMES_HOME}"
      GUI_KNOWN=1
    elif [ "${OS_KIND}" = mac ] && command -v launchctl >/dev/null 2>&1; then
      GUI_RAW=$(launchctl getenv HERMES_HOME 2>/dev/null || true)
      GUI_KNOWN=1
    fi
    ;;
esac
if [ "${GUI_KNOWN}" = 1 ]; then
  if [ -n "${GUI_RAW}" ]; then GUI_HOME=$(normalize_home "${GUI_RAW}"); else GUI_HOME="${DEFAULT_HOME}"; fi
  if [ "${GUI_HOME}" != "${H}" ]; then
    if gq=$(shq "${GUI_HOME}"); then
      gui_install=$(installer_cmd "HERMES_HOME=${gq}")
    else
      gui_install="install the kit with HERMES_HOME set to the folder ${GUI_HOME} (its name has a line break or another control character, so no command is shown)"
    fi
    fix gui-home "Hermes Desktop opened from the Dock or Finder uses ${GUI_HOME}, not ${H}: it does not see HERMES_HOME from your shell profile. Either install into the home Desktop uses (first line), or make Desktop use ${H} (second line), then quit and reopen Hermes Desktop" \
      "${gui_install}" \
      "$(cmd "set HERMES_HOME to %s for apps (launchctl setenv HERMES_HOME)" "launchctl setenv HERMES_HOME %s" "${H}")"
  fi
elif [ -n "${HERMES_HOME:-}" ] && [ "${WIN_TARGET}" = 0 ]; then
  info shell-home "HERMES_HOME is set in this shell; an app launcher may not see it. If the plugins don't show, set it where your desktop session reads it (for example ~/.profile)"
fi

# Other Hermes homes in this account's home folder (a second install).
others=""
for d in "${HOME}"/.hermes*; do
  [ -d "${d}" ] || continue
  [ "${d%/}" = "${H}" ] && continue
  [ -d "${d}/desktop-plugins" ] || [ -f "${d}/config.yaml" ] || continue
  others="${others}${others:+, }${d}"
done
[ -n "${others}" ] && info other-homes "Another Hermes home is on this machine: ${others}. Desktop reads only ${H}; the checks below are for that one"

if [ -n "${FLATPAK_ID:-}" ] || [ -n "${SNAP:-}" ]; then
  info sandbox "This shell runs inside a Flatpak or Snap sandbox, whose home can differ from the one Hermes Desktop (an AppImage) uses; run the doctor from a normal terminal"
fi

# --- The desktop-plugins folder ---------------------------------------------------
D="${H}/desktop-plugins"
if [ -d "${D}" ]; then
  ok plugins-folder "Desktop plugins folder: ${D}"
else
  info plugins-folder "Desktop plugins folder: ${D} (does not exist yet)"
fi

RECORD="${D}/.hermes-bot-kit-install"
MANIFEST="${D}/MANIFEST.sha256"
RELEASE="none"
EXPECTED="${KIT_PLUGINS}"
if [ -f "${RECORD}" ]; then
  RELEASE=$(sed -n 's/^release=//p' "${RECORD}" | head -n 1)
  rec_plugins=$(sed -n 's/^plugins=//p' "${RECORD}" | head -n 1)
  [ -n "${rec_plugins}" ] && EXPECTED="${rec_plugins}"
  ok install-record "Install record: release ${RELEASE:-?}, plugins ${rec_plugins:-?}"
elif [ -d "${D}" ]; then
  info install-record "No install record (${RECORD}): the kit was copied by hand or by a release older than v2026.11.16"
fi

expected() { case " ${EXPECTED} " in *" $1 "*) return 0 ;; esac; return 1; }

# Kit plugins in profile folders (an install with HERMES_HOME=.../profiles/<name>).
PROFILE_SCOPED=" "
for pj in "${H}"/profiles/*/desktop-plugins/*/plugin.js; do
  [ -f "${pj}" ] || continue
  p=$(plugin_of "${pj}")
  [ -n "${p}" ] || continue
  dir=$(dirname -- "${pj}")
  prof=$(basename -- "$(dirname -- "$(dirname -- "${dir}")")")
  if [ -f "${D}/${p}/plugin.js" ]; then
    fix "${p}-profile" "${p}: a second copy sits in the profile folder ${dir}; Desktop loads only ${D}/${p} and never this one. Move the profile copy out (first line), then reinstall so ${D}/${p} is current (second line)" \
      "$(cmd "move the folder %s to %s" "mv %s %s" "${dir}" "${H}/desktop-plugins-removed-${prof}-$(basename -- "${dir}")")" \
      "$(installer_cmd)"
  else
    fix "${p}-profile" "${p}: installed in the profile folder ${dir}; desktop plugins belong to the app, in ${D} (Hermes also moves it itself when it next scans its plugins)" \
      "$(cmd "create the folder %s if it is missing, then move the folder %s into it as %s" "mkdir -p %s && mv %s %s" "${D}" "${dir}" "${D}/${p}")"
    PROFILE_SCOPED="${PROFILE_SCOPED}${p} "
  fi
done

# Copies of a kit plugin under another folder name, or nested too deep.
# Desktop loads only desktop-plugins/<folder>/plugin.js (runtime-loader.ts:591),
# so only those count as copies. A deeper one (a backup inside a plugin folder,
# a whole clone) is never loaded: it is the fix only when no loadable copy exists.
LOADABLE=$(find "${D}" -mindepth 2 -maxdepth 2 -name plugin.js 2>/dev/null | sort)
DEEPER=$(find "${D}" -mindepth 3 -maxdepth 4 -name plugin.js 2>/dev/null | sort)
for p in ${KIT_PLUGINS}; do
  want="${D}/${p}/plugin.js"
  found_right=0
  [ "$(plugin_of "${want}")" = "${p}" ] && found_right=1
  stray_hit=0
  while IFS= read -r pj; do
    [ -n "${pj}" ] || continue
    [ "${pj}" = "${want}" ] && continue
    [ "$(plugin_of "${pj}")" = "${p}" ] || continue
    stray_hit=1
    dir=$(dirname -- "${pj}")
    rel=${dir#"${D}/"}
    if [ "${found_right}" != 0 ]; then
      fix "${p}-place" "${p}: an extra copy in desktop-plugins/${rel}; Hermes loads one plugin per id and shows the other copy as an error. Move it out" \
        "$(cmd "move the folder %s to %s" "mv %s %s" "${dir}" "${H}/desktop-plugins-removed-${rel}")"
    else
      fix "${p}-place" "${p}: the folder is named desktop-plugins/${rel}; it must be exactly desktop-plugins/${p} (the installer and updates use that name, and a second copy of one plugin id fails to load)" \
        "$(cmd "rename the folder %s to %s" "mv %s %s" "${dir}" "${D}/${p}")"
      found_right=2
    fi
  done <<< "${LOADABLE}"
  while IFS= read -r pj; do
    [ -n "${pj}" ] || continue
    [ "$(plugin_of "${pj}")" = "${p}" ] || continue
    dir=$(dirname -- "${pj}")
    rel=${dir#"${D}/"}
    if [ "${found_right}" != 0 ]; then
      info "${p}-nested" "${p}: a copy nested in desktop-plugins/${rel} is never loaded (Hermes loads desktop-plugins/<folder>/plugin.js only); left alone"
      continue
    fi
    stray_hit=1
    if [ "${rel%%/*}" = "${p}" ]; then
      fix "${p}-place" "${p}: nested too deep (desktop-plugins/${rel}/plugin.js); Hermes only loads desktop-plugins/<folder>/plugin.js, so it is not loaded" \
        "$(cmd "rename the folder %s to %s, then move the folder %s to %s" "mv %s %s && mv %s %s" "${D}/${p}" "${D}/${p}.nested" "${D}/${p}.nested/${rel#*/}" "${D}/${p}")"
    else
      fix "${p}-place" "${p}: nested too deep (desktop-plugins/${rel}/plugin.js); Hermes only loads desktop-plugins/<folder>/plugin.js, so it is not loaded" \
        "$(cmd "move the folder %s to %s" "mv %s %s" "${dir}" "${D}/${p}")"
    fi
    found_right=2
  done <<< "${DEEPER}"

  if [ "${found_right}" = 0 ]; then
    case "${PROFILE_SCOPED}" in *" ${p} "*) continue ;; esac
    if expected "${p}"; then
      fix "${p}-installed" "${p}: not installed (no ${want})" "$(installer_cmd)"
    else
      info "${p}-installed" "${p}: not installed (left out at install time)"
    fi
    continue
  fi
  [ "${found_right}" = 1 ] || continue
  [ "${stray_hit}" = 1 ] || ok "${p}-place" "${p}: folder name and place are right (${D}/${p})"

  # Every file the installer puts in the plugin folder, against the installed
  # manifest (its skills/ go to the profiles, not here).
  if [ ! -f "${MANIFEST}" ]; then
    fix "${p}-files" "${p}: no MANIFEST.sha256 next to the plugins, so this copy can't be checked" "reinstall: $(installer_cmd)"
    continue
  fi
  if ! awk -v r="${p}/plugin.js" '$2 == r { found = 1 } END { exit !found }' "${MANIFEST}"; then
    fix "${p}-files" "${p}: the installed MANIFEST.sha256 does not list ${p}/plugin.js" "reinstall: $(installer_cmd)"
    continue
  fi
  nbad=0
  nfiles=0
  while read -r want_sha rel; do
    case "${rel}" in
      *..*|"${p}"/skills/*) continue ;;
      "${p}"/*) ;;
      *) continue ;;
    esac
    nfiles=$((nfiles + 1))
    if [ ! -f "${D}/${rel}" ]; then
      fix "${p}-files" "${p}: ${rel#"${p}/"} is missing (a half-copied or hand-made install)" "reinstall: $(installer_cmd)"
      nbad=$((nbad + 1))
    elif [ "$(file_sha256 "${D}/${rel}")" != "${want_sha}" ]; then
      fix "${p}-files" "${p}: ${rel#"${p}/"} does not match the installed MANIFEST.sha256 (edited, half-copied, or from another release)" \
        "reinstall: $(installer_cmd)"
      nbad=$((nbad + 1))
    fi
  done < "${MANIFEST}"
  rel_note=""
  [ -n "${RELEASE}" ] && [ "${RELEASE}" != none ] && rel_note=" (release ${RELEASE})"
  if [ "${nbad}" = 0 ] && [ "${nfiles}" -le 1 ]; then
    ok "${p}-files" "${p}: plugin.js matches MANIFEST.sha256${rel_note}"
  elif [ "${nbad}" = 0 ]; then
    ok "${p}-files" "${p}: plugin.js and its $((nfiles - 1)) other files match MANIFEST.sha256${rel_note}"
  fi
done

# --- Retired kit plugins -------------------------------------------------------------
retired=""
for entry in ${RETIRED_PLUGINS}; do
  name="${entry%%:*}"
  marker="${entry#*:}"
  [ -f "${D}/${name}/plugin.js" ] && grep -qF "${marker}" "${D}/${name}/plugin.js" && retired="${retired} ${name}"
done
if [ -n "${retired}" ]; then
  if [ "${WIN_TARGET}" = 1 ]; then
    retired_fix="move those folders out of ${D} (nothing else needs them)"
    retired_note=""
  else
    retired_fix="$(installer_cmd KIT_REMOVE_RETIRED=1)"
    retired_note=". This moves exactly those to desktop-plugins-retired-<date>/; nothing is deleted"
  fi
  fix retired "Retired kit plugins are still installed:${retired} (Bubble Mode, Task Dock and Bot Sections were retired on 2026-11-10 and can fight Grokbot Override)${retired_note}" \
    "${retired_fix}"
fi
orgo=""
for d in "${H}" "${H}"/profiles/*; do
  [ -d "${d}/plugins/orgo-computer" ] && orgo="${orgo} ${d}"
done
if [ -n "${orgo}" ]; then
  if [ -n "${KIT_REF}" ]; then
    rm_cmd="$(pinned computer-viewer/remove-orgo-computer.sh)"
    rm_note=". The command is a dry run; add --yes after \"\$f\" to move it out (nothing is deleted)"
  else
    rm_cmd="move each plugins/orgo-computer folder out of its Hermes home, and take orgo-computer out of plugins.enabled in that home's config.yaml"
    rm_note=""
  fi
  fix orgo "The retired orgo-computer agent plugin is still installed (in${orgo})${rm_note}" "${rm_cmd}"
fi
[ -z "${retired}" ] && [ -z "${orgo}" ] && ok retired "No retired kit plugins"

# --- Settings this script can't read -----------------------------------------------------
info switches "On/off switches: Hermes keeps them in the app's own storage, which a script can't read. Check Capabilities -> Plugins (in the sidebar): Grokbot Override and Computer should be on"
info override-switch "Grokbot Override has its own switch: if the Bots tab looks stock, press Cmd+K (Ctrl+K on Linux/Windows) -> 'Grokbot Override: toggle'"
info reload "After installing or updating: Cmd+K (Ctrl+K on Linux/Windows) -> 'Reload desktop plugins', or quit and reopen Hermes Desktop (Cmd+Shift+P is not a Hermes shortcut)"

# --- The summary -------------------------------------------------------------------------
# Only closed-set values: each one matches a strict pattern or comes from a
# fixed list, else it reads "unknown". No path and no text from any file.
sum_plugins=""
for p in ${KIT_PLUGINS}; do expected "${p}" && sum_plugins="${sum_plugins} ${p}"; done
case "${HOME_CAT}" in
  default-home|HERMES_HOME|profile-scoped|windows-localappdata|windows-legacy) sum_home="${HOME_CAT}" ;;
  *) sum_home=other ;;
esac
[ "${OS_KIND}" = wsl ] && [ "${HOME_VERIFIED}" = 0 ] && sum_home=wsl
case "${OS_KIND}" in
  mac) sum_ver=$(only '[0-9]+(\.[0-9]+){0,3}' "${OS_VER}") ;;
  linux|wsl) sum_ver=$(only '[a-z0-9._-]{1,32} [A-Za-z0-9._-]{0,32}' "${OS_VER}") ;;
  *) sum_ver=none ;;
esac

echo
if [ "${NFIX}" -eq 0 ] && [ "${HOME_VERIFIED}" = 0 ] && [ "${WIN_TARGET}" = 1 ]; then
  echo "Nothing to fix in ${H}, but Hermes Desktop for Windows may read another home (a HERMES_HOME in the registry): run the README's PowerShell check on Windows (README: Troubleshooting, Hermes Desktop on Windows). Exit code 2."
elif [ "${NFIX}" -eq 0 ] && [ "${HOME_VERIFIED}" = 0 ]; then
  echo "Nothing to fix in WSL's home, but that is not the home Hermes Desktop for Windows reads: check %LOCALAPPDATA%\\hermes\\desktop-plugins on Windows (README: Troubleshooting, Hermes Desktop on Windows). Exit code 2."
elif [ "${NFIX}" -eq 0 ]; then
  echo "Nothing to fix. If the plugins still don't show, reload them (above) and check Capabilities -> Plugins."
else
  echo "${NFIX} thing(s) to fix: run each 'fix:' line above, then reload plugins and run the doctor again."
fi
echo "Opening an issue? Paste everything between the two summary lines (no paths, names or tokens in it):"
echo
echo "--- doctor summary ---"
echo "os: ${OS_KIND} $(only '[A-Za-z0-9_.-]{1,40}' "${UNAME_S}") $(only '[A-Za-z0-9_.+-]{1,64}' "$(uname -r 2>/dev/null)") ${sum_ver}"
if [ "${DESKTOP_VERSION}" = "not found" ]; then
  echo "hermes desktop: not-found"
else
  echo "hermes desktop: $(only '[0-9]+(\.[0-9]+){1,3}' "${DESKTOP_VERSION}")"
fi
echo "kit release: $(only 'v[0-9]{4}\.[0-9]{2}\.[0-9]{2}(\.[0-9]{1,3})?|local|none' "${RELEASE}")"
echo "kit plugins:${sum_plugins:- none}"
echo "hermes home: ${sum_home}"
for l in "${LINES[@]}"; do
  only 'check [a-z0-9-]{1,40} (OK|FIX|INFO)' "${l}"
done
echo "--- doctor summary ---"

[ "${NFIX}" -eq 0 ] || exit 1
[ "${HOME_VERIFIED}" = 1 ] || exit 2
exit 0
