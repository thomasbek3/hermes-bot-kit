#!/usr/bin/env bash
# Offline tests for install.sh --auto-update on|off|status|run. Every HOME and
# Hermes home is a throwaway folder; launchctl, systemctl and curl are fakes
# (KIT_LAUNCHCTL, KIT_SYSTEMCTL, tests/fake-curl.sh), so no real LaunchAgent,
# systemd unit, crontab or network is touched.
set -euo pipefail

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
INSTALLER="${ROOT}/install.sh"

WORK=$(mktemp -d)
# The physical path: the updater resolves the Hermes home to it (macOS's
# temp folder sits behind the /var -> /private/var symlink).
WORK=$(CDPATH= cd -P -- "${WORK}" && pwd -P)
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
[ "$1" = bootout ] && [ "${FAKE_BOOTOUT:-ok}" != ok ] && exit 5
[ "$1" = bootout ] && rm -f "${FAKE_LAUNCHCTL_LOG}.loaded"
exit 0
EOF
cat > "${FAKE}/systemctl" <<'EOF'
#!/usr/bin/env bash
printf '%s\n' "$*" >> "${FAKE_SYSTEMCTL_LOG}"
case "$2" in
  show-environment) [ "${FAKE_SYSTEMD:-ok}" = ok ] || exit 1 ;;
esac
case " ${FAKE_SYSTEMCTL_FAIL:-} " in *" $2 "*) exit 1 ;; esac
case "$2" in
  enable) touch "${FAKE_SYSTEMCTL_LOG}.enabled" ;;
  disable) rm -f "${FAKE_SYSTEMCTL_LOG}.enabled" ;;
  is-active|is-enabled) [ -e "${FAKE_SYSTEMCTL_LOG}.enabled" ] || exit 3 ;;
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
  env -i PATH="${XPATH:+${XPATH}:}${FAKE}:/usr/bin:/bin" HOME="${H}" HERMES_HOME="${HH}" TMPDIR="${TMPDIR}" \
    KIT_LAUNCHCTL="${FAKE}/launchctl" KIT_SYSTEMCTL="${FAKE}/systemctl" KIT_UPDATE_OS="${OS:-mac}" \
    FAKE_LAUNCHCTL_LOG="${LOGS}/launchctl" FAKE_SYSTEMCTL_LOG="${LOGS}/systemctl" \
    FAKE_API="${API:-ok}" FAKE_ROOT="${FROOT:-${REL}}" FAKE_LOG="${LOGS}/curl" "$@"
}
job() { kit "$@" bash "${STATE}/update.sh" --auto-update run; }
# hold_lock: a background process holds the updater's flock until killed.
hold_lock() {
  rm -f "${M}/held"
  # The lock sits beside the state folder (uninstall moves that folder).
  perl -MFcntl=:flock -e 'open(my $f, ">>", $ARGV[0]) or die; flock($f, LOCK_EX) or die; open(my $r, ">", $ARGV[1]) or die; close $r; sleep 300' \
    "${HH}/.hermes-bot-kit-update.flock" "${M}/held" &
  SLEEPER=$!
  until [ -e "${M}/held" ]; do sleep 0.05; done
  printf '%s\n' "${SLEEPER}" > "${HH}/.hermes-bot-kit-update.flock.pid"
}
drop_lock() {
  kill -9 "${SLEEPER}" 2>/dev/null || true
  wait "${SLEEPER}" 2>/dev/null || true
  SLEEPER=""
}

# --- Regression tests (review of fad9c31) ---------------------------------------
# AU_TEST_ONLY=<name> runs just that one after the shared setup.

# 1. The hook that runs is the file that was checked: every folder above it
# must be yours (or root's) and not writable by others, and a private copy
# runs, not the path.
reg_hook_toctou() {
  new_machine
  local shared="${M}/shared" hook
  mkdir -p "${shared}"
  hook="${shared}/hook.sh"
  printf '#!/bin/sh\nprintf "%%s\\n" "$0" > "%s/hook.argv0"\n' "${M}" > "${hook}"
  chmod 0700 "${hook}"
  chmod 0777 "${shared}"
  if kit KIT_POST_UPDATE_HOOK="${hook}" bash "${DL}/install.sh" --auto-update on >/dev/null 2>&1; then
    fail "hook toctou: a hook in a folder others can write to was accepted"
  fi
  chmod 0700 "${shared}"
  mkdir -p "${STATE}"
  printf '%s\n' "${CUR_TAG}" > "${STATE}/installed-release"
  kit KIT_POST_UPDATE_HOOK="${hook}" bash "${DL}/install.sh" --auto-update on >/dev/null || fail "hook toctou: a safe hook was rejected"
  job >/dev/null || fail "hook toctou: run failed"
  [ -s "${M}/hook.argv0" ] || fail "hook toctou: the hook did not run: $(tail -n 1 "${ULOG}")"
  case "$(cat "${M}/hook.argv0")" in
    "${STATE}/.hook."*/hook) ;;
    *) fail "hook toctou: the path ran, not a private copy: $(cat "${M}/hook.argv0")" ;;
  esac
  if ls -d "${STATE}"/.hook.* >/dev/null 2>&1; then fail "hook toctou: the private copy was left behind"; fi
  # Made swappable after on: not run.
  rm -f "${M}/hook.argv0"
  printf '%s\n' "${CUR_TAG}" > "${STATE}/installed-release"
  chmod 0777 "${shared}"
  job >/dev/null || fail "hook toctou: run with a swappable hook failed"
  chmod 0700 "${shared}"
  [ ! -e "${M}/hook.argv0" ] || fail "hook toctou: a hook in a folder others can write to ran"
  tail -n 1 "${ULOG}" | grep -q 'post-update hook not run: it has a folder above it that group or others can write to' || fail "hook toctou log: $(tail -n 1 "${ULOG}")"
  ok "regression: hook folders above it checked (on and run); a private 0700 copy runs, then is removed"
}

