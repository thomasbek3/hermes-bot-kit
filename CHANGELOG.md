# Changelog (kit)

## Unreleased

- **Grokbot Override: the first message no longer vanishes (2026-11-10)**: in a new Bot Chat the bubble you
  just sent disappeared (empty state plus "Thinking…") until the reply came, because a transcript re-read
  that ran before the gateway stored the turn rebuilt the chat without it. A sent bubble now stays until
  its stored row arrives and is then replaced by it, with no duplicate.
- **The kit is slimmer (2026-11-10)**: it keeps Grokbot Override, the Computer pane (computer-viewer +
  orgo-computer), texting-style and the Slack pieces. **Bubble Mode, Task Dock and Bot Sections are
  retired** (their folders, tests and pictures are removed; history stays in git), and so are the six
  root forwarding shims (`connect-*.sh` / `hiperf-*` at the repo root; the real scripts are in
  `computer-viewer/`, and one-liners pinned to an older release tag keep working) and
  `REPORT-BOT-SECTIONS.md`.
- **Grokbot Override owns sections**: its own roster sections in its plugin storage (`sections`): + → New
  section, right-click a header to rename (inline, autosave), move up / down or delete (its bots go back
  to their default section; a confirm only when it has bots), click to collapse, and **Move to section →**
  on a bot's menu. A Bot Sections layout (sections, names, order, collapsed state, assignments) is copied
  in once on the first run; the Bot Sections storage is never changed.
- **Grokbot Override owns the work-rows setting**: **Grokbot Override: show work rows** in the palette
  (hidden by default, stored in its own plugin storage); Bubble Mode's old preference is copied once.
- **Installer**: installs Grokbot Override **switched on** (the committed `plugin.js`;
  `plugin.default-off.js` and its build target are gone; a toggle the user set before still wins), the
  Computer pane and, opt-in, the cards skill. `KIT_SKIP_BUBBLES`, `KIT_SKIP_SECTIONS` and
  `KIT_SKIP_TASK_DOCK` are gone. On upgrade it names any `bubble-mode`, `task-dock` or `bot-sections`
  folder that carries this kit's marker and says how to remove it; `KIT_REMOVE_RETIRED=1` moves exactly
  those folders to `desktop-plugins-retired-<YYYYMMDD>/` (never deletes, never touches other folders).
- **Ready for a new user**: every tracked file and picture now uses demo content (bot names, sections,
  workspaces, desktops); `tests/privacy-guard.test.mjs` (run in CI) keeps private host names, addresses,
  home folders, workspace ids, business and bot names and real email addresses out of every tracked text
  file. The Bot Sections and Computer pictures are new renders with invented content (old versions stay
  in git history).
- **Grokbot Override cards for everyone**: a generic agent-cards skill
  (`grokbot-override/skills/agent-cards/SKILL.md`: the `card.v1` file, the `::card` line, approval and task
  flows, when to show a card). `install.sh` installs it only with `KIT_CARDS_SKILL=1` (all profiles, or
  `KIT_CARDS_PROFILES`), leaves a user's own `agent-cards` skill alone, and `KIT_CARDS_SKILL=remove` takes
  the kit's copies out again. Question cards need no skill (Hermes's `clarify` tool).
- **Grokbot Override chat**: flat bot bubbles; a **Model** row in the profile panel; Bot Chats are desktop
  sessions (`source: 'desktop'`), so bots know markdown, files and cards render; clarify questions as inline
  choice cards; live `::card` (approval, task, draft-email) and `::preview` widgets drawn from the bot's own
  session, in the choice card's shell; a sidebar footer with your name and a Hermes Settings button; a
  **NEW** line above the first unseen message; no transcript jumps while scrolling past a live card, and
  message actions float beside the message.
- **Pictures and READMEs**: a new hero, cards, NEW line, footer and a three-step **Add to Slack** strip
  (`grokbot-override/screenshots/`), all from the preview harness with demo data; the root README leads
  the Grokbot Override part with one-click Add to Slack and its requirements.
