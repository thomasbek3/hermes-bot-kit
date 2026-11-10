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
assert_plugin "${home}" "computer-viewer/hiperf-linux.sh"
assert_plugin "${home}" "computer-viewer/connect-windows.ps1"
assert_plugin "${home}" "computer-viewer/hiperf-windows.ps1"
assert_plugin "${home}" "computer-viewer/hiperf-agent.py"
assert_exec "${home}/desktop-plugins/computer-viewer/connect-mac.sh"
assert_exec "${home}/desktop-plugins/computer-viewer/connect-linux.sh"
assert_exec "${home}/desktop-plugins/computer-viewer/hiperf-mac.sh"
assert_exec "${home}/desktop-plugins/computer-viewer/hiperf-linux.sh"
if awk '$2 == "computer-viewer/vendor/novnc-rfb.mjs" { found=1 } END { exit found ? 0 : 1 }' "${MANIFEST}"; then
  assert_plugin "${home}" "computer-viewer/vendor/novnc-rfb.mjs"
fi
echo "OK  happy path"

# Grokbot Override: the default-off build lands under the plugin's own name,
# so the override stays off until it is toggled on from the palette.
grokbot_dest="${home}/desktop-plugins/grokbot-override/plugin.js"
[ -f "${grokbot_dest}" ] || fail "missing ${grokbot_dest}"
expected=$(manifest_hash "grokbot-override/plugin.default-off.js") || fail "grokbot default-off build not in MANIFEST.sha256"
[ "${expected}" = "$(file_sha256 "${grokbot_dest}")" ] || fail "grokbot-override/plugin.js is not the default-off build"
grep -q 'var DEFAULT_ON = true ? false : true;' "${grokbot_dest}" || fail "installed Grokbot Override does not start off"
if [ -e "${home}/desktop-plugins/grokbot-override/plugin.default-off.js" ]; then
  fail "the build's source name was installed too"
fi
echo "OK  Grokbot Override installed switched off"

# The helper scripts' offline digest check needs a manifest next to them.
manifest_dest="${home}/desktop-plugins/MANIFEST.sha256"
[ -f "${manifest_dest}" ] || fail "MANIFEST.sha256 was not installed to desktop-plugins/"
cmp -s "${MANIFEST}" "${manifest_dest}" || fail "installed MANIFEST.sha256 differs from the source"
echo "OK  manifest installed alongside the plugins"

# With curl unusable, hiperf-mac.sh's manifest_agent_sha must still resolve the
# agent digest from that installed manifest (../../MANIFEST.sha256 relative to
# desktop-plugins/computer-viewer/). Extracted the way test-bind.sh extracts
# resolve_bind, and sourced from the installed directory so script_dir() lands
# where the real script would.
shim_curl=$(mktemp -d)
CLEANUP+=("${shim_curl}")
cat > "${shim_curl}/curl" <<'EOF'
#!/usr/bin/env bash
exit 1
EOF
chmod +x "${shim_curl}/curl"

extract="${home}/desktop-plugins/computer-viewer/.manifest-agent-sha-extract.sh"
{
  printf "RAW_REPO_URL='https://offline.invalid/hermes-bot-kit/computer-viewer'\n"
  sed -n '/^script_dir()/,/^}/p' "${ROOT}/computer-viewer/hiperf-mac.sh"
  sed -n '/^manifest_agent_sha()/,/^}/p' "${ROOT}/computer-viewer/hiperf-mac.sh"
} > "${extract}"
grep -q '^manifest_agent_sha()' "${extract}" || fail "manifest_agent_sha not found in hiperf-mac.sh"
[ "$(tail -n1 "${extract}")" = '}' ] || fail "manifest_agent_sha extract did not end at a closing brace"

got=$(env -i PATH="${shim_curl}:/usr/bin:/bin" HOME="${HOME:-/tmp}" \
  bash --noprofile --norc -c \
  'set -euo pipefail; . "$1"; manifest_agent_sha' _ "${extract}")
want=$(manifest_hash "computer-viewer/hiperf-agent.py") || fail "hiperf-agent.py not in MANIFEST.sha256"
[ "${got}" = "${want}" ] || fail "offline manifest_agent_sha -> '${got}' want '${want}'"
rm -f "${extract}"
echo "OK  offline agent digest from the installed manifest"

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

