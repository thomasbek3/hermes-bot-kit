#!/usr/bin/env bash
# Runs the real command blocks from AGENTS.md (marked <!-- runbook:NAME -->)
# offline: a fake curl serves install.sh and the release files from this tree.
# Checks the prerequisites, install, verify and uninstall blocks, for the
# default install, Grokbot-only and viewer-only, and that verify fails when a
# selected plugin, its digest or the record is missing.
set -euo pipefail

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
WORK=$(mktemp -d)
export TMPDIR="${WORK}"
trap 'rm -rf "${WORK}"' EXIT
fail() { echo "FAIL: $*" >&2; exit 1; }

block() {
  # The fenced bash block right after <!-- runbook:$1 --> in AGENTS.md.
  awk -v m="<!-- runbook:$1 -->" '
    $0 == m { want = 1; next }
    want && /^```bash/ { inside = 1; next }
    inside && /^```/ { exit }
    inside { print }
  ' "${ROOT}/AGENTS.md"
}
for name in prereq install verify uninstall; do
  [ -n "$(block "${name}")" ] || fail "AGENTS.md has no runbook:${name} block"
done

FAKE="${WORK}/fake"
mkdir -p "${FAKE}"
cp "${ROOT}/tests/fake-curl.sh" "${FAKE}/curl"
chmod +x "${FAKE}/curl"

runblock() {
  # runblock <home> <script text>
  env -i PATH="${FAKE}:/usr/bin:/bin" HOME="${WORK}" TMPDIR="${WORK}" HERMES_HOME="$1" \
    FAKE_API=down FAKE_ROOT="${ROOT}" bash -c "$2"
}

install_variant() {
  # install_variant <home> <env assignments or empty>
  local script
  script=$(block install)
  script=${script//bash \"\$f\"/$2 bash \"\$f\"}
  runblock "$1" "${script}"
}

# Prerequisites: a missing tool or a missing Hermes home exits non-zero.
only_bash="${WORK}/only-bash"
mkdir -p "${only_bash}"
ln -s "$(command -v bash)" "${only_bash}/bash"
if out=$(env -i PATH="${only_bash}" HOME="${WORK}" "${only_bash}/bash" -c "$(block prereq)" 2>&1); then
  fail "prerequisites passed with only bash on PATH"
fi
printf '%s\n' "${out}" | grep -q "prerequisites OK" && fail "prerequisites printed OK after a missing tool"
if runblock "${WORK}/no-such-home" "$(block prereq)" >/dev/null 2>&1; then
  fail "prerequisites passed without a Hermes home"
fi
mkdir -p "${WORK}/home-ok"
runblock "${WORK}/home-ok" "$(block prereq)" | grep -q "prerequisites OK" || fail "prerequisites failed on a good setup"
echo "OK  prerequisites block fails fast"

check_variant() {
  # check_variant <label> <env> <expected plugin list>
  local home="${WORK}/home-$1" out
  mkdir -p "${home}"
  install_variant "${home}" "$2" >/dev/null || fail "$1: install block failed"
  out=$(runblock "${home}" "$(block verify)") || fail "$1: verify block failed"
  printf '%s\n' "${out}" | grep -q "Bot Kit installed OK (.*): $3\$" || fail "$1: verify said: ${out}"
  echo "OK  $1: install + verify ($3)"
}
check_variant default "" "computer-viewer grokbot-override"
check_variant grokbot-only "KIT_SKIP_COMPUTER=1" "grokbot-override"
check_variant viewer-only "KIT_SKIP_GROKBOT=1" "computer-viewer"

expect_verify_fail() {
  # expect_verify_fail <home> <label>
  if runblock "$1" "$(block verify)" >/dev/null 2>&1; then fail "verify passed: $2"; fi
  echo "OK  verify fails: $2"
}
D="${WORK}/home-default/desktop-plugins"
cp "${D}/grokbot-override/plugin.js" "${WORK}/keep.js"
rm "${D}/grokbot-override/plugin.js"
expect_verify_fail "${WORK}/home-default" "a selected plugin is missing"
cp "${WORK}/keep.js" "${D}/grokbot-override/plugin.js"
printf '\n// changed\n' >> "${D}/grokbot-override/plugin.js"
expect_verify_fail "${WORK}/home-default" "a plugin does not match its digest"
cp "${WORK}/keep.js" "${D}/grokbot-override/plugin.js"
cp "${D}/MANIFEST.sha256" "${WORK}/keep.manifest"
grep -v ' grokbot-override/plugin.js$' "${WORK}/keep.manifest" > "${D}/MANIFEST.sha256"
expect_verify_fail "${WORK}/home-default" "a selected plugin has no digest"
{ cat "${WORK}/keep.manifest"; grep ' grokbot-override/plugin.js$' "${WORK}/keep.manifest"; } > "${D}/MANIFEST.sha256"
expect_verify_fail "${WORK}/home-default" "a selected plugin has two digests"
cp "${WORK}/keep.manifest" "${D}/MANIFEST.sha256"
cp "${D}/.hermes-bot-kit-install" "${WORK}/keep.record"
printf 'release=x\nplugins=\n' > "${D}/.hermes-bot-kit-install"
expect_verify_fail "${WORK}/home-default" "the record lists no plugins"
rm "${D}/.hermes-bot-kit-install"
expect_verify_fail "${WORK}/home-default" "there is no install record"
cp "${WORK}/keep.record" "${D}/.hermes-bot-kit-install"
runblock "${WORK}/home-default" "$(block verify)" >/dev/null || fail "verify failed after restoring"

# A move that fails (read-only home) makes the uninstall block exit non-zero.
chmod a-w "${WORK}/home-default"
if runblock "${WORK}/home-default" "$(block uninstall)" >/dev/null 2>&1; then
  chmod u+w "${WORK}/home-default"
  fail "uninstall succeeded although the move failed"
fi
chmod u+w "${WORK}/home-default"
echo "OK  uninstall block fails when a move fails"

# Uninstall moves both plugins out, removes the record, then verify fails.
out=$(runblock "${WORK}/home-default" "$(block uninstall)") || fail "uninstall block failed"
[ ! -e "${D}/computer-viewer" ] && [ ! -e "${D}/grokbot-override" ] || fail "uninstall left a plugin"
ls "${WORK}/home-default" | grep -q 'desktop-plugins-removed-.*-grokbot-override' || fail "uninstall did not keep a moved copy"
expect_verify_fail "${WORK}/home-default" "after uninstall"

# A failed download stops the install block with a non-zero exit.
if env -i PATH="${FAKE}:/usr/bin:/bin" HOME="${WORK}" TMPDIR="${WORK}" HERMES_HOME="${WORK}/home-x" \
  FAKE_API=down FAKE_ROOT="${WORK}/nothing-here" bash -c "$(block install)" >/dev/null 2>&1; then
  fail "the install block succeeded on a failed download"
fi
echo "OK  install block fails on a failed download"

echo "test-agents-runbook.sh: all passed"
