#!/usr/bin/env bash
# Hermes Bot Kit doctor: says why the kit's desktop plugins are not showing up.
# Read-only: it changes nothing, reads no .env, no tokens and no settings
# values. One line per check (OK, FIX or INFO); every FIX is followed by the
# exact fix. It ends with a summary you can paste into an issue: paths under
# your home folder become ~, your username becomes <user>.
#
#   bash scripts/doctor.sh            (from a clone)
#   bash install.sh --doctor          (the same checks; fetched alone, it
#                                      downloads this script from the same
#                                      release and checks its digest first)
#
# Exit 0 when nothing needs fixing, 1 when any check says FIX.
#
# Facts it relies on (Hermes v0.23.2, apps/desktop/):
#   - Desktop loads <HERMES_HOME>/desktop-plugins/<folder>/plugin.js, one level
#     deep, for the whole app, not per profile (electron/fs-ipc.ts:141-150,
#     src/contrib/runtime-loader.ts:590-595, 960-975).
#   - HERMES_HOME, else ~/.hermes; a HERMES_HOME inside profiles/ means its
#     parent; Windows: %LOCALAPPDATA%\hermes (electron/data-paths.mjs:14-66).
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
#   - The command palette is Cmd+K or Cmd+P (Ctrl elsewhere); there is no
#     Cmd+Shift+P (src/lib/keybinds/actions.ts:202). The reload command is
#     "Reload desktop plugins" (src/app/contrib/controller.tsx:332-339).
#
# Test overrides (never needed in normal use):
#   DOCTOR_APP_PATH        Hermes app(s) to check instead of searching, separated
#                          by ':' (a .app folder or an .AppImage); "none" = none
#   DOCTOR_GUI_HERMES_HOME the HERMES_HOME a Dock launch sees, instead of asking
#                          launchctl ("" = not set)
#   DOCTOR_KIT_REF         the kit release for the fix commands (install.sh
#                          --doctor sets it)
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

SELF_DIR=$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
KIT_DIR=""
if [ -f "${SELF_DIR}/../install.sh" ] && [ -f "${SELF_DIR}/../computer-viewer/plugin.js" ]; then
  KIT_DIR=$(CDPATH= cd -- "${SELF_DIR}/.." && pwd)
fi

LINES=()   # "STATUS<TAB>message" for the summary
NFIX=0

ok()   { printf 'OK    %s\n' "$1"; LINES+=("OK	$1"); }
info() { printf 'INFO  %s\n' "$1"; LINES+=("INFO	$1"); }
fix()  {
  printf 'FIX   %s\n' "$1"
  printf '      fix: %s\n' "$2"
  LINES+=("FIX	$1")
  NFIX=$((NFIX + 1))
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

# The release for the fix commands: install.sh --doctor passes it; a clone's
# own install.sh names the release it came with.
KIT_REF="${DOCTOR_KIT_REF:-}"
if [ -z "${KIT_REF}" ] && [ -n "${KIT_DIR}" ]; then
  KIT_REF=$(sed -n 's/^KIT_FALLBACK_REF="\(.*\)"/\1/p' "${KIT_DIR}/install.sh" | head -n 1)
fi
installer_cmd() {
  # installer_cmd [VAR=value]: the exact command that (re)installs the kit.
  local pre="${1:+$1 }"
  if [ -n "${KIT_DIR}" ]; then
    printf '%sbash "%s/install.sh"' "${pre}" "${KIT_DIR}"
  elif [ -n "${KIT_REF}" ]; then
    printf '( set -e; f=$(mktemp); trap '"'"'rm -f "$f"'"'"' EXIT; curl -fsSL https://raw.githubusercontent.com/%s/%s/install.sh -o "$f"; test -s "$f"; %sbash "$f" )' "${KIT_REPO}" "${KIT_REF}" "${pre}"
  else
    printf 'the install command in https://github.com/%s#install%s' "${KIT_REPO}" "${1:+, with $1 in front of bash}"
  fi
}

# --- The machine ------------------------------------------------------------
OS_KIND=other
OS_LINE=$(uname -s 2>/dev/null || echo unknown)
case "${OS_LINE}" in
  Darwin)
    OS_KIND=mac
    OS_LINE="macOS $(sw_vers -productVersion 2>/dev/null || echo '?') ($(uname -m))"
    ;;
  Linux)
    OS_KIND=linux
    pretty=$(sed -n 's/^PRETTY_NAME="\{0,1\}\([^"]*\)"\{0,1\}$/\1/p' /etc/os-release 2>/dev/null | head -n 1)
    OS_LINE="Linux ${pretty:-$(uname -r)} ($(uname -m))"
    if grep -qi microsoft /proc/sys/kernel/osrelease 2>/dev/null; then
      OS_KIND=wsl
      OS_LINE="${OS_LINE}, WSL"
    fi
    ;;
  MINGW*|MSYS*|CYGWIN*) OS_KIND=windows; OS_LINE="Windows (${OS_LINE})" ;;