# KIT_SKIP_GROKBOT=1 skips exactly that plugin
skip_home=$(new_home)
HERMES_HOME="${skip_home}" KIT_SOURCE_DIR="${ROOT}" KIT_SKIP_GROKBOT=1 bash "${INSTALLER}" >/dev/null
[ -f "${skip_home}/desktop-plugins/task-dock/plugin.js" ] || fail "skip: task-dock missing"
if [ -e "${skip_home}/desktop-plugins/grokbot-override" ]; then
  fail "skip: grokbot-override was installed"
fi
echo "OK  KIT_SKIP_GROKBOT"

# A release whose manifest predates Grokbot Override installs the rest.
old=$(mktemp -d)
CLEANUP+=("${old}")
copy_tree "${old}"
grep -v ' grokbot-override/' "${old}/MANIFEST.sha256" > "${old}/MANIFEST.next"
mv "${old}/MANIFEST.next" "${old}/MANIFEST.sha256"
old_home=$(new_home)
HERMES_HOME="${old_home}" KIT_SOURCE_DIR="${old}" bash "${INSTALLER}" >/dev/null 2>&1 || fail "install from an older manifest failed"
[ -f "${old_home}/desktop-plugins/task-dock/plugin.js" ] || fail "older manifest: task-dock missing"
if [ -e "${old_home}/desktop-plugins/grokbot-override" ]; then
  fail "older manifest: grokbot-override was installed"
fi
echo "OK  older manifest without Grokbot Override"

# Rerun is idempotent (no new .bak.* when nothing changed)
bak_before=$(find "${home}" -name '*.bak.*' | wc -l | tr -d ' ')
HERMES_HOME="${home}" KIT_SOURCE_DIR="${ROOT}" bash "${INSTALLER}" >/dev/null
bak_after=$(find "${home}" -name '*.bak.*' | wc -l | tr -d ' ')
[ "${bak_before}" = "${bak_after}" ] || fail "rerun created backups (${bak_before} -> ${bak_after})"
echo "OK  idempotent rerun"

# The agent-cards skill is opt-in: a default install leaves skills/ alone.
if [ -e "${home}/skills" ]; then
  fail "default install created ${home}/skills"
fi
echo "OK  cards skill off by default"

CARDS_REL="grokbot-override/skills/agent-cards/SKILL.md"
cards_hash=$(manifest_hash "${CARDS_REL}") || fail "${CARDS_REL} not in MANIFEST.sha256"
assert_skill() {
  dest="$1/skills/agent-cards/SKILL.md"
  [ -f "${dest}" ] || fail "missing ${dest}"
  [ "$(file_sha256 "${dest}")" = "${cards_hash}" ] || fail "${dest} is not the kit's skill"
}

# KIT_CARDS_SKILL=1: the root home and every profile; a user's own
# agent-cards skill is left alone.
cards_home=$(new_home)
mkdir -p "${cards_home}/profiles/alpha" "${cards_home}/profiles/beta/skills/agent-cards"
printf -- '---\nname: agent-cards\n---\nmine\n' > "${cards_home}/profiles/beta/skills/agent-cards/SKILL.md"
out=$(HERMES_HOME="${cards_home}" KIT_SOURCE_DIR="${ROOT}" KIT_CARDS_SKILL=1 bash "${INSTALLER}")
assert_skill "${cards_home}"
assert_skill "${cards_home}/profiles/alpha"
grep -qx 'mine' "${cards_home}/profiles/beta/skills/agent-cards/SKILL.md" || fail "the user's own agent-cards skill was replaced"
printf '%s\n' "${out}" | grep -q 'is your own agent-cards skill; left alone' || fail "no note about the user's own skill"
printf '%s\n' "${out}" | grep -q 'keeps its old mode until its session restarts' || fail "no note about running chats"
[ -f "${cards_home}/desktop-plugins/bubble-mode/plugin.js" ] || fail "cards install skipped the plugins"
echo "OK  KIT_CARDS_SKILL=1 (root home, profiles, user's own skill kept)"

