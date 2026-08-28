#!/usr/bin/env bash
# High-performance H.264 stream agent for the Computer plugin (macOS).
# Installs ffmpeg (brew or ~/.hermes-cv/bin/ffmpeg), a dedicated venv,
# hiperf-agent.py, and a LaunchAgent.
# Idempotent, no sudo. LAN / Tailscale only. Port 6090.
#
# A launchd-started agent CANNOT show the Screen Recording (TCC) prompt.
# Permission must be granted manually (see the footer). The Mac must be
# logged in; a lock screen yields only the lock-screen image.

set -euo pipefail

if [ "$(uname -s)" != "Darwin" ]; then
  echo "This script is for macOS. Use hiperf-linux.sh or hiperf-windows.ps1." >&2
  exit 1
fi

LABEL='com.hermes-cv.hiperf'
PLIST="${HOME}/Library/LaunchAgents/${LABEL}.plist"
HERMES_CV="${HOME}/.hermes-cv"
HIPERF_DIR="${HERMES_CV}/hiperf"
VENV_DIR="${HIPERF_DIR}/venv"
AGENT_PATH="${HIPERF_DIR}/hiperf-agent.py"
TOKEN_FILE="${HERMES_CV}/hiperf-token.txt"
LOG_PATH="${HERMES_CV}/hiperf.log"
LISTEN_PORT=6090
RAW_REPO_URL='https://raw.githubusercontent.com/thomasbek3/hermes-bot-kit/master/computer-viewer'
WEBSOCKETS_PIN='websockets>=13,<16'

echo "Computer viewer - high-performance stream (macOS)"
echo "LAN / Tailscale only - H.264 agent on :${LISTEN_PORT}."
echo

xml_escape() {
  printf '%s' "$1" | sed -e 's/\&/\&amp;/g' -e 's/</\&lt;/g' -e 's/>/\&gt;/g'
}

port_listening() {
  local port="$1"
  if command -v lsof >/dev/null 2>&1; then
    lsof -nP -iTCP:"$port" -sTCP:LISTEN >/dev/null 2>&1 && return 0
  fi
  if command -v nc >/dev/null 2>&1; then
    nc -z 127.0.0.1 "$port" >/dev/null 2>&1 && return 0
  fi
  return 1
}

detect_hostname() {
  local host=""
  if command -v scutil >/dev/null 2>&1; then
    host="$(scutil --get LocalHostName 2>/dev/null || true)"
  fi
  if [ -z "$host" ]; then
    host="$(hostname -s 2>/dev/null || hostname)"
  fi
  case "$host" in
    *.local) printf '%s' "$host" ;;
    *) printf '%s.local' "$host" ;;
  esac
}

script_dir() {
  local src="${BASH_SOURCE[0]:-$0}"
  if [ -n "$src" ] && [ -f "$src" ]; then
    cd "$(dirname "$src")" && pwd
  else
    printf ''
  fi
}

ensure_token() {
  umask 077
  if [ -f "${TOKEN_FILE}" ]; then
    local existing
    existing="$(tr -d ' \t\r\n' < "${TOKEN_FILE}")"
    if printf '%s' "$existing" | grep -Eq '^[0-9a-fA-F]{32}$'; then
      echo "==> Reusing token in ${TOKEN_FILE}" >&2
      printf '%s' "$existing"
      return
    fi
  fi
  local tok=""
  if [ -n "${PYTHON_CMD:-}" ] && [ -x "${PYTHON_CMD}" ]; then
    tok="$("${PYTHON_CMD}" -c 'import secrets; print(secrets.token_hex(16))')"
  elif command -v python3 >/dev/null 2>&1; then
    tok="$(python3 -c 'import secrets; print(secrets.token_hex(16))')"
  else
    tok="$(dd if=/dev/urandom bs=16 count=1 2>/dev/null | od -An -tx1 | tr -d ' \n')"
  fi
  printf '%s\n' "$tok" > "${TOKEN_FILE}"
  chmod 600 "${TOKEN_FILE}"
  echo "==> Wrote token ${TOKEN_FILE} (mode 600)" >&2
  printf '%s' "$tok"
}