esac
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
    mac) fix "Hermes Desktop: not found in /Applications or ~/Applications" \
      "install it from https://github.com/NousResearch/hermes-agent (drag Hermes to Applications), open it once, then run this again" ;;
    *) info "Hermes Desktop: no Hermes AppImage found in the usual folders; check its version in Settings -> About" ;;
  esac
else
  for a in "${APPS[@]}"; do
    v=$(app_version "${a}")
    name=$(basename -- "${a}")
    if [ -z "${v}" ]; then
      info "Hermes Desktop: ${a} (version unknown; check Settings -> About)"
      continue
    fi
    [ "${DESKTOP_VERSION}" = "not found" ] && DESKTOP_VERSION="${v}"
    if version_older "${v}" "${MIN_DESKTOP}"; then
      fix "Hermes Desktop ${v} (${a}) is older than ${MIN_DESKTOP}, the oldest this kit supports" \
        "update Hermes Desktop: Settings -> About -> Update now, or download the newest release"
    else
      ok "Hermes Desktop ${v} (${a}), supported (${MIN_DESKTOP} or newer)"
    fi
    case "${name}" in
      Hermes.app|Hermes-*) ;;
      *) info "${name} is not the stable app: Canary and per-commit builds can keep their own Hermes home" ;;
    esac
  done
  if [ ${#APPS[@]} -gt 1 ]; then
    info "More than one Hermes app is installed; the plugins load in whichever one you open (all of them read the same Hermes home unless a build says otherwise)"
  fi
fi

# --- The Hermes home ------------------------------------------------------------
case "${OS_KIND}" in
  windows)
    if [ -n "${LOCALAPPDATA:-}" ]; then
      DEFAULT_HOME="${LOCALAPPDATA}/hermes"
      command -v cygpath >/dev/null 2>&1 && DEFAULT_HOME=$(cygpath -u "${LOCALAPPDATA}")/hermes
    else
      DEFAULT_HOME="${HOME}/AppData/Local/hermes"
    fi
    info "Windows: this doctor checks files only; Hermes Desktop on Windows uses %LOCALAPPDATA%\\hermes unless HERMES_HOME is set, and the kit's installer is for macOS and Linux"
    ;;
  *) DEFAULT_HOME="${HOME}/.hermes" ;;
esac

if [ -n "${HERMES_HOME:-}" ]; then
  H=$(normalize_home "${HERMES_HOME}")
  if [ "${H}" != "${HERMES_HOME%/}" ]; then
    fix "HERMES_HOME points at a profile (${HERMES_HOME}); Hermes Desktop uses its parent, ${H}" \
      "unset HERMES_HOME (or set it to ${H}) and run the installer again: $(installer_cmd)"
  fi
  ok "Hermes home: ${H} (from HERMES_HOME)"
else
  H="${DEFAULT_HOME}"
  ok "Hermes home: ${H} (the default; HERMES_HOME is not set)"
fi

if [ ! -d "${H}" ]; then
  fix "No Hermes home at ${H}" "open Hermes Desktop once (it creates the home), then install the kit: $(installer_cmd)"
fi

# The home a Dock or Finder launch sees on macOS (only launchctl's environment).
if [ -n "${DOCTOR_GUI_HERMES_HOME+set}" ]; then
  GUI_RAW="${DOCTOR_GUI_HERMES_HOME}"
  GUI_KNOWN=1
