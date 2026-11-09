#!/usr/bin/env bash
# Install the slack-check dashboard plugin into a Hermes home and enable it for every profile
# that has SLACK_BOT_TOKEN. Idempotent. Never restarts anything. Never prints token values.
#
#   bash install.sh [--dry-run] [--profile NAME ...]
#
#   --dry-run       show what would change, change nothing
#   --profile NAME  also enable for NAME ("default" = the root home), e.g. when the token comes
#                   from a secret manager rather than the profile's .env (repeatable)
#
# Env: HERMES_HOME (default ~/.hermes), HERMES_AGENT_DIR (Hermes source, default $HERMES_HOME/hermes-agent),
#      HERMES_PYTHON (default $HERMES_AGENT_DIR/venv/bin/python)
set -euo pipefail

DRY_RUN=0
EXTRA_PROFILES=()
while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run) DRY_RUN=1 ;;
    --profile) shift; [ $# -gt 0 ] || { echo "--profile needs a name" >&2; exit 2; }; EXTRA_PROFILES+=("$1") ;;
    --profile=*) EXTRA_PROFILES+=("${1#--profile=}") ;;
    -h|--help) sed -n '2,12p' "$0"; exit 0 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
  shift
done

SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HERMES_HOME="${HERMES_HOME:-$HOME/.hermes}"
HERMES_HOME="${HERMES_HOME%/}"
DEST="$HERMES_HOME/plugins/slack-check"
AGENT_DIR="${HERMES_AGENT_DIR:-$HERMES_HOME/hermes-agent}"
PY="${HERMES_PYTHON:-$AGENT_DIR/venv/bin/python}"
FILES=(dashboard/manifest.json dashboard/plugin_api.py dashboard/dist/index.js README.md)

say() { printf '%s\n' "$*"; }
run() { if [ "$DRY_RUN" = 1 ]; then say "  [dry-run] $*"; else "$@"; fi; }

[ -d "$HERMES_HOME" ] || { echo "No Hermes home at $HERMES_HOME (set HERMES_HOME)" >&2; exit 1; }
for f in "${FILES[@]}"; do
  [ -f "$SRC_DIR/$f" ] || { echo "missing source file: $SRC_DIR/$f" >&2; exit 1; }
done

# ---- 1. copy -------------------------------------------------------------------------------
say "slack-check -> $DEST"
changed=0
for f in "${FILES[@]}"; do
  if ! cmp -s "$SRC_DIR/$f" "$DEST/$f" 2>/dev/null; then changed=1; fi
done
if [ "$changed" = 0 ]; then
  say "  files already up to date"
else
  if [ -d "$DEST" ]; then
    # Back up OUTSIDE plugins/: a copy under plugins/ would be discovered as a second plugin.
    backup="$HERMES_HOME/plugin-backups/slack-check.bak.$(date +%Y%m%d%H%M%S)"
    run mkdir -p "$HERMES_HOME/plugin-backups"
    run cp -R "$DEST" "$backup"
    [ "$DRY_RUN" = 1 ] || say "  backed up previous copy to $backup"
  fi
  for f in "${FILES[@]}"; do
    run mkdir -p "$(dirname "$DEST/$f")"
    run cp "$SRC_DIR/$f" "$DEST/$f.tmp.$$"
    run mv -f "$DEST/$f.tmp.$$" "$DEST/$f"
  done
  if [ "$DRY_RUN" = 1 ]; then say "  files would be installed"; else say "  files installed"; fi
fi

# ---- 2. enable per profile -----------------------------------------------------------------
# Dashboard-only plugins are not known to `hermes plugins enable` (it lists agent plugins, which
# need plugin.yaml), so the enable goes through Hermes's own config writer for plugins.enabled
# (hermes_cli.plugins_cmd._set_plugin_enabled: locked, admission-checked), run per profile home.
has_slack_token() {
  [ -f "$1/.env" ] && grep -Eq '^[[:space:]]*(export[[:space:]]+)?SLACK_BOT_TOKEN=[[:space:]]*["'"'"']?[^[:space:]"'"'"'#]' "$1/.env"
}

declare -a TARGETS=()
add_target() {
  local t
  for t in "${TARGETS[@]+"${TARGETS[@]}"}"; do [ "$t" = "$1" ] && return 0; done
  TARGETS+=("$1")
}
has_slack_token "$HERMES_HOME" && add_target "default"
if [ -d "$HERMES_HOME/profiles" ]; then
  for p in "$HERMES_HOME"/profiles/*/; do
    [ -d "$p" ] || continue
    name="$(basename "$p")"
    has_slack_token "$HERMES_HOME/profiles/$name" && add_target "$name"
  done
fi
for p in "${EXTRA_PROFILES[@]+"${EXTRA_PROFILES[@]}"}"; do
  if [ "$p" != "default" ] && [ ! -d "$HERMES_HOME/profiles/$p" ]; then
    echo "  skip --profile $p: no $HERMES_HOME/profiles/$p" >&2; continue
  fi
  add_target "$p"
done

if [ "${#TARGETS[@]}" = 0 ]; then
  say "No profile has SLACK_BOT_TOKEN in its .env; nothing enabled (use --profile NAME to force)."
else
  if [ ! -x "$PY" ]; then
    echo "Hermes Python not found at $PY (set HERMES_PYTHON). Files are installed; enable by adding" >&2
    echo "'slack-check' to plugins.enabled in each profile's config.yaml." >&2
    exit 1
  fi
  for name in "${TARGETS[@]}"; do
    if [ "$name" = "default" ]; then home="$HERMES_HOME"; else home="$HERMES_HOME/profiles/$name"; fi
    state="$(cd "$home" && HERMES_HOME="$home" "$PY" -I -c '
import sys; sys.path.insert(0, sys.argv[1])
from hermes_cli.plugins_cmd import _get_disabled_set, _get_enabled_set
print("on" if "slack-check" in _get_enabled_set() and "slack-check" not in _get_disabled_set() else "off")
' "$AGENT_DIR" 2>/dev/null | tail -n 1 || true)"
    if [ "$state" = "on" ]; then
      say "  profile $name: already enabled"
      continue
    fi
    if [ "$DRY_RUN" = 1 ]; then
      say "  [dry-run] profile $name: would add slack-check to plugins.enabled ($home/config.yaml)"
      continue
    fi
    (cd "$home" && HERMES_HOME="$home" "$PY" -I -c '
import sys; sys.path.insert(0, sys.argv[1])
from hermes_cli.plugins_cmd import _set_plugin_enabled
_set_plugin_enabled("slack-check", enable=True)
' "$AGENT_DIR") >/dev/null
    say "  profile $name: enabled"
  done
fi

# ---- 3. next step (never done here) --------------------------------------------------------
say ""
say "Restart the Hermes backend to mount /api/plugins/slack-check/ (the launch profile's gateway,"
say "which serves the dashboard API: quit and reopen Hermes Desktop, or 'hermes gateway restart')."
say "This script did not restart anything. Recent Hermes versions also hot-mount the route on its"
say "first request, so a restart is only needed if the check answers 404."
