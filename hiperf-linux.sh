#!/usr/bin/env bash
# This script moved to computer-viewer/hiperf-linux.sh (repo is now hermes-bot-kit,
# formerly hermes-computer-viewer). This shim keeps old one-liners working.
set -euo pipefail
KIT_REF="v2026.09.07.2"
exec bash <(curl -fsSL "https://raw.githubusercontent.com/thomasbek3/hermes-bot-kit/${KIT_REF}/computer-viewer/hiperf-linux.sh")
