# Agent runbook: install Hermes Bot Kit

You are an AI agent and a person asked you to "install
https://github.com/thomasbek3/hermes-bot-kit". Follow this file top to bottom.
It is written to be run unattended on **macOS and Linux**.

- No sudo, no prompts. Every command block below can be copied as is, and it
  exits non-zero when something is wrong. Stop and report when one fails.
- It installs the two **desktop plugins**: Grokbot Override (the chat-app Bot
  Mode screen, installed switched on) and the Computer viewer pane. They go
  into `~/.hermes/desktop-plugins/`, or `$HERMES_HOME/desktop-plugins/` when
  `HERMES_HOME` is set. Existing files are backed up (`*.bak.<timestamp>`) before
  being replaced, and re-running changes nothing.
- The installer picks the **newest GitHub release** by itself. If the GitHub API
  can't be reached, it falls back to the release it was published with. Every
  file is checked against that release's `MANIFEST.sha256` before anything is
  copied; a mismatch installs nothing.
- One step needs the human: reloading plugins in Hermes Desktop (step 4).

## 1. Check the prerequisites

```bash
for c in bash curl grep awk; do command -v "$c" >/dev/null || { echo "missing: $c" >&2; false; break; }; done \
  && { command -v shasum >/dev/null || command -v sha256sum >/dev/null || { echo "missing: shasum or sha256sum" >&2; false; }; } \
  && { test -d "${HERMES_HOME:-$HOME/.hermes}" || { echo "No Hermes home at ${HERMES_HOME:-$HOME/.hermes}: install and open Hermes Desktop first (https://github.com/NousResearch/hermes-agent)" >&2; false; }; } \
  && echo "prerequisites OK"
```

- **Hermes Desktop 0.20.5 or newer is required.** On older builds the Computer
  pane has zero size. Ask the person to check *About* in Hermes Desktop if you
  can't.
- `node` is optional. When it is present the installer also syntax-checks the
  plugins.
- Do **not** point `HERMES_HOME` at `~/.hermes/profiles/<name>`. Desktop plugins
  belong to the app, not to one profile. Hermes moves profile-scoped desktop
  plugins up to `~/.hermes/desktop-plugins/` on its next launch.

## 2. Install

```bash
f=$(mktemp) && curl -fsSL https://raw.githubusercontent.com/thomasbek3/hermes-bot-kit/v2026.11.16.3/install.sh -o "$f" && bash "$f"; rc=$?; rm -f "$f"; [ "$rc" -eq 0 ]
```

The first output line names the release it installs, for example
`Release -> v2026.11.19 (newest GitHub release)`.

Variants (same command, with a variable in front of `bash "$f"`):

| Want | Put in front of `bash "$f"` |
|---|---|
| Grokbot Override only | `KIT_SKIP_COMPUTER=1` |
| Computer viewer only | `KIT_SKIP_GROKBOT=1` |
| A specific release | `KIT_REF=v2026.11.16.3` |
| Another Hermes home (a second install) | `HERMES_HOME=/path/to/.hermes` |
| Move retired kit plugins (Bubble Mode, Task Dock, Bot Sections) out of the way | `KIT_REMOVE_RETIRED=1` |

From a clone, the same install copies from the checkout:
`git clone https://github.com/thomasbek3/hermes-bot-kit && bash hermes-bot-kit/install.sh`.

## 3. Verify

```bash
D="${HERMES_HOME:-$HOME/.hermes}/desktop-plugins"; SUM=$(command -v sha256sum || echo "shasum -a 256"); (cd "$D" && grep -E ' (computer-viewer/plugin.js|grokbot-override/plugin.js)$' MANIFEST.sha256 | $SUM -c -) && echo "Bot Kit installed OK"
```

Expect two `: OK` lines and `Bot Kit installed OK`. (With `KIT_SKIP_*`, only
the plugin you installed is listed.) The folder names must stay exactly
`computer-viewer` and `grokbot-override`, because they are the plugin ids.

## 4. Finish (HUMAN)

Hermes Desktop loads disk plugins at start and on reload. Ask the person to do
one of these:

- Hermes Desktop: **⌘⇧P** (macOS) or **Ctrl+Shift+P** → **Reload plugins**, or
- quit and reopen Hermes Desktop.

Then tell them what they will see:

- **Grokbot Override** is on. The Bots tab is now the chat-app screen.
  **⌘⇧P → Grokbot Override: toggle** switches back to stock Bot Mode and on
  again. Someone who switched it off before keeps it off. It is a preview: if
  Bot Mode misbehaves, switch it off rather than editing files.
- **Computer viewer**: enable **Computer** once in **Settings → Plugins**, then
  add a computer in the pane. Setting up the machine to view is interactive; see
  [computer-viewer/README.md](computer-viewer/README.md).

## 5. Optional add-ons

Offer these; install only what the person wants.

- **Slack** (the bot answers DMs and @mentions in Slack): follow
  [docs/SLACK.md](docs/SLACK.md). It has human-only steps.
