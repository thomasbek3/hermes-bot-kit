# Changelog (kit)

Per-plugin history lives in [bubble-mode/CHANGELOG.md](bubble-mode/CHANGELOG.md)
and [computer-viewer/CHANGELOG.md](computer-viewer/CHANGELOG.md).

## 2026-08-27 — Hermes Bot Kit

- Repo renamed `hermes-computer-viewer` → `hermes-bot-kit`. GitHub redirects
  all old links.
- Merged `hermes-bubble-mode` (v1.0, history preserved) as `bubble-mode/`;
  that repo is archived.
- Computer viewer moved to `computer-viewer/`. Root shims keep every
  previously published `curl … | bash` / `irm … | iex` one-liner working
  (they fetch the moved script from its new path).
- New root `install.sh`: installs both plugins in one command
  (`KIT_SKIP_BUBBLES=1` / `KIT_SKIP_COMPUTER=1` to pick one).
- `RAW_REPO_URL` in `plugin.js` and the hiperf installers now points at
  `…/hermes-bot-kit/master/computer-viewer` so generated setup one-liners
  target the new layout.