# 2 (round 3: replaces the lock-folder race test). The lock is a kernel lock:
# while a live process holds it, no run takes over, whatever stale-looking
# leftovers (an old lock folder with a dead PID, an old .recover guard) lie
# around; this is the state in which two contenders used to race.
reg_lock_race() {
  new_machine
  kit bash "${DL}/install.sh" --auto-update on >/dev/null
  printf '%s\n' "${CUR_TAG}" > "${STATE}/installed-release"
  sleep 0.1 &
  local dead=$!
  wait "${dead}" 2>/dev/null || true
  mkdir -p "${STATE}/update.lock" "${STATE}/update.lock.recover"
  printf '%s\n' "${dead}" > "${STATE}/update.lock/pid"
  touch -t 202001010000 "${STATE}/update.lock.recover"
  hold_lock
  local i
  for i in 1 2 3; do
    kit bash "${DL}/install.sh" --auto-update run >/dev/null 2>&1 &
  done
  wait $(jobs -p | grep -vx "${SLEEPER}") 2>/dev/null || true
  [ "$(cat "${STATE}/installed-release")" = "${CUR_TAG}" ] || fail "lock race: a run took over a lock a live process holds"
  [ "$(grep -c "skipped: another update is running (pid ${SLEEPER})" "${ULOG}")" = 3 ] || fail "lock race: not every contender waited: $(cat "${ULOG}")"
  drop_lock
  ok "regression: a held lock is never taken over by any number of contenders, whatever leftovers exist"
}

# 3. texting-style: a symlink anywhere above the plugin (plugins/ -> elsewhere)
# means it is left alone.
reg_texting_ancestor_link() {
  new_machine
  local outside="${M}/outside/plugins"
  mkdir -p "${outside}/texting-style" "${HH}/profiles/evil" "${HH}/plugins/texting-style"
  printf 'old\n' > "${outside}/texting-style/plugin.yaml"
  printf '# old texting-style.sms-register\n' > "${outside}/texting-style/__init__.py"
  ln -s "${outside}" "${HH}/profiles/evil/plugins"
  cp "${outside}/texting-style/"* "${HH}/plugins/texting-style/"
  mkdir -p "${STATE}"
  printf '%s\n' "${CUR_TAG}" > "${STATE}/installed-release"
  kit KIT_TEXTING_STYLE=1 bash "${DL}/install.sh" --auto-update on >/dev/null
  job >/dev/null || fail "texting ancestor: run failed"
  [ "$(cat "${outside}/texting-style/plugin.yaml")" = old ] || fail "texting ancestor: wrote through a symlinked plugins/ folder"
  if ls "${outside}/texting-style/"*.bak.* >/dev/null 2>&1; then fail "texting ancestor: backups written outside the Hermes home"; fi
  cmp -s "${HH}/plugins/texting-style/plugin.yaml" "${REL}/texting-style/plugin.yaml" || fail "texting ancestor: the plain copy was not refreshed"
  tail -n 1 "${ULOG}" | grep -q 'texting-style refreshed in 1 profile(s), 1 with a symlink in the path left alone' || fail "texting ancestor log: $(tail -n 1 "${ULOG}")"
  ok "regression: texting-style skips a plugin behind a symlinked folder"
}

# 4. off normalises HERMES_HOME like on, and never says off while the job stays.
reg_off_normalise() {
  new_machine
  kit bash "${DL}/install.sh" --auto-update on >/dev/null
  out=$(kit HERMES_HOME="${HH}/" bash "${DL}/install.sh" --auto-update off) || fail "off with a trailing slash failed: ${out}"
  [ ! -e "${PLIST}" ] || fail "off with a trailing slash left this home's LaunchAgent"
  grep -qx "bootout gui/${UIDN}/io.github.thomasbek3.hermes-bot-kit.update" "${LOGS}/launchctl" || fail "off with a trailing slash: no bootout"
  [ ! -e "${STATE}/auto-update.env" ] || fail "off with a trailing slash: settings kept"
  kit HERMES_HOME="${HH}/" bash "${DL}/install.sh" --auto-update on >/dev/null
  grep -qF "<string>${STATE}/update.sh</string>" "${PLIST}" || fail "on with a trailing slash: plist path not normalised"
  if out=$(kit FAKE_BOOTOUT=fail bash "${DL}/install.sh" --auto-update off 2>&1); then
    fail "off reported success while the job is still loaded"
  fi
  printf '%s\n' "${out}" | grep -q 'auto-update is NOT off' || fail "off: no NOT off message: ${out}"
  [ -f "${STATE}/auto-update.env" ] || fail "off deleted the settings while the job stayed loaded"
  ok "regression: on/off/status/run share one HERMES_HOME normalisation; off fails while a job remains"
}

