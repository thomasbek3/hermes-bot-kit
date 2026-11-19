#!/usr/bin/env bash
# Cut a dated release: pin KIT_REF, regenerate MANIFEST.sha256, run the CI
# test set, commit, and annotate the tag. Does not push.
set -euo pipefail

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
cd "${ROOT}"

usage() {
  echo "Usage: scripts/release.sh vYYYY.MM.DD[.N]" >&2
}

TAG="${1:-}"
case "${TAG}" in
  v[0-9][0-9][0-9][0-9].[0-9][0-9].[0-9][0-9]) ;;
  v[0-9][0-9][0-9][0-9].[0-9][0-9].[0-9][0-9].[1-9]) ;;  # same-day follow-up: vYYYY.MM.DD.N
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

OLD=$(sed -n 's/^KIT_FALLBACK_REF="\(.*\)"/\1/p' install.sh | head -1)
if [ -z "${OLD}" ]; then
  echo "release.sh: could not read KIT_FALLBACK_REF from install.sh" >&2
  exit 1
fi
OLD_ESC=$(printf '%s' "${OLD}" | sed 's/\./\\./g')

PINNED_FILES="
install.sh
texting-style/install.sh
remote-cua/install.sh
README.md
AGENTS.md
texting-style/README.md
computer-viewer/README.md
computer-viewer/hiperf-mac.sh
computer-viewer/hiperf-linux.sh
computer-viewer/hiperf-windows.ps1
"

rewrite() {
  local file="$1" tmp
  tmp=$(mktemp)
  sed "s/${OLD_ESC}/${TAG}/g" "${file}" > "${tmp}"
  # cat, not mv: keep the file's mode (mv would drop the executable bit).
  cat "${tmp}" > "${file}"
  rm -f "${tmp}"
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
cat "${plugin_tmp}" > computer-viewer/plugin.js
rm -f "${plugin_tmp}"

bash scripts/make-manifest.sh

run_ci_tests() {
  node --check computer-viewer/plugin.js
  node --check grokbot-override/plugin.js
  node --test tests/privacy-guard.test.mjs
  # The committed bundle must match src/ (needs `npm ci --prefix grokbot-override`).
  npm run --prefix grokbot-override check
  python3 -m unittest discover -s email-drafts/tests -p 'test_*.py'
  node --test computer-viewer/plugin.test.mjs
  python3 -m unittest discover -s texting-style/tests -p 'test_*.py'
  # -n 1: without it xargs passes every later path as an ARGUMENT to the
  # first script, so only one file was ever parsed.
  find . -name '*.sh' -not -path './.git/*' -print0 | xargs -0 -n 1 bash -n
  python3 computer-viewer/tests/test-hiperf-agent.py
  bash computer-viewer/tests/test-bind.sh
  bash computer-viewer/tests/test-remove-orgo-computer.sh
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
