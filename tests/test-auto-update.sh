#!/usr/bin/env bash
# Offline tests for install.sh --auto-update on|off|status|run. Every HOME and
# Hermes home is a throwaway folder; launchctl, systemctl and curl are fakes
# (KIT_LAUNCHCTL, KIT_SYSTEMCTL, tests/fake-curl.sh), so no real LaunchAgent,
# systemd unit, crontab or network is touched.
set -euo pipefail

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
INSTALLER="${ROOT}/install.sh"

WORK=$(mktemp -d)
export TMPDIR="${WORK}"
SLEEPER=""
cleanup() {
  [ -n "${SLEEPER}" ] && kill "${SLEEPER}" 2>/dev/null || true
  rm -rf "${WORK}"
}
trap cleanup EXIT

fail() { echo "FAIL: $*" >&2; exit 1; }
ok() { echo "OK  $*"; }
mode_of() { stat -c %a -- "$1" 2>/dev/null || stat -f %Lp -- "$1"; }
UIDN=$(id -u)
NEW_TAG="v2099.01.02"
CUR_TAG=$(sed -n 's/^KIT_FALLBACK_REF="\(.*\)"/\1/p' "${INSTALLER}")
[ -n "${CUR_TAG}" ] || fail "install.sh has no KIT_FALLBACK_REF"

# The installer as the one-liner downloads it: alone, no checkout beside it.
DL="${WORK}/dl"
mkdir -p "${DL}"
cp "${INSTALLER}" "${DL}/install.sh"

# A fake newer release: this tree with its tag rewritten and its manifest
# regenerated, served by the fake curl for any ref.
REL="${WORK}/release"
mkdir -p "${REL}"
tar -C "${ROOT}" --exclude .git --exclude node_modules -cf - . | tar -C "${REL}" -xf -
sed "s/^KIT_FALLBACK_REF=\".*\"/KIT_FALLBACK_REF=\"${NEW_TAG}\"/" "${INSTALLER}" > "${REL}/install.sh"
bash "${REL}/scripts/make-manifest.sh" >/dev/null
grep -q ' install.sh$' "${REL}/MANIFEST.sha256" || fail "the release manifest does not list install.sh"

# Fakes: curl, launchctl, systemctl (each logs its arguments).
FAKE="${WORK}/bin"
mkdir -p "${FAKE}"
cp "${ROOT}/tests/fake-curl.sh" "${FAKE}/curl"
cat > "${FAKE}/launchctl" <<'EOF'
#!/usr/bin/env bash
printf '%s\n' "$*" >> "${FAKE_LAUNCHCTL_LOG}"
case "$1" in
  bootstrap) [ "${FAKE_BOOTSTRAP:-ok}" = ok ] || exit 5 ;;
  print) [ -f "${FAKE_LAUNCHCTL_LOG}.loaded" ] || exit 113 ;;
esac
[ "$1" = bootstrap ] && touch "${FAKE_LAUNCHCTL_LOG}.loaded"
[ "$1" = bootout ] && rm -f "${FAKE_LAUNCHCTL_LOG}.loaded"
exit 0
EOF
cat > "${FAKE}/systemctl" <<'EOF'
#!/usr/bin/env bash
printf '%s\n' "$*" >> "${FAKE_SYSTEMCTL_LOG}"
case "$2" in
  show-environment) [ "${FAKE_SYSTEMD:-ok}" = ok ] || exit 1 ;;
esac
exit 0
EOF
chmod +x "${FAKE}/curl" "${FAKE}/launchctl" "${FAKE}/systemctl"

# A fresh machine: HOME with a Hermes home inside.
new_machine() {
  M=$(mktemp -d "${WORK}/m.XXXXXX")
  H="${M}/home"
  HH="${H}/.hermes"
  mkdir -p "${HH}"
  LOGS="${M}/logs"
  mkdir -p "${LOGS}"
  : > "${LOGS}/curl" ; : > "${LOGS}/launchctl" ; : > "${LOGS}/systemctl"
  STATE="${HH}/hermes-bot-kit"
  ULOG="${HH}/logs/hermes-bot-kit-update.log"
  PLIST="${H}/Library/LaunchAgents/io.github.thomasbek3.hermes-bot-kit.update.plist"
  UNITS="${H}/.config/systemd/user"
}

