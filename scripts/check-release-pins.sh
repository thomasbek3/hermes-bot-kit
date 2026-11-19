#!/usr/bin/env bash
# Check that every place the kit pins its own release names TAG and no other
# release: raw.githubusercontent URLs, KIT_REF / KIT_FALLBACK_REF defaults and
# "falls back to" text in the files scripts/release.sh rewrites, plus the HD
# script URLs in computer-viewer/plugin.js.
#
#   scripts/check-release-pins.sh v2026.11.19          # this checkout
#   scripts/check-release-pins.sh v2026.11.19 <root>   # another tree
#
# release.sh runs it right after rewriting the pins. Run it again on the
# merged branch before pushing the tag: a branch merged after release.sh (or a
# release.sh run on the wrong base) leaves an old pin that this names.
# Exit 0 = all pins name TAG; 1 = a pin names another release (listed);
# 2 = usage.
set -euo pipefail

TAG="${1:-}"
case "${TAG}" in
  v[0-9][0-9][0-9][0-9].[0-9][0-9].[0-9][0-9]) ;;
  v[0-9][0-9][0-9][0-9].[0-9][0-9].[0-9][0-9].[1-9]) ;;
  *)
    echo "Usage: scripts/check-release-pins.sh vYYYY.MM.DD[.N] [root]" >&2
    exit 2
    ;;
esac
ROOT="${2:-$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)}"

# Keep in step with PINNED_FILES in scripts/release.sh (test-release-pins.sh
# checks that the two lists match).
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
computer-viewer/plugin.js
"

REL='v[0-9]{4}\.[0-9]{2}\.[0-9]{2}(\.[0-9])?'
PIN="(hermes-bot-kit/|KIT_REF:-|KIT_REF=|KIT_FALLBACK_REF=\"|back to )${REL}"

bad=0
for file in ${PINNED_FILES}; do
  path="${ROOT}/${file}"
  if [ ! -f "${path}" ]; then
    echo "MISSING ${file}"
    bad=1
    continue
  fi
  pins=$(grep -noE "${PIN}" "${path}" || true)
  if [ -z "${pins}" ]; then
    echo "NO PIN  ${file}: names no release at all"
    bad=1
    continue
  fi
  while IFS= read -r hit; do
    line="${hit%%:*}"
    found=$(printf '%s\n' "${hit#*:}" | grep -oE "${REL}\$")
    if [ "${found}" != "${TAG}" ]; then
      echo "OLD PIN ${file}:${line}: ${found} (expected ${TAG})"
      bad=1
    fi
  done <<< "${pins}"
done

if [ "${bad}" -ne 0 ]; then
  echo "check-release-pins: some pins do not name ${TAG}." >&2
  exit 1
fi
echo "check-release-pins: every pin names ${TAG}."
