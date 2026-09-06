#!/usr/bin/env bash
# Install Bubble Mode only. Thin wrapper over the kit's root install.sh so the
# same pinned tag + MANIFEST.sha256 verification applies.
#
#   curl -fsSL https://raw.githubusercontent.com/thomasbek3/hermes-bot-kit/v2026.09.06/bubble-mode/install.sh | bash
#
# or from a clone:  bash bubble-mode/install.sh
set -euo pipefail

KIT_REF="${KIT_REF:-v2026.09.06}"
export KIT_REF
export KIT_SKIP_COMPUTER=1 KIT_SKIP_SECTIONS=1 KIT_SKIP_TASK_DOCK=1

SCRIPT_DIR=""
if [ -n "${BASH_SOURCE:-}" ] && [ -f "${BASH_SOURCE[0]:-}" ]; then
  SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
fi

if [ -n "${SCRIPT_DIR}" ] && [ -f "${SCRIPT_DIR}/../install.sh" ] && [ -f "${SCRIPT_DIR}/../MANIFEST.sha256" ]; then
  KIT_SOURCE_DIR="${SCRIPT_DIR}/.." exec bash "${SCRIPT_DIR}/../install.sh" "$@"
fi
exec bash <(curl -fsSL "https://raw.githubusercontent.com/thomasbek3/hermes-bot-kit/${KIT_REF}/install.sh") "$@"