# 5. A newest release without --auto-update runs only as an installer: the
# updater copy stays.
reg_legacy_driver() {
  new_machine
  local legacy="${WORK}/legacy"
  rm -rf "${legacy}"
  cp -R "${REL}" "${legacy}"
  sed '/^KIT_AUTO_UPDATE_API=1$/d' "${REL}/install.sh" > "${legacy}/install.sh"
  ( cd "${legacy}" && bash scripts/make-manifest.sh >/dev/null )
  mkdir -p "${STATE}"
  printf '%s\n' "${CUR_TAG}" > "${STATE}/installed-release"
  kit bash "${DL}/install.sh" --auto-update on >/dev/null
  FROOT="${legacy}" job >/dev/null || fail "legacy: run failed"
  [ "$(cat "${STATE}/installed-release")" = "${NEW_TAG}" ] || fail "legacy: the legacy release was not installed"
  cmp -s "${STATE}/update.sh" "${DL}/install.sh" || fail "legacy: update.sh was replaced by an installer without auto-update"
  tail -n 1 "${ULOG}" | grep -q "kept the current updater (the ${NEW_TAG} installer has no auto-update)" || fail "legacy log: $(tail -n 1 "${ULOG}")"
  ok "regression: a release without auto-update installs but never replaces the updater"
}

# Round 2. 6. A hook reached through a symlinked folder: the folders above the
# symlink's TARGET are checked too (on and run).
reg_hook_symlinked_ancestor() {
  new_machine
  local pub="${M}/pub" safe="${M}/safe" hook
  mkdir -p "${pub}/real" "${safe}"
  chmod 0700 "${pub}/real" "${safe}"
  printf '#!/bin/sh\ntouch "%s/hook.ran"\n' "${M}" > "${pub}/real/hook.sh"
  chmod 0700 "${pub}/real/hook.sh"
  ln -s "${pub}/real" "${safe}/link"
  hook="${safe}/link/hook.sh"
  chmod 0777 "${pub}"
  if out=$(kit KIT_POST_UPDATE_HOOK="${hook}" bash "${DL}/install.sh" --auto-update on 2>&1); then
    fail "hook symlinked ancestor: accepted a hook whose real folder sits in a folder others can write to"
  fi
  printf '%s\n' "${out}" | grep -q "group or others can write to (${pub}," || fail "hook symlinked ancestor: wrong reason: ${out}"
  [ ! -e "${STATE}/auto-update.env" ] || fail "hook symlinked ancestor: on went ahead"
  chmod 0700 "${pub}"
  mkdir -p "${STATE}"
  printf '%s\n' "${CUR_TAG}" > "${STATE}/installed-release"
  kit KIT_POST_UPDATE_HOOK="${hook}" bash "${DL}/install.sh" --auto-update on >/dev/null || fail "hook symlinked ancestor: a safe symlinked path was rejected"
  chmod 0777 "${pub}"
  job >/dev/null || fail "hook symlinked ancestor: run failed"
  chmod 0700 "${pub}"
  [ ! -e "${M}/hook.ran" ] || fail "hook symlinked ancestor: the hook ran from a swappable folder"
  tail -n 1 "${ULOG}" | grep -q 'post-update hook not run: it has a folder above it that group or others can write to' || fail "hook symlinked ancestor log: $(tail -n 1 "${ULOG}")"
  ok "regression: a hook behind a symlinked folder is checked on its resolved path too (on and run)"
}

# 7. A holder that crashes (kill -9) frees the lock at once: the next run
# proceeds, and leftovers of the old lock folders don't block it.
reg_lock_crashed_recover() {
  new_machine
  kit bash "${DL}/install.sh" --auto-update on >/dev/null
  printf '%s\n' "${CUR_TAG}" > "${STATE}/installed-release"
  hold_lock
  mkdir -p "${STATE}/update.lock" "${STATE}/update.lock.recover"
  printf '%s\n' "${SLEEPER}" > "${STATE}/update.lock/pid"
  drop_lock
  kit bash "${DL}/install.sh" --auto-update run >/dev/null || fail "crashed holder: run failed: $(tail -n 1 "${ULOG}")"
  [ "$(cat "${STATE}/installed-release")" = "${NEW_TAG}" ] || fail "crashed holder: not updated: $(tail -n 1 "${ULOG}")"
  ok "regression: a crashed lock holder never blocks the next run (kernel lock, no stale state)"
}

# 8. off retried after a failed unload: unloads the still-loaded job, then
# succeeds; with the job already gone it succeeds too.
reg_off_retry() {
  new_machine
  kit bash "${DL}/install.sh" --auto-update on >/dev/null
  if kit FAKE_BOOTOUT=fail bash "${DL}/install.sh" --auto-update off >/dev/null 2>&1; then fail "off retry: first off should fail"; fi
  [ -e "${LOGS}/launchctl.loaded" ] || fail "off retry: test setup, job not loaded"
  out=$(kit bash "${DL}/install.sh" --auto-update off 2>&1) || fail "off retry: second off failed: ${out}"
  [ ! -e "${LOGS}/launchctl.loaded" ] || fail "off retry: reported off while the job is still loaded"
  [ ! -e "${STATE}/auto-update.env" ] || fail "off retry: settings kept after success"
  [ "$(grep -c "^bootout gui/${UIDN}/" "${LOGS}/launchctl")" -ge 2 ] || fail "off retry: no second bootout"
  new_machine
  kit bash "${DL}/install.sh" --auto-update on >/dev/null
  if kit FAKE_BOOTOUT=fail bash "${DL}/install.sh" --auto-update off >/dev/null 2>&1; then fail "off retry: first off should fail"; fi
  rm -f "${LOGS}/launchctl.loaded"
  kit bash "${DL}/install.sh" --auto-update off >/dev/null 2>&1 || fail "off retry: off after the job went away failed"
  [ ! -e "${STATE}/auto-update.env" ] || fail "off retry: settings kept"
  ok "regression: off retried after a failed unload unloads the job, and succeeds once it is gone"
}

