#!/usr/bin/env bash
# Bridge this Mac's Screen Sharing (VNC :5900) to a WebSocket the Computer
# plugin can paste: ws://<hostname>.local:6080/websockify
# Idempotent, no sudo.

set -euo pipefail

LABEL='com.computer-viewer.websockify'
PLIST="${HOME}/Library/LaunchAgents/${LABEL}.plist"
LISTEN_PORT=6080
VNC_TARGET='localhost:5900'
LOG_DIR="${HOME}/Library/Logs"
OUT_LOG="${LOG_DIR}/computer-viewer-websockify.log"
ERR_LOG="${LOG_DIR}/computer-viewer-websockify.err"

echo "Computer viewer — Mac Screen Sharing bridge"
echo "This script does not enable Screen Sharing. Turn that on yourself:"
echo "  System Settings → General → Sharing → Screen Sharing"
echo

if ! command -v python3 >/dev/null 2>&1; then
  echo "python3 not found. Install Python 3 (Xcode Command Line Tools or python.org) and re-run." >&2
  exit 1
fi

PYTHON_BIN="$(python3 -c 'import sys; print(sys.executable)')"
echo "Using Python: ${PYTHON_BIN}"

install_websockify() {
  if "${PYTHON_BIN}" -c 'import websockify' >/dev/null 2>&1; then
    echo "websockify is already available."
    return 0
  fi

  echo "Installing websockify (user install, no sudo)…"
  if "${PYTHON_BIN}" -m pip install --user websockify; then
    return 0
  fi
  echo "Retrying with --break-system-packages…"
  if "${PYTHON_BIN}" -m pip install --user --break-system-packages websockify; then
    return 0
  fi
  if command -v pipx >/dev/null 2>&1; then
    echo "Trying pipx…"
    if pipx install websockify; then
      return 0
    fi
  fi
  if command -v brew >/dev/null 2>&1; then
    echo "Trying Homebrew…"
    if brew install websockify; then
      return 0
    fi
  fi
  echo "Couldn't install websockify. Install it yourself, then re-run:" >&2
  echo "  python3 -m pip install --user websockify" >&2
  return 1
}

install_websockify

WEBSOCKIFY_BIN=""
if "${PYTHON_BIN}" -c 'import websockify' >/dev/null 2>&1; then
  WEBSOCKIFY_BIN=""
else
  WEBSOCKIFY_BIN="$(command -v websockify || true)"
  if [ -z "${WEBSOCKIFY_BIN}" ]; then
    echo "websockify installed but not importable and not on PATH." >&2
    exit 1
  fi
fi

mkdir -p "${HOME}/Library/LaunchAgents" "${LOG_DIR}"

# Escape XML text.
xml_escape() {
  printf '%s' "$1" | sed -e 's/\&/\&amp;/g' -e 's/</\&lt;/g' -e 's/>/\&gt;/g'
}

PYTHON_XML="$(xml_escape "${PYTHON_BIN}")"
OUT_XML="$(xml_escape "${OUT_LOG}")"
ERR_XML="$(xml_escape "${ERR_LOG}")"

if [ -n "${WEBSOCKIFY_BIN}" ]; then
  BIN_XML="$(xml_escape "${WEBSOCKIFY_BIN}")"
  PROGRAM_ARGS="    <string>${BIN_XML}</string>
    <string>${LISTEN_PORT}</string>
    <string>${VNC_TARGET}</string>"
else
  PROGRAM_ARGS="    <string>${PYTHON_XML}</string>
    <string>-m</string>
    <string>websockify</string>
    <string>${LISTEN_PORT}</string>
    <string>${VNC_TARGET}</string>"
fi

umask 077
cat > "${PLIST}" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
${PROGRAM_ARGS}
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>WorkingDirectory</key>
  <string>$(xml_escape "${HOME}")</string>
  <key>StandardOutPath</key>
  <string>${OUT_XML}</string>
  <key>StandardErrorPath</key>
  <string>${ERR_XML}</string>
</dict>
</plist>
EOF

echo "Wrote LaunchAgent ${PLIST}"

UID_NUM="$(id -u)"
DOMAIN="gui/${UID_NUM}"

if command -v launchctl >/dev/null 2>&1; then
  launchctl bootout "${DOMAIN}/${LABEL}" >/dev/null 2>&1 || true
  if ! launchctl bootstrap "${DOMAIN}" "${PLIST}"; then
    echo "launchctl bootstrap failed. Trying load…"
    launchctl load -w "${PLIST}" >/dev/null 2>&1 || true
  fi
  launchctl enable "${DOMAIN}/${LABEL}" >/dev/null 2>&1 || true
  launchctl kickstart -k "${DOMAIN}/${LABEL}" >/dev/null 2>&1 || \
    launchctl start "${LABEL}" >/dev/null 2>&1 || true
  echo "Loaded ${LABEL} (websockify ${LISTEN_PORT} → ${VNC_TARGET}, starts at login)."
else
  echo "launchctl not found; the plist is in place but was not loaded." >&2
fi

HOST=""
if command -v scutil >/dev/null 2>&1; then
  HOST="$(scutil --get LocalHostName 2>/dev/null || true)"
fi
if [ -z "${HOST}" ]; then
  HOST="$(hostname -s 2>/dev/null || hostname)"
fi

echo
echo "Paste this address in Computer:"
echo "  ws://${HOST}.local:${LISTEN_PORT}/websockify"
echo
echo "Then open Advanced and fill your Mac username and password."
echo "Tailscale names work too (ws://<tailscale-name>:${LISTEN_PORT}/websockify)."
echo "ws:// only works on a private network (this Mac, your LAN, or Tailscale)."
echo
echo "Logs: ${OUT_LOG}"
echo "      ${ERR_LOG}"
