# This script moved to computer-viewer/connect-windows.ps1 (repo is now hermes-bot-kit,
# formerly hermes-computer-viewer). This shim keeps old one-liners working.
$KitRef = 'v2026.09.07.1'
Invoke-Expression (Invoke-RestMethod "https://raw.githubusercontent.com/thomasbek3/hermes-bot-kit/${KitRef}/computer-viewer/connect-windows.ps1")
