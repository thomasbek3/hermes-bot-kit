#!/bin/sh
set -eu
src=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P)
home=${HERMES_HOME:-}
if [ -z "$home" ] || [ "$(basename -- "$(dirname -- "$home")")" != profiles ] || [ "$(basename -- "$home")" = default ]; then
  printf 'Set HERMES_HOME to the named target profile before installing.\n' >&2
  exit 1
fi
dest="$home/plugins/platforms/slack"
case ${1:-} in
  --dry-run) printf 'Would install the Slack platform shadow to %s; no service restarts.\n' "$dest"; exit 0 ;;
  '') ;;
  *) printf 'Usage: %s [--dry-run]\n' "$0" >&2; exit 2 ;;
esac
mkdir -p "$dest"
for file in plugin.yaml __init__.py http_adapter.py; do
  if [ -e "$dest/$file" ] && ! cmp -s "$src/$file" "$dest/$file"; then
    printf 'Existing plugin differs at %s; use the staged installer with backup.\n' "$dest/$file" >&2
    exit 1
  fi
done
for file in plugin.yaml __init__.py http_adapter.py; do
  if [ ! -e "$dest/$file" ]; then cp "$src/$file" "$dest/$file"; fi
done
printf 'Installed slack-http at %s; no service was restarted.\n' "$dest"
