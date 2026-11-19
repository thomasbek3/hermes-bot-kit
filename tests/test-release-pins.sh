#!/usr/bin/env bash
# scripts/check-release-pins.sh: passes on the tree as committed, fails when a
# pin names another release, and passes after release.sh's own rewrite.
set -euo pipefail
ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
cd "${ROOT}"
WORK=$(mktemp -d "${TMPDIR:-/tmp}/kit-pins.XXXXXX")
trap 'rm -rf "${WORK}"' EXIT
fail() { echo "FAIL $*" >&2; exit 1; }
ok() { echo "OK  $*"; }

# 1. The checker covers exactly release.sh's PINNED_FILES plus plugin.js.
list() { sed -n "/^PINNED_FILES=\"/,/^\"/p" "$1" | sed '1d;$d' | sort; }
diff <({ list scripts/release.sh; echo computer-viewer/plugin.js; } | sort) <(list scripts/check-release-pins.sh) >/dev/null ||
  fail "PINNED_FILES differ between release.sh and check-release-pins.sh"
ok "same pinned-file list as release.sh"

# 2. The committed tree pins its own fallback release everywhere.
CUR=$(sed -n 's/^KIT_FALLBACK_REF="\(.*\)"/\1/p' install.sh | head -1)
bash scripts/check-release-pins.sh "${CUR}" >/dev/null || fail "tree does not pin ${CUR} everywhere"
ok "committed tree pins ${CUR}"

# 3. Another tag fails and names the files.
out=$(bash scripts/check-release-pins.sh v2099.01.01 2>&1) && fail "v2099.01.01 passed on an un-rewritten tree"
printf '%s\n' "${out}" | grep -q 'OLD PIN install.sh:' || fail "old install.sh pin not named"
ok "an old pin fails and is named"

# 4. release.sh's rewrite (same sed) makes it pass; one file left behind fails.
files=$(list scripts/check-release-pins.sh)
for f in ${files}; do mkdir -p "${WORK}/$(dirname "$f")"; cp "$f" "${WORK}/$f"; done
OLD_ESC=$(printf '%s' "${CUR}" | sed 's/\./\\./g')
for f in $(list scripts/release.sh); do sed -i.bak "s/${OLD_ESC}/v2099.01.01/g" "${WORK}/$f"; rm -f "${WORK}/$f.bak"; done
sed -i.bak "s|hermes-bot-kit/[^/']*/computer-viewer|hermes-bot-kit/v2099.01.01/computer-viewer|g" "${WORK}/computer-viewer/plugin.js"
rm -f "${WORK}/computer-viewer/plugin.js.bak"
bash scripts/check-release-pins.sh v2099.01.01 "${WORK}" >/dev/null || fail "rewritten tree does not pass"
ok "release.sh's rewrite passes"
cp computer-viewer/hiperf-windows.ps1 "${WORK}/computer-viewer/hiperf-windows.ps1"
out=$(bash scripts/check-release-pins.sh v2099.01.01 "${WORK}" 2>&1) && fail "a file left at the old tag passed"
printf '%s\n' "${out}" | grep -q 'OLD PIN computer-viewer/hiperf-windows.ps1:' || fail "left-behind file not named"
ok "a file left at the old tag fails"

# 5. A bad tag is a usage error.
set +e; bash scripts/check-release-pins.sh latest >/dev/null 2>&1; rc=$?; set -e
[ "${rc}" -eq 2 ] || fail "bad tag exit ${rc}, want 2"
ok "bad tag is a usage error"
echo "test-release-pins.sh: all passed"
