# Changelog (kit)

Per-plugin history lives in [bubble-mode/CHANGELOG.md](bubble-mode/CHANGELOG.md)
and [computer-viewer/CHANGELOG.md](computer-viewer/CHANGELOG.md).

## 2026-08-28 — bubble-mode 1.1.0 · texting-style 1.1.0

- bubble-mode: mixed text+code fix (1.0.1) and quiet chat — Bot Mode hides
  thinking/tool noise by default, "Bubble Mode: toggle work rows" restores it.
- texting-style: pre_llm_call backfill hook — eternal Bot Chat sessions whose
  frozen prompt predates the plugin get the doctrine injected per turn until
  a capability-epoch rebuild bakes the section in; then the hook goes silent.

## 2026-08-27 — texting-style 1.0.0

- New third plugin: `texting-style/`, a Hermes **agent plugin** that adds an
  SMS-register doctrine as a cache-safe system-prompt section
  (`register_system_prompt_section`, ≤4k chars, frozen per session).
- **Bot Mode only by default**: `bot_chat_only: true` gates the doctrine to
  sessions titled `Bot Chat` (the desktop's canonical per-bot conversation —
  the same gate core uses in `tools/bot_mode_probe.py`, read from the
  profile's `state.db`). Regular Sessions stay stock. `false` = everywhere.
- Config: `enabled`, `bot_chat_only`, `platforms` allowlist, `extra_rules`.
  No tools, hooks, or network.
- Own installer (`texting-style/install.sh`): symlinks from a clone or copies
  when curl-piped; discovers `~/.hermes` + `~/.hermes/profiles/*`; enables
  itself in each profile's `config.yaml`. Validated with `hermes plugins
  doctor` on v0.20.5.

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