# kit [VAR=value ...] <command...>: run with only the fakes and this machine.
kit() {
  env -i PATH="${FAKE}:/usr/bin:/bin" HOME="${H}" HERMES_HOME="${HH}" TMPDIR="${TMPDIR}" \
    KIT_LAUNCHCTL="${FAKE}/launchctl" KIT_SYSTEMCTL="${FAKE}/systemctl" KIT_UPDATE_OS="${OS:-mac}" \
    FAKE_LAUNCHCTL_LOG="${LOGS}/launchctl" FAKE_SYSTEMCTL_LOG="${LOGS}/systemctl" \
    FAKE_API="${API:-ok}" FAKE_ROOT="${FROOT:-${REL}}" FAKE_LOG="${LOGS}/curl" "$@"
}
job() { kit "$@" bash "${STATE}/update.sh" --auto-update run; }

# --- on / status / off on macOS ------------------------------------------------
new_machine
out=$(kit KIT_SKIP_GROKBOT=1 bash "${DL}/install.sh" --auto-update on) || fail "on (mac) failed: ${out}"
[ -f "${PLIST}" ] || fail "on (mac): no LaunchAgent at ${PLIST}"
grep -q '<string>io.github.thomasbek3.hermes-bot-kit.update</string>' "${PLIST}" || fail "plist: no label"
tr -d ' \n' < "${PLIST}" | grep -q '<key>StartCalendarInterval</key><dict><key>Hour</key><integer>4</integer><key>Minute</key><integer>20</integer></dict>' || fail "plist: not 04:20"
tr -d ' \n' < "${PLIST}" | grep -q '<key>RunAtLoad</key><false/>' || fail "plist: RunAtLoad is not false"
grep -qF "<string>${STATE}/update.sh</string>" "${PLIST}" || fail "plist: does not run the stored update.sh"
grep -qF "<string>${HH}</string>" "${PLIST}" || fail "plist: no HERMES_HOME"
if command -v plutil >/dev/null 2>&1; then plutil -lint "${PLIST}" >/dev/null || fail "plist does not lint"; fi
grep -qx "bootstrap gui/${UIDN} ${PLIST}" "${LOGS}/launchctl" || fail "on: not bootstrapped into gui/${UIDN}: $(cat "${LOGS}/launchctl")"
if grep -q 'user/' "${LOGS}/launchctl"; then fail "on: used the user/ domain"; fi
ok "on (mac): LaunchAgent written (04:20, RunAtLoad false) and bootstrapped into gui/<uid>"

[ "$(mode_of "${STATE}/auto-update.env")" = 600 ] || fail "auto-update.env mode $(mode_of "${STATE}/auto-update.env"), want 600"
grep -qx 'KIT_SKIP_GROKBOT=1' "${STATE}/auto-update.env" || fail "KIT_SKIP_GROKBOT not remembered"
grep -qx 'KIT_SKIP_COMPUTER=0' "${STATE}/auto-update.env" || fail "KIT_SKIP_COMPUTER not recorded"
grep -qx 'KIT_TEXTING_STYLE=0' "${STATE}/auto-update.env" || fail "KIT_TEXTING_STYLE not off by default"
grep -qx "HERMES_HOME=${HH}" "${STATE}/auto-update.env" || fail "HERMES_HOME not remembered"
grep -qx 'SCHEDULER=launchd' "${STATE}/auto-update.env" || fail "scheduler not recorded"
cmp -s "${STATE}/update.sh" "${INSTALLER}" || fail "update.sh is not a copy of install.sh"
[ "$(mode_of "${STATE}/update.sh")" = 700 ] || fail "update.sh mode $(mode_of "${STATE}/update.sh"), want 700"
ok "state file 0600 with the knobs (no secrets); updater copied to <home>/hermes-bot-kit/update.sh"

