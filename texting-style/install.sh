#!/usr/bin/env bash
# Install the texting-style agent plugin into one or more Hermes profiles.
# Each profile is its own HERMES_HOME (plugins/, config.yaml).
#
#   curl -fsSL https://raw.githubusercontent.com/thomasbek3/hermes-bot-kit/master/texting-style/install.sh | bash
#
# or from a clone:  bash texting-style/install.sh [--profiles a,b] [--yes]
#
# From a clone the plugin is symlinked (repo pulls update it). When curl-piped,
# the two plugin files are downloaded and copied instead. Re-runs idempotent.
set -euo pipefail

RAW_BASE="https://raw.githubusercontent.com/thomasbek3/hermes-bot-kit/master/texting-style"
HERMES_ROOT="${HERMES_ROOT:-${HOME}/.hermes}"
PLUGIN_NAME="texting-style"

usage() {
  cat <<'EOF'
Usage: install.sh [--all | --profiles LIST] [--yes]

Installs the texting-style plugin into Hermes profile homes:
  ~/.hermes                    (default profile)
  ~/.hermes/profiles/<name>/   (named profiles)

Options:
  --all             Install into every discovered profile (default with --yes)
  --profiles LIST   Comma-separated profile names
  --yes             No prompts (non-interactive)
EOF
}

ALL=1
YES=0
PROFILES_ARG=""
while [ $# -gt 0 ]; do
  case "$1" in
    --all) ALL=1; shift ;;
    --profiles) ALL=0; PROFILES_ARG="${2:-}"; shift 2 ;;
    --profiles=*) ALL=0; PROFILES_ARG="${1#--profiles=}"; shift ;;
    --yes|-y) YES=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "install.sh: unknown option: $1" >&2; usage >&2; exit 2 ;;
  esac
done

SCRIPT_DIR=""
if [ -n "${BASH_SOURCE:-}" ] && [ -f "${BASH_SOURCE[0]:-}" ]; then
  SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
fi

# Source: local clone (symlink) or downloaded copy (curl-pipe).
MODE="copy"
SRC_DIR=""
if [ -n "${SCRIPT_DIR}" ] && [ -f "${SCRIPT_DIR}/plugin.yaml" ] && [ -f "${SCRIPT_DIR}/__init__.py" ]; then
  MODE="symlink"
  SRC_DIR="${SCRIPT_DIR}"
else
  SRC_DIR=$(mktemp -d)
  trap 'rm -rf "${SRC_DIR}"' EXIT
  curl -fsSL "${RAW_BASE}/plugin.yaml" -o "${SRC_DIR}/plugin.yaml"
  curl -fsSL "${RAW_BASE}/__init__.py" -o "${SRC_DIR}/__init__.py"
fi
grep -q "texting-style.sms-register" "${SRC_DIR}/__init__.py" || {
  echo "install.sh: plugin source does not look like texting-style; aborting" >&2
  exit 1
}

# Discover profiles: name<TAB>home
DISCOVERED=$(mktemp)
trap 'rm -f "${DISCOVERED}"; [ "${MODE}" = "copy" ] && rm -rf "${SRC_DIR}" || true' EXIT
if [ -d "${HERMES_ROOT}" ]; then
  printf 'default\t%s\n' "${HERMES_ROOT}" >> "${DISCOVERED}"
