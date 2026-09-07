#!/usr/bin/env bash
# High-performance H.264 stream agent for the Computer plugin (Linux / X11).
# Installs ffmpeg via apt/dnf/yum/pacman, a dedicated venv, hiperf-agent.py,
# and a systemd --user unit. Idempotent. LAN / Tailscale only. Port 6090.
#
# Wayland: capture dry-runs fail; the agent stays up and answers capture-failed.

set -euo pipefail

if [ "$(uname -s)" = "Darwin" ]; then
  echo "This script is for Linux. On a Mac run hiperf-mac.sh." >&2
  exit 1
fi

HERMES_CV="${HOME}/.hermes-cv"
HIPERF_DIR="${HERMES_CV}/hiperf"
VENV_DIR="${HIPERF_DIR}/venv"
AGENT_PATH="${HIPERF_DIR}/hiperf-agent.py"
TOKEN_FILE="${HERMES_CV}/hiperf-token.txt"
UNIT_DIR="${HOME}/.config/systemd/user"
UNIT_FILE="${UNIT_DIR}/hermes-cv-hiperf.service"
LISTEN_PORT=6090
RAW_REPO_URL='https://raw.githubusercontent.com/thomasbek3/hermes-bot-kit/v2026.09.07/computer-viewer'
WEBSOCKETS_PIN='websockets>=13,<16'

echo "Computer viewer - high-performance stream (Linux)"
echo "LAN / Tailscale only - H.264 agent bind is chosen below (port ${LISTEN_PORT})."
echo

umask 077
mkdir -p "${HIPERF_DIR}" "${HERMES_CV}" "${UNIT_DIR}"

resolve_bind() {
  # Env override wins.
  case "${CV_BIND:-}" in
    "")        ;;
    lan|0.0.0.0) printf '0.0.0.0'; return ;;
    *)         printf '%s' "${CV_BIND}"; return ;;
  esac
  # Tailscale present and up -> bind its IPv4 only.
  if command -v tailscale >/dev/null 2>&1; then
    ip="$(tailscale ip -4 2>/dev/null | head -n1 | tr -d '[:space:]')"
    case "$ip" in 100.*) printf '%s' "$ip"; return ;; esac
  fi
  printf '127.0.0.1'
}

announce_bind() {
  case "$1" in
    0.0.0.0)
      echo "==> Bind: 0.0.0.0 (CV_BIND override) WARNING: every interface, plaintext, LAN-only use."
      ;;
    127.0.0.1)
      echo "==> Bind: 127.0.0.1 (no Tailscale found; reach it through an SSH tunnel or set CV_BIND=0.0.0.0)"
      ;;
    *)
      if [ -n "${CV_BIND:-}" ]; then
        echo "==> Bind: $1 (CV_BIND override)"
      else
        echo "==> Bind: $1 (Tailscale interface; set CV_BIND=0.0.0.0 for every interface)"
      fi
      ;;
  esac
}

port_listening() {
  local port="$1"
  if command -v ss >/dev/null 2>&1; then
    ss -ltn 2>/dev/null | grep -qE ":${port}([^0-9]|$)" && return 0
  fi
  if command -v lsof >/dev/null 2>&1; then
    lsof -nP -iTCP:"$port" -sTCP:LISTEN >/dev/null 2>&1 && return 0
  fi
  if command -v nc >/dev/null 2>&1; then
    nc -z 127.0.0.1 "$port" >/dev/null 2>&1 && return 0
  fi
  return 1
}

run_root() {
  if [ "$(id -u)" -eq 0 ]; then
    "$@"
  elif command -v sudo >/dev/null 2>&1; then
    sudo "$@"
  else
    echo "Need root to install packages (sudo not found). Install them yourself and re-run." >&2
    echo "  $*" >&2
    return 1
  fi
}

