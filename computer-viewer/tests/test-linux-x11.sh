#!/usr/bin/env bash
# Runs connect-linux.sh's whole X11 path under Linux bash with shimmed x11vnc,
# websockify, systemctl and loginctl in a throwaway HOME. No network, no root,
# nothing outside the temporary folder is touched. Linux only (CI ubuntu, or a
# container: docker run --rm -v "$PWD":/kit -w /kit debian:bookworm-slim bash computer-viewer/tests/test-linux-x11.sh).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
SCRIPT="${ROOT}/computer-viewer/connect-linux.sh"

if [ "$(uname -s)" != "Linux" ]; then
  echo "test-linux-x11: skipped (needs Linux)"
  exit 0
fi

WORK="$(mktemp -d)"
trap 'rm -rf "${WORK}"' EXIT
fail() { echo "FAIL: $*" >&2; exit 1; }

BIN="${WORK}/bin"
mkdir -p "${BIN}"
for tool in x11vnc websockify; do
  printf '#!/bin/sh\nexit 0\n' > "${BIN}/${tool}"
done
cat > "${BIN}/systemctl" <<'EOF'
#!/bin/sh
echo "systemctl $*" >> "${SHIM_LOG}"
exit 0
EOF
cat > "${BIN}/loginctl" <<'EOF'
#!/bin/sh
echo "loginctl $*" >> "${SHIM_LOG}"
exit 0
EOF
chmod +x "${BIN}"/*

run() {
  # run <home>: the real script, X11 session, loopback bind, shimmed tools.
  env -i PATH="${BIN}:/usr/bin:/bin" HOME="$1" USER=tester SHIM_LOG="$1/shim.log" \
    XDG_SESSION_TYPE=x11 DISPLAY=:0 CV_BIND=127.0.0.1 \
    bash "${SCRIPT}"
}

home="${WORK}/home1"
mkdir -p "${home}"
out="$(run "${home}")" || fail "fresh X11 setup exited non-zero"
pwfile="${home}/.hermes-cv/vnc-password.txt"
[ -f "${pwfile}" ] || fail "no password file"
[ "$(stat -c '%a' "${pwfile}")" = 600 ] || fail "password file mode $(stat -c '%a' "${pwfile}")"
grep -Eqx '[A-Za-z0-9]{8}' "${pwfile}" || fail "password file is not 8 letters/digits"
pw="$(cat "${pwfile}")"
printf '%s\n' "${out}" | grep -qF "${pw}" && fail "the password was printed"
printf '%s\n' "${out}" | grep -q "Paste this address in Computer" || fail "no paste instructions"
printf '%s\n' "${out}" | grep -qF "cat ${pwfile}" || fail "no password-file instructions"
unit="${home}/.config/systemd/user/computer-viewer-x11vnc.service"
grep -q -- "-passwdfile ${pwfile}" "${unit}" || fail "x11vnc unit does not use -passwdfile"
grep -q -- "-rfbauth\|-storepasswd\|-passwd " "${unit}" && fail "x11vnc unit still passes a password another way"
grep -q "systemctl --user enable computer-viewer-x11vnc.service" "${home}/shim.log" || fail "x11vnc unit not enabled"
echo "OK  fresh X11 setup: 0600 password file, not printed, paste + file instructions, -passwdfile unit"

out="$(run "${home}" 2>&1)" || fail "rerun exited non-zero"
[ "$(cat "${pwfile}")" = "${pw}" ] || fail "rerun changed a valid password"
printf '%s\n' "${out}" | grep -q "Reusing VNC password" || fail "rerun did not reuse"
echo "OK  rerun reuses a valid private password file"

chmod 644 "${pwfile}"
run "${home}" >/dev/null 2>&1 || fail "rerun with a 0644 file exited non-zero"
[ "$(stat -c '%a' "${pwfile}")" = 600 ] || fail "a 0644 password file was kept"
[ "$(cat "${pwfile}")" != "${pw}" ] || fail "a 0644 (readable) password was reused"
echo "OK  a group/world-readable password file is replaced"

printf 'has spaces and is too long\n' > "${pwfile}"; chmod 600 "${pwfile}"
run "${home}" >/dev/null 2>&1 || fail "rerun with bad contents exited non-zero"
grep -Eqx '[A-Za-z0-9]{8}' "${pwfile}" || fail "bad contents were kept"
echo "OK  a password file with bad contents is replaced"

target="${WORK}/elsewhere"; printf 'abcd1234\n' > "${target}"; chmod 600 "${target}"
rm -f "${pwfile}"; ln -s "${target}" "${pwfile}"
run "${home}" >/dev/null 2>&1 || fail "rerun with a symlinked file exited non-zero"
[ ! -L "${pwfile}" ] || fail "a symlinked password file was kept"
[ "$(cat "${target}")" = "abcd1234" ] || fail "the symlink target was written"
echo "OK  a symlinked password file is replaced, its target untouched"

echo "test-linux-x11: all passed"
