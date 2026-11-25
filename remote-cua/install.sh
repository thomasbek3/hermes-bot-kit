#!/usr/bin/env bash
# Install the remote-cua agent plugin into Hermes profiles and enable it there. Idempotent.
# Never restarts anything, never writes remote_cua/computer_use settings, never touches a remote machine.
#
#   bash remote-cua/install.sh --profiles helper[,other] [--dry-run]
#   bash remote-cua/install.sh --all [--dry-run]
#   curl -fsSL https://raw.githubusercontent.com/thomasbek3/hermes-bot-kit/<tag>/remote-cua/install.sh | bash -s -- --profiles helper
#
#   --profiles LIST  comma-separated profile names ("default" = the root Hermes home)
#   --all            every profile
#   --dry-run        show what would change, change nothing
#
# Env: HERMES_HOME (default ~/.hermes), KIT_REF (tag when curl-piped), HERMES_AGENT_DIR
#      (default $HERMES_HOME/hermes-agent), HERMES_PYTHON (default $HERMES_AGENT_DIR/venv/bin/python),
#      HERMES_BIN (default $HERMES_AGENT_DIR/venv/bin/hermes, else hermes on PATH)
#
# The Hermes version is checked first (the plugin's own compat.py, the same range as at runtime);
# an unsupported Hermes stops the script before any file is copied. Enabling goes through the
# public `hermes plugins enable remote-cua`, run with HERMES_HOME set to each profile's home.
set -euo pipefail

KIT_REF="${KIT_REF:-v2026.11.24}"
RAW_ROOT="https://raw.githubusercontent.com/thomasbek3/hermes-bot-kit/${KIT_REF}"
PLUGIN="remote-cua"
FILES=(plugin.yaml __init__.py settings.py lease.py compat.py remote.py status.py backend.py provider.py cli.py
       check.py dashboard/manifest.json dashboard/plugin_api.py dashboard/dist/index.js)

DRY_RUN=0
ALL=0
PROFILES_ARG=""
while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run) DRY_RUN=1 ;;
    --all) ALL=1 ;;
    --profiles) shift; [ $# -gt 0 ] || { echo "--profiles needs a list" >&2; exit 2; }; PROFILES_ARG="$1" ;;
    --profiles=*) PROFILES_ARG="${1#--profiles=}" ;;
    -h|--help) sed -n '2,16p' "$0" 2>/dev/null || true; exit 0 ;;
    *) echo "install.sh: unknown argument: $1" >&2; exit 2 ;;
  esac
  shift
done
if [ "$ALL" = 0 ] && [ -z "$PROFILES_ARG" ]; then
  echo "install.sh: name the bots' profiles: --profiles a,b (or --all)" >&2
  exit 2
fi

HERMES_HOME="${HERMES_HOME:-$HOME/.hermes}"
HERMES_HOME="${HERMES_HOME%/}"
AGENT_DIR="${HERMES_AGENT_DIR:-$HERMES_HOME/hermes-agent}"
PY="${HERMES_PYTHON:-$AGENT_DIR/venv/bin/python}"
HERMES_CMD="${HERMES_BIN:-}"
if [ -z "$HERMES_CMD" ]; then
  if [ -x "$AGENT_DIR/venv/bin/hermes" ]; then HERMES_CMD="$AGENT_DIR/venv/bin/hermes"
  else HERMES_CMD="$(command -v hermes 2>/dev/null || true)"; fi
fi
[ -d "$HERMES_HOME" ] || { echo "No Hermes home at $HERMES_HOME (set HERMES_HOME)" >&2; exit 1; }

say() { printf '%s\n' "$*"; }
run() { if [ "$DRY_RUN" = 1 ]; then say "  [dry-run] $*"; else "$@"; fi; }

file_sha256() {
  if command -v shasum >/dev/null 2>&1; then shasum -a 256 -- "$1" | awk '{print $1}'
  else sha256sum -- "$1" | awk '{print $1}'; fi
}

# ---- source: this clone, or a verified download --------------------------------------------
SRC_DIR=""
if [ -n "${BASH_SOURCE:-}" ] && [ -f "${BASH_SOURCE[0]:-}" ]; then
  here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  [ -f "$here/plugin.yaml" ] && [ -f "$here/remote.py" ] && SRC_DIR="$here"
fi
TMP=""
cleanup() { [ -n "$TMP" ] && rm -rf "$TMP"; return 0; }
trap cleanup EXIT
if [ -z "$SRC_DIR" ]; then
  TMP="$(mktemp -d)"
  curl -fsSL "$RAW_ROOT/MANIFEST.sha256" -o "$TMP/MANIFEST.sha256"
  for f in "${FILES[@]}"; do
    mkdir -p "$(dirname "$TMP/src/$f")"
    curl -fsSL "$RAW_ROOT/$PLUGIN/$f" -o "$TMP/src/$f"
    expected=$(awk -v p="$PLUGIN/$f" '$2 == p { print $1; found=1; exit } END { if (!found) exit 1 }' "$TMP/MANIFEST.sha256") || {
      echo "install.sh: $PLUGIN/$f is missing from MANIFEST.sha256" >&2; exit 1; }
    [ "$expected" = "$(file_sha256 "$TMP/src/$f")" ] || { echo "install.sh: sha256 mismatch for $PLUGIN/$f" >&2; exit 1; }
  done
  SRC_DIR="$TMP/src"
