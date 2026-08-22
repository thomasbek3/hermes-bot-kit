#!/usr/bin/env bash
# Install the orgo-computer agent plugin into one or more Hermes profiles.
# Each profile is its own HERMES_HOME (plugins/, .env, config.yaml).
set -euo pipefail

usage() {
  cat <<'EOF'
Usage: install-agent-plugin.sh [options]

Install agent-plugin/orgo-computer into Hermes profile homes:
  ~/.hermes                    (default profile)
  ~/.hermes/profiles/<name>/   (named profiles)

Options:
  --all                 Install into every discovered profile (default)
  --profiles LIST       Comma-separated profile names (default, ava, ...)
  --yes                 Do not prompt for profile selection
  --api-key KEY         Write this ORGO_API_KEY into selected profiles that
                        lack a key. Never printed. If omitted, you are
                        prompted once (empty + --yes writes ORGO_API_KEY=).
  -h, --help            Show this help

Re-runs are idempotent: existing symlinks, enabled entries, and non-empty
ORGO_API_KEY values are left in place.
EOF
}

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
PLUGIN_SRC="${SCRIPT_DIR}/agent-plugin/orgo-computer"
HERMES_ROOT="${HOME}/.hermes"

ALL=1
ALL_FLAG=0
YES=0
PROFILES_ARG=""
API_KEY_ARG=""

while [ $# -gt 0 ]; do
  case "$1" in
    --all)
      ALL=1
      ALL_FLAG=1
      shift
      ;;
    --profiles)
      ALL=0
      PROFILES_ARG="${2:-}"
      if [ -z "${PROFILES_ARG}" ]; then
        echo "install-agent-plugin.sh: --profiles requires a comma-separated list" >&2
        exit 2
      fi
      shift 2
      ;;
    --profiles=*)
      ALL=0
      PROFILES_ARG="${1#--profiles=}"
      shift
      ;;
    --yes|-y)
      YES=1
      shift
      ;;
    --api-key)
      API_KEY_ARG="${2:-}"
      if [ -z "${API_KEY_ARG}" ]; then
        echo "install-agent-plugin.sh: --api-key requires a value" >&2
        exit 2
      fi
      shift 2
      ;;
    --api-key=*)
      API_KEY_ARG="${1#--api-key=}"
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "install-agent-plugin.sh: unknown option: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

if [ ! -f "${PLUGIN_SRC}/plugin.yaml" ] || [ ! -f "${PLUGIN_SRC}/__init__.py" ]; then
  echo "install-agent-plugin.sh: plugin source not found at ${PLUGIN_SRC}" >&2
  exit 1
fi

# name<TAB>home
DISCOVERED_FILE=$(mktemp)
trap 'rm -f "${DISCOVERED_FILE}"' EXIT

if [ -d "${HERMES_ROOT}" ]; then
  printf 'default\t%s\n' "${HERMES_ROOT}" >> "${DISCOVERED_FILE}"
