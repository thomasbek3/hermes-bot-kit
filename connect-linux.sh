#!/usr/bin/env bash
# Bridge this Linux desktop (x11vnc on X11, wayvnc on wlroots-Wayland) to a
# WebSocket the Computer plugin can paste: ws://<hostname>:6080/websockify
#
# Idempotent. VNC binds localhost:5900; only websocket :6080 is on the LAN.
# LAN / Tailscale only. GNOME/KDE Wayland is not supported — log into Xorg.

set -euo pipefail

if [ "$(uname -s)" = "Darwin" ]; then
  echo "This script is for Linux. On a Mac run connect-mac.sh." >&2
  exit 1
fi

HERMES_CV="${HOME}/.hermes-cv"
VNC_PWD_FILE="${HERMES_CV}/vncpwd"
VNC_PWD_TEXT="${HERMES_CV}/vnc-password.txt"
WAYVNC_CONF="${HERMES_CV}/wayvnc.conf"
WAYVNC_RSA="${HERMES_CV}/wayvnc-rsa.pem"
UNIT_DIR="${HOME}/.config/systemd/user"
X11VNC_UNIT="${UNIT_DIR}/computer-viewer-x11vnc.service"
WAYVNC_UNIT="${UNIT_DIR}/computer-viewer-wayvnc.service"
WS_UNIT="${UNIT_DIR}/computer-viewer-websockify.service"
LISTEN_PORT=6080
VNC_PORT=5900
WEBSOCKIFY_PIN='websockify==0.13.0'
VENV_DIR="${HERMES_CV}/venv"

echo "Computer viewer — Linux desktop bridge"
echo "LAN / Tailscale only — VNC stays on localhost:${VNC_PORT}; websocket on :${LISTEN_PORT}."
echo

umask 077
mkdir -p "${HERMES_CV}" "${UNIT_DIR}"

lc() {
  printf '%s' "$1" | tr '[:upper:]' '[:lower:]'
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
  # Install required packages; optional packages are best-effort.
  local required="$1"
  local optional="${2:-}"
  local pkg
  echo "==> Installing packages: ${required}${optional:+ (optional: ${optional})}"
  install_one() {
    local mgr="$1" pkg="$2"
    case "$mgr" in
      apt) run_root apt-get install -y "$pkg" ;;
      dnf)
        if [ "$pkg" = websockify ]; then
          run_root dnf install -y websockify || run_root dnf install -y python3-websockify
        else
          run_root dnf install -y "$pkg"
        fi
        ;;
      yum)
        if [ "$pkg" = websockify ]; then
          run_root yum install -y websockify || run_root yum install -y python3-websockify
        else
          run_root yum install -y "$pkg"
        fi
        ;;
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

ensure_websockify() {
  local bin=""
  bin="$(command -v websockify 2>/dev/null || command -v websockify3 2>/dev/null || true)"
  if [ -n "$bin" ]; then
    printf '%s' "$bin"
    return 0
  fi
  echo "==> System websockify not on PATH; installing pinned ${WEBSOCKIFY_PIN} in ${VENV_DIR}" >&2
  if ! command -v python3 >/dev/null 2>&1; then
    echo "python3 not found; cannot install websockify." >&2
    return 1
  fi
  if [ ! -x "${VENV_DIR}/bin/python" ]; then
    python3 -m venv "${VENV_DIR}"
  fi
  "${VENV_DIR}/bin/pip" install -q "${WEBSOCKIFY_PIN}"
  if [ -x "${VENV_DIR}/bin/websockify" ]; then
    printf '%s' "${VENV_DIR}/bin/websockify"
    return 0
  fi
  echo "websockify install failed." >&2
  return 1
}

generate_password() {
  if command -v python3 >/dev/null 2>&1; then
    python3 -c 'import secrets,string; a=string.ascii_letters+string.digits; print("".join(secrets.choice(a) for _ in range(8)))'
    return
  fi
  # 8-char fallback; classic VNC DES truncates at 8.
  tr -dc 'A-Za-z0-9' </dev/urandom 2>/dev/null | head -c 8
  echo
}

