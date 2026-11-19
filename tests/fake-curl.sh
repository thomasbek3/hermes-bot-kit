#!/usr/bin/env bash
# Fake curl for the offline installer tests: answers the GitHub API per
# FAKE_API (ok, garbage, old, anything else = down) and serves raw files from
# FAKE_ROOT, logging the ref of each raw file to FAKE_LOG.
out="" url=""
while [ $# -gt 0 ]; do
  case "$1" in
    -o) out="$2"; shift 2 ;;
    -H|--connect-timeout|--max-time|--retry|--retry-delay|--max-filesize) shift 2 ;;
    -*) shift ;;
    *) url="$1"; shift ;;
  esac
done
case "${url}" in
  *api.github.com*|*releases/latest*)
    case "${FAKE_API:-down}" in
      ok) printf '{\n  "url": "x",\n  "tag_name": "v2099.01.02",\n  "name": "x"\n}\n' ;;
      garbage) printf '{"tag_name": "main; rm -rf /"}\n' ;;
      old) printf '{"tag_name": "v2020.01.01"}\n' ;;
      *) exit 22 ;;
    esac
    exit 0 ;;
  https://raw.githubusercontent.com/thomasbek3/hermes-bot-kit/*)
    rest=${url#https://raw.githubusercontent.com/thomasbek3/hermes-bot-kit/}
    ref=${rest%%/*}
    rel=${rest#*/}
    printf '%s\n' "${ref}" >> "${FAKE_LOG:-/dev/null}"
    [ -f "${FAKE_ROOT}/${rel}" ] || exit 22
    if [ -n "${out}" ]; then cat "${FAKE_ROOT}/${rel}" > "${out}"; else cat "${FAKE_ROOT}/${rel}"; fi ;;
  *) exit 22 ;;
esac
