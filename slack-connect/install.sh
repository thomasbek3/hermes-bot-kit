#!/bin/sh
# Slack one-click connect installer for a Hermes host. See README.md; --help lists options.
set -eu
src=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P)
case "$(uname -s 2>/dev/null || echo unknown)" in
  CYGWIN*|MINGW*|MSYS*|Windows*)
    echo 'Windows is not supported yet; use the paste-tokens dialog in Hermes instead.'
    exit 0 ;;
esac
home=${HERMES_HOME:-"$HOME/.hermes"}
py="$home/hermes-agent/venv/bin/python"
[ -x "$py" ] || py=$(command -v python3 || true)
[ -n "$py" ] || { echo 'Slack installer: Python 3 not found; install Hermes first.' >&2; exit 1; }
exec "$py" -I -B "$src/install.py" "$@"
