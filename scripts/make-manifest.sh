#!/usr/bin/env bash
# Write MANIFEST.sha256 (sha256sum format, sorted by path) from
# scripts/manifest-files.txt. --check exits 1 if the committed file differs.
# --allow-missing skips absent files with a warning (needed until
# computer-viewer/vendor/novnc-rfb.mjs lands; drop it after that).
set -euo pipefail

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
cd "${ROOT}"

CHECK=0
ALLOW_MISSING=0
for arg in "$@"; do
  case "${arg}" in
    --check) CHECK=1 ;;
    --allow-missing) ALLOW_MISSING=1 ;;
    -h|--help)
      echo "Usage: scripts/make-manifest.sh [--check] [--allow-missing]"
      exit 0
      ;;
    *)
      echo "make-manifest.sh: unknown option: ${arg}" >&2
      exit 2
      ;;
  esac
done

LIST="${ROOT}/scripts/manifest-files.txt"
OUT="${ROOT}/MANIFEST.sha256"

if [ ! -f "${LIST}" ]; then
  echo "make-manifest.sh: missing ${LIST}" >&2
  exit 1
fi

hash_file() {
  if command -v shasum >/dev/null 2>&1; then
    shasum -a 256 -- "$1"
  elif command -v sha256sum >/dev/null 2>&1; then
    sha256sum -- "$1"
  else
    echo "make-manifest.sh: need shasum or sha256sum" >&2
    exit 1
  fi
}

tmp=$(mktemp)
trap 'rm -f "${tmp}"' EXIT

while IFS= read -r path || [ -n "${path}" ]; do
  path=${path%$'\r'}
  case "${path}" in
    ''|\#*) continue ;;
  esac
  if [ ! -f "${path}" ]; then
    if [ "${ALLOW_MISSING}" -eq 1 ]; then
      echo "make-manifest.sh: warning: missing ${path} (skipped)" >&2
      continue
    fi
    echo "make-manifest.sh: missing ${path}" >&2
    exit 1
  fi
  hash_file "${path}"
done < "${LIST}" | LC_ALL=C sort -k2,2 > "${tmp}"

if [ "${CHECK}" -eq 1 ]; then
  if [ ! -f "${OUT}" ]; then
    echo "make-manifest.sh: ${OUT} is missing" >&2
    exit 1
  fi
  if ! cmp -s "${tmp}" "${OUT}"; then
    echo "make-manifest.sh: MANIFEST.sha256 is stale" >&2
    diff -u "${OUT}" "${tmp}" >&2 || true
    exit 1
  fi
  echo "MANIFEST.sha256 OK"
  exit 0
fi

cp "${tmp}" "${OUT}"
echo "wrote ${OUT}"
