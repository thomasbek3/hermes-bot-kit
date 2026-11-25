# Changelog (kit)

## Unreleased

- **The doctor checks your own Hermes.** `install.sh --doctor` (and the end of
  every install) runs `scripts/check-hermes-compat.py`, CI-only until now,
  against the local Hermes Agent source (`<home>/hermes-agent`, or
  `KIT_HERMES_SOURCE`): one `OK` line with the Hermes version and commit
  (read from its `.git` files), a `WARN` listing each missing surface and the
  kit part it affects ("the kit may misbehave on this Hermes; check
  COMPATIBILITY.md / update the kit"), or one `skipped (why)` line without a
  source, a python3 3.8+ (macOS `/usr/bin/python3` 3.9 works; the Command Line
  Tools stub is never run) or a whole tree. Read-only, never fetches Hermes,
  never a FIX, never fatal. The checker now also runs from
  `scripts/hermes-surfaces.json` (what the kit uses, written ahead with
  `--write-surfaces`; CI checks it is current), which `install.sh --doctor`
  downloads with the doctor and checks against the release manifest. Its CI
  output is unchanged. Tests: a fake Hermes tree (`tests/fake-hermes-source.py`)
  in `tests/test-doctor.sh` (2c) and `tests/test-install.sh`.

- **`install.sh --uninstall` (fixes: an uninstall was undone by the next
  auto-update).** The old runbook moved the two desktop plugins out but left
  the daily job and `<home>/hermes-bot-kit/installed-release`, so the next
  release put them back. `--uninstall` (also through the curl one-liner) first
  turns auto-update off through the `--auto-update off` code path and stops
  with a non-zero exit, changing nothing, if that fails. Then it moves
  `computer-viewer` and `grokbot-override` to
  `<home>/desktop-plugins-removed-<ts>-<name>` and the records
  (`desktop-plugins/.hermes-bot-kit-install`, the installed `MANIFEST.sha256`,
  the `hermes-bot-kit/` folder with `installed-release`) to
  `<home>/hermes-bot-kit-removed-<ts>/`; nothing is deleted or restarted. A
  second run says nothing is installed and exits 0, and the doctor then reports
  "not installed" (INFO, exit 0) instead of a FIX per plugin. Agent plugins and
  `config.yaml` are never touched: it lists where each kit agent plugin was
  found with its README's removal steps. AGENTS.md's uninstall block uses it;
  the manual fallback block now turns auto-update off first. Tests in
  `tests/test-auto-update.sh` (`uninstall: …`), `tests/test-doctor.sh` (2b) and
  `tests/test-agents-runbook.sh`.

- **Computer Viewer: per-bot computers are scoped to the connection, not just
  the profile name (#26).** Two Desktop connections that both had a `default`
  profile shared one endpoint override. Bindings are now stored under the
  focused chat's `connectionId::profile` owner (`local::<profile>` for the
  local gateway); older profile-only bindings still apply as a fallback, `null`
  is an explicit **Use global default** and `false` is the new **No computer
  assigned** (disconnects). With no known owner only the global default
  applies. Auto-wake and remote-cua Take over use the same scope. Ported from
  JamRov's PR #26 with its regression tests. Tests in
  `computer-viewer/plugin.test.mjs` (`#26 …`).
- **Computer Viewer test fixture (#27):** the classifier test no longer uses a
  live-Stripe-shaped `sk_live_…` string; it uses `sk_test_FAKE_PLACEHOLDER`.
- **Grokbot Override: opening a bot clears its unread dot (#35).** Clicking an
  unread row opened the chat but the blue dot and the "More unreads" pill
  stayed. The override only called `ackStoredSessionId`, which retires
  Hermes's persisted unread marker; the dot paints from core's transient
  unread list, which stock clears only when a chat is selected in core's own
  chat pane, a path the override's chat never takes. Opening a bot now also
  calls `forgetSessionUnread` for its Bot Chat ids under the bot's profile,
  and the bot whose chat is on screen is read again on new activity instead
  of left to be lit. Test: `grokbot-override/test/unread-ack-35.test.mjs`.
- **Daily auto-update: `install.sh --auto-update on|off|status|run`.**
  Hermes's plugin auto-update never touches `desktop-plugins/` (and treats
  monorepo sub-folder installs as provenance drift), so the kit updates
  itself. `on` stores the knobs that apply (`HERMES_HOME`, `KIT_SKIP_GROKBOT`,
  `KIT_SKIP_COMPUTER`, `KIT_TEXTING_STYLE`, `KIT_POST_UPDATE_HOOK`; no secrets)
  in `<home>/hermes-bot-kit/auto-update.env` (0600), copies the updater to
  `<home>/hermes-bot-kit/update.sh` and installs a daily 04:20 job: a
  LaunchAgent bootstrapped into `gui/<uid>` on macOS (`RunAtLoad` false; over
  ssh it prints the command), a systemd user timer (`Persistent=true`) on
  Linux or a crontab line without one. Windows/WSL: not supported yet. `run`
  installs the newest release when it is newer than
  `<home>/hermes-bot-kit/installed-release` (now written by every install),
  with `KIT_REF=<tag>`, after checking that tag's `install.sh` against its
  `MANIFEST.sha256` (which now lists `install.sh`). Single instance via a
  kernel lock (`flock(1)`, or perl on macOS; released when a run exits),
  network failure = log and exit 0, one log line per run in
  `<home>/logs/hermes-bot-kit-update.log` (rotated at 1 MB). It never restarts
  Hermes. Optional: refresh texting-style copies (never through a symlink
  anywhere in the path, never new profiles) and run your own post-update
  hook (owner-only file in owner-only folders; a private copy is what runs).
  The updater copy is only replaced by an installer that has auto-update
  (`KIT_AUTO_UPDATE_API=1`); an older release is installed but not used as
  the updater. `on` saves the settings and updater before it loads the job,
  and `run` does nothing without saved settings. `HERMES_HOME` is resolved to its physical
  path for every subcommand, so a symlinked home is one home; `off` fails
  while a job for the home remains (every `launchctl`/`systemctl` result is
  checked) and a retry finishes it. A texting-style copy that can't be
  refreshed is logged per profile as `texting-style FAILED`. The hook's
  folders are checked on its path as written and as resolved. The doctor reports
  the auto-update state. Tests: `tests/test-auto-update.sh` (fake launchctl,
  systemctl and curl).
- **Qualified on Hermes v0.23.3 (2026-11-21).** Stable v0.23.3 (`caafe538`,
  released 2026-11-20) passes every source contract (SDK, host, context,
  gateway, REST, bridge, DOM, agent hooks); no breaking change was found in
  the contracts the kit uses (upstream added optional fields, one SDK export and
  new gateway methods), so no code change was needed
  and the minimum stays **0.23.0**. The remote-cua, slack-connect, slack-check,
  email-drafts and texting-style tests also ran against the real v0.23.0 and
  v0.23.3 code (same results on both), and `hermes plugins validate` from each
  release passes the four agent plugins. CI's source-contract job now checks
  v0.23.3, v0.23.0 and main (was v0.23.2 and main). See
  [docs/COMPATIBILITY.md](docs/COMPATIBILITY.md#what-changed-in-v0233-for-the-kit).
- **remote-cua on v0.23.3: update the Mac's cua-driver.** Hermes v0.23.3 moved
  its cua-driver pin from 0.21.0 to 0.52.0, and remote-cua requires the remote
  Mac's driver to match the gateway's pin, so after updating the gateway the
  Mac needs cua-driver 0.52.0 (README step 2). Until then the check says which
  version it found and which it wants. Not yet run live with 0.52.0.
- **Known gap:** stock Bot Mode's new "teammate waits" banner above the
  composer (v0.23.3) does not show in Grokbot Override's chat.

## 2026-11-19 — release v2026.11.19: one-sentence agent install, security audit

First GitHub Release since v2026.09.12. For new users, in short: tell your AI
agent "install https://github.com/thomasbek3/hermes-bot-kit" (it follows
`AGENTS.md`), or run the one-line installer, then reload plugins. Everything
below shipped in tags v2026.11.09 to v2026.11.16.3 without a GitHub Release, or
is new in this one.

- **Install: the newest release by itself (2026-11-19).** With no `KIT_REF`,
  `install.sh` asks the GitHub API for the newest release, accepts only a
  `vYYYY.MM.DD[.N]` tag, and never installs one older than the tag it was
  published with (`KIT_FALLBACK_REF`, rewritten by `scripts/release.sh`). No
  network or an odd answer falls back to that tag. Every file is still checked
  against the chosen release's `MANIFEST.sha256` before anything is copied.
  `KIT_REF=<tag>` pins, `KIT_REF=latest` asks. Remote-mode installer tests
  (fake curl: API ok, down, malformed, older, explicit ref).
- **Docs: point your agent at it (2026-11-19).** README opens with a
  three-line quick start. `AGENTS.md` is a step-by-step runbook for macOS and
  Linux (prerequisites, install, verify, reload, add-ons, uninstall,
  troubleshooting); every command exits non-zero on failure. New
  `docs/SLACK.md`: Socket Mode or one-click Add to Slack, with the steps only
  the human can do marked, where tokens live, who can talk to the bot, the 👀
  acknowledgement and the home channel.
- **First run: works on stable Hermes, and says why when it doesn't
  (2026-11-19).** The kit's instructions said **⌘⇧P → Reload plugins**, which
  is not a Hermes shortcut: the palette is **⌘K** / **Ctrl+K** (or ⌘P), and the
  command is **Reload desktop plugins**. Fixed in the installer's closing
  lines, README, AGENTS.md and the plugin's own notices. Plugin switches are
  under **Capabilities → Plugins**. Every Hermes surface the two desktop
  plugins use (SDK names, host and context members, 91 gateway methods and
  events, REST routes, the desktop bridge, DOM anchors) was checked against
  stable **v0.23.2** and **v0.23.0**: all present, with the same params, so no
  fallback was needed. The minimum is now stated honestly as **0.23.0** (it
  said 0.20.5; v0.22.7 and v0.21.7 fail the check).
  `scripts/check-hermes-compat.py` now covers Grokbot Override too, and CI
  checks stable v0.23.2 and main. New **doctor** (`install.sh --doctor`, or
  `scripts/doctor.sh` from a clone): read-only, one OK/FIX/INFO line per check
  (Hermes Desktop version, the Hermes home Desktop uses, folder names and
  places, profile-scoped copies, checksums against the installed release,
  retired plugins, WSL and second-install traps), each FIX with its command,
  ending in a paste-able summary with home paths, usernames and token-shaped
  strings redacted. README gains **Getting started** (what you should see at
  each step) and **Troubleshooting**; GitHub issue forms ask for the OS, the
  Hermes version and the doctor summary. The doctor checks every file of each
  plugin against the installed manifest; finds Hermes Desktop for Windows'
  home in the order Desktop does (registry, `%LOCALAPPDATA%\hermes`, the
  legacy `~/.hermes`), and from WSL checks that home when it can see it, else
  says the home is unverified and exits 2; ignores a backup copy nested
  inside a plugin folder (Desktop loads only one level down). Its issue
  summary holds only versions, plugin names, a home category and
  OK/FIX/INFO per check: no paths, usernames, tokens or file contents.
  **Downloaded alone, `install.sh` never uses files beside it** (the
  one-liner's temp dir can be a shared `/tmp`): it copies from a local tree
  only in a git checkout you own (or with `KIT_SOURCE_DIR`; from an
  unpacked zip you trust: `KIT_SOURCE_DIR="$PWD" bash install.sh`), and
  `--doctor` runs a local doctor only there, else it downloads and verifies
  the release copy. The doctor's fixes never run a local file: every repair
  command is the release's pinned download-then-run one-liner, a `mv` line
  or a plain instruction. In WSL it also reads a `HERMES_HOME` set in the
  Windows registry, as Desktop does; if it can't, the home is unverified
  (exit 2), including when reading it is refused. The README's Windows check
  finds the same home as Desktop, and Windows CI runs it as written. Every
  doctor repair command single-quotes its folder paths, so a folder name
  with quotes, spaces, `$(…)`, backticks or `;` is moved, never run; a name
  with a line break gets a plain instruction instead. A new Mac without the
  Command Line Tools no longer aborts the install: Apple's `/usr/bin/python3`
  stub is never run (no install dialog), any other `python3` is probed with
  a 10-second limit, and without a working Python the optional HD-helper
  check is skipped with an INFO line while the plugins are still verified
  and installed. The installer's syntax check parses the plugins as ES
  modules, so it no longer aborts on older Node or with ESM detection off.
  The Windows steps include copying `MANIFEST.sha256` and a one-line
  PowerShell check.
- **Security audit (2026-11-19), a partial pass.** A source-only audit with
  Cloudflare's security-audit skill (full-audit mode, stopped early after five
  waves). Two areas were **not reviewed**: the bot's terminal and file tools
  versus the remote-cua take-over lease, and Duplicate bot versus Slack
  credentials. Three low-severity findings were confirmed and fixed: the
  privacy-guard tests no longer spell the private values they guard against, a
  reversible VNC password blob was removed from the build notes, and
  email-drafts "Allow recipient" is bound to the revision and addresses on
  screen. Fifteen leads that could not be confirmed from source were changed
  in source but **not checked on a live system**; a second review found eight
  of those first fixes incomplete, and they were redone (below). See
  SECURITY.md.
  - Mitigated in source: the `/email-drafts` slash command changes drafts only
    from Hermes Desktop/TUI (never from a messaging platform); replies show
    their Gmail thread; bot-named SVG images never open as their own window;
    Slack first-DM approval shows the member ID; the Computer viewer ends the
    old session at once when you switch computers; the macOS docs no longer
    claim Screen Sharing is loopback-only; texting-style's debug log moved out
    of `/tmp`.
  - Redone after the second review: **Linux X11** stores the VNC password in a
    0600 file it validates (a bad, linked or loose file is replaced) and no
    longer crashes printing it. **Windows:** Python is used only from an
    all-users install whose exe, folders and import locations are admin-only,
    checked before it is first run, always in isolated mode (`-I`); HD's ffmpeg
    gets the same check; a `C:\ProgramData\hermes-cv` tree or a
    `C:\usbmmidd_v2` folder another account created is refused, not adopted, and
    driver files are staged in a fresh admin-only folder and moved in only
    after a last check; UltraVNC's config is locked down before the password is
    written, then verified (ACL, password, loopback) and, after start, the
    :5900 listener must be loopback-only, or UltraVNC is stopped and TightVNC
    restored; the VNC password file's ACL is replaced and verified, never
    best-effort; a new or replaced password is applied to the running TightVNC
    server and read back before it is printed, and is no longer passed to
    msiexec; it is rotated when the old one was readable by other accounts (in
    its file or in TightVNC's registry key, which is now locked to
    Administrators and SYSTEM); `UseVncAuthentication`, `AllowLoopback` and
    `LoopbackOnly` are written and read back every run, and any failure stops
    setup. The HD venv is reused only if it was built on the checked machine
    Python and nobody else could change it; otherwise it is rebuilt (links
    deleted as links, never followed). If UltraVNC has to be backed out, setup
    stops only the kit's own UltraVNC, confirms it stopped and that TightVNC is
    on loopback only, or stops; another program on :5900 is named, not killed.
    TightVNC's registry key is locked before the password is written, and an
    HD token whose original permissions let other accounts read or change it
    is replaced; the kit's HD task is restarted on the new token, and setup
    confirms the kit's own agent is running and holds the HD port before
    printing it (the token is never sent anywhere; a rotation-pending marker
    makes a re-run finish an interrupted rotation). Reconnect the HD viewer
    with the new token to confirm.
    **Computer viewer:** one check parses each address once (ws/wss, or
    http(s) mapped to them; nothing else, no credentials in the URL, plaintext
    only to a private host), and the connection uses that checked address, for
    a saved computer and a session-API reply alike; the legacy auto-connecting "This Mac" entry
    is unselected and stops auto-connecting for upgraders too (once; you can
    delete it). **Preview pages** never send on their own: Send always needs
    your click and sends the text shown. **Skills hub:** one-click Install is
    offered only for a result with a source-qualified identifier. Hermes's hub
    search returns names only, so today that is none: each result shows its
    name, its source and a copyable, safely quoted
    `hermes -p '<profile>' skills install '<name>'`, with a pointer to
    `hermes skills search` to check the source first.
- **Slack: who can talk to the bot (2026-11-19).** Unchanged in this release:
  after one-click **Connect**, only the person who clicked **Allow** can talk
  to the bot (`SLACK_ALLOWED_USERS` = that member). To let teammates in, add
  their Slack member IDs to `SLACK_ALLOWED_USERS` in the bot's profile `.env`
  (`~/.hermes/profiles/<bot profile>/.env`) and restart or reload the bot;
  `docs/SLACK.md` has the step, and says that anyone on the list can make the
  bot act with its own access. Team-wide access by default is coming in the
  next release.
- **Install: no downgrades, complete manifests, timeouts (2026-11-19).**
  `install.sh` records the installed release
  (`desktop-plugins/.hermes-bot-kit-install`) and, when it picked the release
  itself, never replaces a newer one with an older one. A manifest that lacks
  a plugin the release should have, or is empty, stops the install. Every
  download has a connect timeout, a total timeout and a size cap. The quick
  start and `AGENTS.md` download the installer to a file and run it, so a
  failed download is an error, not an empty script; `AGENTS.md`'s verify step
  checks every recorded plugin against its digest.
- **Computer viewer: plaintext guard covers http: addresses (2026-11-19).** A
  public `http:` HD address is refused like a `ws:` one (it becomes plaintext
  `ws:`); SECURITY.md now says the HD token goes in the first frame (with the
  legacy `?token=` still accepted).
- **Hermes 0.23.2 canary checked (2026-11-18).** Source contracts and the
  offline suites pass; see `docs/COMPATIBILITY.md`.
- **Slack: `reactions:write` by default, a missing-scope warning and an
  add-only repair (2026-11-18).** New bots get the scope the 👀
  acknowledgement needs. **Test connection** warns when an older app lacks
  it, and `scope_repair.py` adds only the missing required scope.
- **grokbot-override: unread dots (2026-11-19).** A Grok-Bot-style blue dot on
  the right of each bot with unread messages, and a **More unreads** pill when
  unread bots are scrolled out of view. Remote and SSH bots don't get dots yet.
  (Details in the unread-look entry below.)
- **grokbot-override: the bot's computer (2026-11-18).** The profile panel's
  Computer card shows a thumbnail; the viewer wakes the screen on open,
  recovers by itself, has a Close icon, a visible pointer and its controls as a
  pill under the desk image. SSH bots keep the name their own gateway holds.

Also in this release (merged since v2026.09.12, details below):

- **grokbot-override: Grok Bot unread look and "More unreads" (2026-11-19)**: an unread bot row shows a small blue dot
  at its right edge, vertically centred, instead of the green badge on its avatar (it is still Hermes's own status dot,
  restyled, so Hermes's unread store stays the only record; marking and the ack on open are unchanged). Hermes's
  running cue (working, stalled, background) keeps its own dot on the avatar. A blue "More unreads" pill (#1366D6,
  white text at 5.4:1; hover #0B59BE) floats at the top or bottom of the roster while an unread row is less than half
  in view that way; a click (or a key: the pills are buttons named "More unreads above" / "below" and come before the
  rows in tab order) scrolls to the nearest one, instantly with Reduce Motion, and moves focus to it, also at a UI scale
  other than 100 % (CSS zoom). Row offsets and the view height are measured together on structure or layout changes
  (MutationObserver, not for changes inside a row such as an avatar's picture; ResizeObserver), so a resized
  roster, a late observer entry or a large scroll jump never turns the pill the wrong way; scrolling reads no layout and
  selecting a row re-registers nothing. Remote and SSH bots have no dot yet. New `src/core/unreadPill.js`,
  `src/ui/UnreadPill.tsx`; tests `test/unread-look-45.test.mjs`, `test/loader-unread-dot-45.test.mjs`,
  `test/loader-unread-pill-45.test.mjs`, `test/loader-unread-pill-geometry-45.test.mjs`,
  `test/loader-unread-running-45.test.mjs`.
- **grokbot-override: T3 Code links get the T3 Code logo (2026-11-16)**: a source link to `t3.codes` (e.g. `app.t3.codes/threads/…`) draws with T3 Code's own favicon, inlined as a data: PNG, instead of the neutral globe; lookalike hosts such as `t3.codes.evil.io` stay a globe.
- **grokbot-override: the "delivery unknown" composer note clears itself (2026-11-16)**: after a send whose answer
  was lost (e.g. the connection was torn down and respawned mid-send), the line under the composer now follows the
  chat's history check: "Checking whether your message went through…", gone as soon as the message is found in the
  history, "Couldn’t confirm this message was sent. Check the chat before resending." when it is not found or the
  history cannot be read. The next send to that bot (from any tab showing it) or a bot switch clears it, and an
  older send that settles after a newer one never brings it back. It still never offers a resend; a definite
  refusal still puts the text back in the composer. Tests `test/delivery-unknown-note.test.mjs`.
- **grokbot-override: light background polling on a struggling remote gateway (2026-11-16)**: the own roster read
  (`profiles.list` with session summaries + `host.agents()`) runs at most once per 60 s instead of every ~15 s. All
  background polls (roster, source re-list, room list, one idle-refresh pass per connection over every open chat) go
  through one scheduler: never two at once on a connection (the union roster, which reads every registered non-SSH
  connection, is its own poll that waits until no other background poll runs, reserving its lanes once due so busy
  connections cannot starve it; the active connection's rich read only holds that connection), a failure, a failed source or a > 2 s
  answer doubles the interval (cap 5 min) and a fast success resets it, a run past 30 s lets other polls go on, starts
  no further request and has its late answer dropped (the same read is not reissued until it settles), the idle pass
  rotates past every attempted chat so a slow or timing-out chat never holds the others back, nothing polls while the window is hidden, and every
  poll is due once when it is visible again (however short the hide, also when the visibility event never arrives). Older background
  answers never overwrite a newer foreground read; stopping the plugin drops late answers and follow-ups. Foreground
  calls (switch bot, open a chat, send, a write's re-read, Retry, create/disband a room) are never delayed. The full
  `profiles.list` stays because previews, unread dots, activity toasts and the Bot Chat a click opens come only from
  its session fields, and the handler has no lighter option than `include_sessions: false` (see PARITY,
  Architecture notes). Idle with one remote connection and an open chat: about 17 requests a minute (3.3 full
  roster reads) before, about 11 (1 full roster read) after, none while hidden. New `src/core/backgroundPolls.js`,
  tests `test/light-roster.test.mjs`.
- **computer-viewer: native computer_use, Take over / Hand back, Orgo removed (2026-11-15)**: the pane now opens on
  Hermes's own `computer_use` and `browser_*` tool calls (live `tool.start` only, never replayed, once per bot per
  30 s, a manual close holds 30 s) for a bot with its own bound computer, instead of on Orgo tool rows. Computers the
  bot drives through the kit's `remote-cua` plugin get Hermes's Bot Screen controls: "Bot is in control" /
  "You are in control" chip, **Take over** (red border, input on), **Hand back**, closing the pane or Disconnect
  hands back, a dropped connection keeps the lease, **Hand back (force)** after a reload; view-only while the bot
  holds control; the plugin's status check in plain words. Removed: the `orgo-computer` agent plugin, `orgo-term`,
  `orgo-hands`, Orgo API-key discovery and the Orgo session parser, `install-agent-plugin.sh`. New
  `computer-viewer/remove-orgo-computer.sh` (dry run, `--yes`) removes an installed `orgo-computer` from profiles;
  `install.sh` names it when it finds one.
- **computer-viewer: Take over talks to remote-cua's dashboard routes (2026-11-15)**: the pane now calls
  `/api/plugins/remote-cua/{lease,take,release,status}` on the bot's own connection and profile through Hermes
  Desktop's REST bridge (`window.hermesDesktop.api`, a private Hermes touch point, documented in the
  computer-viewer README), instead of gateway RPC. It reads the plugin's exact lease and status shapes, shows the
  status `summary` lines, re-checks with `?fresh=1` on **Check**, and shows a refused take or release (409) with
  the plugin's message and the current holder.
- **computer-viewer: control fixes from review (2026-11-15)**: input goes off when Hand back starts and stays off
  after a lost answer until a fresh lease read; stale lease answers (older epoch, or sent before a take, hand back,
  close or switch) are ignored; closing, Disconnect or switching bots during a pending Take over hands the late grant
  back without reopening the pane; the lease is asked of the bot's own `(connectionId, profile)` route and the pane
  fails closed when that is ambiguous or unknown; tool calls from another gateway no longer wake it; a bot-driven
  computer shown as an embedded page is `inert` and watch-only. `remove-orgo-computer.sh` now refuses (exit 3, no
  changes for that profile) any config form it cannot rewrite safely, and validates its edit before replacing.
- **computer-viewer: control fixes from review round 2 (2026-11-15)**: lease changes per gateway are serialized
  (a late close-release can no longer undo the next Take over); every lease this window may hold, including a take
  whose answer was lost, is handed back (with retries) whenever the pane stops controlling that machine, including
  removing the binding; the gateway is picked by the focused chat's `focusedSessionOwner`, never the active socket,
  and fails closed when unprovable.
- **computer-viewer + remote-cua: a forced hand back clears only the lease it saw (2026-11-16)**: **Hand back
  (force)** now sends the epoch of the human lease the pane saw, and remote-cua's `release` clears only that
  lease (409 `stale_force` once it has changed hands; `lease.release(expect_epoch=…)`). Before, a forced
  release that timed out but committed later (after the old viewer handed back and this pane took over under
  a new id) revoked the new grant while the pane's input stayed on. `epoch` is required with `force`: a
  forced release without one (an older pane, a script, `"epoch": null`) is refused with 400
  `force_needs_epoch` (`lease.ForceNeedsEpoch`), since a delayed epoch-free force could still revoke a later
  take-over; scripts GET the lease first and send its epoch, and the pane never sends a force without one.
  Round 3's "a late release can never revoke a later grant" now holds for forced releases too.
- **computer-viewer: control fixes from review round 3 (2026-11-16)**: a lease change with no answer retires its
  viewer id, so a release that commits late can never revoke a later grant (Package P's release only clears the
  viewer it names), and Take over re-reads the lease and waits while an old id of this window holds it; a focus
  change fences input and hands back the old gateway synchronously; owner lookups are sequenced and tied to the
  plugin's lifetime, so a stale or post-unload lookup changes nothing and arms no polling. The README lists the
  known limits.
- **remote-cua: Hermes's own computer_use on a remote Mac (2026-11-15)**: a new per-profile agent plugin,
  [`remote-cua`](remote-cua/README.md). With `computer_use.backend: remote-cua` and a `remote_cua` block
  (`host`, `user`, `os`, optional `driver`, `vnc`) the bot's native `computer_use` (schema, approvals,
  Hermes's cua-driver backend) drives a Mac over SSH: the driver is found on the Mac (config, then the
  gateway's pinned version under `~/.hermes/tools`, then PATH) and checked (version pin, Hermes's driver
  contract, CuaDriver.app signature), a private daemon is started through that exact `CuaDriver.app`
  (`open -n -g -a <path>`, never by name), and Hermes's MCP session runs over one `ssh -T -o BatchMode=yes`
  connection; the daemon is stopped on session end, at exit, and after a crash on the next start. A
  take-over lease (`<profile>/remote-cua/lease.json`) refuses `computer_use` with `human_has_control` while a
  human holds it; the Computer pane changes it through `/api/plugins/remote-cua/` (`lease`, `take`,
  `release`, `status`, see [computer-viewer/docs/REMOTE-CUA.md](computer-viewer/docs/REMOTE-CUA.md)).
  `hermes remote-cua check` reports reachability, driver, permissions and screen state. `os: windows` is
  accepted and refused with "Windows support coming: needs cua Session proxy". Hermes internals it uses are
  version-gated (`>=0.23.0,<0.24.0`, [CONTRACT.md](remote-cua/CONTRACT.md)). Linux VMs: Hermes's native
  `terminal.backend: ssh` path, documented in [docs/LINUX-VM.md](docs/LINUX-VM.md).
  Review round 1: the lease fence covers a whole action, a capture's CLI re-fetch included; a screenshot
  path in a remote answer is never read on the gateway; daemons are recorded before launch and forgotten
  only after a confirmed stop (no socket unlinked while the daemon still answers; unconfirmed stops are
  retried); the status probe runs on that managed lifecycle and is READY only with both permissions and
  a visible window; the installer checks the Hermes version before copying and enables through
  `hermes plugins enable`.
  Review round 2: every send to the driver is lease-checked right before it goes out, Hermes's own
  reconnect and ended-session replays included, and an action whose lease moved raises Hermes's
  `HumanHasControl` instead of returning; a daemon counts as stopped only when its driver says "not
  running" (a missing driver or any other status failure keeps the record and socket); the daemon
  record file is updated under an inter-process file lock. Review round 3: an action refused at its
  start also forgets the last capture target, so a hand-back always needs a fresh capture.
- **grokbot-override: source links with service logos in bot replies (2026-11-15)**: a markdown link in a
  bot's reply to a known service now draws as the service's small logo (14 px, full colour, a fixed box so
  nothing shifts) plus its underlined text, like "Her message" next to the Slack logo. About 27 services are
  recognised by exact host or subdomain (lookalikes such as `slack.com.evil.io` are not); any other public
  site gets a neutral globe, never a fetched favicon. A bare URL gets a short label ("Slack message", "Gmail",
  "GitHub PR #12"). A click opens it through the plugin SDK's `openExternal`; a Slack permalink opens on
  slack.com, which hands off to the Slack app at that message (no team id is ever guessed). A `slack://channel?team=…&id=…&message=…`
  app link is carried past the renderer's link sanitizer and tried as itself first (the exact message);
  when the host refuses app schemes, as Hermes does today, it opens that channel on app.slack.com. This is a
  known limit (PARITY.md): Hermes's opener admits only http/https/mailto, so bots are told to use https
  permalinks, which open the exact message. Titled, `<angle>`, upper-case and reference-style Slack links are
  carried too; code, indented code and escaped text are never rewritten. Heading and table-header links get the
  same logo, title and short bare-URL label, kept up to date as the reply streams. Unsafe links,
  `mailto:`, private hosts and code stay as before. Logos are Simple Icons (CC0, bundled); dark marks such as
  GitHub and X switch to the light text colour in dark mode. A bare URL still typing waits until it ends, so
  its chip never changes mid-stream. The agent-cards skill gains "Link your sources": end a line about a
  specific message, email, doc, ticket, PR or event with `[short label](permalink)`, with how to build Slack
  and Gmail permalinks.
- **grokbot-override: one guarded contract for private Hermes internals (T10, 2026-11-15)**: every private
  dependency (window-chrome DOM anchors, Bot Mode's roster cache key and localStorage keys, the
  `window.hermesDesktop` bridge calls, the gateway event names) is listed in `src/core/contract.js` with a
  read-only probe. Each window-chrome rule is now written only while its anchor is in the DOM, so a Hermes
  update that renames one drops that rule instead of hiding the wrong thing. The self-check report gains a
  `contract` block, and a missing required entry shows one quiet notice per app session. No behaviour change
  while everything is present.
- **grokbot-override: the composer keeps a draft per bot (T8, 2026-11-15)**: switching bots used to clear what
  you had typed. The composer now keeps the typed text per bot and puts it back when you return, as Hermes's
  own composer does per session. Text only (never attachments), in memory for this app session, up to 20 bots,
  kept whole however long; a send clears it. Text Hermes did not take (a refused send, a failed free-text
  answer) always comes back to that bot's composer, below anything newer, even after switching bots; files
  come back only into the same composer, otherwise a note asks to attach them again.
- **grokbot-override: native notifications from override chats (T7, 2026-11-15)**: Hermes only fires its OS
  notifications for sessions its own message stream owns, so a reply or an approval in an override chat made
  none while Hermes was in the background. The open chat now sends them through the plugin door
  `ctx.os.notify`: reply finished, approval waiting, input needed (clarify, sudo, secret, vault, connection).
  Only while the Hermes window is not focused, once per reply / card / prompt, never for a silent reply or a
  failed turn, and with generic bodies only. Clicking one opens that bot. Needs a live check.
- **grokbot-override: switching back to a bot shows its chat at once (T9, 2026-11-15)**: every bot switch went
  through the centred "Opening …'s chat" card and then popped in the transcript, and the profile panel blanked its
  jobs and computer status. The last eight bots' transcripts, scheduled jobs and screen status are now kept in
  memory: going back shows them straight away while the Bot Chat registry, history, jobs and status are re-read in
  the background. If the bot's Bot Chat changed meanwhile, the remembered transcript is dropped and the chat opens
  the normal way. The remembered transcript is only a picture: until the registry check and history read are done
  the composer is disabled (as on any open) and any action is refused at once, never queued; a failed check shows
  the usual error and forgets the remembered chat, so nothing can reach a replaced Bot Chat. The fresh read merges
  into the remembered rows, keeping earlier pages. A chat whose history came from the `session.resume` fallback (no
  REST history bridge) is remembered too. Opening a replacement of the open bot's Bot Chat through Hermes opens
  the replacement, never the old chat still on screen.
- **grokbot-override: Hermes's own session views work again (T3, 2026-11-15)**: the override claimed the main
  pane back on every session focus, so session search, a notification click, a cron run's "open", ⌘N and artifact
  links were undone at once. Start-up and reload still land on the override's chat tab. After that (the first
  click or key press, or 10 s), a session that is a roster bot's Bot Chat opens in the override with that bot
  selected; any other session, or a new draft, stays in Hermes's own view until you go back to the override. This
  is decided by the session Hermes has focused when its view comes up, so ⌘N with nothing open and re-opening the
  same session work too; closing the override's tab still reopens it. The
  computer-viewer status now reads the SDK's `paneVisibility` first; the layout-tree query remains only to tell
  that a hidden viewer pane exists.
- **grokbot-override: the roster tick no longer re-renders the open chat (T2, 2026-11-15)**: the 3 s roster
  refresh used to hand the store new row objects and a re-parsed Bot Mode meta on every tick, so the open chat
  re-rendered its whole transcript every 3 s. Rows equal to the last read now keep their objects (and the list
  its array), Bot Mode's local meta is re-parsed only when its stored text changes, and a tick that changed
  nothing leaves the roster state untouched.
- **grokbot-override: images and recordings keep their size, and streaming no longer re-renders old messages
  (2026-11-15)**: an image from the bot's machine is decoded before it shows and drawn with its width and height
  (clamped to 360 px wide), instead of a fixed 160×110 box that then jumped to the image's size; the size and the
  decoded image are remembered per bot and path, so switching bots and coming back draws it at once in its final
  box. Audio and video load in a player-sized box instead of a file card that turned into a player. A bot's
  finished messages are memoized (`BotProse`, `BotText`, the Markdown renderer), so each streamed delta re-renders
  only the reply that is streaming, not every message above it; media effects key on the bot's route, not the
  roster's row object.
- **grokbot-override: a finished reply no longer flashes when its stored copy arrives (2026-11-15)**: a streamed
  reply (`live:…`) and a sent bubble (`local:…`) were replaced by their stored rows on the next history read, which
  gave them new React keys: the bubble and its group remounted, Markdown re-parsed, cards showed their loading box
  again and images went back to the placeholder. The stored item now carries the old identity as `renderKey`
  (`carryKeys` in `src/core/history.js`: a sent bubble goes to the exact stored row that confirmed it, a streamed reply to an assistant row of that same turn, same text first; rows another surface wrote never take them, and an ambiguous case keeps no key) and keeps
  it across later refreshes; groups and the transcript key on it. The durable id stays the stored row's, so
  reactions, edit and rewind address the same rows as before.
- **grokbot-override: the transcript stays pinned through late growth (2026-11-15)**: the chat used to follow the
  bottom only when its message list changed, so an image, card, preview or code block that finished sizing afterwards
  left you short of the latest message. A pinned view now follows every content resize before paint
  (`src/ui/stickToBottom.ts`, fed by OverlayScroll's existing ResizeObserver; its DOM-mutation thumb update is now
  once per frame). A reader who scrolled up is never moved; a newer message then shows a round jump-to-latest button
  that scrolls down smoothly (at once with reduced motion) and keeps following a reply that grows on the way (still moving after 1.2 s, it settles at the bottom and stays pinned); your own scrolling, including a drag of the scrollbar, cancels it. **Show earlier messages** keeps the message you were reading in place, even inside a tall group or bubble that is still streaming below you. A message that arrives while older messages load still brings up the jump button, and a message you send then is followed as usual. Known limits are listed in `grokbot-override/PARITY.md`. The
  transcript uses the browser's scroll anchoring, so content changing above you no longer shifts what you read. The
  narrow-pane drawer decision is measured before the first paint, so a docked panel no longer flips after one frame.
- **grokbot-override: replies are formatted live while they stream (2026-11-15)**: a bot reply no longer
  types as plain text and then snaps into formatting when it finishes. It renders through the same markdown
  path as a finished reply from the first token: bold, lists, headings, links, inline code and code blocks
  (with Copy) appear as it types, and the bubble's markup is the same while streaming and when done, so
  settled formatting does not change at completion (ambiguous endings appear with the next chunk or at
  completion; PARITY C7 known limits). A new pure `streamSafe` step keeps each
  tick render-stable: an open code fence is closed temporarily (the block grows), a trailing unmatched
  `**`/`*`/`_`/backtick is closed or held, and a half link, table row, list or heading marker, `MEDIA:` line
  or `::card{…}` directive waits until it is complete (a card still streaming shows a quiet skeleton line,
  never raw directive text). Re-renders are throttled to one per 60 ms; the finished reply uses its full text
  untouched. Silence markers still never show.
  Review round 1 hardening: an inline `MEDIA:` tag (spaced, quoted or Unicode path) is held until its path is
  terminated, so no partial path is drawn or read; a combined closer (`**a *b***`) closes every run; fences in
  blockquotes and list items close with their container prefix and code is never repaired; a temporary
  inline-code closer never merges with a literal backtick; a table ending in a complete row or separator shows
  whole; a card completing never remounts the prose before it; markdown re-renders only on throttled ticks; a
  streaming preview reserves its own height; StrictMode effect replay no longer freezes the stream.
  Review round 2: the streaming text is now read as CommonMark blocks (quote and list-item containers at any
  nesting, fenced and indented code, tables, reference definitions, lazy continuation), so a fence closes only
  under its own containers and code is never changed; an inline tokenizer skips link destinations, autolinks,
  bare URLs, MEDIA tags and directives, waits for unfinished links (nested parentheses, titles) and shows
  defined reference links at once; GFM short table rows show while streaming; a bare `height=360` sizes the
  preview placeholder. A local, out-of-repo check compared every prefix of 790 documents with a CommonMark/GFM parser.
  Review round 3: a `MEDIA:` tag whose path starts on the next line (LF or CRLF, as `extractMedia` accepts) is
  held from its start, so no marker shows and no truncated path is read; tabs count as CommonMark indentation
  (tab stops of 4) for containers, fences and indented code, so tab-indented code is shown exactly; emphasis
  pairs by CommonMark's delimiter rules (flanking, `_` rules, the multiple-of-3 rule, delimiters between a pair
  removed), so a complete span such as `**2*3**` is unchanged while streaming. The test fixture email now uses
  a reserved example domain (the root privacy guard passes).
- **grokbot-override: a failed reply is a calm card with Try again (2026-11-11)**: a turn that ends in an error
  (a live `message.complete` with `status: "error"`, or the stored `failed_turn` boundary row with its error)
  now shows one card, "That reply didn’t go through.", instead of the raw red error and the grey "This turn did
  not complete…" line; both stay readable behind **Details**. **Try again** is the supported `/retry`: the
  canonical `session.rewind` of the failed user turn and the same message resubmitted (the gateway's own
  `/retry` through `slash.exec` on an older gateway); one press, disabled while it runs, only on the newest
  failed turn and never while a reply runs. If it fails again the card says "Still failing. Start a new chat"
  with a button that opens a new chat with that bot. A typed `/undo` now shows one muted line, "Removed the
  failed reply", instead of the monospace receipt. Hermes's error copy for a failed turn is no longer drawn
  as a bot bubble (real partial reply text still is). Every bot, local and remote.
- **grokbot-override: remote bots show their server avatar (2026-11-11)**: a bot on another connection whose
  own gateway holds a picture (`has_avatar`, set with `profiles.set_asset`) now shows it in the roster, pins,
  chat header and panel instead of its generated shape. Hermes Desktop only fetches these for the active
  connection's bots. The override reads `profiles.get_asset` on each such bot's own route, once per app
  session (re-checked every 15 minutes); when a row cannot say `has_avatar`, one `profiles.list` per
  connection answers for all of its bots. The shape stays while loading and after an error (retried after
  2 minutes). Bot Mode's 160 px face rasters, non-image data and local bots are left alone; read-only.
  This covers bots on an SSH machine that Hermes dials on demand (its source reports `connect-on-demand`,
  which is available, not down).
- **email-drafts: email goes through Composio by default (2026-11-10)**: a new `composio` sender, now the
  default **Send with** (Gmail OAuth and SMTP stay as options). **Send** runs the `composio` CLI that is
  installed and logged in on the bot's own machine: `composio execute GMAIL_GET_PROFILE` (read only) to
  confirm the chosen account is the bot's **From address**, then `composio execute GMAIL_SEND_EMAIL` (or
  `GMAIL_REPLY_TO_THREAD` for a reply with a Gmail thread id), with `--account <alias|word id|id>` from the
  new per-bot **Composio account** setting and the email as JSON on stdin (`-d -`). No shell, a minimal
  environment, a 90-second limit that kills the CLI, and Composio's approval prompts turned into a clear
  refusal instead of a wait. To, Cc, Bcc, subject, the plain-text body with the bot's signature, and
  attachments (local paths the CLI uploads; 20 MB in total) all go through. Not logged in, no connected
  Gmail, an expired connection, rate limits and refused input show a clear error with **Retry**; a timeout,
  a crash or a dropped connection mid-send is "Delivery unknown: check the Sent folder" and is never retried.
  An optional Composio user API key is read with the profile's secret scope only. The bot instructions now
  say: "Email goes through Composio. Use email_draft_create; never send email any other way." Tests use a
  fake `composio` executable.
- **email-drafts: bots write email as drafts you send from the chat (2026-11-10)**: a new per-profile agent
  plugin, [`email-drafts`](email-drafts/README.md). A bot gets `email_draft_create`, `email_draft_update` and
  `email_draft_status`, and **no send tool**. Its draft shows in the Grokbot Override chat as a card like Grok
  Bot's: subject, From, "In reply to", editable To and Cc, the editable body with the bot's signature under it,
  attachments as file cards (click one to preview it), the rules menu (**Allow recipient**, **Needs approval**, **Disable drafts for
  <bot>**, **Manage rules**) and **Discard** / **Send**. Nothing is sent until you click **Send**, or, when you
  allowed every recipient for that bot, automatically ("Sent automatically · allowed recipient"). Sending goes
  through Gmail with your own Google OAuth client signed in by Hermes (`hermes auth add email-drafts:google`,
  `gmail.send` scope only; the plugin never holds the token) or SMTP over TLS with the password read from
  Hermes's secret scope. A draft is sent at most once (a file-locked `sending` claim, the card's revision, one
  click in flight; a lost reply is never re-sent); a failure shows the error with **Retry**. Attachments are
  limited to the bot's working directory and folders you list (symlinks resolved, hidden files refused,
  checked again at send). Scheduled runs only create drafts and never wait. Every send, discard and rule
  change is in an audit log with who caused it. The card talks to the bot's own gateway and route, so a
  remote bot's mail is sent by its machine (`plugin.email-drafts.api`, or `/email-drafts api` through
  `slash.exec`). Needs Hermes 0.23.0 or newer. Tests use fake Gmail and SMTP backends.