# 9. A symlinked HERMES_HOME and its target are the same home for on, off,
# status and run.
reg_symlinked_home() {
  new_machine
  local hl="${M}/hermes-link"
  ln -s "${HH}" "${hl}"
  kit HERMES_HOME="${hl}" bash "${DL}/install.sh" --auto-update on >/dev/null || fail "symlinked home: on failed"
  grep -qF "<string>${STATE}/update.sh</string>" "${PLIST}" || fail "symlinked home: plist does not name the resolved home"
  out=$(kit bash "${DL}/install.sh" --auto-update status)
  printf '%s\n' "${out}" | grep -q '^Auto-update      : on, daily at 04:20 local time via launchd (LaunchAgent loaded)' || fail "symlinked home: status through the target: ${out}"
  mkdir -p "${STATE}"
  printf '%s\n' "${CUR_TAG}" > "${STATE}/installed-release"
  kit HERMES_HOME="${hl}" bash "${STATE}/update.sh" --auto-update run >/dev/null || fail "symlinked home: run failed"
  [ "$(cat "${STATE}/installed-release")" = "${NEW_TAG}" ] || fail "symlinked home: run did not update"
  kit bash "${DL}/install.sh" --auto-update off >/dev/null || fail "symlinked home: off through the target failed"
  [ ! -e "${PLIST}" ] || fail "symlinked home: off through the target left the job"
  kit bash "${DL}/install.sh" --auto-update on >/dev/null
  kit HERMES_HOME="${hl}/" bash "${DL}/install.sh" --auto-update off >/dev/null || fail "symlinked home: off through the link failed"
  [ ! -e "${PLIST}" ] && [ ! -e "${STATE}/auto-update.env" ] || fail "symlinked home: off through the link left state"
  ok "regression: a symlinked HERMES_HOME and its target are one home for on/off/status/run"
}

# Round 3. 10. on saves the settings and the updater BEFORE the job is
# installed: a job fired by bootstrap / enable already sees the knobs. And a
# run without settings does nothing.
reg_on_order() {
  new_machine
  cat > "${M}/launchctl" <<EOF
#!/usr/bin/env bash
if [ "\$1" = bootstrap ]; then
  grep -qx 'KIT_SKIP_GROKBOT=1' "${STATE}/auto-update.env" 2>/dev/null && [ -f "${STATE}/update.sh" ] && echo saved > "${M}/at-bootstrap" || echo missing > "${M}/at-bootstrap"
fi
exec "${FAKE}/launchctl" "\$@"
EOF
  chmod +x "${M}/launchctl"
  kit KIT_LAUNCHCTL="${M}/launchctl" KIT_SKIP_GROKBOT=1 bash "${DL}/install.sh" --auto-update on >/dev/null || fail "on order: on failed"
  [ "$(cat "${M}/at-bootstrap")" = saved ] || fail "on order (mac): the job was loaded before the settings were saved"
  new_machine
  cat > "${M}/systemctl" <<EOF
#!/usr/bin/env bash
if [ "\$2" = enable ]; then
  grep -qx 'KIT_SKIP_GROKBOT=1' "${STATE}/auto-update.env" 2>/dev/null && [ -f "${STATE}/update.sh" ] && echo saved > "${M}/at-enable" || echo missing > "${M}/at-enable"
fi
exec "${FAKE}/systemctl" "\$@"
EOF
  chmod +x "${M}/systemctl"
  OS=linux kit KIT_SYSTEMCTL="${M}/systemctl" KIT_SKIP_GROKBOT=1 bash "${DL}/install.sh" --auto-update on >/dev/null || fail "on order: on (linux) failed"
  [ "$(cat "${M}/at-enable")" = saved ] || fail "on order (linux): the timer was enabled before the settings were saved"
  new_machine
  mkdir -p "${STATE}"
  printf '%s\n' "${CUR_TAG}" > "${STATE}/installed-release"
  kit bash "${DL}/install.sh" --auto-update run >/dev/null || fail "no settings: run exited non-zero"
  [ "$(cat "${STATE}/installed-release")" = "${CUR_TAG}" ] || fail "no settings: run installed without saved settings"
  [ ! -e "${HH}/desktop-plugins" ] || fail "no settings: run installed plugins"
  tail -n 1 "${ULOG}" | grep -q 'skipped: auto-update is off (no ' || fail "no settings log: $(tail -n 1 "${ULOG}")"
  ok "regression: on saves settings and updater before loading the job; run without settings does nothing"
}