# Next run time from a fixed clock: 03:00 -> today 04:20; 05:00 -> tomorrow.
at() { date -j -f '%Y-%m-%d %H:%M:%S' "$1" +%s 2>/dev/null || date -d "$1" +%s; }
out=$(kit KIT_UPDATE_NOW="$(at '2026-11-21 03:00:00')" bash "${DL}/install.sh" --auto-update status) || fail "status failed: ${out}"
printf '%s\n' "${out}" | grep -q '^Auto-update      : on, daily at 04:20 local time via launchd (LaunchAgent loaded)' || fail "status: not on/loaded:
${out}"
printf '%s\n' "${out}" | grep -q '^Next run         : 2026-11-21 04:20 local time' || fail "status: wrong next run (03:00):
${out}"
printf '%s\n' "${out}" | grep -q "^Newest release   : ${NEW_TAG}" || fail "status: no newest release"
printf '%s\n' "${out}" | grep -q '^Installed release: unknown' || fail "status: installed release"
printf '%s\n' "${out}" | grep -q '^Last run         : never' || fail "status: last run"
printf '%s\n' "${out}" | grep -q "^Backups          : .*${HH}/desktop-plugins/" || fail "status: no backups line"
out=$(kit KIT_UPDATE_NOW="$(at '2026-11-21 05:00:00')" bash "${DL}/install.sh" --auto-update status)
printf '%s\n' "${out}" | grep -q '^Next run         : 2026-11-22 04:20 local time' || fail "status: wrong next run (05:00):
${out}"
out=$(API=down kit bash "${DL}/install.sh" --auto-update status) || fail "status with no network failed"
printf '%s\n' "${out}" | grep -q '^Newest release   : unknown' || fail "status: offline newest"
ok "status: on/loaded, installed, newest, last run, next run (fixed clock), backups"

# The doctor reports it.
dout=$(kit DOCTOR_APP_PATH=none DOCTOR_GUI_HERMES_HOME="${HH}" DOCTOR_OS=mac bash "${ROOT}/scripts/doctor.sh" 2>&1 || true)
printf '%s\n' "${dout}" | grep -q '^OK    Auto-update is on (launchd, daily at 04:20); no run yet' || fail "doctor: no auto-update line:
${dout}"
printf '%s\n' "${dout}" | grep -qx 'check auto-update OK' || fail "doctor: no auto-update summary line"
rm -f "${PLIST}"
dout=$(kit DOCTOR_APP_PATH=none DOCTOR_GUI_HERMES_HOME="${HH}" DOCTOR_OS=mac bash "${ROOT}/scripts/doctor.sh" 2>&1 || true)
printf '%s\n' "${dout}" | grep -q '^FIX   Auto-update is on but its daily job' || fail "doctor: missing job not flagged"
ok "doctor: reports auto-update on, and a missing job as FIX"

kit bash "${DL}/install.sh" --auto-update on >/dev/null
out=$(kit bash "${DL}/install.sh" --auto-update off) || fail "off failed"
[ ! -e "${PLIST}" ] || fail "off: plist still there"
grep -qx "bootout gui/${UIDN}/io.github.thomasbek3.hermes-bot-kit.update" "${LOGS}/launchctl" || fail "off: no bootout of gui/<uid>/<label>"
[ ! -e "${STATE}/auto-update.env" ] && [ ! -e "${STATE}/update.sh" ] || fail "off: state left behind"
out=$(kit bash "${DL}/install.sh" --auto-update status)
printf '%s\n' "${out}" | grep -q '^Auto-update      : off' || fail "status after off"
dout=$(kit DOCTOR_APP_PATH=none DOCTOR_GUI_HERMES_HOME="${HH}" DOCTOR_OS=mac bash "${ROOT}/scripts/doctor.sh" 2>&1 || true)
printf '%s\n' "${dout}" | grep -q '^INFO  Auto-update is off' || fail "doctor: off not reported"
ok "off: bootout gui/<uid>/<label>, plist, settings and updater removed"

