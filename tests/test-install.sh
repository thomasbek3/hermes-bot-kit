#!/usr/bin/env bash
# Offline tests for install.sh: happy path, tamper, skip knobs, idempotent rerun.
set -euo pipefail

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
INSTALLER="${ROOT}/install.sh"
MANIFEST="${ROOT}/MANIFEST.sha256"

CLEANUP=()
cleanup() {
  if [ ${#CLEANUP[@]} -gt 0 ]; then
    rm -rf "${CLEANUP[@]}"
  fi
}
trap cleanup EXIT

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

file_sha256() {
  if command -v shasum >/dev/null 2>&1; then
    shasum -a 256 -- "$1" | awk '{print $1}'
  elif command -v sha256sum >/dev/null 2>&1; then
    sha256sum -- "$1" | awk '{print $1}'
  else
    fail "need shasum or sha256sum"
  fi
}

manifest_hash() {
  awk -v p="$1" '$2 == p { print $1; found=1; exit } END { if (!found) exit 1 }' "${MANIFEST}"
}

new_home() {
  home=$(mktemp -d)
  CLEANUP+=("${home}")
  printf '%s\n' "${home}"
}

copy_tree() {
  dest=$1
  mkdir -p "${dest}"
  tar -C "${ROOT}" --exclude .git -cf - . | tar -C "${dest}" -xf -
}

assert_plugin() {
  home=$1
  rel=$2
  dest="${home}/desktop-plugins/${rel}"
  [ -f "${dest}" ] || fail "missing ${dest}"
  expected=$(manifest_hash "${rel}") || fail "${rel} not in MANIFEST.sha256"
  actual=$(file_sha256 "${dest}")
  [ "${expected}" = "${actual}" ] || fail "sha256 mismatch for ${rel}: manifest ${expected} dest ${actual}"
}

assert_exec() {
  dest=$1
  [ -x "${dest}" ] || fail "not executable: ${dest}"
}

[ -f "${INSTALLER}" ] || fail "installer not found at ${INSTALLER}"
[ -f "${MANIFEST}" ] || fail "MANIFEST.sha256 not found; run scripts/make-manifest.sh --allow-missing"

# Happy path
home=$(new_home)
HERMES_HOME="${home}" KIT_SOURCE_DIR="${ROOT}" bash "${INSTALLER}" >/dev/null
assert_plugin "${home}" "bubble-mode/plugin.js"
assert_plugin "${home}" "bot-sections/plugin.js"
assert_plugin "${home}" "task-dock/plugin.js"
assert_plugin "${home}" "computer-viewer/plugin.js"
assert_plugin "${home}" "computer-viewer/connect-mac.sh"
assert_plugin "${home}" "computer-viewer/connect-linux.sh"
assert_plugin "${home}" "computer-viewer/hiperf-mac.sh"
assert_plugin "${home}" "computer-viewer/hiperf-agent.py"
assert_exec "${home}/desktop-plugins/computer-viewer/connect-mac.sh"
assert_exec "${home}/desktop-plugins/computer-viewer/connect-linux.sh"
assert_exec "${home}/desktop-plugins/computer-viewer/hiperf-mac.sh"
if awk '$2 == "computer-viewer/vendor/novnc-rfb.mjs" { found=1 } END { exit found ? 0 : 1 }' "${MANIFEST}"; then
  assert_plugin "${home}" "computer-viewer/vendor/novnc-rfb.mjs"
fi
echo "OK  happy path"

# Tamper: flip one byte, installer must refuse and copy nothing
tampered=$(mktemp -d)
CLEANUP+=("${tampered}")
copy_tree "${tampered}"
python3 -c '
from pathlib import Path
import sys
p = Path(sys.argv[1])
b = bytearray(p.read_bytes())
if not b:
    raise SystemExit("empty plugin")
b[0] ^= 0x01
p.write_bytes(b)
' "${tampered}/task-dock/plugin.js"
bad_home=$(new_home)
set +e
HERMES_HOME="${bad_home}" KIT_SOURCE_DIR="${tampered}" bash "${INSTALLER}" >/dev/null 2>&1
status=$?
set -e
[ "${status}" -ne 0 ] || fail "tampered installer exited 0"
if [ -e "${bad_home}/desktop-plugins" ]; then
  fail "tampered install created ${bad_home}/desktop-plugins"
fi
echo "OK  tamper"

# KIT_SKIP_TASK_DOCK=1 skips exactly that plugin
skip_home=$(new_home)
HERMES_HOME="${skip_home}" KIT_SOURCE_DIR="${ROOT}" KIT_SKIP_TASK_DOCK=1 bash "${INSTALLER}" >/dev/null
[ -f "${skip_home}/desktop-plugins/bubble-mode/plugin.js" ] || fail "skip: bubble-mode missing"
[ -f "${skip_home}/desktop-plugins/bot-sections/plugin.js" ] || fail "skip: bot-sections missing"
[ -f "${skip_home}/desktop-plugins/computer-viewer/plugin.js" ] || fail "skip: computer-viewer missing"
if [ -e "${skip_home}/desktop-plugins/task-dock" ]; then
  fail "skip: task-dock was installed"
fi
echo "OK  KIT_SKIP_TASK_DOCK"

# Rerun is idempotent (no new .bak.* when nothing changed)
bak_before=$(find "${home}" -name '*.bak.*' | wc -l | tr -d ' ')
HERMES_HOME="${home}" KIT_SOURCE_DIR="${ROOT}" bash "${INSTALLER}" >/dev/null
bak_after=$(find "${home}" -name '*.bak.*' | wc -l | tr -d ' ')
[ "${bak_before}" = "${bak_after}" ] || fail "rerun created backups (${bak_before} -> ${bak_after})"
echo "OK  idempotent rerun"

echo "test-install.sh: all passed"