# 11. Linux off checks every systemctl result: a failed disable keeps the
# units and settings, prints the command and exits non-zero; a retry works.
reg_systemd_off_failure() {
  new_machine
  OS=linux kit bash "${DL}/install.sh" --auto-update on >/dev/null
  if out=$(OS=linux kit FAKE_SYSTEMCTL_FAIL=disable bash "${DL}/install.sh" --auto-update off 2>&1); then
    fail "systemd off: reported off although disable failed"
  fi
  printf '%s\n' "${out}" | grep -qF 'systemctl --user disable --now hermes-bot-kit-update.timer' || fail "systemd off: no command printed: ${out}"
  [ -f "${UNITS}/hermes-bot-kit-update.timer" ] && [ -f "${UNITS}/hermes-bot-kit-update.service" ] || fail "systemd off: units removed after a failed disable"
  [ -f "${STATE}/auto-update.env" ] || fail "systemd off: settings removed after a failed disable"
  if OS=linux kit FAKE_SYSTEMCTL_FAIL=daemon-reload bash "${DL}/install.sh" --auto-update off >/dev/null 2>&1; then
    fail "systemd off: reported off although daemon-reload failed"
  fi
  [ -f "${STATE}/auto-update.env" ] || fail "systemd off: settings removed after a failed daemon-reload"
  OS=linux kit bash "${DL}/install.sh" --auto-update off >/dev/null 2>&1 || fail "systemd off: the retry failed"
  [ ! -e "${UNITS}/hermes-bot-kit-update.timer" ] && [ ! -e "${STATE}/auto-update.env" ] || fail "systemd off: retry left state"
  [ ! -e "${LOGS}/systemctl.enabled" ] || fail "systemd off: timer still enabled"
  ok "regression: Linux off checks disable, is-active/is-enabled and daemon-reload; failures keep everything; a retry finishes"
}

# 12. texting-style refresh failures (an unwritable copy) are logged per
# profile as FAILED, not "refreshed"; the update itself still stands.
reg_texting_copy_failure() {
  [ "${UIDN}" != 0 ] || { ok "regression: texting-style copy failure (skipped as root)"; return 0; }
  new_machine
  mkdir -p "${HH}/plugins/texting-style" "${HH}/profiles/ok/plugins/texting-style"
  printf 'old\n' > "${HH}/plugins/texting-style/plugin.yaml"
  printf '# old texting-style.sms-register\n' > "${HH}/plugins/texting-style/__init__.py"
  cp "${HH}/plugins/texting-style/"* "${HH}/profiles/ok/plugins/texting-style/"
  chmod 0444 "${HH}/plugins/texting-style/"*
  chmod 0555 "${HH}/plugins/texting-style"
  kit KIT_TEXTING_STYLE=1 bash "${DL}/install.sh" --auto-update on >/dev/null
  printf '%s\n' "${CUR_TAG}" > "${STATE}/installed-release"
  job >/dev/null || fail "texting failure: run failed"
  chmod 0755 "${HH}/plugins/texting-style"
  chmod 0644 "${HH}/plugins/texting-style/"*
  [ "$(cat "${STATE}/installed-release")" = "${NEW_TAG}" ] || fail "texting failure: the update did not stand"
  tail -n 1 "${ULOG}" | grep -qF "texting-style FAILED: could not refresh 1 profile(s) (${HH}/plugins/texting-style: plugin.yaml (backup failed)" || fail "texting failure log: $(tail -n 1 "${ULOG}")"
  tail -n 1 "${ULOG}" | grep -q 'refreshed in 1 profile(s)' || fail "texting failure: the writable profile was not counted"
  cmp -s "${HH}/profiles/ok/plugins/texting-style/plugin.yaml" "${REL}/texting-style/plugin.yaml" || fail "texting failure: the writable profile was not refreshed"
  out=$(kit bash "${DL}/install.sh" --auto-update status)
  printf '%s\n' "${out}" | grep -q '^Last run         : .*texting-style FAILED' || fail "texting failure: status does not show it: ${out}"
  ok "regression: texting-style copy failures are logged per profile as FAILED and shown by status"
}

REGRESSIONS="reg_hook_toctou reg_lock_race reg_texting_ancestor_link reg_off_normalise reg_legacy_driver reg_hook_symlinked_ancestor reg_lock_crashed_recover reg_off_retry reg_symlinked_home reg_on_order reg_systemd_off_failure reg_texting_copy_failure"
if [ -n "${AU_TEST_ONLY:-}" ]; then
  "${AU_TEST_ONLY}"
  echo "test-auto-update.sh: ${AU_TEST_ONLY} passed"
  exit 0
fi

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
kit bash "${DL}/install.sh" --auto-update on >/dev/null
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

# Lock: a live holder blocks a second run; once it is gone the next run goes.
new_machine
kit bash "${DL}/install.sh" --auto-update on >/dev/null
printf '%s\n' "${CUR_TAG}" > "${STATE}/installed-release"
hold_lock
out=$(kit bash "${DL}/install.sh" --auto-update run) || fail "locked run exited non-zero"
tail -n 1 "${ULOG}" | grep -q "skipped: another update is running (pid ${SLEEPER})" || fail "lock: $(tail -n 1 "${ULOG}")"
[ "$(cat "${STATE}/installed-release")" = "${CUR_TAG}" ] || fail "lock: updated anyway"
drop_lock
out=$(kit bash "${DL}/install.sh" --auto-update run) || fail "run after the holder exited failed: ${out}"
[ "$(cat "${STATE}/installed-release")" = "${NEW_TAG}" ] || fail "lock: not updated after the holder exited"
ok "lock: a running update blocks overlap; the lock goes with its holder"

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
tail -n 1 "${ULOG}" | grep -q 'texting-style refreshed in 2 profile(s), 1 with a symlink in the path left alone (new code loads at the next agent/gateway restart)' || fail "texting-style log: $(tail -n 1 "${ULOG}")"
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