# bootstrap fails (over ssh): on still succeeds and prints the exact command.
new_machine
out=$(kit FAKE_BOOTSTRAP=fail bash "${DL}/install.sh" --auto-update on) || fail "on with failing bootstrap exited non-zero"
printf '%s\n' "${out}" | grep -qF "launchctl bootstrap gui/${UIDN} '${PLIST}'" || fail "no bootstrap command printed:
${out}"
[ -f "${PLIST}" ] || fail "plist not written when bootstrap failed"
ok "bootstrap failure (ssh): plist kept, exact launchctl bootstrap gui/<uid> command printed"

# --- Linux: systemd user timer, cron fallback ---------------------------------
new_machine
out=$(OS=linux kit bash "${DL}/install.sh" --auto-update on) || fail "on (linux) failed: ${out}"
[ -f "${UNITS}/hermes-bot-kit-update.timer" ] && [ -f "${UNITS}/hermes-bot-kit-update.service" ] || fail "linux: units missing"
grep -qx 'OnCalendar=\*-\*-\* 04:20' "${UNITS}/hermes-bot-kit-update.timer" || fail "timer: OnCalendar"
grep -qx 'Persistent=true' "${UNITS}/hermes-bot-kit-update.timer" || fail "timer: Persistent"
grep -qF "\"${STATE}/update.sh\" --auto-update run" "${UNITS}/hermes-bot-kit-update.service" || fail "service: ExecStart"
grep -qx 'Type=oneshot' "${UNITS}/hermes-bot-kit-update.service" || fail "service: Type"
grep -qx -- '--user enable --now hermes-bot-kit-update.timer' "${LOGS}/systemctl" || fail "linux: timer not enabled: $(cat "${LOGS}/systemctl")"
[ ! -e "${PLIST}" ] || fail "linux wrote a LaunchAgent"
grep -qx 'SCHEDULER=systemd' "${STATE}/auto-update.env" || fail "linux: scheduler"
out=$(OS=linux kit bash "${DL}/install.sh" --auto-update off)
[ ! -e "${UNITS}/hermes-bot-kit-update.timer" ] && [ ! -e "${UNITS}/hermes-bot-kit-update.service" ] || fail "linux off: units left"
grep -qx -- '--user disable --now hermes-bot-kit-update.timer' "${LOGS}/systemctl" || fail "linux off: not disabled"
ok "linux: systemd user timer + service (04:20, Persistent) enabled; off disables and removes them"

new_machine
out=$(OS=linux kit FAKE_SYSTEMD=none bash "${DL}/install.sh" --auto-update on) || fail "on (no systemd) failed"
printf '%s\n' "${out}" | grep -qF "20 4 * * * HERMES_HOME='${HH}' " || fail "no crontab line:
${out}"
printf '%s\n' "${out}" | grep -qF "'${STATE}/update.sh' --auto-update run" || fail "crontab line does not run update.sh"
[ ! -e "${UNITS}/hermes-bot-kit-update.timer" ] || fail "no systemd: units written anyway"
grep -qx 'SCHEDULER=cron' "${STATE}/auto-update.env" || fail "cron: scheduler"
ok "linux without systemctl --user: prints a crontab line"

for os in wsl windows; do
  new_machine
  if out=$(OS=${os} kit bash "${DL}/install.sh" --auto-update on 2>&1); then fail "${os}: on succeeded"; fi
  printf '%s\n' "${out}" | grep -q 'not supported on Windows or WSL yet' || fail "${os}: no explanation"
  [ ! -e "${STATE}" ] && [ ! -e "${PLIST}" ] || fail "${os}: wrote something"
done
ok "Windows/WSL: on explains, exits non-zero, writes nothing"