ensure_vnc_password() {
  local pw=""
  if [ -f "${VNC_PWD_TEXT}" ]; then
    pw="$(tr -d '\n' < "${VNC_PWD_TEXT}")"
    echo "==> Reusing VNC password stored in ${VNC_PWD_TEXT}" >&2
  else
    pw="$(generate_password)"
    printf '%s\n' "$pw" > "${VNC_PWD_TEXT}"
    chmod 600 "${VNC_PWD_TEXT}"
    echo "==> Generated 8-char VNC password (DES limit) → ${VNC_PWD_TEXT}" >&2
  fi
  printf '%s' "$pw"
}

write_websockify_unit() {
  local ws_bin="$1"
  cat > "${WS_UNIT}" <<EOF
[Unit]
Description=Computer viewer websockify (6080 → localhost:5900)
After=network.target

[Service]
Type=simple
ExecStart=${ws_bin} ${LISTEN_PORT} localhost:${VNC_PORT}
Restart=always
RestartSec=3

[Install]
WantedBy=default.target
EOF
}

enable_user_units() {
  echo "==> systemctl --user daemon-reload && enable --now"
  if ! command -v systemctl >/dev/null 2>&1; then
    echo "systemctl not found. User units written to ${UNIT_DIR} but not started." >&2
    echo "  After login: systemctl --user daemon-reload && systemctl --user enable --now $*" >&2
    return 0
  fi
  if ! systemctl --user daemon-reload; then
    echo "systemd --user is not running (typical over SSH without lingering)." >&2
    echo "Units written. On the graphical session run:" >&2
    echo "  systemctl --user daemon-reload" >&2
    echo "  systemctl --user enable --now $*" >&2
    return 0
  fi
  local u
  for u in "$@"; do
    systemctl --user enable --now "$u" || echo "    failed to enable $u (will be available after login)" >&2
  done
}

note_linger() {
  echo
  echo "==> linger (so user services run without an active graphical login)"
  if command -v loginctl >/dev/null 2>&1; then
    if loginctl enable-linger "${USER}" >/dev/null 2>&1; then
      echo "    loginctl enable-linger ${USER} — ok."
    else
      echo "    Could not enable linger. If the bridge dies at logout, run:"
      echo "      loginctl enable-linger ${USER}"
      echo "      # or: sudo loginctl enable-linger ${USER}"
    fi
  else
    echo "    loginctl not found. If the bridge dies at logout, enable lingering"
    echo "    for ${USER} so systemd --user stays up."
  fi
}

detect_session() {
  local st="${XDG_SESSION_TYPE:-}"
  st="$(lc "$st")"
  if [ -n "$st" ]; then
    printf '%s' "$st"
    return
  fi
  if [ -n "${WAYLAND_DISPLAY:-}" ]; then
    printf 'wayland'
    return
  fi
  if [ -n "${DISPLAY:-}" ]; then
    printf 'x11'
    return
  fi
  printf 'unknown'
}

guess_wayland_family() {
  local desk c
  desk="$(lc "${XDG_CURRENT_DESKTOP:-} ${XDG_SESSION_DESKTOP:-} ${DESKTOP_SESSION:-}")"
  if [ -n "${SWAYSOCK:-}" ] || [ -n "${HYPRLAND_INSTANCE_SIGNATURE:-}" ]; then
    printf 'wlroots'
    return
  fi
  case "$desk" in
    *gnome*|*cinnamon*|*unity*|*pantheon*)
      printf 'gnome'
      return
      ;;
    *kde*|*plasma*)
      printf 'kde'
      return
      ;;
    *sway*|*hyprland*|*hypr*|*wayfire*|*river*|*labwc*|*dwl*|*hikari*|*cage*)
      printf 'wlroots'
      return
      ;;
  esac
  for c in sway Hyprland wayfire river labwc dwl hikari; do
    if command -v pgrep >/dev/null 2>&1 && pgrep -x "$c" >/dev/null 2>&1; then
      printf 'wlroots'
      return
    fi
  done
  printf 'unknown'
}

print_paste() {
  local host pw
  host="$(hostname -s 2>/dev/null || hostname)"
  pw="${1:-}"
  echo
  echo "===================================================================="
  echo "Paste this address in Computer:"
  echo "  ws://${host}:${LISTEN_PORT}/websockify"
  echo
  echo "mDNS:        ws://${host}.local:${LISTEN_PORT}/websockify"
  echo "Tailscale:   ws://<tailscale-name>:${LISTEN_PORT}/websockify"
  echo "(.local and Tailscale MagicDNS both work on a private net.)"
  echo
  if [ -n "$pw" ]; then
    echo "Linux VNC password (paste into the plugin Password field):"
    echo "  ${pw}"
    echo "Stored at ${VNC_PWD_TEXT} (mode 600)."
  else
    echo "Use the VNC password stored at ${VNC_PWD_TEXT}."
  fi
  echo
  echo "LAN / Tailscale only. Do not port-forward ${VNC_PORT} or ${LISTEN_PORT}."
  echo "VNC is bound to localhost; only the websocket port is reachable."
  echo "===================================================================="
}