# --- install.sh --uninstall ------------------------------------------------------
# tree_sum <dir>: every path and file checksum under it (what must not change).
tree_sum() { (cd "$1" && find . -print | LC_ALL=C sort && find . -type f -print0 | LC_ALL=C sort -z | xargs -0 cksum); }
uninstall_machine() {
  # A machine with the kit installed at the current release, auto-update on,
  # and agent plugins plus config.yaml in two profiles.
  new_machine
  mkdir -p "${HH}/plugins/texting-style" "${HH}/profiles/a/plugins/remote-cua" "${HH}/profiles/a/plugins/platforms/slack"
  printf 'name: texting-style\n' > "${HH}/plugins/texting-style/plugin.yaml"
  printf 'x = 1\n' > "${HH}/profiles/a/plugins/remote-cua/__init__.py"
  printf '# adapter\n' > "${HH}/profiles/a/plugins/platforms/slack/http_adapter.py"
  printf 'plugins:\n  enabled: [texting-style]\n' > "${HH}/config.yaml"
  printf 'plugins:\n  enabled: [remote-cua]\ncomputer_use:\n  backend: remote-cua\n' > "${HH}/profiles/a/config.yaml"
  API=down kit bash "${DL}/install.sh" >/dev/null || fail "uninstall setup: install failed"
  [ "$(cat "${STATE}/installed-release")" = "${CUR_TAG}" ] || fail "uninstall setup: not on ${CUR_TAG}"
  kit bash "${DL}/install.sh" --auto-update on >/dev/null || fail "uninstall setup: on failed"
  [ -f "${PLIST}" ] && [ -e "${LOGS}/launchctl.loaded" ] || fail "uninstall setup: no job"
  tree_sum "${HH}/plugins" > "${M}/agent.before"
  tree_sum "${HH}/profiles" > "${M}/profiles.before"
  cksum "${HH}/config.yaml" "${HH}/profiles/a/config.yaml" > "${M}/config.before"
}

# 1. auto-update on: the job goes first, the plugins and records move out,
# agent plugins and config.yaml stay byte for byte, and the next run (a newer
# release is out) installs nothing.
uninstall_machine
out=$(kit bash "${DL}/install.sh" --uninstall) || fail "uninstall failed: ${out}"
[ ! -e "${PLIST}" ] && [ ! -e "${LOGS}/launchctl.loaded" ] || fail "uninstall left the daily job"
grep -qx "bootout gui/${UIDN}/io.github.thomasbek3.hermes-bot-kit.update" "${LOGS}/launchctl" || fail "uninstall: no bootout"
[ ! -e "${HH}/desktop-plugins/computer-viewer" ] && [ ! -e "${HH}/desktop-plugins/grokbot-override" ] || fail "uninstall left a desktop plugin"
ls -d "${HH}"/desktop-plugins-removed-*-computer-viewer "${HH}"/desktop-plugins-removed-*-grokbot-override >/dev/null 2>&1 || fail "uninstall did not keep the moved plugins"
[ ! -e "${HH}/desktop-plugins/.hermes-bot-kit-install" ] || fail "uninstall left the install record"
[ ! -e "${STATE}" ] || fail "uninstall left ${STATE} (installed-release, update.sh, auto-update.env)"
removed=$(ls -d "${HH}"/hermes-bot-kit-removed-*)
[ -f "${removed}/installed-release" ] && [ -f "${removed}/UNINSTALLED" ] || fail "uninstall: records not kept in ${removed}"
[ ! -e "${removed}/update.sh" ] && [ ! -e "${removed}/auto-update.env" ] || fail "uninstall: the updater or its settings survived"
printf '%s\n' "${out}" | grep -qx 'Reload desktop plugins (Cmd+K) or restart Hermes Desktop' || fail "uninstall: no reload line: ${out}"
printf '%s\n' "${out}" | grep -q '^  texting-style (plugins/texting-style in ' || fail "uninstall: texting-style not listed: ${out}"
printf '%s\n' "${out}" | grep -q '^  remote-cua (plugins/remote-cua in .*/profiles/a)' || fail "uninstall: remote-cua not listed: ${out}"
printf '%s\n' "${out}" | grep -q '^  slack-http (the Slack platform shadow) (plugins/platforms/slack in ' || fail "uninstall: slack-http not listed: ${out}"
printf '%s\n' "${out}" | grep -q 'remote-cua/README.md#uninstall' || fail "uninstall: no removal pointer: ${out}"
tree_sum "${HH}/plugins" | cmp -s - "${M}/agent.before" || fail "uninstall touched an agent plugin"
tree_sum "${HH}/profiles" | cmp -s - "${M}/profiles.before" || fail "uninstall touched a profile"
cksum "${HH}/config.yaml" "${HH}/profiles/a/config.yaml" | cmp -s - "${M}/config.before" || fail "uninstall touched a config.yaml"
: > "${LOGS}/curl"
kit bash "${DL}/install.sh" --auto-update run >/dev/null || fail "run after uninstall failed"
[ ! -e "${HH}/desktop-plugins/grokbot-override" ] && [ ! -e "${HH}/desktop-plugins/computer-viewer" ] || fail "a run after uninstall installed the plugins again"
[ ! -e "${STATE}/installed-release" ] || fail "a run after uninstall wrote installed-release"
grep -q "${NEW_TAG}" "${LOGS}/curl" && fail "a run after uninstall downloaded ${NEW_TAG}"
tail -n 1 "${ULOG}" | grep -q 'skipped: auto-update is off' || fail "run after uninstall: $(tail -n 1 "${ULOG}")"
ok "uninstall: job removed first, plugins and records moved out, agent plugins/config.yaml untouched; the next run installs nothing"