# --- installed-release from manual installs ------------------------------------
new_machine
kit KIT_SOURCE_DIR="${ROOT}" bash "${INSTALLER}" >/dev/null 2>&1 || fail "local install failed"
[ "$(cat "${STATE}/installed-release")" = local ] || fail "local install: installed-release is '$(cat "${STATE}/installed-release")'"
new_machine
API=down FROOT="${ROOT}" kit bash "${DL}/install.sh" >/dev/null 2>&1 || fail "remote install failed"
[ "$(cat "${STATE}/installed-release")" = "${CUR_TAG}" ] || fail "remote install: installed-release is '$(cat "${STATE}/installed-release")'"
ok "manual installs write installed-release (the tag, or local)"

# --- run --------------------------------------------------------------------------
# Up to date: a no-op that fetches nothing.
printf '%s\n' "${NEW_TAG}" > "${STATE}/installed-release"
kit bash "${DL}/install.sh" --auto-update on >/dev/null
: > "${LOGS}/curl"
out=$(job) || fail "run (up to date) failed"
[ "$(wc -l < "${ULOG}" | tr -d ' ')" = 1 ] || fail "run: not one log line"
grep -q " up to date (${NEW_TAG})$" "${ULOG}" || fail "run: not 'up to date': $(cat "${ULOG}")"
[ ! -s "${LOGS}/curl" ] || fail "run (up to date) downloaded: $(cat "${LOGS}/curl")"
ok "run: no-op when the installed release is the newest"

# No network: logs and exits 0.
out=$(API=down job) || fail "run with no network exited non-zero"
tail -n 1 "${ULOG}" | grep -q 'skipped: GitHub API not reachable or rate-limited' || fail "run offline: $(tail -n 1 "${ULOG}")"
ok "run: network failure / rate limit logs and exits 0"

# Newer release: installs it with KIT_REF=<tag> and the remembered knobs.
new_machine
API=down FROOT="${ROOT}" kit bash "${DL}/install.sh" >/dev/null 2>&1
kit KIT_SKIP_GROKBOT=1 bash "${DL}/install.sh" --auto-update on >/dev/null
old_cv="${HH}/desktop-plugins/computer-viewer/plugin.js"
printf '// local edit\n' >> "${old_cv}"
: > "${LOGS}/curl"
out=$(job) || fail "run (newer) failed: ${out}; $(cat "${HH}/logs/hermes-bot-kit-update.last-run.log" 2>/dev/null)"
[ "$(cat "${STATE}/installed-release")" = "${NEW_TAG}" ] || fail "run: installed-release not ${NEW_TAG}"
[ "$(sort -u "${LOGS}/curl")" = "${NEW_TAG}" ] || fail "run fetched refs: $(sort -u "${LOGS}/curl" | tr '\n' ' ')"
grep -qx "release=${NEW_TAG}" "${HH}/desktop-plugins/.hermes-bot-kit-install" || fail "run: install record not ${NEW_TAG}"
grep -qx 'plugins=computer-viewer' "${HH}/desktop-plugins/.hermes-bot-kit-install" || fail "run: KIT_SKIP_GROKBOT not applied"
cmp -s "${old_cv}" "${REL}/computer-viewer/plugin.js" || fail "run: plugin not replaced"
ls "${old_cv}".bak.* >/dev/null 2>&1 || fail "run: the edited copy was not backed up"
grep -qxF "KIT_FALLBACK_REF=\"${NEW_TAG}\"" "${STATE}/update.sh" || fail "run: update.sh not replaced with the new release's"
[ "$(mode_of "${STATE}/update.sh")" = 700 ] || fail "run: update.sh mode"
tail -n 1 "${ULOG}" | grep -q "updated ${CUR_TAG} -> ${NEW_TAG}. Reload desktop plugins (Cmd+K) to pick up ${NEW_TAG}$" || fail "run log: $(tail -n 1 "${ULOG}")"
out=$(kit bash "${STATE}/update.sh" --auto-update status)
printf '%s\n' "${out}" | grep -q "^Installed release: ${NEW_TAG}" || fail "status after update"
printf '%s\n' "${out}" | grep -q "Reload desktop plugins (Cmd+K) to pick up ${NEW_TAG}" || fail "status: no reload hint"
out=$(job)
tail -n 1 "${ULOG}" | grep -q " up to date (${NEW_TAG})$" || fail "second run not up to date"
ok "run: newer release installed at its tag with the remembered knobs, backup kept, updater replaced, reload hint"