fi
if [ -d "${HERMES_ROOT}/profiles" ]; then
  for dir in "${HERMES_ROOT}/profiles"/*; do
    [ -d "${dir}" ] || continue
    name=$(basename -- "${dir}")
    case "${name}" in .*|"") continue ;; esac
    printf '%s\t%s\n' "${name}" "${dir}" >> "${DISCOVERED}"
  done
fi
[ -s "${DISCOVERED}" ] || { echo "install.sh: no Hermes home at ${HERMES_ROOT}" >&2; exit 1; }

SELECTED=$(mktemp)
trap 'rm -f "${DISCOVERED}" "${SELECTED}"; [ "${MODE}" = "copy" ] && rm -rf "${SRC_DIR}" || true' EXIT
if [ -n "${PROFILES_ARG}" ]; then
  OLDIFS=${IFS}; IFS=,
  # shellcheck disable=SC2086
  set -- ${PROFILES_ARG}
  IFS=${OLDIFS}
  for want in "$@"; do
    want=$(printf '%s' "${want}" | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')
    [ -n "${want}" ] || continue
    found=0
    while IFS="$(printf '\t')" read -r name home; do
      if [ "${name}" = "${want}" ]; then
        printf '%s\t%s\n' "${name}" "${home}" >> "${SELECTED}"
        found=1; break
      fi
    done < "${DISCOVERED}"
    [ "${found}" -eq 1 ] || { echo "install.sh: unknown profile: ${want}" >&2; exit 1; }
  done
elif [ "${YES}" -eq 1 ] || [ ! -t 0 ]; then
  cat "${DISCOVERED}" > "${SELECTED}"
else
  echo "Discovered Hermes profiles:"
  while IFS="$(printf '\t')" read -r name home; do echo "  - ${name}"; done < "${DISCOVERED}"
  printf 'Install into which profiles? [all]: '
  read -r reply || reply=""
  reply=$(printf '%s' "${reply}" | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')
  if [ -z "${reply}" ] || [ "${reply}" = "all" ]; then
    cat "${DISCOVERED}" > "${SELECTED}"
  else
    OLDIFS=${IFS}; IFS=,
    # shellcheck disable=SC2086
    set -- ${reply}
    IFS=${OLDIFS}
    for want in "$@"; do
      want=$(printf '%s' "${want}" | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')
      [ -n "${want}" ] || continue
      found=0
      while IFS="$(printf '\t')" read -r name home; do
        if [ "${name}" = "${want}" ]; then
          printf '%s\t%s\n' "${name}" "${home}" >> "${SELECTED}"
          found=1; break
        fi
      done < "${DISCOVERED}"
      [ "${found}" -eq 1 ] || { echo "install.sh: unknown profile: ${want}" >&2; exit 1; }
    done
  fi
fi
[ -s "${SELECTED}" ] || { echo "install.sh: no profiles selected" >&2; exit 1; }

find_hermes_python() {
  if [ -n "${HERMES_PYTHON:-}" ] && [ -x "${HERMES_PYTHON}" ]; then
    printf '%s\n' "${HERMES_PYTHON}"; return 0
  fi
  if [ -x "${HOME}/.hermes/hermes-agent/venv/bin/python" ]; then
    printf '%s\n' "${HOME}/.hermes/hermes-agent/venv/bin/python"; return 0
  fi
  command -v python3 || echo python3
}
HERMES_PY=$(find_hermes_python)

enable_plugin() {
  home=$1
  config="${home}/config.yaml"
  "${HERMES_PY}" - "${config}" <<'PY'
import os, sys, tempfile
from pathlib import Path

path = Path(sys.argv[1])
try:
    import yaml
except ImportError:
    sys.stderr.write(
        "install.sh: PyYAML is required to update config.yaml.\n"
        "Use the Hermes venv python (set HERMES_PYTHON).\n"
    )
    sys.exit(1)

data = {}
if path.exists():
    loaded = yaml.safe_load(path.read_text(encoding="utf-8"))
    if isinstance(loaded, dict):
        data = loaded

plugins = data.get("plugins")
if not isinstance(plugins, dict):
    plugins = {}
    data["plugins"] = plugins
enabled = plugins.get("enabled")
if not isinstance(enabled, list):
    enabled = []
if "texting-style" not in enabled:
    enabled.append("texting-style")
plugins["enabled"] = enabled

text = yaml.safe_dump(data, default_flow_style=False, sort_keys=False)
path.parent.mkdir(parents=True, exist_ok=True)
fd, tmp = tempfile.mkstemp(prefix=".texting-style-", suffix=".tmp", dir=str(path.parent))
try:
    with os.fdopen(fd, "w", encoding="utf-8") as handle:
        handle.write(text)
        if not text.endswith("\n"):
            handle.write("\n")
        handle.flush()
        os.fsync(handle.fileno())
    os.replace(tmp, path)
except Exception:
    try:
        os.unlink(tmp)
    except OSError:
        pass
    raise
PY
}

echo "Installing ${PLUGIN_NAME} (${MODE}) into:"
while IFS="$(printf '\t')" read -r name home; do
  echo "  - ${name}"
  plugins_dir="${home}/plugins"
  dest="${plugins_dir}/${PLUGIN_NAME}"
  mkdir -p "${plugins_dir}"
  if [ "${MODE}" = "symlink" ]; then
    if [ -e "${dest}" ] && [ ! -L "${dest}" ]; then
      echo "    skip symlink: ${dest} exists and is not a symlink" >&2
    else
      ln -sfn "${SRC_DIR}" "${dest}"
      echo "    symlink ${dest} -> ${SRC_DIR}"
    fi
  else
    if [ -L "${dest}" ]; then
      echo "    skip copy: ${dest} is a symlink (clone-managed)" >&2
    else
      mkdir -p "${dest}"
      cp "${SRC_DIR}/plugin.yaml" "${SRC_DIR}/__init__.py" "${dest}/"
      echo "    copied plugin files to ${dest}"
    fi
  fi
  enable_plugin "${home}"
  echo "    enabled ${PLUGIN_NAME} in ${home}/config.yaml"
done < "${SELECTED}"

echo
echo "Done. Applies to NEW sessions (prompt sections are frozen per session):"
echo "  /new in a chat, or restart the gateway."
echo "Scope to certain platforms via plugin config 'platforms' (e.g. 'desktop')."