# 2. Running it again is a no-op that says so.
tree_sum "${HH}" > "${M}/all.before"
out=$(kit bash "${DL}/install.sh" --uninstall) || fail "second uninstall exited non-zero: ${out}"
printf '%s\n' "${out}" | grep -q '^Uninstall        -- nothing is installed in ' || fail "second uninstall: ${out}"
tree_sum "${HH}" | cmp -s - "${M}/all.before" || fail "second uninstall changed something"
ok "uninstall: a second run says nothing is installed, exits 0, changes nothing"

# 3. Auto-update can't be turned off: stop, nothing moved.
uninstall_machine
tree_sum "${HH}/desktop-plugins" > "${M}/dp.before"
if out=$(kit FAKE_BOOTOUT=fail bash "${DL}/install.sh" --uninstall 2>&1); then
  fail "uninstall succeeded although auto-update could not be turned off"
fi
printf '%s\n' "${out}" | grep -q 'auto-update could not be turned off (see above), so nothing else was changed' || fail "uninstall (off fails): ${out}"
tree_sum "${HH}/desktop-plugins" | cmp -s - "${M}/dp.before" || fail "uninstall moved plugins although auto-update stayed on"
[ -f "${STATE}/installed-release" ] && [ -f "${STATE}/auto-update.env" ] || fail "uninstall removed records although auto-update stayed on"
if ls -d "${HH}"/desktop-plugins-removed-* "${HH}"/hermes-bot-kit-removed-* >/dev/null 2>&1; then fail "uninstall (off fails) moved something"; fi
out=$(kit bash "${DL}/install.sh" --uninstall) || fail "uninstall retry failed: ${out}"
[ ! -e "${HH}/desktop-plugins/grokbot-override" ] && [ ! -e "${PLIST}" ] || fail "uninstall retry left state"
ok "uninstall: when auto-update can't be turned off it stops (exit 1) and moves nothing; a retry finishes"

# 4. Linux (systemd): the timer goes too.
new_machine
API=down OS=linux kit bash "${DL}/install.sh" >/dev/null
OS=linux kit bash "${DL}/install.sh" --auto-update on >/dev/null
[ -f "${UNITS}/hermes-bot-kit-update.timer" ] || fail "linux uninstall setup: no timer"
OS=linux kit bash "${DL}/install.sh" --uninstall >/dev/null || fail "linux uninstall failed"
[ ! -e "${UNITS}/hermes-bot-kit-update.timer" ] && [ ! -e "${LOGS}/systemctl.enabled" ] || fail "linux uninstall left the timer"
[ ! -e "${HH}/desktop-plugins/grokbot-override" ] && [ ! -e "${STATE}" ] || fail "linux uninstall left state"
ok "uninstall (systemd): timer disabled and removed, then plugins and records moved out"

# 5. (review P1) An update that read its settings before an uninstall, then
# resumes, installs nothing: run and uninstall share a lock outside the folder
# uninstall moves, and run re-checks auto-update after taking it.
uninstall_machine
mkdir -p "${M}/gate"
job KIT_TEST_RUN_GATE="${M}/gate/go" > "${M}/job.out" 2>&1 &
jobpid=$!
for _ in $(seq 1 200); do [ -e "${M}/gate/go.waiting" ] && break; sleep 0.05; done
[ -e "${M}/gate/go.waiting" ] || fail "uninstall race: the update never reached its gate"
kit bash "${DL}/install.sh" --uninstall >/dev/null || fail "uninstall race: uninstall failed while an update was paused"
touch "${M}/gate/go"
wait "${jobpid}" || fail "uninstall race: the paused update exited non-zero: $(cat "${M}/job.out")"
[ ! -e "${HH}/desktop-plugins/grokbot-override" ] && [ ! -e "${HH}/desktop-plugins/computer-viewer" ] || fail "uninstall race: the paused update reinstalled the plugins"
[ ! -e "${STATE}" ] || fail "uninstall race: the paused update recreated ${STATE}"
tail -n 1 "${ULOG}" | grep -q 'skipped: auto-update was turned off' || fail "uninstall race log: $(tail -n 1 "${ULOG}")"
# While an update holds the lock, uninstall changes nothing (exit 1).
uninstall_machine
hold_lock
tree_sum "${HH}" > "${M}/all.before"
if kit bash "${DL}/install.sh" --uninstall >/dev/null 2>&1; then drop_lock; fail "uninstall ran while an update held the lock"; fi
drop_lock
tree_sum "${HH}" | grep -v 'hermes-bot-kit-update.flock' > "${M}/all.after" || true
grep -v 'hermes-bot-kit-update.flock' "${M}/all.before" | cmp -s - "${M}/all.after" || fail "uninstall changed something while an update held the lock"
[ -f "${PLIST}" ] && [ -f "${STATE}/auto-update.env" ] || fail "uninstall turned auto-update off while an update held the lock"
ok "uninstall vs a running update: one lock outside the moved folder; a resumed update re-checks and installs nothing"

