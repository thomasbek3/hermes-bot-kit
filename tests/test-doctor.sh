#!/usr/bin/env bash
# Offline tests for scripts/doctor.sh and install.sh --doctor. Every Hermes home,
# app and HOME is a throwaway folder: the real ~/.hermes and /Applications app
# are never looked at (DOCTOR_APP_PATH and DOCTOR_GUI_HERMES_HOME override them).
set -euo pipefail

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
DOCTOR="${ROOT}/scripts/doctor.sh"
INSTALLER="${ROOT}/install.sh"

WORK=$(mktemp -d)
export TMPDIR="${WORK}"
trap 'rm -rf "${WORK}"' EXIT

fail() { echo "FAIL: $*" >&2; exit 1; }
ok() { echo "OK  $*"; }

# A fake Hermes Desktop: a .app folder with an Info.plist naming a version.
fake_app() {
  # fake_app <dir> <version>
  mkdir -p "$1/Hermes.app/Contents"
  cat > "$1/Hermes.app/Contents/Info.plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict>
  <key>CFBundleShortVersionString</key>
  <string>$2</string>
</dict></plist>
EOF
}

new_user() {
  # new_user: a fresh fake HOME (named after a fake user) with its app; prints HOME.
  local h
  h="$(mktemp -d "${WORK}/u.XXXXXX")/kitdoc"
  mkdir -p "${h}"
  fake_app "${h}/Applications" 0.23.2
  printf '%s\n' "${h}"
}

install_into() {
  # install_into <hermes home> [VAR=value ...]
  local home="$1"
  shift
  env HERMES_HOME="${home}" KIT_SOURCE_DIR="${ROOT}" "$@" bash "${INSTALLER}" >/dev/null
}

