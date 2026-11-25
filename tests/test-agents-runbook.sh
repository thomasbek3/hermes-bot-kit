#!/usr/bin/env bash
# Runs the real command blocks from AGENTS.md (marked <!-- runbook:NAME -->)
# offline: a fake curl serves install.sh and the release files from this tree.
# Checks the prerequisites, install, verify and uninstall blocks (install.sh
# --uninstall and the manual fallback), for the
# default install, Grokbot-only and viewer-only, and that verify fails when a
# selected plugin, its digest or the record is missing. Every block runs
# literally under bash AND zsh (macOS's default shell); zsh must be installed.
set -euo pipefail

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
TOP=$(mktemp -d)
trap 'rm -rf "${TOP}"' EXIT
fail() { echo "FAIL[${SH:-?}]: $*" >&2; exit 1; }

block() {
  # The fenced bash block right after <!-- runbook:$1 --> in AGENTS.md.
  awk -v m="<!-- runbook:$1 -->" '
    $0 == m { want = 1; next }
    want && /^```bash/ { inside = 1; next }
    inside && /^```/ { exit }
    inside { print }
  ' "${ROOT}/AGENTS.md"
}
for name in prereq install verify uninstall uninstall-manual; do
  [ -n "$(block "${name}")" ] || fail "AGENTS.md has no runbook:${name} block"
done
# An interactive bash or zsh treats `!` as history expansion (also inside
# double quotes and here-documents), so the pasted blocks carry none.
awk '/^```bash/ { inside = 1; next } inside && /^```/ { inside = 0 } inside' "${ROOT}/AGENTS.md" |
  grep -q '!' && fail "an AGENTS.md command block contains '!' (history expansion when pasted)"
command -v zsh >/dev/null 2>&1 ||
  fail "zsh is not installed; the runbook blocks must be tested in zsh (apt-get install zsh)"

suite() {
SH=$1
SHBIN=$(command -v "${SH}")
WORK="${TOP}/${SH}"
mkdir -p "${WORK}"
export TMPDIR="${WORK}"
echo "--- blocks under ${SH}"

FAKE="${WORK}/fake"
mkdir -p "${FAKE}"
cp "${ROOT}/tests/fake-curl.sh" "${FAKE}/curl"
chmod +x "${FAKE}/curl"

runblock() {
  # runblock <home> <script text>
  env -i PATH="${FAKE}:/usr/bin:/bin" HOME="${WORK}" TMPDIR="${WORK}" HERMES_HOME="$1" \
    FAKE_API=down FAKE_ROOT="${ROOT}" "${SHBIN}" -c "$2"
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
if out=$(env -i PATH="${only_bash}" HOME="${WORK}" "${SHBIN}" -c "$(block prereq)" 2>&1); then
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

# A move that fails (read-only home) makes either uninstall block exit non-zero.
for b in uninstall uninstall-manual; do
  chmod a-w "${WORK}/home-default"
  if runblock "${WORK}/home-default" "$(block "${b}")" >/dev/null 2>&1; then
    chmod u+w "${WORK}/home-default"
    fail "${b} succeeded although the move failed"
  fi
  chmod u+w "${WORK}/home-default"
  [ -f "${D}/grokbot-override/plugin.js" ] || [ "${b}" = uninstall-manual ] || fail "${b}: moved a plugin although it failed"
done
echo "OK  uninstall blocks fail when a move fails"
# (the manual block may have moved computer-viewer before it failed: put it all back)
for d in "${WORK}"/home-default/desktop-plugins-removed-*; do
  [ -d "${d}" ] || continue
  b=${d##*/}
  mv "${d}" "${D}/${b#desktop-plugins-removed-[0-9]*-}"
done
rm -rf "${WORK}"/home-default/hermes-bot-kit-removed-*
cp "${WORK}/keep.record" "${D}/.hermes-bot-kit-install"
runblock "${WORK}/home-default" "$(block verify)" >/dev/null || fail "verify failed after putting the plugins back"

# install.sh --uninstall moves both plugins and the records out; verify then
# fails, a second run is a no-op, and the doctor says not installed.
out=$(runblock "${WORK}/home-default" "$(block uninstall)") || fail "uninstall block failed"
[ ! -e "${D}/computer-viewer" ] && [ ! -e "${D}/grokbot-override" ] || fail "uninstall left a plugin"
ls "${WORK}/home-default" | grep -q 'desktop-plugins-removed-.*-grokbot-override' || fail "uninstall did not keep a moved copy"
[ ! -e "${D}/.hermes-bot-kit-install" ] && [ ! -e "${WORK}/home-default/hermes-bot-kit" ] || fail "uninstall left the records"
printf '%s\n' "${out}" | grep -qx 'Reload desktop plugins (Cmd+K) or restart Hermes Desktop' || fail "uninstall: no reload line"
expect_verify_fail "${WORK}/home-default" "after uninstall"
out=$(runblock "${WORK}/home-default" "$(block uninstall)") || fail "second uninstall block failed"
printf '%s\n' "${out}" | grep -q 'nothing is installed' || fail "second uninstall: ${out}"
echo "OK  uninstall block: plugins and records moved out; a second run is a no-op"

# The manual fallback: auto-update off first (settings and updater as `on`
# leaves them, cron scheduler: no job to unload), then the same moves.
H2="${WORK}/home-manual"
mkdir -p "${H2}"
install_variant "${H2}" "" >/dev/null || fail "manual uninstall: install failed"
mkdir -p "${H2}/hermes-bot-kit"
cp "${ROOT}/install.sh" "${H2}/hermes-bot-kit/update.sh"
printf 'HERMES_HOME=%s\nKIT_SKIP_GROKBOT=0\nKIT_SKIP_COMPUTER=0\nKIT_TEXTING_STYLE=0\nKIT_POST_UPDATE_HOOK=\nSCHEDULER=cron\n' "${H2}" > "${H2}/hermes-bot-kit/auto-update.env"
out=$(runblock "${H2}" "$(block uninstall-manual)") || fail "manual uninstall block failed"
printf '%s\n' "${out}" | grep -q 'Auto-update      -- off' || fail "manual uninstall: auto-update not turned off: ${out}"
[ ! -e "${H2}/desktop-plugins/computer-viewer" ] && [ ! -e "${H2}/desktop-plugins/grokbot-override" ] || fail "manual uninstall left a plugin"
[ ! -e "${H2}/hermes-bot-kit" ] && [ ! -e "${H2}/desktop-plugins/.hermes-bot-kit-install" ] || fail "manual uninstall left the records"
ls "${H2}"/hermes-bot-kit-removed-*/installed-release >/dev/null 2>&1 || fail "manual uninstall did not keep installed-release"
if ls "${H2}"/hermes-bot-kit-removed-*/auto-update.env >/dev/null 2>&1; then fail "manual uninstall kept auto-update on"; fi
expect_verify_fail "${H2}" "after the manual uninstall"
echo "OK  manual uninstall block: auto-update off first, then plugins and records moved out"

# A failed download stops the install block with a non-zero exit.
if env -i PATH="${FAKE}:/usr/bin:/bin" HOME="${WORK}" TMPDIR="${WORK}" HERMES_HOME="${WORK}/home-x" \
  FAKE_API=down FAKE_ROOT="${WORK}/nothing-here" "${SHBIN}" -c "$(block install)" >/dev/null 2>&1; then
  fail "the install block succeeded on a failed download"
fi
echo "OK  install block fails on a failed download"
}

suite bash
suite zsh
echo "test-agents-runbook.sh: all passed (bash and zsh)"
