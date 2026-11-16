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

# Plans the config.yaml change. Prints one word:
#   no           config.yaml does not name orgo-computer
#   yes          it is in a plugins.enabled list this script can edit safely
#   unsupported  it is named some other way (a list over several lines, a
#                {flow mapping}, an anchor, ...): nothing is changed for that
#                profile, and the script says what to edit by hand
# With "write", also replaces the file atomically with the edited copy. The
# edit only removes the one list item; the result is re-checked (and parsed
# with PyYAML or Ruby when either is installed) before it replaces anything.
config_edit() {
  "${PY}" - "$1" "$2" <<'PY'
import os
import re
import shutil
import subprocess
import sys
import tempfile

path, mode = sys.argv[1], sys.argv[2]
NAME = "orgo-computer"
try:
    with open(path, "r", encoding="utf-8") as handle:
        text = handle.read()
except OSError:
    print("no")
    sys.exit(0)
lines = text.split("\n")


def code(line):
    """The line without a trailing comment (good enough for plain scalars)."""
    out, quote = [], None
    for i, ch in enumerate(line):
        if quote:
            if ch == quote:
                quote = None
        elif ch in "'\"":
            quote = ch
        elif ch == "#" and (i == 0 or line[i - 1] in " \t"):
            break
        out.append(ch)
    return "".join(out).rstrip()


def mentions(line):
    return re.search(r"(?<![A-Za-z0-9_-])orgo-computer(?![A-Za-z0-9_-])", code(line)) is not None


def indent(line):
    return len(line) - len(line.lstrip(" "))


def scalar(value):
    value = value.strip()
    if len(value) >= 2 and value[0] == value[-1] and value[0] in "'\"":
        return value[1:-1]
    return value


SIMPLE = re.compile(r"""^(?:[A-Za-z0-9_.\-]+|'[^']*'|"[^"]*")$""")

if not any(mentions(line) for line in lines):
    print("no")
    sys.exit(0)

out = list(lines)
edited = False
plugins_at = next((i for i, l in enumerate(lines) if re.match(r"^plugins\s*:\s*$", code(l))), None)
if plugins_at is not None:
    i = plugins_at + 1
    while i < len(lines):
        line, body = lines[i], code(lines[i])
        if not body.strip():  # blank or comment-only, at any indent
            i += 1
            continue
        if indent(line) == 0:
            break
        match = re.match(r"^(\s+)enabled\s*:\s*(.*)$", body)
        if not match:
            i += 1
            continue
        lead, rest = match.group(1), match.group(2).strip()
        if rest.startswith("["):
            if not rest.endswith("]") or rest.count("[") != 1 or rest.count("]") != 1:
                break  # a list over several lines, or nested: unsupported
            items = [item.strip() for item in rest[1:-1].split(",") if item.strip()]
            if not all(SIMPLE.match(item) for item in items):
                break
            keep = [item for item in items if scalar(item) != NAME]
            if len(keep) != len(items):
                comment = lines[i][len(body):]
                out[i] = "%senabled: [%s]%s" % (lead, ", ".join(keep), comment)
                edited = True
        elif rest == "":
            j, drop, others = i + 1, [], 0
            while j < len(lines):
                item, item_body = lines[j], code(lines[j])
                if not item_body.strip():
                    j += 1
                    continue
                if indent(item) < len(lead) or (indent(item) == len(lead) and not item_body.lstrip().startswith("-")):
                    break
                bullet = re.match(r"^\s*-\s+(.*)$", item_body)
                if not bullet or indent(item) < len(lead) or not SIMPLE.match(bullet.group(1).strip()):
                    drop = None  # nested or unusual items: unsupported
                    break
                if scalar(bullet.group(1)) == NAME:
                    drop.append(j)
                else:
                    others += 1
                j += 1
            if drop:
                for k in drop:
                    out[k] = None
                if not others:
                    out[i] = "%senabled: []%s" % (lead, lines[i][len(body):])
                edited = True
        break

new_lines = [line for line in out if line is not None]
if not edited or any(mentions(line) for line in new_lines):
    print("unsupported")
    sys.exit(0)
new_text = "\n".join(new_lines)


def parsed(source):
    """(ok, data) from PyYAML or Ruby; (None, None) when neither is installed."""
    try:
        import yaml  # noqa: PLC0415
    except ImportError:
        yaml = None
    if yaml is not None:
        try:
            return True, yaml.safe_load(source)
        except Exception:
            return False, None
    ruby = shutil.which("ruby")
    if ruby:
        script = "require 'yaml'; require 'json'; print JSON.generate(YAML.safe_load(STDIN.read, aliases: false))"
        result = subprocess.run([ruby, "-e", script], input=source, capture_output=True, text=True)
        if result.returncode != 0:
            return False, None
        import json  # noqa: PLC0415
        return True, json.loads(result.stdout or "null")
    return None, None


ok_old, old_data = parsed(text)
ok_new, new_data = parsed(new_text)
if ok_new is False:
    print("unsupported")
    sys.exit(0)
if ok_old and ok_new:
    expected = old_data
    try:
        plugins = dict(expected["plugins"])
        plugins["enabled"] = [x for x in (plugins.get("enabled") or []) if x != NAME]
        expected = dict(expected)
        expected["plugins"] = plugins
    except Exception:
        print("unsupported")
        sys.exit(0)
    if expected != new_data:
        print("unsupported")
        sys.exit(0)

print("yes")
if mode == "write":
    fd, tmp = tempfile.mkstemp(prefix=".config-", suffix=".tmp", dir=os.path.dirname(path) or ".")
    with os.fdopen(fd, "w", encoding="utf-8") as handle:
        handle.write(new_text)
    os.chmod(tmp, os.stat(path).st_mode & 0o777)
    os.replace(tmp, path)
PY
}

