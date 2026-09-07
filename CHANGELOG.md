# Changelog (kit)

## 2026-09-07 — release v2026.09.07.1: three-reviewer hardening round

Findings from Claude, Codex (GPT-6 Astra) and Grok 4.6 passes, built by Opus,
reviewed and re-reviewed. Highlights:

- **Computer viewer.** noVNC bundle now actually loads from `vendor/` (the
  v2026.09.06/07 plugin looked one folder up and silently used the CDN); a
  tampered or unloadable bundle fails closed and is never cached; the status
  line and error bodies name the real reason. RSA server keys are pinned on
  first contact and a changed key disconnects (Advanced: "Forget pinned
  server key"); pins survive probe success and auto-reconnect. The HD token
  travels as the first WebSocket frame, not in the URL. Bare hostnames are no
  longer mistaken for API keys; public `host:port` never falls back to a
  plain-http page; the unauthenticated session fetch refuses redirects;
  remote clipboard sync is gated on the per-computer clipboard switch. The
  H.264 Exp-Golomb reader was returning inflated values (JS and Python).
- **HD agent + host scripts.** In-band auth frame (query-string token still
  accepted, deprecated); ownership-gated pipeline so a superseded viewer can
  never touch the live one; `hiperf-agent.py` download is digest-checked
  against the manifest (which the kit now installs alongside the plugins);
  Linux upgrades restart live units; Windows installers are pinned by hash
  (TightVNC, UltraVNC, Amyuni ZIP + extracted exe).
- **Bubble Mode / Task Dock / Bot Sections.** Settings reads cannot undo a
  newer toggle; decorated captions ("Bot Chat, 2 unread") still match; theme
  tokens instead of hard-coded dark colours; dead detection code removed;
  task ages no longer freeze; a module constant that shadowed `CSS.escape`
  renamed in all three plugins; first bot-sections tests; shared Bot Chat
  gate test matrix.
- **Python plugins.** Orgo control lock is cancellation-safe; screenshot size
  cap enforced while streaming; texting-style retries failed title lookups.
- **CI.** Syntax check parses every shell file; PowerShell files parsed on
  windows-latest; all suites run (58 JS, 26 HD agent, 27 orgo, 7 texting).

## 2026-09-06 — release v2026.09.06: pinned installs, verified manifest, vendored noVNC (issues #5 #10)

- **Installs are pinned and verified** (#10, #5). Every one-liner fetches from
  a release tag (`KIT_REF`, default `v2026.09.06`) and `install.sh` checks each
  file's SHA-256 against that tag's `MANIFEST.sha256` before copying anything;
  staged files are syntax-checked; a failed copy rolls back. `KIT_REF=master`
  still works but warns. `texting-style/install.sh` verifies too;
  `bubble-mode/install.sh` wraps the root installer.
- **noVNC is vendored** (#5). `computer-viewer/vendor/novnc-rfb.mjs` (1.7.0,
  MPL-2.0) is installed next to `plugin.js`; the viewer reads it through the
  desktop bridge, checks its SHA-256 against the hash pinned in `plugin.js`,
  and imports it from a blob. CDN only as a labelled fallback.
- **CI** on ubuntu + macOS runs every test suite plus the manifest check and
  an installer tamper test. `scripts/release.sh vYYYY.MM.DD` cuts releases
  (see `RELEASING.md`).

## 2026-09-06 — security hardening (issues #6 #7 #8 #9)

- **Host scripts bind to Tailscale or loopback, never `0.0.0.0` by default**
  (#7). `connect-*` and `hiperf-*` resolve one bind address: `CV_BIND` if
  set (`0.0.0.0`/`lan` for every interface, with a warning), else the
  Tailscale IPv4, else `127.0.0.1`. `hiperf-agent.py` defaults `--bind` to
  loopback. Windows scripts take `-Bind`. Printed paste addresses follow the
  bind. `SECURITY.md` now states the real model (plaintext `ws://`, tailnet or
  SSH tunnel as the boundary). Re-run the script on each host to migrate.
- **Computer viewer sends the API key only to the configured origin** (#6).
  One `authFetch` helper checks origin, requires https except for
  local/LAN/`.local`/Tailscale hosts, and refuses redirects. Public `http://`
  addresses are rejected at paste time. Agent plugin: `ORGO_API_BASE_URL` must
  be https (or loopback / `ORGO_ALLOW_INSECURE_HTTP=1`); foreign screenshot
  URLs are fetched without the bearer; httpx never follows redirects.
- **Viewer iframe is sandboxed** (#8): `allow-scripts allow-same-origin
  allow-forms`; clipboard read is a per-computer Advanced switch, off by
  default. The status line shows the embedded origin.
- **Installer keeps the Orgo key out of argv** (#9): `--api-key-stdin` and
  `--api-key-file`; `--api-key` still works but warns.
- Tests: `computer-viewer/plugin.test.mjs`, `tests/test-bind.sh`,
  `tests/test-install-agent-plugin.sh`, 7 new cases in `test_hands.py`.
- orgo-computer agent plugin 1.1.0 → 1.2.0.

## 2026-09-02 — task-dock 1.0.1

- Task Dock now requires bot profile and canonical session ID to agree before
  restoring cached tasks, and it remains mounted through transient transcript
  remounts. It also hides the captured stock source while enabled so the two
  panels cannot overlap. Multiple source widgets collapse to the newest single
  list, terminal lists auto-hide, and the persistent visibility toggle hides
  all task UI without letting stock bars flash back in. This prevents stale
  cross-bot panels, duplicate widgets, and random reappearance.

## 2026-09-02 — bubble-mode 2.1.1

- Bubble Mode now treats the stable Scheduled Jobs ownership pane as the
  complete Hermes 0.20.6+ Bot Chat signal. Prompt submission can remount the
  transcript without flashing back to stock session styling.

## 2026-09-01 — task-dock 1.0.0

- New desktop plugin: `task-dock/`. Copies the live **Tasks N/M** composer
  widget while it is on screen and re-renders a compact dock above the
  composer after the app clears the list on bot switch. Per-bot snapshots,
  ~1/s capture throttle, 24h expiry, palette **Task Dock: toggle**.
  Root `install.sh` ships it with `KIT_SKIP_TASK_DOCK=1` to skip.

## 2026-08-31 — bot-sections 1.5.0

- Agents (and you) can assign bots to roster sections by writing
  `~/.hermes/bot-sections.json`. The plugin polls the file every 5s and
  applies only when the contents change, so manual UI moves stick.

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
[computer-viewer/CHANGELOG.md](computer-viewer/CHANGELOG.md),
[bot-sections/CHANGELOG.md](bot-sections/CHANGELOG.md), and
[task-dock/CHANGELOG.md](task-dock/CHANGELOG.md).

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
