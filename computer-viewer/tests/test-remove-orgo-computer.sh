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

# Parses with Ruby or PyYAML when either is here. Exact-text checks below do
# not depend on it; this is a second opinion, and says so when it is absent.
yaml_ok() {
  if command -v ruby >/dev/null 2>&1; then
    ruby -ryaml -e 'YAML.safe_load(File.read(ARGV[0]))' "$1" >/dev/null 2>&1
  elif python3 -c 'import yaml' >/dev/null 2>&1; then
    python3 -c 'import sys, yaml; yaml.safe_load(open(sys.argv[1]))' "$1" >/dev/null 2>&1
  else
    echo "note: no YAML parser here; relying on the exact-text checks" >&2
    return 0
  fi
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
# Exact text, so no YAML parser is needed to trust the result.
expected_default='# my config
model: some-model
plugins:
  enabled:
    - texting-style
  disabled: []
terminal:
  backend: local'
[ "$(cat "${h}/config.yaml")" = "${expected_default}" ] || fail "default config.yaml not as expected: $(cat "${h}/config.yaml")"
[ "$(cat "${h}/profiles/helper/config.yaml")" = "plugins:
  enabled: []" ] || fail "helper config.yaml not as expected"
yaml_ok "${h}/config.yaml" || fail "edited default config.yaml does not parse"
yaml_ok "${h}/profiles/helper/config.yaml" || fail "edited helper config.yaml does not parse"

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

# 6. Review round 1: valid YAML this script must not rewrite is left alone,
#    plugin folder included, and the run says so and exits non-zero.
unsupported_case() {
  local label=$1 config=$2
  local home="${WORK}/unsupported-${label}"
  mkdir -p "${home}/.hermes/plugins/orgo-computer"
  echo "name: orgo-computer" > "${home}/.hermes/plugins/orgo-computer/plugin.yaml"
  printf '%s\n' "${config}" > "${home}/.hermes/config.yaml"
  local before
  before=$(cat "${home}/.hermes/config.yaml")
  local status=0
  out=$(run "${home}" --yes) || status=$?
  [ "${status}" -eq 3 ] || fail "${label}: expected exit 3, got ${status}: ${out}"
  [ "$(cat "${home}/.hermes/config.yaml")" = "${before}" ] || fail "${label}: config.yaml was changed"
  [ -d "${home}/.hermes/plugins/orgo-computer" ] || fail "${label}: plugin folder moved although config was skipped"
  echo "${out}" | grep -q "SKIPPED" || fail "${label}: no SKIPPED note"
  echo "${out}" | grep -q "By hand: remove orgo-computer from plugins.enabled" || fail "${label}: no manual steps"
}
unsupported_case multiline 'plugins:
  enabled: [orgo-computer,
    texting-style]
model: sample'
unsupported_case flowmap 'plugins: {enabled: [orgo-computer, texting-style]}
model: sample'
unsupported_case nested 'plugins:
  enabled:
    - name: orgo-computer
model: sample'

# 7. A column-0 comment inside the plugins block is fine: edited, not skipped.
home="${WORK}/comment"
mkdir -p "${home}/.hermes/plugins/orgo-computer"
printf '%s\n' 'plugins:
# keep these
  enabled:
    - orgo-computer
    - texting-style
model: sample' > "${home}/.hermes/config.yaml"
run "${home}" --yes >/dev/null || fail "comment case failed"
[ "$(cat "${home}/.hermes/config.yaml")" = 'plugins:
# keep these
  enabled:
    - texting-style
model: sample' ] || fail "comment case: $(cat "${home}/.hermes/config.yaml")"
[ ! -e "${home}/.hermes/plugins/orgo-computer" ] || fail "comment case: plugin not moved"
yaml_ok "${home}/.hermes/config.yaml" || fail "comment case does not parse"

echo "remove-orgo-computer: all checks passed"
