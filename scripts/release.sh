#!/usr/bin/env bash
# Cut a dated release: pin KIT_REF, regenerate MANIFEST.sha256, run the CI
# test set, commit, and annotate the tag. Does not push.
set -euo pipefail

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
cd "${ROOT}"

usage() {
  echo "Usage: scripts/release.sh vYYYY.MM.DD" >&2
}

TAG="${1:-}"
case "${TAG}" in
  v[0-9][0-9][0-9][0-9].[0-9][0-9].[0-9][0-9]) ;;
  *)
    usage
    exit 2
    ;;
esac

if [ -n "$(git status --porcelain)" ]; then
  echo "release.sh: working tree is dirty; commit or stash first" >&2
  git status --porcelain >&2
  exit 1
fi

if git rev-parse -q --verify "refs/tags/${TAG}" >/dev/null; then
  echo "release.sh: tag ${TAG} already exists" >&2
  exit 1
fi

OLD=$(sed -n 's/^KIT_REF="${KIT_REF:-\(.*\)}"/\1/p' install.sh | head -1)
if [ -z "${OLD}" ]; then
  echo "release.sh: could not read current KIT_REF from install.sh" >&2
  exit 1
fi
OLD_ESC=$(printf '%s' "${OLD}" | sed 's/\./\\./g')

PINNED_FILES="
install.sh
texting-style/install.sh
connect-linux.sh
connect-mac.sh
hiperf-mac.sh
hiperf-linux.sh
connect-windows.ps1
hiperf-windows.ps1
README.md
AGENTS.md
texting-style/README.md
computer-viewer/README.md
computer-viewer/hiperf-mac.sh
computer-viewer/hiperf-linux.sh
computer-viewer/hiperf-windows.ps1
bubble-mode/install.sh
bubble-mode/README.md
bot-sections/README.md
task-dock/README.md
"

rewrite() {
  local file="$1" tmp
  tmp=$(mktemp)
  sed "s/${OLD_ESC}/${TAG}/g" "${file}" > "${tmp}"
  mv "${tmp}" "${file}"
}

for file in ${PINNED_FILES}; do
  if [ ! -f "${file}" ]; then
    echo "release.sh: missing ${file}" >&2
    exit 1
  fi
  rewrite "${file}"
done

plugin_tmp=$(mktemp)
sed -e "s|hermes-bot-kit/[^/']*/computer-viewer|hermes-bot-kit/${TAG}/computer-viewer|g" \
  computer-viewer/plugin.js > "${plugin_tmp}"
mv "${plugin_tmp}" computer-viewer/plugin.js

bash scripts/make-manifest.sh

run_ci_tests() {
  node --check bubble-mode/plugin.js
  node --check bot-sections/plugin.js
  node --check task-dock/plugin.js
  node --check computer-viewer/plugin.js
  node --test bubble-mode/plugin.test.mjs task-dock/plugin.test.mjs computer-viewer/plugin.test.mjs
  python3 -m unittest discover -s computer-viewer/agent-plugin/orgo-computer/tests -p 'test_*.py'
  find . -name '*.sh' -not -path './.git/*' -print0 | xargs -0 bash -n
  bash computer-viewer/tests/test-bind.sh
  bash computer-viewer/tests/test-install-agent-plugin.sh
  python3 -c '
import sys
from pathlib import Path
root = Path("computer-viewer/agent-plugin")
bad = [p for p in root.rglob("*.py") if any(b > 127 for b in p.read_bytes())]
if bad:
    print("non-ASCII bytes in:")
    for p in bad:
        print(" ", p)
    sys.exit(1)
print("ASCII OK")
'
  bash scripts/make-manifest.sh --check
  bash tests/test-install.sh
}

run_ci_tests

git add -u
git add MANIFEST.sha256
git commit -m "release: ${TAG}"
git tag -a "${TAG}" -m "release: ${TAG}"

echo
echo "Created commit and annotated tag ${TAG}."
echo "Push with:"
echo "  git push origin HEAD"
echo "  git push origin ${TAG}"