# A tampered install.sh (listed in the manifest) is never run.
TAMP="${WORK}/tampered"
cp -R "${REL}" "${TAMP}"
printf '\ntouch "%s/TAMPERED-RAN"\n' "${WORK}" >> "${TAMP}/install.sh"
new_machine
API=down FROOT="${ROOT}" kit bash "${DL}/install.sh" >/dev/null 2>&1
if out=$(FROOT="${TAMP}" kit bash "${DL}/install.sh" --auto-update run); then fail "tampered run succeeded"; fi
[ ! -e "${WORK}/TAMPERED-RAN" ] || fail "the tampered install.sh ran"
tail -n 1 "${ULOG}" | grep -q 'FAILED: .* install.sh does not match its MANIFEST.sha256' || fail "tamper log: $(tail -n 1 "${ULOG}")"
[ "$(cat "${STATE}/installed-release")" = "${CUR_TAG}" ] || fail "tamper: installed-release changed"
# Not listed: install.sh's own per-file checks are relied on, but it must name the tag.
grep -v ' install.sh$' "${TAMP}/MANIFEST.sha256" > "${TAMP}/m" && mv "${TAMP}/m" "${TAMP}/MANIFEST.sha256"
sed "s/^KIT_FALLBACK_REF=\".*\"/KIT_FALLBACK_REF=\"v2000.01.01\"/" "${REL}/install.sh" > "${TAMP}/install.sh"
if FROOT="${TAMP}" kit bash "${DL}/install.sh" --auto-update run >/dev/null; then fail "a wrong-tag install.sh was run"; fi
tail -n 1 "${ULOG}" | grep -q 'does not look like that release' || fail "wrong-tag log: $(tail -n 1 "${ULOG}")"
cp "${REL}/install.sh" "${TAMP}/install.sh"
FROOT="${TAMP}" kit bash "${DL}/install.sh" --auto-update run >/dev/null || fail "an unlisted but right install.sh did not run"
[ "$(cat "${STATE}/installed-release")" = "${NEW_TAG}" ] || fail "unlisted install.sh: not updated"
ok "run: install.sh checked against the tag's manifest when listed (tampered = nothing runs), else must name the tag"

# Lock: a live owner blocks a second run; a dead owner's lock is taken over.
new_machine
mkdir -p "${STATE}"
printf '%s\n' "${CUR_TAG}" > "${STATE}/installed-release"
sleep 300 &
SLEEPER=$!
mkdir -p "${STATE}/update.lock"
printf '%s\n' "${SLEEPER}" > "${STATE}/update.lock/pid"
out=$(kit bash "${DL}/install.sh" --auto-update run) || fail "locked run exited non-zero"
tail -n 1 "${ULOG}" | grep -q "skipped: another update is running (pid ${SLEEPER})" || fail "lock: $(tail -n 1 "${ULOG}")"
[ "$(cat "${STATE}/installed-release")" = "${CUR_TAG}" ] || fail "lock: updated anyway"
kill "${SLEEPER}" 2>/dev/null || true
wait "${SLEEPER}" 2>/dev/null || true
dead=${SLEEPER}
SLEEPER=""
printf '%s\n' "${dead}" > "${STATE}/update.lock/pid"
out=$(kit bash "${DL}/install.sh" --auto-update run) || fail "stale-lock run failed: ${out}"
[ "$(cat "${STATE}/installed-release")" = "${NEW_TAG}" ] || fail "stale lock: not updated"
[ ! -e "${STATE}/update.lock" ] || fail "lock not released"
ok "lock: a running update blocks overlap; a stale PID's lock is taken over and released"