pkg_install() {
  local required="$1"
  local optional="${2:-}"
  local pkg
  echo "==> Installing packages: ${required}${optional:+ (optional: ${optional})}"
  install_one() {
    local mgr="$1" pkg="$2"
    case "$mgr" in
      apt) run_root apt-get install -y "$pkg" ;;
      dnf) run_root dnf install -y "$pkg" ;;
      yum) run_root yum install -y "$pkg" ;;
      pacman) run_root pacman -S --noconfirm "$pkg" ;;
    esac
  }
  if command -v apt-get >/dev/null 2>&1; then
    run_root apt-get update -y
    for pkg in $required; do install_one apt "$pkg"; done
    for pkg in $optional; do install_one apt "$pkg" || true; done
  elif command -v dnf >/dev/null 2>&1; then
    for pkg in $required; do install_one dnf "$pkg"; done
    for pkg in $optional; do install_one dnf "$pkg" || true; done
  elif command -v yum >/dev/null 2>&1; then
    for pkg in $required; do install_one yum "$pkg" || true; done
    for pkg in $optional; do install_one yum "$pkg" || true; done
  elif command -v pacman >/dev/null 2>&1; then
    run_root pacman -Sy --noconfirm
    for pkg in $required; do install_one pacman "$pkg"; done
    for pkg in $optional; do install_one pacman "$pkg" || true; done
  else
    echo "No apt/dnf/pacman found. Install (${required}) yourself if the binaries are missing." >&2
  fi
}

script_dir() {
  local src="${BASH_SOURCE[0]:-$0}"
  if [ -n "$src" ] && [ -f "$src" ]; then
    cd "$(dirname "$src")" && pwd
  else
    printf ''
  fi
}

sha256_of() {
  # Digest one file with whatever is installed. Non-zero if neither tool exists.
  if command -v shasum >/dev/null 2>&1; then
    shasum -a 256 -- "$1" | awk '{print $1}'
  elif command -v sha256sum >/dev/null 2>&1; then
    sha256sum -- "$1" | awk '{print $1}'
  else
    return 1
  fi
}

manifest_agent_sha() {
  # MANIFEST.sha256 sits at the repo root, one level above RAW_REPO_URL.
  local root="${RAW_REPO_URL%/computer-viewer}"
  local pick='$2 == "computer-viewer/hiperf-agent.py" { print $1; found = 1; exit } END { if (!found) exit 1 }'
  local sum=""
  sum="$(curl -fsSL "${root}/MANIFEST.sha256" 2>/dev/null | awk "$pick" || true)"
  if [ -z "$sum" ]; then
    # Offline fallback. Two layouts: a clone keeps MANIFEST.sha256 one level
    # up (repo root, next to computer-viewer/), and install.sh puts a copy two
    # levels up (desktop-plugins/, next to computer-viewer/).
    local here local_manifest
    here="$(script_dir)"
    if [ -n "$here" ]; then
      for local_manifest in "${here}/../MANIFEST.sha256" "${here}/../../MANIFEST.sha256"; do
        if [ -f "$local_manifest" ]; then
          sum="$(awk "$pick" "$local_manifest" || true)"
          if [ -n "$sum" ]; then
            break
          fi
        fi
      done
    fi
  fi
  [ -n "$sum" ] || return 1
  printf '%s' "$sum"
}

verify_agent_sha() {
  local file="$1" want="$2" got=""
  got="$(sha256_of "$file")" || {
    echo "Neither shasum nor sha256sum is available; refusing an unverified hiperf-agent.py." >&2
    return 1
  }
  if [ "$got" != "$want" ]; then
    echo "hiperf-agent.py sha256 mismatch - refusing to install." >&2
    echo "  manifest: ${want}" >&2
    echo "  file:     ${got}" >&2
    return 1
  fi
  return 0
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
  if command -v python3 >/dev/null 2>&1; then
    tok="$(python3 -c 'import secrets; print(secrets.token_hex(16))')"
  else
    tok="$(dd if=/dev/urandom bs=16 count=1 2>/dev/null | od -An -tx1 | tr -d ' \n')"
  fi
  printf '%s\n' "$tok" > "${TOKEN_FILE}"
  chmod 600 "${TOKEN_FILE}"
  echo "==> Wrote token ${TOKEN_FILE} (mode 600)" >&2
  printf '%s' "$tok"
}

note_linger() {
  echo
  echo "==> linger (so user services run without an active graphical login)"
  if command -v loginctl >/dev/null 2>&1; then
    if loginctl enable-linger "${USER}" >/dev/null 2>&1; then
      echo "    loginctl enable-linger ${USER} - ok."
    else
      echo "    Could not enable linger. If the agent dies at logout, run:"
      echo "      loginctl enable-linger ${USER}"
      echo "      # or: sudo loginctl enable-linger ${USER}"
    fi
  else
    echo "    loginctl not found. If the agent dies at logout, enable lingering"
    echo "    for ${USER} so systemd --user stays up."
  fi
}