# 6. (review P2) A record move that fails part-way is finished by a rerun,
# which writes the UNINSTALLED marker.
uninstall_machine
mkdir -p "${M}/failmv"
cat > "${M}/failmv/mv" <<'EOF'
#!/bin/sh
for a in "$@"; do case "$a" in *desktop-plugins/MANIFEST.sha256) [ -n "${FAKE_MV_FAIL:-}" ] && exit 1 ;; esac; done
exec /bin/mv "$@"
EOF
chmod +x "${M}/failmv/mv"
if XPATH="${M}/failmv" kit FAKE_MV_FAIL=1 bash "${DL}/install.sh" --uninstall >/dev/null 2>&1; then fail "partial uninstall: a failed record move exited 0"; fi
[ -f "${HH}/desktop-plugins/MANIFEST.sha256" ] || fail "partial uninstall: test setup, the manifest moved"
out=$(kit bash "${DL}/install.sh" --uninstall) || fail "partial uninstall: the rerun failed: ${out}"
printf '%s\n' "${out}" | grep -q 'nothing is installed' && fail "partial uninstall: the rerun said nothing is installed: ${out}"
[ ! -e "${HH}/desktop-plugins/MANIFEST.sha256" ] || fail "partial uninstall: the rerun left the manifest"
ls "${HH}"/hermes-bot-kit-removed-*/UNINSTALLED >/dev/null 2>&1 || fail "partial uninstall: no UNINSTALLED marker after the rerun"
ok "uninstall: a record move that failed part-way is finished by a rerun, which writes the marker"

# 7. (review round 2, P1) An OLDER updater (the released v2026.11.22 install.sh,
# kept as a fixture so shallow CI checkouts work, run as update.sh) holds the legacy lock
# <state>/update.flock while it waits on the GitHub API. Uninstall must see it:
# exit 1, nothing changed. Once it is done, uninstall goes ahead. A new-style
# run waits for the legacy lock too.
OLD_UPDATER="${WORK}/old-update.sh"
cp "${ROOT}/tests/fixtures/legacy-install-v2026.11.22.sh" "${OLD_UPDATER}" || fail "legacy lock: fixture tests/fixtures/legacy-install-v2026.11.22.sh missing"
uninstall_machine
cp "${OLD_UPDATER}" "${STATE}/update.sh"
chmod 0700 "${STATE}/update.sh"
mkdir -p "${M}/apigate"
job FAKE_API_WAIT="${M}/apigate/go" > "${M}/oldjob.out" 2>&1 &
oldpid=$!
for _ in $(seq 1 200); do [ -e "${M}/apigate/go.waiting" ] && break; sleep 0.05; done
[ -e "${M}/apigate/go.waiting" ] || { kill "${oldpid}" 2>/dev/null; fail "legacy lock: the old updater never reached the API"; }
[ -f "${STATE}/update.flock" ] || { touch "${M}/apigate/go"; fail "legacy lock: test setup, the old updater has no legacy lock file"; }
tree_sum "${HH}" | grep -v 'hermes-bot-kit-update.flock' > "${M}/all.before"
if out=$(kit bash "${DL}/install.sh" --uninstall 2>&1); then
  touch "${M}/apigate/go"; wait "${oldpid}" || true
  fail "legacy lock: uninstall ran while an older updater held its lock: ${out}"
fi
printf '%s\n' "${out}" | grep -q 'an update is running right now' || { touch "${M}/apigate/go"; fail "legacy lock: wrong message: ${out}"; }
tree_sum "${HH}" | grep -v 'hermes-bot-kit-update.flock' | cmp -s - "${M}/all.before" || { touch "${M}/apigate/go"; fail "legacy lock: uninstall changed something"; }
# A new-style run while the old one holds the legacy lock: skipped.
kit bash "${DL}/install.sh" --auto-update run >/dev/null || { touch "${M}/apigate/go"; fail "legacy lock: a new run failed"; }
tail -n 1 "${ULOG}" | grep -q 'skipped: another update is running' || { touch "${M}/apigate/go"; fail "legacy lock: a new run did not wait for the old one: $(tail -n 1 "${ULOG}")"; }
touch "${M}/apigate/go"
wait "${oldpid}" || fail "legacy lock: the old updater failed: $(cat "${M}/oldjob.out")"
out=$(kit bash "${DL}/install.sh" --uninstall) || fail "legacy lock: uninstall after the old updater finished failed: ${out}"
[ ! -e "${HH}/desktop-plugins/grokbot-override" ] && [ ! -e "${STATE}" ] || fail "legacy lock: uninstall left state"
ok "uninstall vs an older updater: its legacy lock is honoured (exit 1, nothing changed); new runs wait for it too"

for r in ${REGRESSIONS}; do "${r}"; done

echo "test-auto-update.sh: all passed"
