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

if [ "$fail" -ne 0 ]; then
  echo "test-bind: FAILED"
  exit 1
fi
echo "test-bind: all passed"