show_effective_listener() {
  # `enable --now` is a no-op on an already-active unit, so a re-run used to
  # leave the OLD bind in place. Print what is actually listening now.
  local port="$1"
  command -v ss >/dev/null 2>&1 || return 0
  echo "    effective listener on :${port}"
  ss -ltnp 2>/dev/null | grep ":${port}" || echo "      (nothing listening on :${port} yet)"
}

enable_user_units() {
  echo "==> systemctl --user daemon-reload, then enable + restart"
  if ! command -v systemctl >/dev/null 2>&1; then
    echo "systemctl not found. User unit written to ${UNIT_DIR} but not started." >&2
    echo "  After login: systemctl --user daemon-reload && systemctl --user enable $* && systemctl --user restart $*" >&2
    return 0
  fi
  if ! systemctl --user daemon-reload; then
    echo "systemd --user is not running (typical over SSH without lingering)." >&2
    echo "Unit written. On the graphical session run:" >&2
    echo "  systemctl --user daemon-reload" >&2
    echo "  systemctl --user enable $* && systemctl --user restart $*" >&2
    return 0
  fi
  local u
  for u in "$@"; do
    systemctl --user enable "$u" || echo "    failed to enable $u (will be available after login)" >&2
    if systemctl --user is-active --quiet "$u"; then
      systemctl --user restart "$u" || echo "    failed to restart $u" >&2
    else
      systemctl --user start "$u" || echo "    failed to start $u (will be available after login)" >&2
    fi
  done
  show_effective_listener "${LISTEN_PORT}"
}

need_pkg=0
command -v ffmpeg >/dev/null 2>&1 || need_pkg=1
command -v python3 >/dev/null 2>&1 || need_pkg=1
if [ "$need_pkg" -eq 1 ]; then
  pkg_install "ffmpeg python3 python3-venv python3-pip" ""
else
  echo "==> ffmpeg and python3 already installed"
fi

if ! command -v python3 >/dev/null 2>&1; then
  echo "python3 not found. Install Python 3.10+ and re-run." >&2
  exit 1
fi
if ! python3 -c 'import sys; raise SystemExit(0 if sys.version_info >= (3, 10) else 1)'; then
  echo "Python 3.10+ is required (found $(python3 --version 2>&1))." >&2
  exit 1
fi

FFMPEG_BIN="$(command -v ffmpeg || true)"
if [ -z "${FFMPEG_BIN}" ] || [ ! -x "${FFMPEG_BIN}" ]; then
  echo "ffmpeg is not installed. Install it (apt/dnf/yum/pacman package ffmpeg) and re-run." >&2
  exit 1
fi
FFMPEG_BIN="$(python3 -c 'import os,sys; print(os.path.realpath(sys.argv[1]))' "${FFMPEG_BIN}")"
echo "==> ffmpeg: ${FFMPEG_BIN}"

TOKEN="$(ensure_token)"

if [ ! -x "${VENV_DIR}/bin/python" ]; then
  echo "==> Creating dedicated venv at ${VENV_DIR}"
  if ! python3 -m venv "${VENV_DIR}"; then
    echo "python3 -m venv failed. Install python3-venv and re-run." >&2
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
# Staged to a temp file and checked against MANIFEST.sha256 before it replaces
# anything, so a tampered or truncated download cannot become the running agent.
AGENT_SHA="$(manifest_agent_sha || true)"
if [ -z "${AGENT_SHA}" ]; then
  echo "Could not read the hiperf-agent.py digest from ${RAW_REPO_URL%/computer-viewer}/MANIFEST.sha256" >&2
  echo "and no local MANIFEST.sha256 was found. Refusing to install an unverified agent." >&2
  exit 1
fi
AGENT_TMP="${AGENT_PATH}.new"
rm -f "${AGENT_TMP}"
if curl -fsSL "${RAW_REPO_URL}/hiperf-agent.py" -o "${AGENT_TMP}"; then
  AGENT_SRC="${RAW_REPO_URL}/hiperf-agent.py"