# Run the doctor as that fake user, with no HERMES_HOME (so ~/.hermes is used).
OUT=""
RC=0
doctor() {
  # doctor <HOME> [extra env ...]; sets OUT and RC.
  local h="$1"
  shift
  set +e
  OUT=$(env -i PATH=/usr/bin:/bin HOME="${h}" USER="$(basename -- "${h}")" LOGNAME="$(basename -- "${h}")" \
    TMPDIR="${WORK}" DOCTOR_APP_PATH="${h}/Applications/Hermes.app" DOCTOR_GUI_HERMES_HOME= "$@" \
    bash "${DOCTOR}" 2>&1)
  RC=$?
  set -e
}
has() { printf '%s\n' "${OUT}" | grep -qF -- "$1" || fail "$2: no '$1' in:
${OUT}"; }
hasnt() { if printf '%s\n' "${OUT}" | grep -qF -- "$1"; then fail "$2: unexpected '$1' in:
${OUT}"; fi; }
summary() { printf '%s\n' "${OUT}" | awk '/^--- doctor summary ---$/ { n++; print; next } n == 1 { print }'; }

[ -f "${DOCTOR}" ] || fail "scripts/doctor.sh not found"

# The retired-plugin list matches install.sh's.
grep -qxF "$(grep '^RETIRED_PLUGINS=' "${INSTALLER}")" "${DOCTOR}" || fail "RETIRED_PLUGINS differs between install.sh and doctor.sh"
ok "retired-plugin list matches install.sh"

# 1. A good install: exit 0, no FIX, the plugins checked against the manifest.
U=$(new_user)
install_into "${U}/.hermes"
doctor "${U}"
[ "${RC}" -eq 0 ] || fail "good install: exit ${RC}:
${OUT}"
hasnt "FIX" "good install"
has "OK    Hermes Desktop 0.23.2" "good install"
has "OK    grokbot-override: plugin.js matches MANIFEST.sha256" "good install"
CV_OTHERS=$(( $(grep -c ' computer-viewer/' "${ROOT}/MANIFEST.sha256") - 1 ))
has "OK    computer-viewer: plugin.js and its ${CV_OTHERS} other files match MANIFEST.sha256" "good install"
has "Reload desktop plugins" "good install"
[ "$(summary | grep -c '^--- doctor summary ---$')" = 2 ] || fail "good install: the summary is not fenced by two marker lines"
GOOD_OUT="${OUT}"
ok "good install: exit 0, no FIX"

# The doctor is read-only: the home is byte-for-byte the same afterwards.
snap() { (cd "$1" && find . -print0 | LC_ALL=C sort -z | xargs -0 ls -ld 2>/dev/null; find . -type f -print0 | LC_ALL=C sort -z | xargs -0 cksum); }
before=$(snap "${U}")
doctor "${U}"
[ "$(snap "${U}")" = "${before}" ] || fail "the doctor changed files in the home"
ok "read-only: nothing in the home changed"

# 2. A missing plugin folder.
U=$(new_user)
install_into "${U}/.hermes"
mv "${U}/.hermes/desktop-plugins/grokbot-override" "$(dirname -- "${U}")/gone"
doctor "${U}"
[ "${RC}" -eq 1 ] || fail "missing folder: exit ${RC}, want 1"
has "FIX   grokbot-override: not installed" "missing folder"
has "install.sh" "missing folder (the fix names the installer)"
hasnt "FIX   computer-viewer" "missing folder"
ok "missing plugin folder: FIX naming it"

# 3. A wrong folder name (a GitHub zip's -main folder).
U=$(new_user)
install_into "${U}/.hermes"
D="${U}/.hermes/desktop-plugins"
mv "${D}/grokbot-override" "${D}/grokbot-override-main"
doctor "${U}"
[ "${RC}" -eq 1 ] || fail "wrong name: exit ${RC}, want 1"
has "FIX   grokbot-override: the folder is named desktop-plugins/grokbot-override-main" "wrong name"
has "fix: mv \"${D}/grokbot-override-main\" \"${D}/grokbot-override\"" "wrong name"
hasnt "grokbot-override: not installed" "wrong name"
ok "wrong folder name: FIX with the rename"

# 3b. Nested one level too deep (a whole clone or zip inside desktop-plugins).
U=$(new_user)
install_into "${U}/.hermes"
D="${U}/.hermes/desktop-plugins"
mkdir -p "${D}/hermes-bot-kit"
mv "${D}/computer-viewer" "${D}/hermes-bot-kit/computer-viewer"
doctor "${U}"
[ "${RC}" -eq 1 ] || fail "nested: exit ${RC}, want 1"
has "FIX   computer-viewer: nested too deep (desktop-plugins/hermes-bot-kit/computer-viewer/plugin.js)" "nested"
has "fix: mv \"${D}/hermes-bot-kit/computer-viewer\" \"${D}/computer-viewer\"" "nested"
ok "nested too deep: FIX with the move"

# 4. A profile-scoped install (HERMES_HOME=<home>/profiles/x).
U=$(new_user)
mkdir -p "${U}/.hermes/profiles/x"
install_into "${U}/.hermes/profiles/x"
doctor "${U}"
[ "${RC}" -eq 1 ] || fail "profile-scoped: exit ${RC}, want 1"
P="${U}/.hermes/profiles/x/desktop-plugins"
has "FIX   grokbot-override: installed in the profile folder ${P}/grokbot-override" "profile-scoped"
has "fix: mkdir -p \"${U}/.hermes/desktop-plugins\" && mv \"${P}/grokbot-override\" \"${U}/.hermes/desktop-plugins/grokbot-override\"" "profile-scoped"
has "FIX   computer-viewer: installed in the profile folder" "profile-scoped"
hasnt "grokbot-override: not installed" "profile-scoped (one FIX per plugin, not two)"
PROFILE_OUT="${OUT}"
# HERMES_HOME pointing at the profile: Desktop uses the parent; say so.
doctor "${U}" HERMES_HOME="${U}/.hermes/profiles/x"
has "FIX   HERMES_HOME points at a profile" "profile HERMES_HOME"
has "Hermes home: ${U}/.hermes (from HERMES_HOME)" "profile HERMES_HOME"
# A profile copy beside an app-level one: never loaded; move it out.
install_into "${U}/.hermes"
doctor "${U}"
has "grokbot-override: a second copy sits in the profile folder" "profile duplicate"
ok "profile-scoped install: FIX with the move"

# 5. A checksum mismatch.
U=$(new_user)
install_into "${U}/.hermes"
printf '\n// edited\n' >> "${U}/.hermes/desktop-plugins/computer-viewer/plugin.js"
doctor "${U}"
[ "${RC}" -eq 1 ] || fail "checksum: exit ${RC}, want 1"
has "FIX   computer-viewer: plugin.js does not match the installed MANIFEST.sha256" "checksum"
has "OK    grokbot-override: plugin.js matches" "checksum"
ok "checksum mismatch: FIX"

# 6. A retired kit plugin (only one carrying the kit's marker counts).
U=$(new_user)
install_into "${U}/.hermes"
mkdir -p "${U}/.hermes/desktop-plugins/bubble-mode" "${U}/.hermes/desktop-plugins/task-dock"
printf 'const STYLE_ID = "hermes-bubble-mode-style"\n' > "${U}/.hermes/desktop-plugins/bubble-mode/plugin.js"
printf '// my own task dock\n' > "${U}/.hermes/desktop-plugins/task-dock/plugin.js"
doctor "${U}"
[ "${RC}" -eq 1 ] || fail "retired: exit ${RC}, want 1"
has "FIX   Retired kit plugins are still installed: bubble-mode " "retired"
has "KIT_REMOVE_RETIRED=1 bash" "retired"
hasnt "task-dock (" "retired (an unmarked folder is not the kit's)"
mkdir -p "${U}/.hermes/profiles/helper/plugins/orgo-computer"
doctor "${U}"
has "FIX   The retired orgo-computer agent plugin is still installed" "orgo"
has "remove-orgo-computer.sh" "orgo"
ok "retired plugins: FIX with the command"

# 7. Old Hermes Desktop and a Dock launch that sees another home.
U=$(new_user)
install_into "${U}/.hermes"
fake_app "${U}/Old" 0.20.5
doctor "${U}" DOCTOR_APP_PATH="${U}/Old/Hermes.app"
has "FIX   Hermes Desktop 0.20.5" "old desktop"
doctor "${U}" DOCTOR_APP_PATH=none
has "Hermes Desktop" "no app"
doctor "${U}" DOCTOR_GUI_HERMES_HOME="${U}/elsewhere"
has "FIX   Hermes Desktop opened from the Dock or Finder uses ${U}/elsewhere" "gui home"
ok "old app and Dock-home mismatch: FIX"

# 8. The summary holds only closed-set values: no path, no name, no token, no
# text from any file, even with token-shaped folder names, a token-shaped
# release in the install record and a Windows path with a username in it.
SUMMARY_LINE='^(--- doctor summary ---|os: (mac|linux|wsl|windows|other) [A-Za-z0-9_.-]+ [A-Za-z0-9_.+-]+ ([0-9]+(\.[0-9]+){0,3}|[a-z0-9._-]{1,32} [A-Za-z0-9._-]{0,32}|unknown|none)|hermes desktop: ([0-9]+(\.[0-9]+){1,3}|not-found|unknown)|kit release: (v[0-9]{4}\.[0-9]{2}\.[0-9]{2}(\.[0-9]{1,3})?|local|none|unknown)|kit plugins: (none|(computer-viewer|grokbot-override)( (computer-viewer|grokbot-override))*)|hermes home: (default-home|HERMES_HOME|profile-scoped|wsl|windows-localappdata|windows-legacy|other)|check [a-z0-9-]{1,40} (OK|FIX|INFO))$'
PLANTED="xoxb-1234.5678-FAKE xoxe.xoxp-1-FAKE sk-FAKEFAKEFAKEFAKE SomeName doctortest"
check_summary() {
  # check_summary <label>: the summary is fenced, every line is allowlisted,
  # and nothing planted, no path and no username is in it.
  local S w
  S=$(summary)
  [ "$(printf '%s\n' "${S}" | grep -c '^--- doctor summary ---$')" = 2 ] || fail "$1: no fenced summary:
${OUT}"
  if printf '%s\n' "${S}" | grep -Evx -- "${SUMMARY_LINE}" | grep -q .; then
    fail "$1: summary lines outside the allowlist:
$(printf '%s\n' "${S}" | grep -Evx -- "${SUMMARY_LINE}")"
  fi
  printf '%s\n' "${S}" | grep -q / && fail "$1: a path is in the summary:
${S}"
  for w in ${PLANTED} "${NAME}" "$(id -un)"; do
    printf '%s\n' "${S}" | grep -qiF -- "${w}" && fail "$1: '${w}' is in the summary:
${S}"
  done
  return 0
}
U=$(new_user)
NAME=$(basename -- "${U}")
install_into "${U}/.hermes"
printf 'SLACK_BOT_TOKEN=xoxb-1234.5678-FAKE\nSLACK_USER_TOKEN=xoxe.xoxp-1-FAKE\nOPENAI_API_KEY=sk-FAKEFAKEFAKEFAKE\nX=doctortest\n' > "${U}/.hermes/.env"
D="${U}/.hermes/desktop-plugins"
# Token-shaped folder names: a misnamed plugin folder and a nested one.
mv "${D}/grokbot-override" "${D}/grokbot-override-xoxe.xoxp-1-FAKE"
mkdir -p "${D}/xoxb-1234.5678-FAKE/sk-FAKEFAKEFAKEFAKE"
cp "${D}/computer-viewer/plugin.js" "${D}/xoxb-1234.5678-FAKE/sk-FAKEFAKEFAKEFAKE/plugin.js"
printf 'release=xoxb-1234.5678-FAKE\nplugins=computer-viewer grokbot-override\n' > "${D}/.hermes-bot-kit-install"
# A home outside $HOME with the username in it.
OTHER="${WORK}/srv/${NAME}/hermes"
mkdir -p "$(dirname -- "${OTHER}")"
cp -R "${U}/.hermes" "${OTHER}"
doctor "${U}" HERMES_HOME="${OTHER}" DOCTOR_GUI_HERMES_HOME="${OTHER}"
has "grokbot-override-xoxe.xoxp-1-FAKE" "privacy (the local output still names the folder)"
check_summary "privacy, HERMES_HOME"
summary | grep -qx 'kit release: unknown' || fail "privacy: a token-shaped release was not replaced"
summary | grep -qx 'hermes home: HERMES_HOME' || fail "privacy: no HERMES_HOME category"
summary | grep -qx 'check grokbot-override-place FIX' || fail "privacy: no check id for the misnamed folder"
printf '%s\n' "${OUT}" | grep -qF "doctortest" && fail "the doctor printed something from .env"
# WSL with the Windows side visible: a Windows path with a username.
MNT="${WORK}/mnt"
WIN_USER=SomeName
WINHOME="${MNT}/c/Users/${WIN_USER}/AppData/Local/hermes"
mkdir -p "$(dirname -- "${WINHOME}")"
cp -R "${U}/.hermes" "${WINHOME}"
doctor "${U}" DOCTOR_OS=wsl DOCTOR_WSL_MNT="${MNT}" 'DOCTOR_WIN_VARS=%HERMES_HOME%?C:\Users\SomeName\AppData\Local?C:\Users\SomeName'
has "Hermes home: ${WINHOME}" "privacy, WSL (the local output names the Windows home)"
check_summary "privacy, WSL"
summary | grep -qx 'hermes home: windows-localappdata' || fail "privacy: no windows-localappdata category"
doctor "${U}"
check_summary "privacy, default home"
summary | grep -qx 'hermes home: default-home' || fail "privacy: no default-home category"
ok "summary: only allowlisted closed-set lines; no path, name, token or file text"

# 9. install.sh --doctor from a clone runs the same checks.
U=$(new_user)
install_into "${U}/.hermes"
set +e
OUT=$(env -i PATH=/usr/bin:/bin HOME="${U}" USER="$(basename -- "${U}")" TMPDIR="${WORK}" \
  DOCTOR_APP_PATH="${U}/Applications/Hermes.app" DOCTOR_GUI_HERMES_HOME= bash "${INSTALLER}" --doctor 2>&1)
RC=$?
set -e
[ "${RC}" -eq 0 ] || fail "install.sh --doctor (clone): exit ${RC}:
${OUT}"
strip() { printf '%s\n' "$1" | grep -E '^(OK|FIX|INFO) ' | sed -E 's#/u\.[A-Za-z0-9]{6}/kitdoc#/U#g'; }
[ "$(strip "${OUT}")" = "$(strip "${GOOD_OUT}")" ] || fail "install.sh --doctor (clone) differs from doctor.sh:
$(strip "${OUT}")"
ok "install.sh --doctor from a clone: the same checks"

# 10. install.sh --doctor fetched alone: downloads doctor.sh from the release
# and runs it only when it matches that release's manifest (fake curl).
grep -q ' scripts/doctor.sh$' "${ROOT}/MANIFEST.sha256" || fail "MANIFEST.sha256 does not list scripts/doctor.sh (run scripts/make-manifest.sh)"
alone="${WORK}/alone"
fake="${WORK}/fake"
mkdir -p "${alone}" "${fake}"
cp "${INSTALLER}" "${alone}/install.sh"
cp "${ROOT}/tests/fake-curl.sh" "${fake}/curl"
chmod +x "${fake}/curl"
remote_doctor() {
  # remote_doctor <fake root> <HOME>
  set +e
  OUT=$(env -i PATH="${fake}:/usr/bin:/bin" HOME="$2" USER="$(basename -- "$2")" TMPDIR="${WORK}" \
    FAKE_ROOT="$1" FAKE_LOG="${WORK}/fake.log" DOCTOR_APP_PATH="$2/Applications/Hermes.app" DOCTOR_GUI_HERMES_HOME= \
    bash "${alone}/install.sh" --doctor 2>&1)
  RC=$?
  set -e
}
remote_doctor "${ROOT}" "${U}"
[ "${RC}" -eq 0 ] || fail "install.sh --doctor (alone): exit ${RC}:
${OUT}"
[ "$(strip "${OUT}")" = "$(strip "${GOOD_OUT}")" ] || fail "install.sh --doctor (alone) ran different checks:
${OUT}"
fallback=$(sed -n 's/^KIT_FALLBACK_REF="\(.*\)"/\1/p' "${INSTALLER}")
[ "$(sort -u "${WORK}/fake.log")" = "${fallback}" ] || fail "install.sh --doctor (alone) fetched another ref: $(sort -u "${WORK}/fake.log" | tr '\n' ' ')"
# Remove the plugin: the fix line is the release's one-liner, not a local path.
mv "${U}/.hermes/desktop-plugins/grokbot-override" "${WORK}/gone-alone"
remote_doctor "${ROOT}" "${U}"
[ "${RC}" -eq 1 ] || fail "install.sh --doctor (alone, missing plugin): exit ${RC}"
has "raw.githubusercontent.com/thomasbek3/hermes-bot-kit/${fallback}/install.sh" "alone: release one-liner in the fix"
# A tampered doctor.sh is refused, not run.
bad="${WORK}/bad-root"
mkdir -p "${bad}/scripts"
cp "${ROOT}/MANIFEST.sha256" "${bad}/MANIFEST.sha256"
{ cat "${DOCTOR}"; echo 'echo TAMPERED'; } > "${bad}/scripts/doctor.sh"
remote_doctor "${bad}" "${U}"
[ "${RC}" -ne 0 ] || fail "a tampered doctor.sh ran"
has "sha256 mismatch for scripts/doctor.sh" "tampered doctor"
hasnt "TAMPERED" "tampered doctor"
ok "install.sh --doctor fetched alone: verified against the manifest, tamper refused"

# 10b. A doctor.sh sitting beside a fetched-alone install.sh (a shared /tmp) is
# never run, even with a manifest beside it that lists its digest: no .git, so
# not a checkout. The release's doctor is downloaded and verified instead.
mkdir -p "${alone}/scripts"
printf '#!/usr/bin/env bash\ntouch "%s/PLANTED-RAN"\necho PLANTED\n' "${WORK}" > "${alone}/scripts/doctor.sh"
{ shasum -a 256 "${alone}/scripts/doctor.sh" 2>/dev/null || sha256sum "${alone}/scripts/doctor.sh"; } | awk '{print $1 "  scripts/doctor.sh"}' > "${alone}/MANIFEST.sha256"
mv "${WORK}/gone-alone" "${U}/.hermes/desktop-plugins/grokbot-override"
: > "${WORK}/fake.log"
remote_doctor "${ROOT}" "${U}"
[ ! -e "${WORK}/PLANTED-RAN" ] || fail "install.sh --doctor ran the doctor.sh beside it"
hasnt "PLANTED" "planted doctor"
[ "${RC}" -eq 0 ] || fail "planted doctor: the release doctor did not run cleanly (exit ${RC}):
${OUT}"
[ "$(strip "${OUT}")" = "$(strip "${GOOD_OUT}")" ] || fail "planted doctor: not the release's checks:
${OUT}"
[ "$(sort -u "${WORK}/fake.log")" = "${fallback}" ] || fail "planted doctor: the release doctor was not downloaded"
# A real checkout (a .git beside install.sh, doctor.sh matching its manifest)
# runs its own doctor without downloading; an edited one is not run.
co="${WORK}/checkout"
mkdir -p "${co}/scripts" "${co}/.git"
cp "${INSTALLER}" "${co}/install.sh"
cp "${ROOT}/MANIFEST.sha256" "${co}/MANIFEST.sha256"
cp "${DOCTOR}" "${co}/scripts/doctor.sh"
: > "${WORK}/fake.log"
set +e
OUT=$(env -i PATH="${fake}:/usr/bin:/bin" HOME="${U}" USER=kitdoc TMPDIR="${WORK}" FAKE_ROOT="${ROOT}" FAKE_LOG="${WORK}/fake.log" \
  DOCTOR_APP_PATH="${U}/Applications/Hermes.app" DOCTOR_GUI_HERMES_HOME= bash "${co}/install.sh" --doctor 2>&1)
RC=$?
set -e
[ "${RC}" -eq 0 ] || fail "checkout doctor: exit ${RC}:
${OUT}"
[ ! -s "${WORK}/fake.log" ] || fail "checkout doctor: downloaded instead of running the checkout's copy"
echo 'echo LOCAL-EDIT' >> "${co}/scripts/doctor.sh"
set +e
OUT=$(env -i PATH="${fake}:/usr/bin:/bin" HOME="${U}" USER=kitdoc TMPDIR="${WORK}" FAKE_ROOT="${ROOT}" FAKE_LOG="${WORK}/fake.log" \
  DOCTOR_APP_PATH="${U}/Applications/Hermes.app" DOCTOR_GUI_HERMES_HOME= bash "${co}/install.sh" --doctor 2>&1)
set -e
hasnt "LOCAL-EDIT" "checkout doctor that does not match its manifest"
[ -s "${WORK}/fake.log" ] || fail "checkout doctor (edited): the release doctor was not downloaded"
ok "install.sh --doctor: a neighbouring doctor.sh runs only in a real checkout and only when it matches"

# 11. Every runtime file of a plugin is checked against the manifest.
U=$(new_user)
install_into "${U}/.hermes"
V="${U}/.hermes/desktop-plugins/computer-viewer/vendor/novnc-rfb.mjs"
mv "${V}" "${WORK}/novnc.saved"
doctor "${U}"
[ "${RC}" -eq 1 ] || fail "missing runtime file: exit ${RC}, want 1"
has "FIX   computer-viewer: vendor/novnc-rfb.mjs is missing" "missing runtime file"
has "install.sh" "missing runtime file (the fix names the installer)"
hasnt "Nothing to fix" "missing runtime file"
mv "${WORK}/novnc.saved" "${V}"
python3 -c 'import sys; p = sys.argv[1]; b = bytearray(open(p, "rb").read()); b[0] ^= 1; open(p, "wb").write(b)' "${V}"
doctor "${U}"
[ "${RC}" -eq 1 ] || fail "changed runtime file: exit ${RC}, want 1"
has "FIX   computer-viewer: vendor/novnc-rfb.mjs does not match the installed MANIFEST.sha256" "changed runtime file"
ok "runtime files: a missing or changed one is a FIX naming it"

# 12. A backup copy nested inside a plugin folder is never loaded: no FIX, and
# never a move of the working folder.
U=$(new_user)
install_into "${U}/.hermes"
D="${U}/.hermes/desktop-plugins"
mkdir -p "${D}/grokbot-override/backup"
cp "${D}/grokbot-override/plugin.js" "${D}/grokbot-override/backup/plugin.js"
doctor "${U}"
[ "${RC}" -eq 0 ] || fail "nested backup: exit ${RC}, want 0:
${OUT}"
hasnt "FIX" "nested backup"
hasnt "mv \"${D}/grokbot-override\"" "nested backup (no move of the working folder)"
has "OK    grokbot-override: plugin.js matches MANIFEST.sha256" "nested backup"
ok "nested backup copy: no FIX, exit 0"

# 13. WSL: the Windows home is checked when the current Windows user's folder
# can be seen; otherwise the home is unverified, never OK, and the exit is 2.
U=$(new_user)
MNT="${WORK}/mnt-wsl"
WIN_USER="Win User"
OTHER_ACCOUNT=Another
WIN_LAD="${MNT}/c/Users/${WIN_USER}/AppData/Local"
mkdir -p "${WIN_LAD}" "${MNT}/c/Users/${OTHER_ACCOUNT}/AppData/Local/hermes/desktop-plugins"
install_into "${WIN_LAD}/hermes"
WSL_VARS='DOCTOR_WIN_VARS=%HERMES_HOME%?C:\Users\Win User\AppData\Local?C:\Users\Win User'
doctor "${U}" DOCTOR_OS=wsl DOCTOR_WSL_MNT="${MNT}" "${WSL_VARS}"
[ "${RC}" -eq 0 ] || fail "WSL with a Windows home: exit ${RC}:
${OUT}"
has "WSL: diagnosing Hermes Desktop for Windows" "WSL windows home"
has "OK    Hermes home: ${WIN_LAD}/hermes (%LOCALAPPDATA%\\hermes, the Windows default)" "WSL windows home"
has "OK    grokbot-override: plugin.js matches" "WSL windows home"
hasnt "${OTHER_ACCOUNT}" "WSL (another account's folder listed)"
# The Windows home without the kit: the fix is the Windows copy step.
mv "${WIN_LAD}/hermes/desktop-plugins/grokbot-override" "${WORK}/gone-wsl"
doctor "${U}" DOCTOR_OS=wsl DOCTOR_WSL_MNT="${MNT}" "${WSL_VARS}"
[ "${RC}" -eq 1 ] || fail "WSL, Windows home missing a plugin: exit ${RC}"
has "fix: on Windows: copy the grokbot-override and computer-viewer folders and MANIFEST.sha256" "WSL fix text"
# Windows side not visible, a good WSL-only install: unverified, exit 2.
install_into "${U}/.hermes"
doctor "${U}" DOCTOR_OS=wsl DOCTOR_WIN_VARS=
[ "${RC}" -eq 2 ] || fail "WSL-only copy: exit ${RC}, want 2:
${OUT}"
has "INFO  Hermes home: ${U}/.hermes (WSL's; unverified: Windows Desktop reads its own home, not WSL's)" "WSL unverified"
hasnt "OK    Hermes home" "WSL unverified"
hasnt "Nothing to fix. If" "WSL unverified"
summary | grep -qx 'hermes home: wsl' || fail "WSL unverified: no wsl category"
ok "WSL: Windows home checked when visible; otherwise unverified, exit 2"

# 14. Windows (Git Bash): Desktop's order. HERMES_HOME, then the registry
# value, then %LOCALAPPDATA%\hermes, then a legacy ~/.hermes only when the
# first is missing.
U=$(new_user)
mkdir -p "${U}/AppData/Local"
install_into "${U}/.hermes"
win() { doctor "${U}" DOCTOR_OS=windows LOCALAPPDATA="${U}/AppData/Local" USERPROFILE="${U}" "$@"; }
win DOCTOR_WIN_REG_HOME=
[ "${RC}" -eq 0 ] || fail "Windows legacy home: exit ${RC}:
${OUT}"
has "OK    Hermes home: ${U}/.hermes (the legacy %USERPROFILE%\\.hermes" "Windows legacy home"
summary | grep -qx 'hermes home: windows-legacy' || fail "Windows legacy: no windows-legacy category"
mkdir -p "${U}/AppData/Local/hermes"
win DOCTOR_WIN_REG_HOME=
has "OK    Hermes home: ${U}/AppData/Local/hermes (%LOCALAPPDATA%" "Windows LOCALAPPDATA home"
has "fix: on Windows: copy the grokbot-override and computer-viewer folders" "Windows fix text"
win DOCTOR_WIN_REG_HOME="%USERPROFILE%/.hermes"
has "OK    Hermes home: ${U}/.hermes (from HERMES_HOME in the registry" "Windows registry home"
win HERMES_HOME= DOCTOR_WIN_REG_HOME="${U}/.hermes"
has "OK    Hermes home: ${U}/AppData/Local/hermes" "Windows: an empty HERMES_HOME skips the registry"
ok "Windows: HERMES_HOME, registry, %LOCALAPPDATA%, legacy, in Desktop's order"

echo "test-doctor.sh: all passed"