- **Grokbot Override in the installer**: `install.sh` now installs it **switched off**
  (`grokbot-override/plugin.default-off.js`, verified against `MANIFEST.sha256`, installed as
  `desktop-plugins/grokbot-override/plugin.js`); **Grokbot Override: toggle** turns it on.
  `KIT_SKIP_GROKBOT=1` skips it. The avatar silhouettes were replaced with twelve original shapes, and
  `plugin.js` now carries the MIT notice for the layout CSS in `src/ui/styles-ref.ts`.
- **Grokbot Override (preview)**: a chat-app Bot Mode screen (`grokbot-override/`) built from
  source (`src/`, esbuild) into a committed single-file `plugin.js`. Same canonical Bot Chat
  as Bot Mode, read-only open path, toggle back to stock at any time. Capability parity: `grokbot-override/PARITY.md`.
- **Grokbot Override v2 (chat + roster parity merged)**: the roster-side parity (filter menu, retry for
  unreachable sources, pin / hide / show hidden, row context menu, create a bot, needs-attention badge,
  cron create / edit / run / remove, the bot's computer, profile config, model picker, context / cost
  meter) and the chat-side parity in one build, wired together: a new bot's Bot Chat is born through the
  chat side's `createCanonicalChat` with the intro (once); **Open in new tab** opens a second override chat
  tab; **+ → New group chat…** opens the gateway group-chat form; a member's failed group turn badges its
  row; the profile panel lists the bot's group chats instead of handing off to stock. Every roster dialog,
  the Bot screen and the status-bar meter render inside the override's error boundary. One loader-faithful
  test harness (`test/hermes-loader.mjs`): a smoke test of every surface (with and without the SDK's
  dialog / menu parts) and a click-through (roster → chat → repeated bot switches → profile → every dialog).
- **Grokbot Override chat parity (no handoff to stock in normal use)**: Bot Chat creation like Bot Mode
  (registry first, adopt on conflict, eager title); submission ids with a safe Retry of uncertain sends;
  clarify / sudo / secret / vault / connection prompts answered in the chat; full tool detail and
  owner-safe media; slash commands and skills, the `/new` guard and `complete.slash`; @mention notes and
  completions; edit / regenerate / rewind and reactions; voice input transcribed on the bot's own backend;
  chats side by side; unread dots and activity toasts; gateway group chats (rooms, posting, members'
  approvals, stop / continue, create / rename / disband). Tests: `grokbot-override/test/parity-*.test.mjs`
  and `test/loader-*.test.mjs`. Classic (desktop-orchestrated) rooms still open only in stock Bot Mode.
- **Grokbot Override fix: live Transcript crash**: switching bots crashed the chat tab and then the
  whole Hermes window ("l is not a function at Transcript"): a `useEffect` returned `true`, which React
  calls as the effect's cleanup when the transcript unmounts. Fixed, and both panes now render inside
  the override's own error boundary (inline error, **Try again**, **Turn override off**), so nothing
  can reach Hermes's root again. New loader-faithful tests (`test/hermes-loader.mjs`,
  `test/loader-*.test.mjs`) load the built `plugin.js` exactly as Hermes's runtime loader does
  (shim modules over the app's React namespaces, the loader's specifier rewrite, production React and
  react-dom, jsdom) and drive Roster click → open chat → Transcript for a local and a remote bot.
- **Grokbot Override review round 1**: an open chat on a pooled connection now holds a
  `host.retainProfile` lease for its whole life (the socket no longer closes between calls and
  reaps the runtime); stale approval reads can no longer disable a waiting approval; the idle
  refresh keeps earlier pages and unsent bubbles; resumed streams extend the right bubble;
  markdown renders in the owner-safe mode; late file reads cannot land on another bot; clarify /
  secret waits and `@mentions` hand off to Bot Mode; the profile panel is a drawer in narrow panes;
  `plugin.js` embeds every licence text it owes. Regression tests in
  `grokbot-override/test/review-r1.test.mjs`.