pick_python() {
  local cand
  for cand in "${HERMES_CV}/python/bin/python3" "$(command -v python3 2>/dev/null || true)"; do
    if [ -n "$cand" ] && [ -x "$cand" ]; then
      if "$cand" -c 'import sys; raise SystemExit(0 if sys.version_info >= (3, 10) else 1)' 2>/dev/null; then
        printf '%s' "$cand"
        return 0
      fi
    fi
  done
  return 1
}

PYTHON_CMD="$(pick_python || true)"
if [ -z "${PYTHON_CMD}" ]; then
  echo "python3 3.10+ not found on PATH and ${HERMES_CV}/python/bin/python3 is missing or too old." >&2
  echo "Install Python 3.10+ (Xcode Command Line Tools or python.org) and re-run." >&2
  echo "  xcode-select --install" >&2
  echo "Or drop a python-build-standalone tree at ${HERMES_CV}/python so that" >&2
  echo "  ${HERMES_CV}/python/bin/python3" >&2
  echo "exists (this script does not download Python), then re-run." >&2
  exit 1
fi

echo "==> Python: ${PYTHON_CMD} ($("${PYTHON_CMD}" --version 2>&1))"

FFMPEG_BIN=""
if [ -x "${HERMES_CV}/bin/ffmpeg" ]; then
  FFMPEG_BIN="${HERMES_CV}/bin/ffmpeg"
  echo "==> ffmpeg at ${FFMPEG_BIN} (Hermes-cv drop-in)"
elif command -v ffmpeg >/dev/null 2>&1; then
  FFMPEG_BIN="$(command -v ffmpeg)"
  echo "==> ffmpeg already on PATH: ${FFMPEG_BIN}"
else
  if ! command -v brew >/dev/null 2>&1; then
    echo "ffmpeg not found on PATH, ${HERMES_CV}/bin/ffmpeg is missing, and Homebrew is missing." >&2
    echo "Install ffmpeg, then re-run:" >&2
    echo "  brew install ffmpeg" >&2
    echo "Or drop a static ffmpeg binary at" >&2
    echo "  ${HERMES_CV}/bin/ffmpeg" >&2
    echo "(this script does not download ffmpeg) and re-run." >&2
    exit 1
  fi
  echo "==> Installing ffmpeg via Homebrew"
  brew install ffmpeg
  FFMPEG_BIN="$(command -v ffmpeg)"
fi

if [ -z "${FFMPEG_BIN}" ] || [ ! -x "${FFMPEG_BIN}" ]; then
  echo "ffmpeg binary not found after install." >&2
  echo "Drop a static ffmpeg binary at ${HERMES_CV}/bin/ffmpeg if Homebrew is unavailable." >&2
  exit 1
fi
FFMPEG_BIN="$("${PYTHON_CMD}" -c 'import os,sys; print(os.path.realpath(sys.argv[1]))' "${FFMPEG_BIN}")"
echo "    ${FFMPEG_BIN}"

umask 077
mkdir -p "${HIPERF_DIR}" "${HERMES_CV}" "${HOME}/Library/LaunchAgents"

TOKEN="$(ensure_token)"

if [ ! -x "${VENV_DIR}/bin/python" ]; then
  echo "==> Creating dedicated venv at ${VENV_DIR}"
  if ! "${PYTHON_CMD}" -m venv "${VENV_DIR}"; then
    echo "python3 -m venv failed. Install Python 3.10+ from python.org or run: xcode-select --install" >&2
    echo "Or drop a python-build-standalone tree at ${HERMES_CV}/python and re-run." >&2
    exit 1
  fi
else
  echo "==> Reusing venv at ${VENV_DIR}"
fi

echo "==> Installing ${WEBSOCKETS_PIN} into the venv"
if ! "${VENV_DIR}/bin/pip" install -q "${WEBSOCKETS_PIN}"; then
  echo "pip install ${WEBSOCKETS_PIN} failed." >&2
  exit 1
