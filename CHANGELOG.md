# Changelog (kit)

## 2026-08-29 (evening) — bot-sections 1.0.0 → 1.4.5 in a day

- New fourth plugin matured through live iteration: named roster sections
  with counts and native-styled headers (1.0.0, Grok-built/Claude-reviewed);
  instant click-to-collapse; right-click menu — Rename…, New section…,
  Delete (custom sections); autosave editor (Enter or click-away saves,
  Escape cancels) with an iMessage-style smiley button that opens a
  scrollable 120-emoji palette; hover highlight + tooltip chips; real
  chevron carets.
- Hard-won plugin engineering documented in its BUILD-NOTES: the app's
  context menu opens on right-button mousedown from a boot-time capture
  listener (interception must catch the press), and its dismiss-layer
  locks the page with body pointer-events — plugin menus must exempt
  themselves.
- Cold-start ready (1.4.0): the config block is a one-time storage seed,
  shipped empty — fresh installs begin from a single Unassigned section;
  palette move-commands are auto-registered for every roster bot.

## 2026-08-29 — bot-sections 1.0.0

- New fourth plugin: `bot-sections/`, a desktop plugin that overlays named
  group headers on the Bot Mode roster (config block + per-bot palette
  cycle + automatic Unassigned). Root `install.sh` ships it with
  `KIT_SKIP_SECTIONS=1` to skip. Sessions and native gateway headings stay
  stock.

## 2026-08-29 — bubble-mode 2.1.0

- Quiet chat also hides background-process notification rows; agent-to-agent
  chips ("Message from X") always stay visible (2.1.0).
- The live composer is exempt from bubble styling — the 0.20.6 redesign had
  it inheriting the user-bubble shrink (2.0.1).

Per-plugin history lives in [bubble-mode/CHANGELOG.md](bubble-mode/CHANGELOG.md),
[computer-viewer/CHANGELOG.md](computer-viewer/CHANGELOG.md), and
[bot-sections/CHANGELOG.md](bot-sections/CHANGELOG.md).

## 2026-08-28 (final) — verified on Hermes v0.20.6

- Both Macs updated to Hermes Agent + Desktop v0.20.6 (Bot Mode redesign).
- bubble-mode 2.0.0 dual detection verified end-to-end on 0.20.6 (probe:
  body classes active on the selected Bot Chat tab; Scheduled Jobs signal
  confirmed). texting-style and computer-viewer verified compatible; the
  dock fix's converged right column (Computer over Scheduled Jobs) is live.

## 2026-08-28 (later) — bubble-mode 1.5.0 · computer-viewer fixes

- bubble-mode 1.2.0–1.5.0: SMS look gated to the canonical Bot Chat tab
  only; sticky tab memory survives the stock caption-scramble bug;
  iMessage-style "..." typing indicator (Grok-Bot-sized); per-reply timer
  chips hidden in quiet mode; stray empty pre-reply bubble fixed.
- computer-viewer: auto-connects when the bot starts using its computer
  (live-turn orgo tool rows; never on history renders); docks on top of the
  Cronjobs tile so stock's every-launch dock enforcement converges to one
  stable right column; overlay DOM moves guarded — the
  "Something broke in the interface" removeChild shell crash is fixed.
- texting-style 1.1.x: pre_llm_call backfill delivers the doctrine to
  existing eternal Bot Chats; session lookup searches all profile state.dbs;
  TS_DEBUG decision log; doctrine self-identifies as plugin-delivered.
- Docs refreshed across the repo to match all of the above.

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