- **Grokbot Override: click a file to preview it (2026-11-10)**: a file card now opens a large viewer over the
  chat, like Grok Bot's: close X top left, the file name in a pill, the row count and a download button top right;
  Escape closes it and puts focus back on the card. Spreadsheets (`.xlsx`, `.xls`, `.ods`, `.csv`, `.tsv`) show as
  a grid with row numbers, a sticky header row and sheet tabs; click a cell to select it, move with the arrow keys,
  extend with Shift, copy with ⌘C (tab-separated, pastes into a spreadsheet). Long cells end in "…" with the full
  value in a tooltip and in the strip above the grid. Big files stay fast: only the visible rows are drawn, up to
  the first 100,000 rows. PDFs open in the built-in PDF viewer, images fit the window (click to zoom), text and
  markdown keep **Copy all**; other types, and files over 25 MB, offer **Download**. Cards now show a tile by type
  (a green sheet for spreadsheets, PDF, image, document) and an always-visible download button. Spreadsheets are
  read on your computer by the bundled SheetJS Community Edition 0.20.3 (Apache-2.0); nothing is fetched.
  Works for local and remote bots, light and dark themes.
- **Grokbot Override: the model sheet opens at once, with Effort and Speed (2026-11-10)**: the bot's **Model**
  sheet waited for the whole model catalogue (`model.options`, every provider, on the bot's own machine) before
  it drew anything, and asked for it again for every bot and every two minutes. It now draws at once with the
  bot's provider, model, reasoning effort and speed filled in; the catalogue loads behind it, once per machine
  for the app session (shared by every bot and sheet there, refreshed in the background when older than two
  minutes), and fills the lists when it arrives. New **Effort** and **Speed** selects (second row of the same
  grid) offer only what Hermes and the picked model support (`agent.reasoning_effort`: Off … Max per the
  route; `agent.service_tier`: Standard / Fast / Ultrafast per the model's capabilities); a model without
  them shows the select greyed out with "Not supported by this model". **Default** removes the key. One Save
  writes all four to the bot's own profile. The sheet's reads and every profile write now dial the bot's
  backend at user-action priority, as stock does.
- **Grokbot Override: files a bot sends are cards (2026-11-10)**: a file named on a `MEDIA:` line showed as
  a small chip inside the bubble. It is now a card of its own under the bubble, like Grok Bot's: a document
  icon, the name (cut in the middle when long), the size, and a download button on hover. Clicking a text
  file (`.md`, `.txt`, `.json`, `.csv`, code) opens it in a preview with **Copy all** and **Download**; other
  files download. A file the bot's machine no longer has shows "Not available". Several files stack; images,
  audio and video are unchanged. Light and dark themes. The agent-cards skill now tells the bot to send long
  text you will copy (a handoff, a prompt, a spec) as a `.md` file instead of a giant code block.
- **Grokbot Override: code blocks you can copy (2026-11-10)**: a code block in a bot's reply was clipped to a
  few lines behind a small chevron, with no way to copy it. Every code block now has a **Copy** button
  (top-right; "Copied" for a moment) that copies exactly the block's text, shows in full up to 60 lines (a
  normal handoff fits), and longer blocks fold behind **Show more** / **Show less**. Light and dark themes.
- **Grokbot Override: "[SILENT]" is not a reply (2026-11-10)**: a bot that chose not to answer showed a
  "[SILENT]" bubble. A reply that is only Hermes's silence sentinel (`[SILENT]`, `NO_REPLY` and the other
  spellings Hermes uses) now draws nothing: no bubble, no roster preview, no unread dot or toast, no NEW line.
  A reply that just mentions the word shows as usual.
- **Grokbot Override: no raw background-process lines (2026-11-10)**: a grey line under a reply read
  "Background Process Finished: " followed by the full path of the command. It is a work row now: hidden by
  default, and with **show work rows** on it reads "Background task finished" (or failed / stopped), with the
  command only in its tooltip. Errors and approvals still always show.
- **Grokbot Override: questions come one at a time (2026-11-10)**: a question card with several questions
  showed them all stacked with one greyed **Answer** button that did nothing until every question had a
  pick, and nothing said so. It now pages like Grok Bot: one question per page with page dots, a click picks
  a row (its letter turns blue), **Next** / **Back** / **Skip** per question and **Done** on the last page
  sends every answer (skipped ones as null). Typing in the composer answers the question on screen and moves
  on; the page survives a re-render; questions already locked are skipped. One-question cards are unchanged.
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