fi
for f in "${FILES[@]}"; do
  [ -f "$SRC_DIR/$f" ] || { echo "missing source file: $SRC_DIR/$f" >&2; exit 1; }
done
grep -q "register_computer_use_provider" "$SRC_DIR/__init__.py" || { echo "install.sh: source does not look like remote-cua" >&2; exit 1; }

# ---- version gate (before anything is copied) -----------------------------------------------
[ -x "$PY" ] || { echo "install.sh: Hermes Python not found at $PY (set HERMES_PYTHON); cannot check the Hermes version" >&2; exit 1; }
"$PY" -I - "$AGENT_DIR" "$SRC_DIR/compat.py" <<'PY' || exit 3
import importlib.util, sys
sys.path.insert(0, sys.argv[1])
spec = importlib.util.spec_from_file_location("remote_cua_install_compat", sys.argv[2])
compat = importlib.util.module_from_spec(spec)
spec.loader.exec_module(compat)
try:
    print("Hermes " + compat.check_version() + ": supported")
except compat.CompatError as exc:
    sys.stderr.write(f"install.sh: {exc}\nNothing was installed.\n")
    sys.exit(3)
PY
[ -n "$HERMES_CMD" ] && [ -x "$HERMES_CMD" ] || { echo "install.sh: the hermes command was not found (set HERMES_BIN)" >&2; exit 1; }

# ---- profiles ------------------------------------------------------------------------------
declare -a TARGETS=()
if [ "$ALL" = 1 ]; then
  TARGETS+=("default")
  if [ -d "$HERMES_HOME/profiles" ]; then
    for p in "$HERMES_HOME"/profiles/*/; do [ -d "$p" ] && TARGETS+=("$(basename "$p")"); done
  fi
else
  IFS=',' read -r -a WANT <<< "$PROFILES_ARG"
  for p in "${WANT[@]}"; do
    p="$(printf '%s' "$p" | tr -d '[:space:]')"
    [ -n "$p" ] || continue
    case "$p" in
      default) ;;
      *[!A-Za-z0-9._-]*|.|..) echo "install.sh: bad profile name '$p'" >&2; exit 2 ;;
      *) [ -d "$HERMES_HOME/profiles/$p" ] || { echo "install.sh: no profile '$p' under $HERMES_HOME/profiles" >&2; exit 1; } ;;
    esac
    TARGETS+=("$p")
  done
fi

for name in "${TARGETS[@]}"; do
  if [ "$name" = "default" ]; then home="$HERMES_HOME"; else home="$HERMES_HOME/profiles/$name"; fi
  dest="$home/plugins/$PLUGIN"
  say "profile $name -> $dest"
  changed=0
  for f in "${FILES[@]}"; do cmp -s "$SRC_DIR/$f" "$dest/$f" 2>/dev/null || changed=1; done
  if [ "$changed" = 0 ]; then
    say "  files already up to date"
  else
    if [ -d "$dest" ] && [ ! -L "$dest" ]; then
      # Outside plugins/: a backup under plugins/ would be discovered as a second plugin.
      backup="$home/plugin-backups/$PLUGIN.bak.$(date +%Y%m%d%H%M%S)"
      run mkdir -p "$home/plugin-backups"
      run cp -R "$dest" "$backup"
    fi
    for f in "${FILES[@]}"; do
      run mkdir -p "$(dirname "$dest/$f")"
      run cp "$SRC_DIR/$f" "$dest/$f.tmp.$$"
      run mv -f "$dest/$f.tmp.$$" "$dest/$f"
    done
    say "  files installed"
  fi
  if [ "$DRY_RUN" = 1 ]; then
    say "  [dry-run] would run: HERMES_HOME=$home hermes plugins enable $PLUGIN"
    continue
  fi
  # Hermes's public command: locked, admission-checked write of plugins.enabled (no restart).
  (cd "$home" && HERMES_HOME="$home" "$HERMES_CMD" plugins enable "$PLUGIN") >/dev/null
  say "  enabled in plugins.enabled"
done

cat <<'EOF'

Next, per bot profile (not done by this script), in its config.yaml:

  computer_use:
    backend: remote-cua
  remote_cua:
    host: <the Mac's address>
    user: <its login user>
    os: macos

Then restart that profile's gateway (or Hermes Desktop) and run:  hermes -p <profile> remote-cua check
Mac setup (Remote Login, pinned driver, one-time permissions grant): remote-cua/README.md
EOF
