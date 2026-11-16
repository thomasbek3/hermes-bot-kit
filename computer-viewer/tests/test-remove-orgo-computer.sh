#!/usr/bin/env bash
# remove-orgo-computer.sh against throwaway Hermes homes (never the real one).
set -euo pipefail

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
SCRIPT="${ROOT}/remove-orgo-computer.sh"
WORK=$(mktemp -d)
trap 'rm -rf "${WORK}"' EXIT

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

run() {
  env -u HERMES_HOME HOME="$1" PYTHONDONTWRITEBYTECODE=1 bash "${SCRIPT}" "${@:2}"
}

seed() {
  local home=$1
  local h="${home}/.hermes"
  mkdir -p "${h}/plugins/orgo-computer" "${h}/profiles/helper/plugins/orgo-computer" "${h}/profiles/plain"
  echo "name: orgo-computer" > "${h}/plugins/orgo-computer/plugin.yaml"
  echo "name: orgo-computer" > "${h}/profiles/helper/plugins/orgo-computer/plugin.yaml"
  cat > "${h}/config.yaml" <<'EOF'
# my config
model: some-model
plugins:
  enabled:
    - texting-style
    - orgo-computer   # added by the kit
  disabled: []
terminal:
  backend: local
EOF
  cat > "${h}/profiles/helper/config.yaml" <<'EOF'
plugins:
  enabled: [orgo-computer]
EOF
  echo "model: x" > "${h}/profiles/plain/config.yaml"
  printf 'OTHER=1\nORGO_API_KEY=abc\n' > "${h}/.env"
}

# 1. dry run changes nothing
home="${WORK}/dry"
seed "${home}"
tree_sum() { (cd "$1/.hermes" && find . -type f -print | LC_ALL=C sort | while IFS= read -r f; do printf '%s\n' "$f"; cat "$f"; done | shasum); }
before=$(tree_sum "${home}")
out=$(run "${home}")
after=$(tree_sum "${home}")
[ "${before}" = "${after}" ] || fail "dry run modified files"
echo "${out}" | grep -q "would move plugins/orgo-computer" || fail "dry run did not report the plugin dir"
echo "${out}" | grep -q "Re-run with --yes" || fail "dry run did not say how to apply"

# 2. --yes moves the dirs, edits config.yaml, keeps comments, leaves .env alone
home="${WORK}/yes"
seed "${home}"
out=$(run "${home}" --yes)
h="${home}/.hermes"
[ ! -e "${h}/plugins/orgo-computer" ] || fail "default plugin dir still in plugins/"
[ ! -e "${h}/profiles/helper/plugins/orgo-computer" ] || fail "helper plugin dir still in plugins/"
ls "${h}"/plugins-retired-*/orgo-computer/plugin.yaml >/dev/null 2>&1 || fail "default plugin not kept under plugins-retired-*"
ls "${h}"/profiles/helper/plugins-retired-*/orgo-computer/plugin.yaml >/dev/null 2>&1 || fail "helper plugin not kept"
grep -q "orgo-computer" "${h}/config.yaml" && fail "default config still lists orgo-computer"
grep -q "^# my config" "${h}/config.yaml" || fail "comment lost"
grep -q "^    - texting-style" "${h}/config.yaml" || fail "other enabled plugin lost"
grep -q "^  disabled: \[\]" "${h}/config.yaml" || fail "sibling key lost"
grep -q "^  backend: local" "${h}/config.yaml" || fail "later section lost"
grep -q "^  enabled: \[\]" "${h}/profiles/helper/config.yaml" || fail "flow list not emptied: $(cat "${h}/profiles/helper/config.yaml")"
ls "${h}"/config.yaml.bak.* >/dev/null 2>&1 || fail "no config backup"
grep -q "^ORGO_API_KEY=abc" "${h}/.env" || fail ".env was modified"
echo "${out}" | grep -q "still has ORGO_API_KEY" || fail "did not mention the key"
[ "$(cat "${h}/profiles/plain/config.yaml")" = "model: x" ] || fail "untouched profile changed"
python3 - "${h}/config.yaml" "${h}/profiles/helper/config.yaml" <<'PY' || fail "edited config.yaml is not valid YAML"
import sys
try:
    import yaml
except ImportError:
    sys.exit(0)
for path in sys.argv[1:]:
    data = yaml.safe_load(open(path))
    assert "orgo-computer" not in (data["plugins"]["enabled"] or []), path
PY

# 3. second run is a no-op
out=$(run "${home}" --yes --profiles helper)
echo "${out}" | grep -q "Nothing to do" || fail "second run was not a no-op: ${out}"

# 4. --profiles limits the scope; unknown profile fails
home="${WORK}/scoped"
seed "${home}"
run "${home}" --yes --profiles helper >/dev/null
[ -d "${home}/.hermes/plugins/orgo-computer" ] || fail "--profiles helper touched default"
[ ! -e "${home}/.hermes/profiles/helper/plugins/orgo-computer" ] || fail "--profiles helper skipped helper"
if run "${home}" --profiles nope >/dev/null 2>&1; then fail "unknown profile accepted"; fi

# 5. no Hermes home at all
out=$(run "${WORK}/empty")
echo "${out}" | grep -q "nothing to remove" || fail "missing home not handled"

echo "remove-orgo-computer: all checks passed"