elif [ "${OS_KIND}" = mac ] && command -v launchctl >/dev/null 2>&1; then
  GUI_RAW=$(launchctl getenv HERMES_HOME 2>/dev/null || true)
  GUI_KNOWN=1
else
  GUI_RAW=""
  GUI_KNOWN=0
fi
if [ "${GUI_KNOWN}" = 1 ]; then
  if [ -n "${GUI_RAW}" ]; then GUI_HOME=$(normalize_home "${GUI_RAW}"); else GUI_HOME="${DEFAULT_HOME}"; fi
  if [ "${GUI_HOME}" != "${H}" ]; then
    fix "Hermes Desktop opened from the Dock or Finder uses ${GUI_HOME}, not ${H}: it does not see HERMES_HOME from your shell profile" \
      "install into the home Desktop uses: $(installer_cmd "HERMES_HOME=${GUI_HOME}")   or make Desktop use ${H}: launchctl setenv HERMES_HOME \"${H}\", then quit and reopen Hermes Desktop"
  fi
elif [ -n "${HERMES_HOME:-}" ]; then
  info "HERMES_HOME is set in this shell; an app launcher may not see it. If the plugins don't show, set it where your desktop session reads it (for example ~/.profile)"
fi

# Other Hermes homes on this machine (a second install).
others=""
for d in "${HOME}"/.hermes*; do
  [ -d "${d}" ] || continue
  [ "${d%/}" = "${H}" ] && continue
  [ -d "${d}/desktop-plugins" ] || [ -f "${d}/config.yaml" ] || continue
  others="${others}${others:+, }${d}"
