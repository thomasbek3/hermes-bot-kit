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
has "OK    computer-viewer: plugin.js matches MANIFEST.sha256" "good install"
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

# 8. The summary: $HOME -> ~, the username -> <user>, no token-shaped strings.
U=$(new_user)
NAME=$(basename -- "${U}")
install_into "${U}/.hermes"
printf 'SLACK_BOT_TOKEN=xoxb-FAKE-000000-doctortest\nOPENAI_API_KEY=sk-FAKEFAKEFAKEFAKE\n' > "${U}/.hermes/.env"
# A misnamed folder whose name looks like a token: its FIX line must be redacted.
mv "${U}/.hermes/desktop-plugins/grokbot-override" "${U}/.hermes/desktop-plugins/grokbot-override-xoxb-FAKE-111"
# A home outside $HOME with the username in it.
OTHER="${WORK}/srv/${NAME}/hermes"
mkdir -p "$(dirname -- "${OTHER}")"
cp -R "${U}/.hermes" "${OTHER}"
doctor "${U}" HERMES_HOME="${OTHER}" DOCTOR_GUI_HERMES_HOME="${OTHER}"
S=$(summary)
[ -n "${S}" ] || fail "redaction: no summary"
printf '%s\n' "${S}" | grep -qF "grokbot-override-<redacted>" || fail "redaction: the token-shaped folder name was not redacted:
${S}"
printf '%s\n' "${S}" | grep -qF "<user>" || fail "redaction: the username was not replaced:
${S}"
printf '%s\n' "${S}" | grep -qE 'xox[a-z]-|sk-FAKE|FAKE-000000' && fail "redaction: a token-shaped string is in the summary:
${S}"
printf '%s\n' "${S}" | grep -qF "${U}" && fail "redaction: \$HOME is in the summary"
printf '%s\n' "${S}" | grep -qw "${NAME}" && fail "redaction: the username is in the summary"
REAL=$(id -un)
printf '%s\n' "${S}" | grep -qw "${REAL}" && fail "redaction: the account name is in the summary"
printf '%s\n' "${OUT}" | grep -qF "doctortest" && fail "the doctor printed something from .env"
doctor "${U}"
summary | grep -qF "hermes home: ~/.hermes" || fail "redaction: the home is not shown as ~/.hermes"
ok "summary: ~ and <user>, no tokens, nothing from .env"

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

echo "test-doctor.sh: all passed"