setup_x11() {
  echo "==> Session: X11 — using x11vnc"
  local need=0
  command -v x11vnc >/dev/null 2>&1 || need=1
  command -v websockify >/dev/null 2>&1 || command -v websockify3 >/dev/null 2>&1 || need=1
  if [ "$need" -eq 1 ]; then
    pkg_install "x11vnc websockify" "novnc"
  else
    echo "==> x11vnc and websockify already installed"
  fi

  if ! command -v x11vnc >/dev/null 2>&1; then
    echo "x11vnc is not installed. Install it (apt/dnf/pacman package x11vnc) and re-run." >&2
    exit 1
  fi

  local ws_bin x11vnc_bin pw display
  ws_bin="$(ensure_websockify)"
  x11vnc_bin="$(command -v x11vnc)"
  pw="$(ensure_vnc_password)"
  display="${DISPLAY:-:0}"

  echo "==> Writing x11vnc password file ${VNC_PWD_FILE}"
  x11vnc -storepasswd "$pw" "${VNC_PWD_FILE}" >/dev/null
  chmod 600 "${VNC_PWD_FILE}"

  echo "==> Writing systemd user units"
  cat > "${X11VNC_UNIT}" <<EOF
[Unit]
Description=Computer viewer x11vnc (localhost only)
After=graphical-session.target

[Service]
Type=simple
Environment=DISPLAY=${display}
Environment=XAUTHORITY=${XAUTHORITY:-%h/.Xauthority}
ExecStart=${x11vnc_bin} -localhost -forever -shared -noxdamage -rfbauth ${VNC_PWD_FILE} -rfbport ${VNC_PORT}
Restart=always
RestartSec=3

[Install]
WantedBy=default.target
EOF

  write_websockify_unit "$ws_bin"
  systemctl --user disable --now computer-viewer-wayvnc.service >/dev/null 2>&1 || true
  enable_user_units computer-viewer-x11vnc.service computer-viewer-websockify.service
  note_linger

  if ! port_listening "${VNC_PORT}"; then
    echo
    echo "==> Port ${VNC_PORT} is not listening yet. x11vnc needs a live X session"
    echo "    (DISPLAY=${display}). Log into the graphical desktop and, if needed:"
    echo "      systemctl --user restart computer-viewer-x11vnc.service"
  fi

  print_paste "$pw"
}