done
if [ "${OS_KIND}" = wsl ]; then
  for d in /mnt/c/Users/*/AppData/Local/hermes; do
    [ -d "${d}" ] && others="${others}${others:+, }${d} (Hermes Desktop for Windows)"
  done
  info "WSL: Hermes Desktop for Windows does not read this Linux home; it uses %LOCALAPPDATA%\\hermes on the Windows side"
fi
[ -n "${others}" ] && info "Another Hermes home is on this machine: ${others}. Desktop reads only ${H}; the checks below are for that one"

if [ -n "${FLATPAK_ID:-}" ] || [ -n "${SNAP:-}" ]; then
  info "This shell runs inside a Flatpak or Snap sandbox, whose home can differ from the one Hermes Desktop (an AppImage) uses; run the doctor from a normal terminal"
fi

# --- The desktop-plugins folder ---------------------------------------------------
D="${H}/desktop-plugins"
if [ -d "${D}" ]; then
  ok "Desktop plugins folder: ${D}"
else
  info "Desktop plugins folder: ${D} (does not exist yet)"
fi

RECORD="${D}/.hermes-bot-kit-install"
MANIFEST="${D}/MANIFEST.sha256"
RELEASE="none"
EXPECTED="${KIT_PLUGINS}"
if [ -f "${RECORD}" ]; then
  RELEASE=$(sed -n 's/^release=//p' "${RECORD}" | head -n 1)
  rec_plugins=$(sed -n 's/^plugins=//p' "${RECORD}" | head -n 1)
  [ -n "${rec_plugins}" ] && EXPECTED="${rec_plugins}"
  ok "Install record: release ${RELEASE:-?}, plugins ${rec_plugins:-?}"
elif [ -d "${D}" ]; then
  info "No install record (${RECORD}): the kit was copied by hand or by a release older than v2026.11.16"
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
    fix "${p}: a second copy sits in the profile folder ${dir}; Desktop loads only ${D}/${p} and never this one" \
      "move the profile copy out: mv \"${dir}\" \"${H}/desktop-plugins-removed-${prof}-$(basename -- "${dir}")\"   then reinstall so ${D}/${p} is current: $(installer_cmd)"
  else
    fix "${p}: installed in the profile folder ${dir}; desktop plugins belong to the app, in ${D}" \
      "mkdir -p \"${D}\" && mv \"${dir}\" \"${D}/${p}\"   (Hermes also moves it itself when it next scans its plugins)"
    PROFILE_SCOPED="${PROFILE_SCOPED}${p} "
  fi
done

# Copies of a kit plugin under another folder name, or nested too deep.
STRAYS=$(find "${D}" -mindepth 2 -maxdepth 4 -name plugin.js 2>/dev/null | sort)
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
      fix "${p}: an extra copy in desktop-plugins/${rel}; Hermes loads one plugin per id and shows the other copy as an error" \
        "move it out: mv \"${D}/${rel%%/*}\" \"${H}/desktop-plugins-removed-${rel%%/*}\""
    elif [ "${rel}" = "${rel#*/}" ]; then
      fix "${p}: the folder is named desktop-plugins/${rel}; it must be exactly desktop-plugins/${p} (the installer and updates use that name, and a second copy of one plugin id fails to load)" \
        "mv \"${dir}\" \"${D}/${p}\""
      found_right=2
    elif [ "${rel%%/*}" = "${p}" ]; then
      fix "${p}: nested too deep (desktop-plugins/${rel}/plugin.js); Hermes only loads desktop-plugins/<folder>/plugin.js, so it is not loaded" \
        "mv \"${D}/${p}\" \"${D}/${p}.nested\" && mv \"${D}/${p}.nested/${rel#*/}\" \"${D}/${p}\""
      found_right=2
    else
      fix "${p}: nested too deep (desktop-plugins/${rel}/plugin.js); Hermes only loads desktop-plugins/<folder>/plugin.js, so it is not loaded" \
        "mv \"${dir}\" \"${D}/${p}\""
      found_right=2
    fi
  done <<< "${STRAYS}"

  if [ "${found_right}" = 0 ]; then
    case "${PROFILE_SCOPED}" in *" ${p} "*) continue ;; esac
    if expected "${p}"; then
      fix "${p}: not installed (no ${want})" "$(installer_cmd)"
    else
      info "${p}: not installed (left out at install time)"
    fi
    continue
  fi
  [ "${found_right}" = 1 ] || continue
  [ "${stray_hit}" = 1 ] || ok "${p}: folder name and place are right (${D}/${p})"

  # The installed plugin.js against the installed manifest.
  if [ ! -f "${MANIFEST}" ]; then
    fix "${p}: no MANIFEST.sha256 next to the plugins, so this copy can't be checked" "reinstall: $(installer_cmd)"
    continue
  fi
  want_sha=$(awk -v r="${p}/plugin.js" '$2 == r { print $1; exit }' "${MANIFEST}")
  if [ -z "${want_sha}" ]; then
    fix "${p}: the installed MANIFEST.sha256 does not list ${p}/plugin.js" "reinstall: $(installer_cmd)"
  elif [ "$(file_sha256 "${want}")" != "${want_sha}" ]; then
    fix "${p}: plugin.js does not match the installed MANIFEST.sha256 (edited, half-copied, or from another release)" \
      "reinstall: $(installer_cmd)"
  else
    if [ "${RELEASE}" = none ]; then
      ok "${p}: plugin.js matches MANIFEST.sha256"
    else
      ok "${p}: plugin.js matches MANIFEST.sha256 (release ${RELEASE})"
    fi
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
  fix "Retired kit plugins are still installed:${retired} (Bubble Mode, Task Dock and Bot Sections were retired on 2026-11-10 and can fight Grokbot Override)" \
    "$(installer_cmd KIT_REMOVE_RETIRED=1)   (moves exactly those to desktop-plugins-retired-<date>/; nothing is deleted)"
