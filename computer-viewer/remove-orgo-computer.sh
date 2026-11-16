#!/usr/bin/env bash
# Remove the retired orgo-computer agent plugin from Hermes profiles.
#
# The kit no longer ships it: bots drive machines with Hermes's own
# computer_use tool (see remote-cua/ for Mac machines over SSH). This script
# undoes what the old install-agent-plugin.sh did, per profile:
#   - moves <home>/plugins/orgo-computer to <home>/plugins-retired-<date>/
#     (nothing is deleted),
#   - drops orgo-computer from plugins.enabled in <home>/config.yaml (the old
#     file is kept as config.yaml.bak.<timestamp>; comments and layout of the
#     rest of the file are untouched).
# It never touches .env: an ORGO_API_KEY line there is reported, not removed.
#
# Without --yes it only prints what it would do.
set -euo pipefail

usage() {
  cat <<'EOF'
Usage: remove-orgo-computer.sh [--profiles a,b] [--yes]

Finds the retired orgo-computer agent plugin in the Hermes home
(HERMES_HOME, default ~/.hermes) and every profile under its profiles/,
and removes it.

  --profiles a,b   only these profiles ("default" is ~/.hermes itself)
  --yes, -y        make the changes (default: dry run, print only)
  -h, --help       this text
EOF
}

HERMES_ROOT="${HERMES_HOME:-${HOME}/.hermes}"
YES=0
PROFILES_ARG=""

while [ $# -gt 0 ]; do
  case "$1" in
    --profiles)
      PROFILES_ARG="${2:-}"
      if [ -z "${PROFILES_ARG}" ]; then
        echo "remove-orgo-computer.sh: --profiles requires a comma-separated list" >&2
        exit 2
      fi
      shift 2
      ;;
    --profiles=*)
      PROFILES_ARG="${1#--profiles=}"
      shift
      ;;
    --yes|-y)
      YES=1
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "remove-orgo-computer.sh: unknown option: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

if [ ! -d "${HERMES_ROOT}" ]; then
  echo "No Hermes home at ${HERMES_ROOT}; nothing to remove."
  exit 0
fi

