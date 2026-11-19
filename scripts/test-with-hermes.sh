#!/usr/bin/env bash
# Run the tests that need real Hermes code against a Hermes checkout:
# slack-check/tests and slack-connect/tests/test_hermes_parity.py.
#
#   scripts/test-with-hermes.sh <hermes checkout>
#
# Hermes's own dependencies (exported from the checkout's uv.lock, not the
# checkout itself) go into a throwaway venv under $TMPDIR; the checkout is on
# the import path through PYTHONPATH only; HERMES_HOME and HOME are fresh temp
# dirs, so ~/.hermes is never read or written. Everything is removed on exit.
# CI never imports upstream Hermes (.github/workflows/hermes-compat.yml), so
# this is a local and reviewer step. HERMES_TEST_PYTHON picks the Python
# (default 3.14: Hermes pins its dependencies for python_version >= 3.14).
# Exit 0 = both suites passed; 1 = a suite failed; 2 = usage or setup.
set -euo pipefail

if [ "$#" -ne 1 ] || [ ! -d "$1/gateway" ] || [ ! -f "$1/uv.lock" ]; then
  echo "Usage: scripts/test-with-hermes.sh <hermes checkout>" >&2
  exit 2
fi
CHECKOUT=$(CDPATH= cd -- "$1" && pwd)
KIT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
command -v uv >/dev/null || { echo "uv is required (https://docs.astral.sh/uv/)" >&2; exit 2; }

WORK=$(mktemp -d "${TMPDIR:-/tmp}/kit-hermes-test.XXXXXX")
cleanup() { rm -rf -- "${WORK}"; }
trap cleanup EXIT

VENV="${WORK}/venv"
uv venv --quiet --python "${HERMES_TEST_PYTHON:-3.14}" "${VENV}" || exit 2
# Hermes's locked dependencies (uv.lock, read-only with --frozen; the pyproject
# alone does not resolve without its [tool.uv] overrides), never the checkout itself.
uv export --quiet --frozen --no-hashes --no-dev --no-emit-project --project "${CHECKOUT}" \
  -o "${WORK}/requirements.txt" || exit 2
# The export is already a full resolution (overrides applied): install it as is.
uv pip install --quiet --python "${VENV}/bin/python" --no-deps -r "${WORK}/requirements.txt" || exit 2
uv pip install --quiet --python "${VENV}/bin/python" pytest fastapi httpx aiohttp pyyaml python-dotenv || exit 2

mkdir -p "${WORK}/hermes-home" "${WORK}/home"
run() {
  env -i PATH="${VENV}/bin:/usr/bin:/bin" HOME="${WORK}/home" TMPDIR="${WORK}" \
    HERMES_HOME="${WORK}/hermes-home" HERMES_AGENT_DIR="${CHECKOUT}" HERMES_PARITY_CHECKOUT="${CHECKOUT}" \
    PYTHONPATH="${CHECKOUT}" PYTHONDONTWRITEBYTECODE=1 HERMES_DISABLE_LAZY_INSTALLS=1 \
    "${VENV}/bin/python" -m pytest -p no:cacheprovider -q --rootdir "${KIT}" "$@"
}

status=0
cd "${KIT}"
echo "== slack-check against ${CHECKOUT}"
run slack-check/tests || status=1
echo "== slack-connect parity with Hermes's gateway authorization"
run slack-connect/tests/test_hermes_parity.py || status=1
exit "${status}"