fi
if [ -d "${HERMES_ROOT}/profiles" ]; then
  for dir in "${HERMES_ROOT}/profiles"/*; do
    [ -d "${dir}" ] || continue
    name=$(basename -- "${dir}")
    case "${name}" in
      .*|"") continue ;;
    esac
    printf '%s\t%s\n' "${name}" "${dir}" >> "${DISCOVERED_FILE}"
  done
fi

if [ ! -s "${DISCOVERED_FILE}" ]; then
  echo "install-agent-plugin.sh: no Hermes home at ${HERMES_ROOT}" >&2
  echo "Install Hermes first, then re-run." >&2
  exit 1
fi

echo "Discovered Hermes profiles:"
while IFS="$(printf '\t')" read -r name home; do
  echo "  - ${name}  (${home})"
done < "${DISCOVERED_FILE}"

SELECTED_FILE=$(mktemp)
trap 'rm -f "${DISCOVERED_FILE}" "${SELECTED_FILE}"' EXIT

select_all() {
  cat "${DISCOVERED_FILE}" > "${SELECTED_FILE}"
}

if [ -n "${PROFILES_ARG}" ]; then
  ALL=0
  : > "${SELECTED_FILE}"
  OLDIFS=${IFS}
  IFS=,
  # shellcheck disable=SC2086
  set -- ${PROFILES_ARG}
  IFS=${OLDIFS}
  for want in "$@"; do
    want=$(printf '%s' "${want}" | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')
    [ -n "${want}" ] || continue
    found=0
    while IFS="$(printf '\t')" read -r name home; do
      if [ "${name}" = "${want}" ]; then
        printf '%s\t%s\n' "${name}" "${home}" >> "${SELECTED_FILE}"
        found=1
        break
      fi
    done < "${DISCOVERED_FILE}"
    if [ "${found}" -eq 0 ]; then
      echo "install-agent-plugin.sh: unknown profile: ${want}" >&2
      exit 1
    fi
  done
  if [ ! -s "${SELECTED_FILE}" ]; then
    echo "install-agent-plugin.sh: no profiles selected" >&2
    exit 1
  fi
elif [ "${YES}" -eq 1 ] || [ "${ALL_FLAG}" -eq 1 ] || [ ! -t 0 ]; then
  select_all
elif [ "${ALL}" -eq 1 ]; then
  if [ ! -t 0 ]; then
    select_all
  else
    printf 'Install into which profiles? [all]: '
    read -r reply || reply=""
    reply=$(printf '%s' "${reply}" | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')
    if [ -z "${reply}" ] || [ "${reply}" = "all" ]; then
      select_all
    else
      : > "${SELECTED_FILE}"
      OLDIFS=${IFS}
      IFS=,
      # shellcheck disable=SC2086
      set -- ${reply}
      IFS=${OLDIFS}
      for want in "$@"; do
        want=$(printf '%s' "${want}" | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')
        [ -n "${want}" ] || continue
        found=0
        while IFS="$(printf '\t')" read -r name home; do
          if [ "${name}" = "${want}" ]; then
            printf '%s\t%s\n' "${name}" "${home}" >> "${SELECTED_FILE}"
            found=1
            break
          fi
        done < "${DISCOVERED_FILE}"
        if [ "${found}" -eq 0 ]; then
          echo "install-agent-plugin.sh: unknown profile: ${want}" >&2
          exit 1
        fi
      done
    fi
  fi
else
  select_all
fi

find_hermes_python() {
  if [ -n "${HERMES_PYTHON:-}" ] && [ -x "${HERMES_PYTHON}" ]; then
    printf '%s\n' "${HERMES_PYTHON}"
    return 0
  fi
  if [ -x "${HOME}/.hermes/hermes-agent/venv/bin/python" ]; then
    printf '%s\n' "${HOME}/.hermes/hermes-agent/venv/bin/python"
    return 0
  fi
  if command -v hermes >/dev/null 2>&1; then
    hermes_bin=$(command -v hermes)
    if [ -x "${hermes_bin}" ]; then
      hermes_dir=$(CDPATH= cd -- "$(dirname -- "${hermes_bin}")" && pwd)
      if [ -x "${hermes_dir}/python" ]; then
        printf '%s\n' "${hermes_dir}/python"
        return 0
      fi
    fi
  fi
  if command -v python3 >/dev/null 2>&1; then
    command -v python3
    return 0
  fi
  echo "python3"
}

HERMES_PY=$(find_hermes_python)

enable_plugin() {
  home=$1
  config="${home}/config.yaml"
  "${HERMES_PY}" - "${config}" <<'PY'
import os
import sys
import tempfile
from pathlib import Path

path = Path(sys.argv[1])
try:
    import yaml
except ImportError:
    sys.stderr.write(
        "install-agent-plugin.sh: PyYAML is required to update config.yaml.\n"
        "Use the Hermes venv python (set HERMES_PYTHON).\n"
    )
    sys.exit(1)

data = {}
if path.exists():
    with path.open("r", encoding="utf-8") as handle:
        loaded = yaml.safe_load(handle)
    if isinstance(loaded, dict):
        data = loaded

plugins = data.get("plugins")
if not isinstance(plugins, dict):
    plugins = {}
    data["plugins"] = plugins
enabled = plugins.get("enabled")
if not isinstance(enabled, list):
    enabled = []
if "orgo-computer" not in enabled:
    enabled.append("orgo-computer")
plugins["enabled"] = enabled

text = yaml.safe_dump(data, default_flow_style=False, sort_keys=False)
path.parent.mkdir(parents=True, exist_ok=True)
fd, tmp = tempfile.mkstemp(
    prefix=".orgo-computer-", suffix=".tmp", dir=str(path.parent)
)
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

env_key_is_set() {
  envfile=$1
  [ -f "${envfile}" ] || return 1
  "${HERMES_PY}" - "${envfile}" <<'PY'
import sys
from pathlib import Path
path = Path(sys.argv[1])
for line in path.read_text(encoding="utf-8").splitlines():
    if line.startswith("ORGO_API_KEY="):
        value = line.split("=", 1)[1].strip().strip("'").strip('"')
        sys.exit(0 if value else 1)
sys.exit(1)
PY
}

write_env_key() {
  envfile=$1
  ORGO_KEY_VALUE=$2 "${HERMES_PY}" - "${envfile}" <<'PY'
import os
import sys
from pathlib import Path

path = Path(sys.argv[1])
value = os.environ.get("ORGO_KEY_VALUE", "")
lines = []
if path.exists():
    lines = path.read_text(encoding="utf-8").splitlines()
found = False
out = []
for line in lines:
    if line.startswith("ORGO_API_KEY="):
        found = True
        current = line.split("=", 1)[1] if "=" in line else ""
        stripped = current.strip().strip("'").strip('"')
        if stripped:
            out.append(line)
        else:
            out.append("ORGO_API_KEY=" + value)
    else:
        out.append(line)
if not found:
    if out and out[-1] != "":
        out.append("")
    out.append("ORGO_API_KEY=" + value)
path.write_text("\n".join(out) + "\n", encoding="utf-8")
try:
    os.chmod(path, 0o600)
except OSError:
    pass
PY
}

needs_key=0
while IFS="$(printf '\t')" read -r name home; do
  if ! env_key_is_set "${home}/.env"; then
    needs_key=1
    break
  fi
done < "${SELECTED_FILE}"

KEY_TO_WRITE=""
if [ "${needs_key}" -eq 1 ]; then
  if [ -n "${API_KEY_ARG}" ]; then
    KEY_TO_WRITE=${API_KEY_ARG}
  elif [ -n "${ORGO_API_KEY:-}" ]; then
    KEY_TO_WRITE=${ORGO_API_KEY}
  elif [ "${YES}" -eq 1 ] || [ ! -t 0 ]; then
    KEY_TO_WRITE=""
    echo "No ORGO_API_KEY provided; writing empty ORGO_API_KEY= to profiles that lack one."
  else
    printf 'ORGO_API_KEY for selected profiles (input hidden): '
    # shellcheck disable=SC2162
    read -r -s KEY_TO_WRITE || KEY_TO_WRITE=""
    printf '\n'
  fi
fi

echo "Installing orgo-computer into:"
while IFS="$(printf '\t')" read -r name home; do
  echo "  - ${name}"
  plugins_dir="${home}/plugins"
  dest="${plugins_dir}/orgo-computer"
  mkdir -p "${plugins_dir}"
  if [ -e "${dest}" ] && [ ! -L "${dest}" ]; then
    echo "    skip symlink: ${dest} exists and is not a symlink" >&2
  else
    ln -sfn "${PLUGIN_SRC}" "${dest}"
    echo "    symlink ${dest} -> ${PLUGIN_SRC}"
  fi
  enable_plugin "${home}"
  echo "    enabled orgo-computer in ${home}/config.yaml"
  envfile="${home}/.env"
  if env_key_is_set "${envfile}"; then
    echo "    ORGO_API_KEY already set in ${envfile}"
  else
    write_env_key "${envfile}" "${KEY_TO_WRITE}"
    if [ -n "${KEY_TO_WRITE}" ]; then
      echo "    wrote ORGO_API_KEY to ${envfile}"
    else
      echo "    ensured ORGO_API_KEY= in ${envfile} (empty -- fill this in)"
    fi
  fi
done < "${SELECTED_FILE}"

echo
if "${HERMES_PY}" -c "import httpx" >/dev/null 2>&1; then
  echo "httpx is available in ${HERMES_PY}."
else
  echo "httpx is not installed in ${HERMES_PY}."
  echo "Hermes does not auto-install plugin dependencies. Run:"
  echo "  pip install 'httpx>=0.27,<1'"
  echo "against the Hermes venv (for example:"
  echo "  ${HERMES_PY} -m pip install 'httpx>=0.27,<1'"
  echo ")."
fi

echo
echo "Next steps:"
echo "  1. Rotate the Orgo API key exposed in chat on 2026-08-22 if you have not already."
echo "  2. Restart Hermes (CLI, gateway, desktop)."
echo "  3. In each bot run /computer and pin that bot's machine."
echo "  4. In the Computer viewer pane, pick the same machine as the per-bot endpoint."
echo
echo "CLI: hermes orgo-computer list"
echo "     hermes orgo-computer set <profile> <uuid>"