# name<TAB>home
HOMES_FILE=$(mktemp)
trap 'rm -f "${HOMES_FILE}"' EXIT
printf 'default\t%s\n' "${HERMES_ROOT}" >> "${HOMES_FILE}"
if [ -d "${HERMES_ROOT}/profiles" ]; then
  for dir in "${HERMES_ROOT}/profiles"/*; do
    [ -d "${dir}" ] || continue
    name=$(basename -- "${dir}")
    case "${name}" in
      .*|"") continue ;;
    esac
    printf '%s\t%s\n' "${name}" "${dir}" >> "${HOMES_FILE}"
  done
fi

wanted() {
  [ -z "${PROFILES_ARG}" ] && return 0
  case ",${PROFILES_ARG// /}," in
    *",$1,"*) return 0 ;;
  esac
  return 1
}

if [ -n "${PROFILES_ARG}" ]; then
  OLDIFS=${IFS}
  IFS=,
  # shellcheck disable=SC2086
  set -- ${PROFILES_ARG// /}
  IFS=${OLDIFS}
  for want in "$@"; do
    [ -n "${want}" ] || continue
    if ! cut -f1 "${HOMES_FILE}" | grep -qx -- "${want}"; then
      echo "remove-orgo-computer.sh: unknown profile: ${want}" >&2
      exit 1
    fi
  done
fi

PY=$(command -v python3 || true)

# Prints "yes" when config.yaml lists orgo-computer under plugins.enabled.
# With a second argument "write", also removes it (atomic replace).
config_edit() {
  "${PY}" - "$1" "$2" <<'PY'
import os
import re
import sys
import tempfile

path, mode = sys.argv[1], sys.argv[2]
NAME = "orgo-computer"
try:
    with open(path, "r", encoding="utf-8") as handle:
        lines = handle.read().split("\n")
except OSError:
    print("no")
    sys.exit(0)


def indent(line):
    return len(line) - len(line.lstrip(" "))


def unquote(value):
    value = value.split(" #", 1)[0].strip()
    if len(value) >= 2 and value[0] == value[-1] and value[0] in "'\"":
        value = value[1:-1]
    return value


found = False
out = list(lines)
plugins_at = next(
    (i for i, line in enumerate(lines) if re.match(r"^plugins\s*:\s*(#.*)?$", line)), None
)
if plugins_at is not None:
    i = plugins_at + 1
    while i < len(lines):
        line = lines[i]
        if line.strip() and indent(line) == 0:
            break
        match = re.match(r"^(\s+)enabled\s*:\s*(.*)$", line)
        if match:
            key_indent, rest = len(match.group(1)), match.group(2).strip()
            if rest.startswith("["):
                inner = rest[1 : rest.rfind("]")] if "]" in rest else rest[1:]
                items = [unquote(item) for item in inner.split(",") if item.strip()]
                if NAME in items:
                    found = True
                    keep = [item for item in items if item != NAME]
                    out[i] = "%senabled: [%s]" % (match.group(1), ", ".join(keep))
            else:
                j = i + 1
                drop = []
                while j < len(lines):
                    item = lines[j]
                    if not item.strip():
                        j += 1
                        continue
                    if indent(item) < key_indent or (
                        indent(item) == key_indent and not item.lstrip().startswith("-")
                    ):
                        break
                    bullet = re.match(r"^\s*-\s*(.*)$", item)
                    if bullet and unquote(bullet.group(1)) == NAME:
                        drop.append(j)
                    j += 1
                if drop:
                    found = True
                    remaining = [
                        k for k in range(i + 1, j) if k not in drop and re.match(r"^\s*-", lines[k])
                    ]
                    for k in reversed(drop):
                        out[k] = None
                    if not remaining:
                        out[i] = "%senabled: []" % match.group(1)
            break
        i += 1

print("yes" if found else "no")
if found and mode == "write":
    text = "\n".join(line for line in out if line is not None)
    fd, tmp = tempfile.mkstemp(prefix=".config-", suffix=".tmp", dir=os.path.dirname(path) or ".")
    with os.fdopen(fd, "w", encoding="utf-8") as handle:
        handle.write(text)
    os.chmod(tmp, os.stat(path).st_mode & 0o777)
    os.replace(tmp, path)
PY
}

STAMP=$(date +%Y%m%d-%H%M%S)
DAY=$(date +%Y%m%d)
touched=0

while IFS="$(printf '\t')" read -r name home; do
  wanted "${name}" || continue
  plugin_dir="${home}/plugins/orgo-computer"
  config="${home}/config.yaml"
  has_dir=0
  has_cfg=no
  [ -d "${plugin_dir}" ] && has_dir=1
  if [ -f "${config}" ] && [ -n "${PY}" ]; then
    has_cfg=$(config_edit "${config}" check)
  fi
  has_key=0
  if [ -f "${home}/.env" ] && grep -q '^ORGO_API_KEY=' "${home}/.env"; then
    has_key=1
  fi
  if [ "${has_dir}" -eq 0 ] && [ "${has_cfg}" != "yes" ] && [ "${has_key}" -eq 0 ]; then
    continue
  fi
  touched=1
  echo "${name}  (${home})"
  if [ "${has_dir}" -eq 1 ]; then
    dest_root="${home}/plugins-retired-${DAY}"
    dest="${dest_root}/orgo-computer"
    [ -e "${dest}" ] && dest="${dest}.${STAMP}"
    if [ "${YES}" -eq 1 ]; then
      mkdir -p "${dest_root}"
      mv "${plugin_dir}" "${dest}"
      echo "  moved plugins/orgo-computer -> ${dest}"
    else
      echo "  would move plugins/orgo-computer -> ${dest}"
    fi
  fi
  if [ "${has_cfg}" = "yes" ]; then
    if [ "${YES}" -eq 1 ]; then
      cp -p "${config}" "${config}.bak.${STAMP}"
      config_edit "${config}" write >/dev/null
      echo "  removed orgo-computer from plugins.enabled (backup: config.yaml.bak.${STAMP})"
    else
      echo "  would remove orgo-computer from plugins.enabled in config.yaml"
    fi
  elif [ -f "${config}" ] && [ -z "${PY}" ]; then
    echo "  python3 not found: remove orgo-computer from plugins.enabled in ${config} by hand"
  fi
  if [ "${has_key}" -eq 1 ]; then
    echo "  note: ${home}/.env still has ORGO_API_KEY (left alone; delete the line if you no longer use it)"
  fi
done < "${HOMES_FILE}"

if [ "${touched}" -eq 0 ]; then
  echo "orgo-computer is not installed in any selected profile. Nothing to do."
  exit 0
fi
if [ "${YES}" -ne 1 ]; then
  echo
  echo "Dry run. Re-run with --yes to make these changes."
else
  echo
  echo "Done. Restart the gateway (or reload plugins) so the bots drop the old tools."
fi
