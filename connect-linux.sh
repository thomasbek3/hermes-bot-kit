#!/usr/bin/env bash
# This script moved to computer-viewer/connect-linux.sh (repo is now hermes-bot-kit,
# formerly hermes-computer-viewer). This shim keeps old one-liners working.
set -euo pipefail
exec bash <(curl -fsSL "https://raw.githubusercontent.com/thomasbek3/hermes-bot-kit/master/computer-viewer/connect-linux.sh")