# --- post-update hook -----------------------------------------------------------
new_machine
hook="${M}/hook.sh"
printf '#!/bin/sh\nprintf "KIT_REF=%%s\\nHERMES_HOME=%%s\\n" "$KIT_REF" "$HERMES_HOME" > "%s/hook.out"\nexit 3\n' "${M}" > "${hook}"
chmod 0700 "${hook}"
if kit KIT_POST_UPDATE_HOOK=hook.sh bash "${DL}/install.sh" --auto-update on >/dev/null 2>&1; then fail "relative hook accepted"; fi
chmod 0720 "${hook}"
if kit KIT_POST_UPDATE_HOOK="${hook}" bash "${DL}/install.sh" --auto-update on >/dev/null 2>&1; then fail "group-writable hook accepted"; fi
chmod 0702 "${hook}"
if kit KIT_POST_UPDATE_HOOK="${hook}" bash "${DL}/install.sh" --auto-update on >/dev/null 2>&1; then fail "world-writable hook accepted"; fi
chmod 0700 "${hook}"
ln -s "${hook}" "${M}/hook-link"
if kit KIT_POST_UPDATE_HOOK="${M}/hook-link" bash "${DL}/install.sh" --auto-update on >/dev/null 2>&1; then fail "symlinked hook accepted"; fi
if kit KIT_POST_UPDATE_HOOK="${M}/missing" bash "${DL}/install.sh" --auto-update on >/dev/null 2>&1; then fail "missing hook accepted"; fi
if [ "${UIDN}" != 0 ] && [ -f /bin/sh ] && [ ! -L /bin/sh ] && [ ! -O /bin/sh ]; then
  if out=$(kit KIT_POST_UPDATE_HOOK=/bin/sh bash "${DL}/install.sh" --auto-update on 2>&1); then fail "a hook you don't own was accepted"; fi
  printf '%s\n' "${out}" | grep -q 'is not owned by you' || fail "not-owned hook: ${out}"