STAMP=$(date +%Y%m%d-%H%M%S)
DAY=$(date +%Y%m%d)
touched=0

unsupported=0
while IFS="$(printf '\t')" read -r name home; do
  wanted "${name}" || continue
  plugin_dir="${home}/plugins/orgo-computer"
  config="${home}/config.yaml"
  has_dir=0
  plan=no
  [ -d "${plugin_dir}" ] && has_dir=1
  if [ -f "${config}" ]; then
    if [ -n "${PY}" ]; then
      plan=$(config_edit "${config}" check)
    elif grep -q 'orgo-computer' "${config}"; then
      plan=unsupported
    fi
  fi
  has_key=0
  if [ -f "${home}/.env" ] && grep -q '^ORGO_API_KEY=' "${home}/.env"; then
    has_key=1
  fi
  if [ "${has_dir}" -eq 0 ] && [ "${plan}" = "no" ] && [ "${has_key}" -eq 0 ]; then
    continue
  fi
  touched=1
  echo "${name}  (${home})"
  if [ "${plan}" = "unsupported" ]; then
    # Decide before touching anything: no half-done profile.
    unsupported=1
    echo "  SKIPPED: config.yaml names orgo-computer in a form this script will not rewrite"
    echo "  (for example a list spread over several lines, or plugins: {enabled: [...]})."
    echo "  By hand: remove orgo-computer from plugins.enabled in ${config},"
    echo "  then move ${plugin_dir} out of plugins/ (or re-run this script)."
    continue
  fi
  if [ "${plan}" = "yes" ]; then
    if [ "${YES}" -eq 1 ]; then
      cp -p "${config}" "${config}.bak.${STAMP}"
      result=$(config_edit "${config}" write)
      if [ "${result}" != "yes" ]; then
        unsupported=1
        echo "  SKIPPED: config.yaml changed while planning; nothing moved. Re-run the script."
        continue
      fi
      echo "  removed orgo-computer from plugins.enabled (backup: config.yaml.bak.${STAMP})"
    else
      echo "  would remove orgo-computer from plugins.enabled in config.yaml"
    fi
  fi
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
if [ "${unsupported}" -eq 1 ]; then
  echo "Some profiles were skipped (see SKIPPED above); finish those by hand."
  exit 3
fi