else
  rm -f "${AGENT_TMP}"
  HERE="$(script_dir)"
  if [ -n "$HERE" ] && [ -f "${HERE}/hiperf-agent.py" ]; then
    cp "${HERE}/hiperf-agent.py" "${AGENT_TMP}"
    AGENT_SRC="${HERE}/hiperf-agent.py (download failed)"
  else
    echo "Could not download hiperf-agent.py from ${RAW_REPO_URL} and no local copy was found." >&2
    exit 1
  fi
fi
if ! verify_agent_sha "${AGENT_TMP}" "${AGENT_SHA}"; then
  rm -f "${AGENT_TMP}"
  echo "    left ${AGENT_PATH} untouched" >&2
  exit 1
fi
mv -f "${AGENT_TMP}" "${AGENT_PATH}"
echo "    installed from ${AGENT_SRC}"
echo "    sha256 ${AGENT_SHA} verified against MANIFEST.sha256"
chmod 644 "${AGENT_PATH}"

PYTHON_BIN="${VENV_DIR}/bin/python"
DISPLAY_VAL="${DISPLAY:-:0}"
XAUTH_VAL="${XAUTHORITY:-%h/.Xauthority}"

BIND="$(resolve_bind)"
announce_bind "$BIND"

echo "==> Writing systemd user unit ${UNIT_FILE}"
cat > "${UNIT_FILE}" <<EOF
[Unit]
Description=Computer viewer hiperf agent (H.264 over WebSocket :${LISTEN_PORT})
After=graphical-session.target

[Service]
Type=simple
Environment=DISPLAY=${DISPLAY_VAL}
Environment=XAUTHORITY=${XAUTH_VAL}
ExecStart=${PYTHON_BIN} ${AGENT_PATH} --port ${LISTEN_PORT} --token-file ${TOKEN_FILE} --ffmpeg ${FFMPEG_BIN} --bind ${BIND} --display ${DISPLAY_VAL}
Restart=on-failure
RestartSec=10

[Install]
WantedBy=graphical-session.target
EOF

enable_user_units hermes-cv-hiperf.service
note_linger

if port_listening "${LISTEN_PORT}"; then
  echo "==> Port ${LISTEN_PORT} is listening - hiperf agent is up."
else
  echo "==> Port ${LISTEN_PORT} is not listening yet. The agent needs a live X session"
  echo "    (DISPLAY=${DISPLAY_VAL}). Check: journalctl --user -u hermes-cv-hiperf.service"
fi

HOST="$(hostname -s 2>/dev/null || hostname)"
TS_DNS=""
if command -v tailscale >/dev/null 2>&1; then
  TS_DNS="$(tailscale status --json 2>/dev/null | python3 -c 'import sys,json
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
case "$BIND" in
  127.0.0.1)
    echo "  Reach it through an SSH tunnel:"
    echo "    ssh -N -L ${LISTEN_PORT}:127.0.0.1:${LISTEN_PORT} ${USER}@${HOST}"
    echo "  then paste:"
    echo "    ws://127.0.0.1:${LISTEN_PORT}/stream"
    ;;
  0.0.0.0)
    echo "  ws://${HOST}:${LISTEN_PORT}/stream"
    echo "  ws://${HOST}.local:${LISTEN_PORT}/stream"
    if [ -n "${TS_DNS}" ]; then
      echo "  ws://${TS_DNS}:${LISTEN_PORT}/stream"
    fi
    echo "  WARNING: bound to every interface, plaintext. LAN-only use."
    ;;
  *)
    echo "  ws://${BIND}:${LISTEN_PORT}/stream"
    if [ -n "${TS_DNS}" ]; then
      echo "  ws://${TS_DNS}:${LISTEN_PORT}/stream"
    else
      echo "  ws://<tailscale-name>:${LISTEN_PORT}/stream"
    fi
    echo "(.local and Tailscale MagicDNS both work on a private net.)"
    ;;
esac
echo
echo "LAN / Tailscale only. Do not port-forward ${LISTEN_PORT}."
echo "HD agent is bound to ${BIND}:${LISTEN_PORT}."
echo "X11 only. On Wayland the agent stays up but capture fails (use an Xorg session)."
echo "===================================================================="