- **Grokbot Override review round 2**: a cron toggle that finishes after switching bots can no
  longer reload, relabel or re-arm the other bot's panel; events that land while a chat attaches are
  held and reconciled with the gateway (`session.active_list`, a fresh snapshot) instead of dropped,
  sequenced frames apply once, and a lost runtime re-attaches by itself; a completion can no longer be
  undone by a late `prompt.submit` receipt, and a busy watchdog settles turns the gateway reports idle;
  a route that cannot be held open makes no session call; closing the Chat tab or switching bots
  releases the chat (an in-flight send or running turn finishes first, bounded); handing a draft to
  Bot Mode never replaces an unsent stock draft without asking and is blocked while attachments are
  selected; failed sends keep their payload (restored to the composer, or **Retry**), and an
  uncertain one is "delivery unknown" until the history says otherwise; the narrow-pane profile
  drawer manages focus. Regression tests in `grokbot-override/test/review-r2*.test.mjs`.
- **Grokbot Override review round 3 (never send twice)**: a failed send is "not sent" only for the
  refusals Hermes's gateway contract defines (classified from the structured error, wrapped or not;
  `src/core/delivery.js`); 4090 `SESSION_OWNER_UNCONFIRMED`, timeouts and unknown errors are
  "delivery unknown", which is never restored to the composer and never offered for a resend, only a
  read-only **Check again** and **Open in Hermes Bot Mode** (the idle refresh also resolves it); a
  canonical 4001 refusal is no longer mistaken for a reaped runtime. A restored draft keeps its image
  staging, a removed image is detached before it can ride along with later text, and staging-only
  gateways get images in `prompt.submit` `attachments`. A replay-gap snapshot now recreates the live
  bubble (only the unshown segment). PARITY marks C6, C7, C28 and R16 Partial and R17 Fallback, with the
  unread/toast gap stated; README documents the supported Hermes commit and the 30-minute cap.
  Regression tests in `grokbot-override/test/review-r3*.test.mjs`.

## 2026-09-12 — release v2026.09.12: verified against Hermes 0.21.2

Re-verified the whole kit against hermes-agent `284d220ba4` (v0.21.2, 2026-09-11),
1221 commits on from the previous stamp. One real collision found and fixed.

- **Task Dock yields to the new composer session controls.** Hermes 0.21.2 added
  session automation controls (goal / loop / heartbeat) into the same composer
  status stack that carries the stock Tasks widget. Task Dock scanned that whole
  subtree with an unanchored `Tasks N/M` match against text, and those controls
  render user- and agent-authored prose in plain spans — so a loop "until" clause
  or a goal criterion reading "Tasks 3/3 done" was taken for a Tasks header, the
  control's body was hidden by the plugin's own rule, and a dock was published
  from someone's sentence. Header matching now anchors, the app's own status-stack
  widgets are skipped, and the hide pass refuses any node inside or containing
  one. Task Dock owns the stock Tasks list and nothing else in that stack.
- **Computer viewer:** `pl-0.5` went unused upstream, so it no longer exists in
  the app's compiled stylesheet and had silently zeroed one button's padding;
  swapped for `px-0.5` (same geometry).
- **Docs:** the desktop-plugin root is no longer profile-scoped — Hermes now
  resolves `<HERMES_HOME>/desktop-plugins` and migrates anything left under
  `profiles/*`. AGENTS.md and the computer-viewer README said otherwise. The
  Python halves are still per-profile.
- Unchanged and re-confirmed against the new build: zero SDK exports removed, the
  plugin contract, the runtime loader's import allowlist, the
  `desktopPluginsRoot` / `readPluginSource` bridge the vendored noVNC loader
  needs, every DOM anchor and `data-slot`, the Bot Chat caption and the
  routines-pane gate, and both Python plugins' doctor runs.

## 2026-09-07 — release v2026.09.07.2: per-agent Orgo screens

- **orgo-computer:** a profile can pin one of a computer's (up to four) screens
  via plugin config `screen`, env `ORGO_SCREEN`, or `hermes orgo-computer set
  --screen`; screenshot, click, type and key carry `?screen=`. Five agents can
  share one Orgo computer without touching each other's desktop.
- **computer-basics skill:** "Leave the computer clean" hygiene rule.

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