- **agent-cards skill** (approval, task and email-draft cards in the override's
  chat; question cards work without it):

  ```bash
  f=$(mktemp) && curl -fsSL https://raw.githubusercontent.com/thomasbek3/hermes-bot-kit/v2026.11.16.3/install.sh -o "$f" && KIT_CARDS_SKILL=1 bash "$f"; rc=$?; rm -f "$f"; [ "$rc" -eq 0 ]
  ```

  It goes to `<profile home>/skills/agent-cards/SKILL.md` for the root home and
  every profile; `KIT_CARDS_PROFILES=default,helper` limits it. Use
  `KIT_CARDS_SKILL=remove` to take it out again. An `agent-cards` skill that is
  not this kit's copy is left alone. Bots also need the `file` and `clarify`
  toolsets. Chats started before the install keep their old mode until the
  session restarts.
- **texting-style** (bots reply in a short texting register, only in Bot Chat):

  ```bash
  f=$(mktemp) && curl -fsSL https://raw.githubusercontent.com/thomasbek3/hermes-bot-kit/v2026.11.16.3/texting-style/install.sh -o "$f" && bash "$f"; rc=$?; rm -f "$f"; [ "$rc" -eq 0 ]
  ```

  Add `-s -- --profiles default,helper` style arguments after `bash "$f"` to
  limit it. Verify: `hermes plugins list` shows `texting-style enabled`. New
  plugin code loads only when the agent process restarts: restart Hermes
  Desktop, or gracefully restart only that profile's `hermes --profile <name>
  serve` process after checking its owner. Never use broad process-name kills.
  Debug: `TS_DEBUG=1` logs to `<HERMES_HOME>/logs/texting-style-debug.log`.
- **email-drafts** (bots write email as drafts you send from a card) and
  **remote-cua** (a bot's `computer_use` drives a remote Mac over SSH) are
  per-profile agent plugins installed from a clone. See
  [email-drafts/README.md](email-drafts/README.md) and
  [remote-cua/README.md](remote-cua/README.md). remote-cua needs a one-time
  setup at the Mac's own screen, which an agent cannot do over SSH. Never run
  `cua-driver permissions grant` remotely.

## Uninstall

```bash
D="${HERMES_HOME:-$HOME/.hermes}/desktop-plugins"; for p in computer-viewer grokbot-override; do [ ! -e "$D/$p" ] || mv "$D/$p" "$D/../desktop-plugins-removed-$(date +%Y%m%d%H%M%S)-$p" || false; done && echo "moved out of $D"
```

This moves the two plugin folders out of `desktop-plugins/` (nothing is
deleted), then the person reloads plugins. Remove the agent-cards skill with
`KIT_CARDS_SKILL=remove` (step 5). Plugin settings live in Hermes plugin storage
under `hermes.plugin.computer-viewer.*` and `hermes.plugin.grokbot-override.*`.

## Troubleshooting

| Symptom | Cause and fix |
|---|---|
| `install.sh: sha256 mismatch for …` | A downloaded file is not the released one (proxy, partial download). Nothing was installed. Re-run; if it repeats, report it and do not use `KIT_SKIP_VERIFY`. |
| `Release -> … (GitHub API not reachable …)` | No network to api.github.com or a rate limit. The fallback release is still checked against its manifest. Fine to continue. |
| `… has no Grokbot Override in its manifest; skipping it` | You pinned an old release with `KIT_REF`. Drop `KIT_REF`. |
| The Bots tab looks unchanged after reload | The override was switched off earlier: **⌘⇧P → Grokbot Override: toggle**. |
| The Computer pane is zero-size | Hermes Desktop is older than 0.20.5. Update the app. |
| A plugin change "doesn't take" | Bot Chats are served by long-lived per-profile `hermes --profile <name> serve` processes that survive app restarts. Check which process it is and restart only that one gracefully. |
| `Retired plugins still installed: …` | Old kit folders; harmless. `KIT_REMOVE_RETIRED=1` moves exactly those (marker-checked) to `desktop-plugins-retired-<date>/`. |
| `Retired agent plugin still installed: …` (the retired `orgo-computer`) | Run the printed `remove-orgo-computer.sh` command: a dry run first, then `--yes`. Nothing is deleted. |

## Facts that save time

- "Bot Chat" is the desktop's own per-bot conversation (a session titled
  `Bot Chat`). Grokbot Override opens that same session, and texting-style only
  acts in it. Other sessions render stock.
- CLI probes cannot reach a real Bot Chat: `-z --continue "Bot Chat"` and
  `--resume <id>` both start new sessions. Only the desktop UI talks to the real
  one.
- A serve restart under an open Bot Chat tab can scramble the tab's caption
  (stock Hermes; data is fine). To fix it: close the tab, quit, relaunch, then
  click the bot.
- Desktop plugins fail safe. If a Hermes update renames an internal hook, the
  chat renders stock, the pane stays empty or the roster stays stock. Nothing
  crashes.
- Do not run `connect-*.sh` / `hiperf-*.sh` on the machine running Hermes
  Desktop unless the person asked to view **that** machine. They are host-side
  setup scripts for the computer being viewed and install services on it.
- The repo was formerly `hermes-computer-viewer`. GitHub redirects old links.
