#!/usr/bin/env bash
# Bridge this Mac's Screen Sharing (VNC :5900) to a WebSocket the Computer
# plugin can paste: ws://<LocalHostName>.local:6080/websockify
#
# Patterns: dedicated venv + absolute LaunchAgent path (launchd has a bare PATH —
# do not rely on `pip --user`). Idempotent, no sudo. LAN / Tailscale only.
#
# Does NOT enable Screen Sharing or set the VNC password (kickstart needs sudo
# and drops live sessions). Prints the manual steps instead.

set -euo pipefail

if [ "$(uname -s)" != "Darwin" ]; then
  echo "This script is for macOS. Use connect-linux.sh or connect-windows.ps1." >&2
  exit 1
fi

LABEL='com.computer-viewer.websockify'
PLIST="${HOME}/Library/LaunchAgents/${LABEL}.plist"
HERMES_CV="${HOME}/.hermes-cv"
VENV_DIR="${HERMES_CV}/venv"
WEBSOCKIFY_BIN="${VENV_DIR}/bin/websockify"
LOG_PATH="${HERMES_CV}/websockify.log"
LISTEN_PORT=6080
VNC_TARGET='localhost:5900'
WEBSOCKIFY_PIN='websockify==0.13.0'

# Patched builds for CVE-2026-65400 (Aug 2026 Screen Sharing auth bypass).
SONOMA_PATCHED='14.8.9'
SEQUOIA_PATCHED='15.7.9'
TAHOE_PATCHED='26.6.1'

echo "Computer viewer — Mac Screen Sharing bridge"
echo "websockify ${WEBSOCKIFY_PIN}, pinned in ${VENV_DIR}"
echo "LAN / Tailscale only — VNC stays on localhost:5900; websocket on :${LISTEN_PORT}."
echo

xml_escape() {
  printf '%s' "$1" | sed -e 's/\&/\&amp;/g' -e 's/</\&lt;/g' -e 's/>/\&gt;/g'
}

# Return 0 if dotted version $1 >= $2. Best-effort numeric; bash 3.2 safe.
ver_ge() {
  local a="$1" b="$2"
  local IFS=.
  # shellcheck disable=SC2086
  set -- $a
  local a1="${1:-0}" a2="${2:-0}" a3="${3:-0}"
  # shellcheck disable=SC2086
  set -- $b
  local b1="${1:-0}" b2="${2:-0}" b3="${3:-0}"
  a1=$(printf '%s' "$a1" | tr -cd '0-9'); [ -n "$a1" ] || a1=0
  a2=$(printf '%s' "$a2" | tr -cd '0-9'); [ -n "$a2" ] || a2=0
  a3=$(printf '%s' "$a3" | tr -cd '0-9'); [ -n "$a3" ] || a3=0
  b1=$(printf '%s' "$b1" | tr -cd '0-9'); [ -n "$b1" ] || b1=0
  b2=$(printf '%s' "$b2" | tr -cd '0-9'); [ -n "$b2" ] || b2=0
  b3=$(printf '%s' "$b3" | tr -cd '0-9'); [ -n "$b3" ] || b3=0
  if [ "$a1" -gt "$b1" ]; then return 0; fi
  if [ "$a1" -lt "$b1" ]; then return 1; fi
  if [ "$a2" -gt "$b2" ]; then return 0; fi
  if [ "$a2" -lt "$b2" ]; then return 1; fi
  if [ "$a3" -ge "$b3" ]; then return 0; fi
  return 1
}

warn_screen_sharing_cve() {
  local v major
  v="$(sw_vers -productVersion 2>/dev/null || true)"
  echo "--------------------------------------------------------------------"
  if [ -z "$v" ]; then
    echo "WARNING: Could not read macOS version (sw_vers)."
    echo "  CVE-2026-65400: unpatched Screen Sharing may authenticate an"
    echo "  attacker on the network WITHOUT valid credentials."
    echo "  Update macOS (Sonoma ${SONOMA_PATCHED} / Sequoia ${SEQUOIA_PATCHED} / Tahoe ${TAHOE_PATCHED})"
    echo "  and NEVER expose port 5900 or 6080 to the internet."
    echo "--------------------------------------------------------------------"
    echo
    return
  fi
  major="${v%%.*}"
  major="$(printf '%s' "$major" | tr -cd '0-9')"
  [ -n "$major" ] || major=0

  local patched=0 unsure=0
  case "$major" in
    14)
      if ver_ge "$v" "$SONOMA_PATCHED"; then patched=1; else patched=0; fi
      ;;
    15)
      if ver_ge "$v" "$SEQUOIA_PATCHED"; then patched=1; else patched=0; fi
      ;;
    26)
      if ver_ge "$v" "$TAHOE_PATCHED"; then patched=1; else patched=0; fi
      ;;
    *)
      if [ "$major" -ge 27 ] 2>/dev/null; then
        patched=1
      else
        unsure=1
      fi
      ;;
  esac

  if [ "$patched" -eq 1 ]; then
    echo "macOS ${v}: at or above the CVE-2026-65400 Screen Sharing patch."
    echo "  Still: never expose port 5900 or 6080 to the internet (LAN/Tailscale only)."
  elif [ "$unsure" -eq 1 ]; then
    echo "WARNING: macOS ${v} — could not map this build to a known patched release."
    echo "  CVE-2026-65400: unpatched Screen Sharing may authenticate an attacker"
    echo "  on the network WITHOUT valid credentials."
    echo "  Known patched builds: Sonoma ${SONOMA_PATCHED}, Sequoia ${SEQUOIA_PATCHED},"
    echo "  Tahoe ${TAHOE_PATCHED}. Update macOS if you can, and NEVER expose"
    echo "  port 5900 or 6080 to the internet."
  else
    echo "WARNING: macOS ${v} is BELOW the CVE-2026-65400 Screen Sharing patch."
    echo "  An attacker on the network may authenticate to Screen Sharing"
    echo "  WITHOUT valid credentials."
    echo "  Update now: System Settings → General → Software Update"
    echo "  Patched builds: Sonoma ${SONOMA_PATCHED} / Sequoia ${SEQUOIA_PATCHED} / Tahoe ${TAHOE_PATCHED}"
    echo "  NEVER expose port 5900 or 6080 to the internet (LAN/Tailscale only)."
  fi
  echo "--------------------------------------------------------------------"
  echo
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

