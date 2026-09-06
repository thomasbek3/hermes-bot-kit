#!/usr/bin/env bash
# Offline tests for install-agent-plugin.sh key sources.
set -euo pipefail

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
INSTALLER=$(CDPATH= cd -- "${SCRIPT_DIR}/.." && pwd)/install-agent-plugin.sh
PYTHON3=$(command -v python3)

if [ ! -f "${INSTALLER}" ]; then
  echo "test-install-agent-plugin.sh: installer not found at ${INSTALLER}" >&2
  exit 1
fi
if [ -z "${PYTHON3}" ]; then
  echo "test-install-agent-plugin.sh: python3 is required" >&2
  exit 1
fi

CLEANUP=()
cleanup() {
  if [ "${#CLEANUP[@]}" -gt 0 ]; then
    rm -rf "${CLEANUP[@]}"
  fi
}
trap cleanup EXIT

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

assert_no_leak() {
  key=$1
  stdout=$2
  stderr=$3
  if printf '%s' "${stdout}" | grep -F -q -- "${key}"; then
    fail "key leaked on stdout: ${key}"
  fi
  if printf '%s' "${stderr}" | grep -F -q -- "${key}"; then
    fail "key leaked on stderr: ${key}"
  fi
}

new_home() {
  # Must not run in a command substitution: CLEANUP has to be updated here.
  home=$(mktemp -d)
  CLEANUP+=("${home}")
  mkdir -p "${home}/.hermes" "${home}/bin" "${home}/pylib"
  : > "${home}/.hermes/config.yaml"
  cat > "${home}/bin/hermes" <<'EOF'
#!/usr/bin/env bash
echo "hermes stub: unexpected invocation: $*" >&2
exit 1
EOF
  chmod +x "${home}/bin/hermes"
  # Minimal PyYAML stand-in so the installer can enable the plugin offline.
  cat > "${home}/pylib/yaml.py" <<'EOF'
def safe_load(handle):
    text = handle.read() if hasattr(handle, "read") else handle
    if not text or not str(text).strip():
        return {}
    return {}

def safe_dump(data, default_flow_style=False, sort_keys=False):
    enabled = []
    plugins = data.get("plugins") if isinstance(data, dict) else None
    if isinstance(plugins, dict):
        raw = plugins.get("enabled") or []
        if isinstance(raw, list):
            enabled = raw
    lines = ["plugins:\n", "  enabled:\n"]
    for item in enabled:
        lines.append("  - %s\n" % item)
    return "".join(lines)
EOF
}

run_installer() {
  home=$1
  shift
  out_file="${home}/stdout.txt"
  err_file="${home}/stderr.txt"
  env -u ORGO_API_KEY \
    HOME="${home}" \
    PATH="${home}/bin:${PATH}" \
    HERMES_PYTHON="${PYTHON3}" \
    PYTHONPATH="${home}/pylib${PYTHONPATH:+:${PYTHONPATH}}" \
    bash "${INSTALLER}" "$@" > "${out_file}" 2> "${err_file}"
}

# --- --yes --api-key-stdin ---
key_stdin="sk_test_abc123"
new_home
set +e
run_installer "${home}" --yes --api-key-stdin <<< "${key_stdin}"
status=$?
set -e
stdout=$(cat "${home}/stdout.txt")
stderr=$(cat "${home}/stderr.txt")
if [ "${status}" -ne 0 ]; then
  printf 'stdout:\n%s\nstderr:\n%s\n' "${stdout}" "${stderr}" >&2
  fail "stdin case exited ${status}"
fi
if ! grep -qx "ORGO_API_KEY=${key_stdin}" "${home}/.hermes/.env"; then
  printf 'stdout:\n%s\nstderr:\n%s\n.env:\n%s\n' "${stdout}" "${stderr}" "$(cat "${home}/.hermes/.env" 2>/dev/null || true)" >&2
  fail "stdin case did not write ORGO_API_KEY=${key_stdin}"
fi
assert_no_leak "${key_stdin}" "${stdout}" "${stderr}"

# --- --yes --api-key-file ---
key_file="sk_test_abc123"
new_home
keyfile="${home}/api-key"
printf '%s\n' "${key_file}" > "${keyfile}"
chmod 600 "${keyfile}"
set +e
run_installer "${home}" --yes --api-key-file "${keyfile}"
status=$?
set -e
stdout=$(cat "${home}/stdout.txt")
stderr=$(cat "${home}/stderr.txt")
if [ "${status}" -ne 0 ]; then
  printf 'stdout:\n%s\nstderr:\n%s\n' "${stdout}" "${stderr}" >&2
  fail "file case exited ${status}"
fi
if ! grep -qx "ORGO_API_KEY=${key_file}" "${home}/.hermes/.env"; then
  printf 'stdout:\n%s\nstderr:\n%s\n.env:\n%s\n' "${stdout}" "${stderr}" "$(cat "${home}/.hermes/.env" 2>/dev/null || true)" >&2
  fail "file case did not write ORGO_API_KEY=${key_file}"
fi
assert_no_leak "${key_file}" "${stdout}" "${stderr}"

# --- --yes --api-key (discouraged, still works) ---
key_argv="sk_test_argv"
new_home
set +e
run_installer "${home}" --yes --api-key "${key_argv}"
status=$?
set -e
stdout=$(cat "${home}/stdout.txt")
stderr=$(cat "${home}/stderr.txt")
if [ "${status}" -ne 0 ]; then
  printf 'stdout:\n%s\nstderr:\n%s\n' "${stdout}" "${stderr}" >&2
  fail "argv case exited ${status}"
fi
if ! grep -qx "ORGO_API_KEY=${key_argv}" "${home}/.hermes/.env"; then
  printf 'stdout:\n%s\nstderr:\n%s\n.env:\n%s\n' "${stdout}" "${stderr}" "$(cat "${home}/.hermes/.env" 2>/dev/null || true)" >&2
  fail "argv case did not write ORGO_API_KEY=${key_argv}"
fi
if ! printf '%s' "${stderr}" | grep -F -q "WARNING: --api-key"; then
  printf 'stderr:\n%s\n' "${stderr}" >&2
  fail "argv case stderr missing WARNING: --api-key"
fi
assert_no_leak "${key_argv}" "${stdout}" "${stderr}"

# --- conflicting flags exit 2 ---
key_conflict="x"
new_home
set +e
run_installer "${home}" --api-key-stdin --api-key "${key_conflict}"
status=$?
set -e
stdout=$(cat "${home}/stdout.txt")
stderr=$(cat "${home}/stderr.txt")
if [ "${status}" -ne 2 ]; then
  printf 'stdout:\n%s\nstderr:\n%s\n' "${stdout}" "${stderr}" >&2
  fail "conflict case exited ${status}, expected 2"
fi
assert_no_leak "${key_conflict}" "${stdout}" "${stderr}"

echo "test-install-agent-plugin.sh: ok"