fi
orgo=""
for d in "${H}" "${H}"/profiles/*; do
  [ -d "${d}/plugins/orgo-computer" ] && orgo="${orgo} ${d}"
done
if [ -n "${orgo}" ]; then
  if [ -n "${KIT_DIR}" ]; then
    rm_cmd="bash \"${KIT_DIR}/computer-viewer/remove-orgo-computer.sh\""
  elif [ -n "${KIT_REF}" ]; then
    # Downloaded to a file first and pinned to the release, like the installer.
    rm_cmd="( set -e; f=\$(mktemp); trap 'rm -f \"\$f\"' EXIT; curl -fsSL https://raw.githubusercontent.com/${KIT_REPO}/${KIT_REF}/computer-viewer/remove-orgo-computer.sh -o \"\$f\"; test -s \"\$f\"; bash \"\$f\" )"
  else
    rm_cmd="bash computer-viewer/remove-orgo-computer.sh   (from a clone of the kit: git clone https://github.com/${KIT_REPO})"
  fi
  fix "The retired orgo-computer agent plugin is still installed (in${orgo})" \
    "${rm_cmd}   (a dry run; add --yes to move it out, nothing is deleted)"
fi
[ -z "${retired}" ] && [ -z "${orgo}" ] && ok "No retired kit plugins"

# --- Settings this script can't read -----------------------------------------------------
info "On/off switches: Hermes keeps them in the app's own storage, which a script can't read. Check Capabilities -> Plugins (in the sidebar): Grokbot Override and Computer should be on"
info "Grokbot Override has its own switch: if the Bots tab looks stock, press Cmd+K (Ctrl+K on Linux/Windows) -> 'Grokbot Override: toggle'"
info "After installing or updating: Cmd+K (Ctrl+K on Linux/Windows) -> 'Reload desktop plugins', or quit and reopen Hermes Desktop (Cmd+Shift+P is not a Hermes shortcut)"

# --- The summary -------------------------------------------------------------------------
USERS=" "
for u in "${USER:-}" "${LOGNAME:-}" "$(id -un 2>/dev/null || true)"; do
  [ -n "${u}" ] && USERS="${USERS}${u} "
done
redact() {
  # $HOME -> ~, then each username (as a whole word) -> <user>, then anything
  # token-shaped -> <redacted>. Plain string matching, no regex on the names.
  awk -v home="${HOME%/}" -v users="${USERS}" '
    function swap(s, from, to, whole,   out, i, before, after) {
      out = ""
      while ((i = index(s, from)) > 0) {
        before = (i > 1) ? substr(s, i - 1, 1) : ""
        after = substr(s, i + length(from), 1)
        if (!whole || (before !~ /[A-Za-z0-9_]/ && after !~ /[A-Za-z0-9_]/)) {
          out = out substr(s, 1, i - 1) to
        } else {
          out = out substr(s, 1, i - 1 + length(from))
        }
        s = substr(s, i + length(from))
      }
      return out s
    }
    BEGIN { n = split(users, u, " ") }
    {
      line = $0
      if (length(home) > 1) line = swap(line, home, "~", 0)
      for (k = 1; k <= n; k++) if (length(u[k]) > 0) line = swap(line, u[k], "<user>", 1)
      print line
    }' | sed -E \
      -e 's/(xox[abposre]|xapp)-[A-Za-z0-9-]+/<redacted>/g' \
      -e 's/(sk|pk|rk)-[A-Za-z0-9_-]{8,}/<redacted>/g' \
      -e 's/(gh[pousr]_|github_pat_)[A-Za-z0-9_]{8,}/<redacted>/g' \
      -e 's/AKIA[0-9A-Z]{12,}/<redacted>/g' \
      -e 's/passwd=[0-9A-Fa-f]+/passwd=<redacted>/g'
}

echo
if [ "${NFIX}" -eq 0 ]; then
  echo "Nothing to fix. If the plugins still don't show, reload them (above) and check Capabilities -> Plugins."
else
  echo "${NFIX} thing(s) to fix: run each 'fix:' line above, then reload plugins and run the doctor again."
fi
echo "Opening an issue? Paste everything between the two summary lines:"
echo
{
  echo "--- doctor summary ---"
  echo "os: ${OS_LINE}"
  echo "hermes desktop: ${DESKTOP_VERSION} (kit supports ${MIN_DESKTOP}+)"
  echo "kit release: ${RELEASE}"
  echo "hermes home: ${H}"
  for l in "${LINES[@]}"; do
    printf '%-4s %s\n' "${l%%	*}" "${l#*	}"
  done
  echo "--- doctor summary ---"
} | redact

[ "${NFIX}" -eq 0 ]
