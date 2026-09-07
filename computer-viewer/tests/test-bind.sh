#!/usr/bin/env bash
# Extract resolve_bind from each host script and assert bind policy.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"

SCRIPTS=(
  computer-viewer/connect-linux.sh
  computer-viewer/connect-mac.sh
  computer-viewer/hiperf-mac.sh
  computer-viewer/hiperf-linux.sh
)

ENV_BIN="$(command -v env)"
BASH_BIN="$(command -v bash)"
fail=0

run_bind() {
  local extract="$1"
  local inner_path="$2"
  if [ "${3+x}" = x ]; then
    "$ENV_BIN" -i PATH="$inner_path" HOME="${HOME:-/tmp}" CV_BIND="$3" \
      "$BASH_BIN" --noprofile --norc -c 'set -euo pipefail; . "$1"; resolve_bind' _ "$extract"
  else
    "$ENV_BIN" -i PATH="$inner_path" HOME="${HOME:-/tmp}" \
      "$BASH_BIN" --noprofile --norc -c 'set -euo pipefail; . "$1"; resolve_bind' _ "$extract"
  fi
}

assert_eq() {
  local script="$1" label="$2" got="$3" want="$4"
  if [ "$got" = "$want" ]; then
    echo "OK  ${script}  ${label} -> ${got}"
  else
    echo "FAIL ${script}  ${label} -> got '${got}' want '${want}'"
    fail=1
  fi
}

empty_dir="$(mktemp -d)"
shim_ok="$(mktemp -d)"
shim_empty="$(mktemp -d)"
cleanup() {
  rm -rf "$empty_dir" "$shim_ok" "$shim_empty"
}
trap cleanup EXIT

cat > "${shim_ok}/tailscale" <<'EOF'
#!/usr/bin/env bash
if [ "${1:-}" = ip ] && [ "${2:-}" = -4 ]; then
  printf '100.64.0.9\n'
fi
EOF
chmod +x "${shim_ok}/tailscale"

cat > "${shim_empty}/tailscale" <<'EOF'
#!/usr/bin/env bash
exit 0
EOF
chmod +x "${shim_empty}/tailscale"

for script in "${SCRIPTS[@]}"; do
  extract="$(mktemp)"
  sed -n '/^resolve_bind()/,/^}/p' "$script" > "$extract"
  if ! grep -q '^resolve_bind()' "$extract"; then
    echo "FAIL ${script}  resolve_bind not found"
    fail=1
    rm -f "$extract"
    continue
  fi
  if [ "$(tail -n1 "$extract")" != '}' ]; then
    echo "FAIL ${script}  resolve_bind extract did not end at closing brace"
    fail=1
    rm -f "$extract"
    continue
  fi

  got="$(run_bind "$extract" "$empty_dir" '0.0.0.0')"
  assert_eq "$script" 'CV_BIND=0.0.0.0' "$got" '0.0.0.0'

  got="$(run_bind "$extract" "$empty_dir" 'lan')"
  assert_eq "$script" 'CV_BIND=lan' "$got" '0.0.0.0'

  got="$(run_bind "$extract" "$empty_dir" '10.0.0.5')"
  assert_eq "$script" 'CV_BIND=10.0.0.5' "$got" '10.0.0.5'

  got="$(run_bind "$extract" "$empty_dir")"
  assert_eq "$script" 'no tailscale' "$got" '127.0.0.1'

  got="$(run_bind "$extract" "${shim_ok}:/usr/bin:/bin")"
  assert_eq "$script" 'tailscale 100.64.0.9' "$got" '100.64.0.9'

  got="$(run_bind "$extract" "${shim_empty}:/usr/bin:/bin")"
  assert_eq "$script" 'tailscale empty' "$got" '127.0.0.1'

  rm -f "$extract"
done

# --- enable_user_units must RESTART an already-active unit -------------------
# `systemctl --user enable --now` is a no-op on an active unit, so a re-run with
# a new bind never took effect. No systemd on the CI macOS runner, so shim
# systemctl/ss and assert on the argv the function produces.

shim_sys="$(mktemp -d)"
CLEAN_SYS="$shim_sys"
cleanup_sys() {
  rm -rf "$CLEAN_SYS"
}
trap 'cleanup; cleanup_sys' EXIT

cat > "${shim_sys}/systemctl" <<'EOF'
#!/usr/bin/env bash
printf '%s\n' "$*" >> "${SYSCTL_LOG}"
case " $* " in
  *" is-active "*) exit "${IS_ACTIVE_RC:-0}" ;;
esac
exit 0
EOF
chmod +x "${shim_sys}/systemctl"

cat > "${shim_sys}/ss" <<'EOF'
#!/usr/bin/env bash
printf 'LISTEN 0 128 127.0.0.1:6080 0.0.0.0:* users:(("websockify",pid=1,fd=3))\n'
EOF
chmod +x "${shim_sys}/ss"

run_units() {
  local extract="$1" log="$2" active_rc="$3"
  "$ENV_BIN" -i PATH="${shim_sys}:/usr/bin:/bin" HOME="${HOME:-/tmp}" \
    SYSCTL_LOG="$log" IS_ACTIVE_RC="$active_rc" LISTEN_PORT=6080 \
    "$BASH_BIN" --noprofile --norc -c \
    'set -euo pipefail; . "$1"; enable_user_units demo.service' _ "$extract" >/dev/null 2>&1
}

for script in computer-viewer/connect-linux.sh computer-viewer/hiperf-linux.sh; do
  extract="$(mktemp)"
  sed -n '/^show_effective_listener()/,/^}/p' "$script" > "$extract"
  sed -n '/^enable_user_units()/,/^}/p' "$script" >> "$extract"
  if ! grep -q '^enable_user_units()' "$extract"; then
    echo "FAIL ${script}  enable_user_units not found"
    fail=1
    rm -f "$extract"
    continue
  fi

  log="$(mktemp)"
  run_units "$extract" "$log" 0
  if grep -q -- '--user restart demo.service' "$log"; then
    echo "OK  ${script}  active unit -> restart"
  else
    echo "FAIL ${script}  active unit was not restarted"
    fail=1
  fi
  if grep -q -- '--user enable --now' "$log"; then
    echo "FAIL ${script}  still uses 'enable --now'"
    fail=1
  fi
  rm -f "$log"

  log="$(mktemp)"
  run_units "$extract" "$log" 1
  if grep -q -- '--user start demo.service' "$log"; then
    echo "OK  ${script}  inactive unit -> start"
  else
    echo "FAIL ${script}  inactive unit was not started"
    fail=1
  fi
  if grep -q -- '--user restart demo.service' "$log"; then
    echo "FAIL ${script}  inactive unit was restarted instead of started"
    fail=1
  fi
  rm -f "$log"
  rm -f "$extract"
done

if [ "$fail" -ne 0 ]; then
  echo "test-bind: FAILED"
  exit 1
fi
echo "test-bind: all passed"