warn_screen_sharing_cve

if ! command -v python3 >/dev/null 2>&1; then
  echo "python3 not found. Install Python 3 (Xcode Command Line Tools or python.org) and re-run." >&2
  echo "  xcode-select --install" >&2
  exit 1
fi

echo "==> Python: $(python3 -c 'import sys; print(sys.executable)') ($(python3 --version 2>&1))"

umask 077
mkdir -p "${HERMES_CV}" "${HOME}/Library/LaunchAgents"

if [ ! -x "${VENV_DIR}/bin/python" ]; then
  echo "==> Creating dedicated venv at ${VENV_DIR}"
  if ! python3 -m venv "${VENV_DIR}"; then
    echo "python3 -m venv failed. Install Python 3 from python.org or run: xcode-select --install" >&2
    exit 1
  fi
else
  echo "==> Reusing venv at ${VENV_DIR}"
fi

echo "==> Installing ${WEBSOCKIFY_PIN} into the venv (absolute path for launchd)"
if ! "${VENV_DIR}/bin/pip" install -q "${WEBSOCKIFY_PIN}"; then
  echo "pip install ${WEBSOCKIFY_PIN} failed." >&2
  echo "  ${VENV_DIR}/bin/pip install '${WEBSOCKIFY_PIN}'" >&2
  exit 1
fi

if [ ! -x "${WEBSOCKIFY_BIN}" ]; then
  echo "websockify binary missing at ${WEBSOCKIFY_BIN} after install." >&2
  exit 1
fi
echo "    ${WEBSOCKIFY_BIN}"

BIN_XML="$(xml_escape "${WEBSOCKIFY_BIN}")"
LOG_XML="$(xml_escape "${LOG_PATH}")"
LABEL_XML="$(xml_escape "${LABEL}")"

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
    <string>${BIN_XML}</string>
    <string>${LISTEN_PORT}</string>
    <string>${VNC_TARGET}</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>ThrottleInterval</key>
  <integer>10</integer>
  <key>WorkingDirectory</key>
  <string>$(xml_escape "${HERMES_CV}")</string>
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
  echo "    Loaded ${LABEL} (websockify ${LISTEN_PORT} → ${VNC_TARGET}, RunAtLoad + KeepAlive)."
else
  echo "launchctl not found; plist is in place but was not loaded." >&2
fi

echo
echo "==> Screen Sharing (manual — this script will not enable it)"
echo "    1. System Settings → General → Sharing → enable Screen Sharing"
echo "    2. Click Screen Sharing (i)"
echo "    3. Turn on \"VNC viewers may control screen with password\""
echo "    4. Set a password of at most 8 characters"
echo "       (classic VNC auth is DES; longer secrets are truncated to 8.)"
echo "    Do not use kickstart / ARDAgent from the terminal — that needs sudo"
echo "    and drops live Screen Sharing sessions."
echo

if port_listening 5900; then
  echo "==> Port 5900 is listening — Screen Sharing looks enabled."
else
  echo "==> Port 5900 is NOT listening."
  echo "    Screen Sharing is not on yet (or hasn't bound). Finish the steps"
  echo "    above, then come back — websockify is already set to start at login."
fi

if port_listening "${LISTEN_PORT}"; then
  echo "==> Port ${LISTEN_PORT} is listening — websockify is up."
else
  echo "==> Port ${LISTEN_PORT} is not listening yet. Check ${LOG_PATH}"
  echo "    launchd PATH is bare; the agent uses ${WEBSOCKIFY_BIN}."
fi

HOST="$(detect_hostname)"
MAC_USER="$(whoami)"

echo
echo "===================================================================="
echo "Paste this address in Computer:"
echo "  ws://${HOST}:${LISTEN_PORT}/websockify"
echo
echo "The plugin also needs:"
echo "  Username  ${MAC_USER}   (your Mac login, Advanced → Username)"
echo "  Password  the 8-char VNC password you set in Screen Sharing"
echo
echo "Tailscale names work too (ws://<tailscale-name>:${LISTEN_PORT}/websockify)."
echo ".local (Bonjour) and Tailscale MagicDNS both resolve on a private net."
echo
echo "LAN / Tailscale only. Do not port-forward 5900 or ${LISTEN_PORT}."
echo "VNC is bound to localhost; only the websocket port is reachable."
echo "Logs: ${LOG_PATH}"
echo "===================================================================="