fi

echo "==> Fetching hiperf-agent.py"
if curl -fsSL "${RAW_REPO_URL}/hiperf-agent.py" -o "${AGENT_PATH}"; then
  echo "    downloaded from ${RAW_REPO_URL}/hiperf-agent.py"
else
  HERE="$(script_dir)"
  if [ -n "$HERE" ] && [ -f "${HERE}/hiperf-agent.py" ]; then
    cp "${HERE}/hiperf-agent.py" "${AGENT_PATH}"
    echo "    copied local ${HERE}/hiperf-agent.py (download failed)"
  else
    echo "Could not download hiperf-agent.py from ${RAW_REPO_URL} and no local copy was found." >&2
    exit 1
  fi
fi
chmod 644 "${AGENT_PATH}"

PYTHON_BIN="${VENV_DIR}/bin/python"
if [ ! -x "${PYTHON_BIN}" ]; then
  echo "venv python missing at ${PYTHON_BIN}" >&2
  exit 1
fi

BREW_PREFIX=""
if command -v brew >/dev/null 2>&1; then
  BREW_PREFIX="$(brew --prefix 2>/dev/null || true)"
fi
if [ -z "${BREW_PREFIX}" ]; then
  if [ -d /opt/homebrew/bin ]; then
    BREW_PREFIX=/opt/homebrew
  elif [ -d /usr/local/bin ]; then
    BREW_PREFIX=/usr/local
  fi
fi
PATH_VALUE="${HERMES_CV}/bin:${BREW_PREFIX:+${BREW_PREFIX}/bin:}/usr/local/bin:/usr/bin:/bin"

echo "==> Capture probe (will not obtain Screen Recording permission by itself)"
echo "    A launchd-started agent cannot show the TCC prompt, and launchctl asuser"
echo "    requires root, so this script cannot grant Screen Recording for you."
echo "    Grant it MANUALLY before expecting :${LISTEN_PORT} to stream (see footer)."
set +e
"${PYTHON_BIN}" "${AGENT_PATH}" \
  --port "${LISTEN_PORT}" \
  --token-file "${TOKEN_FILE}" \
  --ffmpeg "${FFMPEG_BIN}" \
  --bind 127.0.0.1 &
PROBE_PID=$!
sleep 8
kill "${PROBE_PID}" >/dev/null 2>&1
wait "${PROBE_PID}" >/dev/null 2>&1
set -e
echo "    probe finished (agent will now run under launchd)"

PYTHON_XML="$(xml_escape "${PYTHON_BIN}")"
AGENT_XML="$(xml_escape "${AGENT_PATH}")"
TOKEN_XML="$(xml_escape "${TOKEN_FILE}")"
FFMPEG_XML="$(xml_escape "${FFMPEG_BIN}")"
LOG_XML="$(xml_escape "${LOG_PATH}")"
LABEL_XML="$(xml_escape "${LABEL}")"
PATH_XML="$(xml_escape "${PATH_VALUE}")"
WD_XML="$(xml_escape "${HIPERF_DIR}")"
PORT_XML="$(xml_escape "${LISTEN_PORT}")"

echo "==> Writing LaunchAgent ${PLIST}"
cat > "${PLIST}" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LABEL_XML}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${PYTHON_XML}</string>
    <string>${AGENT_XML}</string>
    <string>--port</string>
    <string>${PORT_XML}</string>
    <string>--token-file</string>
    <string>${TOKEN_XML}</string>
    <string>--ffmpeg</string>
    <string>${FFMPEG_XML}</string>
    <string>--bind</string>
    <string>0.0.0.0</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key>
    <false/>
  </dict>
  <key>WorkingDirectory</key>
  <string>${WD_XML}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>${PATH_XML}</string>
  </dict>
  <key>StandardOutPath</key>
  <string>${LOG_XML}</string>
  <key>StandardErrorPath</key>
  <string>${LOG_XML}</string>
