# Changelog

## 1.0.0 — 2026-08-27

- Initial release.
- iMessage-style bubbles scoped to Bot Mode chats only; Sessions untouched.
- Grok-Bot gray palette: user `#4a4a4e` (right), assistant `#2b2b2e` (left),
  18px radius with a 4px tail.
- Cards, code blocks, tool runs, approvals, and thinking sections keep stock
  chrome via slot exclusions and a `:has()` split.
- Command-palette toggle ("Bubble Mode: toggle"), persisted per install.
- Pure CSS + body-class toggle; no core patches, no network, read-only SDK use.
- Built and verified against Hermes Desktop v0.20.5 (macOS).