bak_before=$(find "${cards_home}" -name '*.bak.*' | wc -l | tr -d ' ')
HERMES_HOME="${cards_home}" KIT_SOURCE_DIR="${ROOT}" KIT_CARDS_SKILL=1 bash "${INSTALLER}" >/dev/null
bak_after=$(find "${cards_home}" -name '*.bak.*' | wc -l | tr -d ' ')
[ "${bak_before}" = "${bak_after}" ] || fail "cards rerun created backups (${bak_before} -> ${bak_after})"
echo "OK  cards skill rerun is idempotent"

# KIT_CARDS_PROFILES limits the skill to the named homes.
only_home=$(new_home)
mkdir -p "${only_home}/profiles/alpha" "${only_home}/profiles/beta"
HERMES_HOME="${only_home}" KIT_SOURCE_DIR="${ROOT}" KIT_CARDS_SKILL=1 KIT_CARDS_PROFILES=alpha bash "${INSTALLER}" >/dev/null
assert_skill "${only_home}/profiles/alpha"
if [ -e "${only_home}/skills/agent-cards" ] || [ -e "${only_home}/profiles/beta/skills" ]; then
  fail "KIT_CARDS_PROFILES=alpha installed the skill elsewhere"
fi
echo "OK  KIT_CARDS_PROFILES"

# Tampered skill: refused, nothing copied.
tampered_skill=$(mktemp -d)
CLEANUP+=("${tampered_skill}")
copy_tree "${tampered_skill}"
printf 'extra\n' >> "${tampered_skill}/${CARDS_REL}"
bad_cards_home=$(new_home)
set +e
HERMES_HOME="${bad_cards_home}" KIT_SOURCE_DIR="${tampered_skill}" KIT_CARDS_SKILL=1 bash "${INSTALLER}" >/dev/null 2>&1
status=$?
set -e
[ "${status}" -ne 0 ] || fail "tampered skill install exited 0"
if [ -e "${bad_cards_home}/skills" ] || [ -e "${bad_cards_home}/desktop-plugins" ]; then
  fail "tampered skill install copied files"
fi
echo "OK  cards skill tamper"

# A release whose manifest predates the skill installs the rest.
old_cards=$(mktemp -d)
CLEANUP+=("${old_cards}")
copy_tree "${old_cards}"
grep -v " ${CARDS_REL}\$" "${old_cards}/MANIFEST.sha256" > "${old_cards}/MANIFEST.next"
mv "${old_cards}/MANIFEST.next" "${old_cards}/MANIFEST.sha256"
old_cards_home=$(new_home)
HERMES_HOME="${old_cards_home}" KIT_SOURCE_DIR="${old_cards}" KIT_CARDS_SKILL=1 bash "${INSTALLER}" >/dev/null 2>&1 || fail "cards install from an older manifest failed"
[ -f "${old_cards_home}/desktop-plugins/task-dock/plugin.js" ] || fail "older manifest: task-dock missing"
[ ! -e "${old_cards_home}/skills" ] || fail "older manifest: the skill was installed"
echo "OK  older manifest without the cards skill"

# KIT_CARDS_SKILL=remove: removes only the kit's copies and installs nothing.
HERMES_HOME="${cards_home}" KIT_CARDS_SKILL=remove bash "${INSTALLER}" >/dev/null
[ ! -e "${cards_home}/skills/agent-cards" ] || fail "remove left the root home's skill"
[ ! -e "${cards_home}/profiles/alpha/skills/agent-cards" ] || fail "remove left alpha's skill"
grep -qx 'mine' "${cards_home}/profiles/beta/skills/agent-cards/SKILL.md" || fail "remove touched the user's own skill"
fresh_home=$(new_home)
HERMES_HOME="${fresh_home}" KIT_CARDS_SKILL=remove bash "${INSTALLER}" >/dev/null
[ -z "$(ls -A "${fresh_home}")" ] || fail "remove on a fresh home created files"
echo "OK  KIT_CARDS_SKILL=remove"

reject_home=$(new_home)
set +e
HERMES_HOME="${reject_home}" KIT_SOURCE_DIR="${ROOT}" KIT_CARDS_SKILL=yes bash "${INSTALLER}" >/dev/null 2>&1
status=$?
set -e
[ "${status}" -eq 2 ] || fail "KIT_CARDS_SKILL=yes exited ${status}, want 2"
echo "OK  KIT_CARDS_SKILL rejects other values"

echo "test-install.sh: all passed"