setup_wayvnc() {
  echo "==> Session: Wayland / wlroots — wayvnc (best-effort, less battle-tested)"
  echo "    noVNC compatibility caveat: wayvnc's default RSA-AES (security type 262)"
  echo "    is not what classic VNC auth expects. This config uses RSA-AES *or*"
  echo "    relax_encryption so noVNC 1.7 may connect; if the plugin shows"
  echo "    'unsupported security types', log into an Xorg session instead and"
  echo "    re-run this script."
  echo

  local need=0
  command -v wayvnc >/dev/null 2>&1 || need=1
  command -v websockify >/dev/null 2>&1 || command -v websockify3 >/dev/null 2>&1 || need=1
  if [ "$need" -eq 1 ]; then
    pkg_install "wayvnc websockify" "novnc"
  else
    echo "==> wayvnc and websockify already installed"
  fi

  if ! command -v wayvnc >/dev/null 2>&1; then
    echo "wayvnc is not installed. Install it and re-run, or log into an Xorg session." >&2
    exit 1
  fi

  local ws_bin wayvnc_bin pw wdisplay
  ws_bin="$(ensure_websockify)"
  wayvnc_bin="$(command -v wayvnc)"
  pw="$(ensure_vnc_password)"
  wdisplay="${WAYLAND_DISPLAY:-wayland-1}"

  if [ ! -f "${WAYVNC_RSA}" ]; then
    echo "==> Generating RSA key for wayvnc RSA-AES (${WAYVNC_RSA})"
    if command -v ssh-keygen >/dev/null 2>&1; then
      ssh-keygen -m pem -f "${WAYVNC_RSA}" -t rsa -N "" -q
    else
      echo "ssh-keygen not found; writing config without RSA-AES (relax_encryption only)."
    fi
  fi

  echo "==> Writing ${WAYVNC_CONF} (localhost, RSA-AES + relax_encryption)"
  {
    echo "address=127.0.0.1"
    echo "port=${VNC_PORT}"
    echo "enable_auth=true"
    echo "username=${USER}"
    echo "password=${pw}"
    echo "relax_encryption=true"
    if [ -f "${WAYVNC_RSA}" ]; then
      echo "rsa_private_key_file=${WAYVNC_RSA}"
    fi
  } > "${WAYVNC_CONF}"
  chmod 600 "${WAYVNC_CONF}"

  echo "==> Writing systemd user units"
  cat > "${WAYVNC_UNIT}" <<EOF
[Unit]
Description=Computer viewer wayvnc (localhost only, wlroots)
After=graphical-session.target

[Service]
Type=simple
Environment=WAYLAND_DISPLAY=${wdisplay}
Environment=XDG_RUNTIME_DIR=${XDG_RUNTIME_DIR:-%t}
ExecStart=${wayvnc_bin} -C ${WAYVNC_CONF} 127.0.0.1 ${VNC_PORT}
Restart=always
RestartSec=3

[Install]
WantedBy=default.target
EOF

  write_websockify_unit "$ws_bin"
  systemctl --user disable --now computer-viewer-x11vnc.service >/dev/null 2>&1 || true
  enable_user_units computer-viewer-wayvnc.service computer-viewer-websockify.service
  note_linger

  echo
  echo "wayvnc + noVNC is less battle-tested than x11vnc. Prefer an Xorg session"
  echo "if the plugin cannot authenticate."

  print_paste "$pw"
}

refuse_gnome_kde_wayland() {
  local family="$1"
  echo "This session is ${family} on Wayland." >&2
  echo "GNOME/KDE Wayland is not supported yet (no x11vnc; wayvnc needs wlroots)." >&2
  echo >&2
  echo "Log into an Xorg / X11 session and re-run:" >&2
  echo "  - GDM: gear menu on the login screen → GNOME on Xorg / Ubuntu on Xorg" >&2
  echo "  - SDDM: Session → Plasma (X11)" >&2
  echo "  - Or: sudo mkdir -p /etc/gdm/ && then disable Wayland in custom.conf" >&2
  echo >&2
  echo "wlroots compositors (Sway, Hyprland, Wayfire, river, labwc) can use the" >&2
  echo "experimental wayvnc path — this desktop is not one of those." >&2
  exit 1
}

# --- main -------------------------------------------------------------------

SESSION="$(detect_session)"
echo "==> XDG_SESSION_TYPE=${XDG_SESSION_TYPE:-<unset>}  DISPLAY=${DISPLAY:-<unset>}  WAYLAND_DISPLAY=${WAYLAND_DISPLAY:-<unset>}"
echo "==> Detected session: ${SESSION}"

case "$SESSION" in
  x11)
    setup_x11
    ;;
  wayland)
    if [ -z "${WAYLAND_DISPLAY:-}" ]; then
      echo "Wayland session but WAYLAND_DISPLAY is unset. Open a terminal on the" >&2
      echo "graphical desktop (not a raw TTY) and re-run." >&2
      exit 1
    fi
    FAMILY="$(guess_wayland_family)"
    echo "==> Wayland family guess: ${FAMILY}"
    case "$FAMILY" in
      wlroots)
        setup_wayvnc
        ;;
      gnome|kde)
        refuse_gnome_kde_wayland "$FAMILY"
        ;;
      *)
        echo "Could not tell if this compositor is wlroots-based." >&2
        echo "GNOME/KDE Wayland is not supported. If you are on Sway/Hyprland/Wayfire," >&2
        echo "install wayvnc and re-run from a terminal inside that session." >&2
        echo "Otherwise log into an Xorg session and re-run." >&2
        exit 1
        ;;
    esac
    ;;
  *)
    echo "No graphical session detected (XDG_SESSION_TYPE=${XDG_SESSION_TYPE:-<unset>})." >&2
    echo "Run this from a terminal on the logged-in desktop, or log into an Xorg session." >&2
    exit 1
    ;;
esac