fi
[ ! -e "${STATE}/auto-update.env" ] || fail "a rejected hook still turned auto-update on"
kit KIT_POST_UPDATE_HOOK="${hook}" bash "${DL}/install.sh" --auto-update on >/dev/null || fail "a good hook was rejected"
grep -qx "KIT_POST_UPDATE_HOOK=${hook}" "${STATE}/auto-update.env" || fail "hook not remembered"
job >/dev/null || fail "run with hook failed"
[ "$(cat "${M}/hook.out")" = "KIT_REF=${NEW_TAG}
HERMES_HOME=${HH}" ] || fail "hook env: $(cat "${M}/hook.out")"
tail -n 1 "${ULOG}" | grep -q 'post-update hook exited 3' || fail "hook exit not logged: $(tail -n 1 "${ULOG}")"
[ "$(cat "${STATE}/installed-release")" = "${NEW_TAG}" ] || fail "a failing hook undid the update"
# Checked again at run: made group-writable after on, it is not run.
printf '%s\n' "${CUR_TAG}" > "${STATE}/installed-release"
rm -f "${M}/hook.out"
chmod 0770 "${hook}"
job >/dev/null || fail "run with an unsafe hook failed"
[ ! -e "${M}/hook.out" ] || fail "an unsafe hook ran"
tail -n 1 "${ULOG}" | grep -q 'post-update hook not run: it is writable by group or others' || fail "unsafe hook log: $(tail -n 1 "${ULOG}")"
ok "hook: absolute, existing, owned, not group/world-writable (at on and at run); KIT_REF + HERMES_HOME; exit logged; failure keeps the update"

# --- texting-style refresh ------------------------------------------------------
new_machine
mkdir -p "${HH}/plugins/texting-style" "${HH}/profiles/linked/plugins" "${HH}/profiles/none" "${HH}/profiles/copy/plugins/texting-style" "${M}/clone"
printf 'name: texting-style\nversion: old\n' > "${HH}/plugins/texting-style/plugin.yaml"
printf '# old texting-style.sms-register\n' > "${HH}/plugins/texting-style/__init__.py"
cp "${HH}/plugins/texting-style/"* "${HH}/profiles/copy/plugins/texting-style/"
printf 'old\n' > "${M}/clone/plugin.yaml"; printf 'old\n' > "${M}/clone/__init__.py"
ln -s "${M}/clone" "${HH}/profiles/linked/plugins/texting-style"
for d in "${HH}" "${HH}/profiles/linked" "${HH}/profiles/none" "${HH}/profiles/copy"; do printf 'plugins:\n  enabled: [x]\n' > "${d}/config.yaml"; done
mkdir -p "${STATE}"
printf '%s\n' "${CUR_TAG}" > "${STATE}/installed-release"
# Off by default: nothing refreshed.
kit bash "${DL}/install.sh" --auto-update on >/dev/null
job >/dev/null || fail "run (texting-style off) failed"
grep -q 'version: old' "${HH}/plugins/texting-style/plugin.yaml" || fail "texting-style refreshed while off"
printf '%s\n' "${CUR_TAG}" > "${STATE}/installed-release"
kit KIT_TEXTING_STYLE=1 bash "${DL}/install.sh" --auto-update on >/dev/null
job >/dev/null || fail "run (texting-style on) failed"
for d in "${HH}" "${HH}/profiles/copy"; do
  cmp -s "${d}/plugins/texting-style/__init__.py" "${REL}/texting-style/__init__.py" || fail "texting-style copy in ${d} not refreshed"
  cmp -s "${d}/plugins/texting-style/plugin.yaml" "${REL}/texting-style/plugin.yaml" || fail "texting-style plugin.yaml in ${d} not refreshed"
  ls "${d}/plugins/texting-style/__init__.py.bak."* >/dev/null 2>&1 || fail "no texting-style backup in ${d}"
done
[ -L "${HH}/profiles/linked/plugins/texting-style" ] || fail "the symlink was replaced"
[ "$(cat "${M}/clone/__init__.py")" = old ] || fail "the symlink's target was written"
[ ! -e "${HH}/profiles/none/plugins/texting-style" ] || fail "texting-style installed into a new profile"
for d in "${HH}" "${HH}/profiles/linked" "${HH}/profiles/none" "${HH}/profiles/copy"; do
  [ "$(cat "${d}/config.yaml")" = "plugins:
  enabled: [x]" ] || fail "config.yaml edited in ${d}"
done
tail -n 1 "${ULOG}" | grep -q 'texting-style refreshed in 2 profile(s), 1 symlinked left alone (new code loads at the next agent/gateway restart)' || fail "texting-style log: $(tail -n 1 "${ULOG}")"
ok "texting-style (KIT_TEXTING_STYLE=1 only): plain copies refreshed with backups; symlinks, new profiles and config.yaml untouched"

# --- log rotation ------------------------------------------------------------------
mkdir -p "$(dirname -- "${ULOG}")"
awk 'BEGIN { for (i = 0; i < 12000; i++) print "old line 0123456789012345678901234567890123456789012345678901234567890123456789012345678901234" }' > "${ULOG}"
[ "$(wc -c < "${ULOG}" | tr -d ' ')" -ge 1048576 ] || fail "test log not 1 MB"
job >/dev/null
[ -f "${ULOG}.1" ] && grep -q '^old line' "${ULOG}.1" || fail "log not rotated to .1"
[ "$(wc -l < "${ULOG}" | tr -d ' ')" = 1 ] || fail "new log is not one line"
awk 'BEGIN { for (i = 0; i < 12000; i++) print "second 0123456789012345678901234567890123456789012345678901234567890123456789012345678901234567" }' >> "${ULOG}"
job >/dev/null
grep -q '^second' "${ULOG}.1" || fail "second rotation did not replace .1"
if grep -q '^old line' "${ULOG}.1"; then fail "more than one old log kept"; fi
[ ! -e "${ULOG}.2" ] || fail "a .2 log was kept"
ok "log: one line per run, rotated at 1 MB, one old file kept"

echo "test-auto-update.sh: all passed"