</dict>
</plist>
EOF
umask 077
chmod 644 "${PLIST}" 2>/dev/null || true

UID_NUM="$(id -u)"
DOMAIN="gui/${UID_NUM}"

echo "==> Reloading ${LABEL} (bootout/bootstrap, fallback unload/load)"
if command -v launchctl >/dev/null 2>&1; then
  launchctl bootout "${DOMAIN}/${LABEL}" >/dev/null 2>&1 || true
  launchctl unload "${PLIST}" >/dev/null 2>&1 || true
  if ! launchctl bootstrap "${DOMAIN}" "${PLIST}" >/dev/null 2>&1; then
    echo "    bootstrap failed; trying launchctl load -w"
    launchctl load -w "${PLIST}" >/dev/null 2>&1 || true
  fi
  launchctl enable "${DOMAIN}/${LABEL}" >/dev/null 2>&1 || true
  launchctl kickstart -k "${DOMAIN}/${LABEL}" >/dev/null 2>&1 || \
    launchctl start "${LABEL}" >/dev/null 2>&1 || true
  echo "    Loaded ${LABEL} (hiperf :${LISTEN_PORT}, RunAtLoad + KeepAlive.SuccessfulExit=false)."
else
  echo "launchctl not found; plist is in place but was not loaded." >&2
fi

if port_listening "${LISTEN_PORT}"; then
  echo "==> Port ${LISTEN_PORT} is listening - hiperf agent is up."
else
  echo "==> Port ${LISTEN_PORT} is not listening yet. Check ${LOG_PATH}"
fi

HOST="$(detect_hostname)"
TS_IP=""
TS_DNS=""
if command -v tailscale >/dev/null 2>&1; then
  TS_IP="$(tailscale ip -4 2>/dev/null | head -n 1 || true)"
  TS_DNS="$(tailscale status --json 2>/dev/null | "${PYTHON_CMD}" -c 'import sys,json
try:
    d=json.load(sys.stdin)
    n=(d.get("Self") or {}).get("DNSName") or ""
    print(n.rstrip("."))
except Exception:
    print("")
' || true)"
fi

echo
echo "===================================================================="
echo "High-performance stream is installed. In the Computer plugin:"
echo "  1. Open the computer endpoint (Advanced -> High-performance stream)"
echo "  2. Paste the token below"
echo "  3. Turn on HD (or click the HD button in the pane header)"
echo
echo "Token:"
echo "  ${TOKEN}"
echo "  stored at ${TOKEN_FILE} (mode 600)"
echo
echo "Optional stream URL override (leave blank to derive :6090 from the VNC host):"
echo "  ws://${HOST}:${LISTEN_PORT}/stream"
if [ -n "${TS_DNS}" ]; then
  echo "  ws://${TS_DNS}:${LISTEN_PORT}/stream"
fi
if [ -n "${TS_IP}" ]; then
  echo "  ws://${TS_IP}:${LISTEN_PORT}/stream"
fi
echo
echo "LAN / Tailscale only. Do not port-forward ${LISTEN_PORT}."
echo
echo "The Mac must be LOGGED IN (not at the lock screen) or capture shows only"
echo "the lock screen."
echo
echo "Screen Recording must be granted MANUALLY (a launchd agent cannot show the"
echo "TCC prompt, and launchctl asuser requires root, so this script cannot do it):"
echo "  System Settings -> Privacy & Security -> Screen Recording"
echo "  add/enable BOTH:"
echo "    ${PYTHON_BIN}"
echo "    ${FFMPEG_BIN}"
echo "If this Mac is headless, grant that through the plugin's own VNC view of"
echo "the Mac (the working VNC path is how you enable the fast path)."
echo
echo "Symptoms:"
echo "  capture hangs / port ${LISTEN_PORT} never listens -> missing Screen Recording permission"
echo "  frames arrive but are the lock screen -> not logged in"
echo "Logs: ${LOG_PATH}"
echo "===================================================================="
