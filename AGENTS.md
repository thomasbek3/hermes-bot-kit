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

<!-- runbook:prereq -->
```bash
( set -e; for c in bash curl grep awk sed mktemp; do command -v "$c" >/dev/null || { echo "missing: $c" >&2; exit 1; }; done; command -v shasum >/dev/null || command -v sha256sum >/dev/null || { echo "missing: shasum or sha256sum" >&2; exit 1; }; test -d "${HERMES_HOME:-$HOME/.hermes}" || { echo "No Hermes home at ${HERMES_HOME:-$HOME/.hermes}: install and open Hermes Desktop first (https://github.com/NousResearch/hermes-agent)" >&2; exit 1; }; echo "prerequisites OK" )
```

- **Hermes Desktop 0.23.0 or newer is required** (verified on stable v0.23.0,
  v0.23.2 and v0.23.3; see [docs/COMPATIBILITY.md](docs/COMPATIBILITY.md)). Ask the
  person to check *About* in Hermes Desktop if you can't; the doctor
  (`bash install.sh --doctor`) prints it too.
- `node` is optional. When it is present the installer also syntax-checks the
  plugins.
- Do **not** point `HERMES_HOME` at `~/.hermes/profiles/<name>`. Desktop plugins
  belong to the app, not to one profile. Hermes moves profile-scoped desktop
  plugins up to `~/.hermes/desktop-plugins/` on its next launch.

## 2. Install

<!-- runbook:install -->
```bash
( set -e; f=$(mktemp); trap 'rm -f "$f"' EXIT; curl -fsSL --connect-timeout 10 --max-time 120 https://raw.githubusercontent.com/thomasbek3/hermes-bot-kit/v2026.11.22/install.sh -o "$f"; test -s "$f"; bash "$f" )
```

The script is downloaded to a file first and run only if the download
succeeded, so a failed or empty download stops here with a non-zero exit. The
first output line names the release it installs, for example
`Release -> v2026.11.22 (newest GitHub release)`.

Variants (same command, with a variable in front of `bash "$f"`, for example
`KIT_SKIP_COMPUTER=1 bash "$f"`):

| Want | Put in front of `bash "$f"` |
|---|---|
| Grokbot Override only | `KIT_SKIP_COMPUTER=1` |
| Computer viewer only | `KIT_SKIP_GROKBOT=1` |
| A specific release | `KIT_REF=v2026.11.22` |
| Another Hermes home (a second install) | `HERMES_HOME=/path/to/.hermes` |
| Move retired kit plugins (Bubble Mode, Task Dock, Bot Sections) out of the way | `KIT_REMOVE_RETIRED=1` |

From a clone, the same install copies from the checkout:
`git clone https://github.com/thomasbek3/hermes-bot-kit && bash hermes-bot-kit/install.sh`.

## 3. Verify

<!-- runbook:verify -->
```bash
bash <<'KIT_EOF'
set -eu; D="${HERMES_HOME:-$HOME/.hermes}/desktop-plugins"; R="$D/.hermes-bot-kit-install"; M="$D/MANIFEST.sha256"; test -s "$R" && test -s "$M" || { echo "no install record or manifest in $D: run step 2" >&2; exit 1; }; SEL=$(sed -n 's/^plugins=//p' "$R"); test -n "$SEL" || { echo "the install record lists no plugins" >&2; exit 1; }; SUM=$(command -v sha256sum || echo "shasum -a 256"); for p in $SEL; do n=$(grep -c " $p/plugin.js\$" "$M" || true); test "$n" = 1 || { echo "$p: $n digests in $M, want exactly 1" >&2; exit 1; }; test -f "$D/$p/plugin.js" || { echo "$p: plugin.js is missing" >&2; exit 1; }; ( cd "$D" && grep " $p/plugin.js\$" MANIFEST.sha256 | $SUM -c - >/dev/null ) || { echo "$p: plugin.js does not match the manifest" >&2; exit 1; }; echo "$p: OK"; done; echo "Bot Kit installed OK ($(sed -n 's/^release=//p' "$R")): $SEL"
KIT_EOF
```

The block runs under `bash` explicitly: its body is a quoted here-document,
so zsh (macOS's default shell) expands nothing in it. It checks exactly the
plugins step 2 installed (the installer records them, with the release, in
`desktop-plugins/.hermes-bot-kit-install`). For each one
there must be exactly one digest in the installed `MANIFEST.sha256` and a
`plugin.js` that matches it. Expect one `<plugin>: OK` line per plugin and
`Bot Kit installed OK (<release>): <plugins>`; anything else exits non-zero.
The folder names must stay exactly `computer-viewer` and `grokbot-override`,
because they are the plugin ids.

## 4. Finish (HUMAN)

Hermes Desktop loads disk plugins at start and on reload. Ask the person to do
one of these:

- Hermes Desktop: **⌘K** (macOS) or **Ctrl+K** (Linux) → **Reload desktop plugins**, or
- quit and reopen Hermes Desktop.

Then tell them what they will see:

- **Grokbot Override** is on. The Bots tab is now the chat-app screen.
  **⌘K → Grokbot Override: toggle** switches back to stock Bot Mode and on
  again. Someone who switched it off before keeps it off. It is a preview: if
  Bot Mode misbehaves, switch it off rather than editing files.
- **Computer viewer**: on by default (if it was switched off: **Capabilities →
  Plugins → Computer**); add a computer in the pane. Setting up the machine to view is interactive; see
  [computer-viewer/README.md](computer-viewer/README.md).

## 5. Optional add-ons

Offer these; install only what the person wants.

- **Slack** (DM and @mention the bot in Slack): follow
  [docs/SLACK.md](docs/SLACK.md). It has human-only steps. Tell the person
  plainly: after Connect **only they** can talk to the bot. To add teammates,
  they put the teammates' Slack member IDs into `SLACK_ALLOWED_USERS` in the
  bot's profile `.env` (`~/.hermes/profiles/<bot profile>/.env`) and restart
  or reload the bot (docs/SLACK.md has the exact step). Anyone on that list
  can make the bot do whatever its tools allow, with the bot's own access.
  Team-wide access by default is coming in the next release.
- **agent-cards skill** (approval, task and email-draft cards in the override's
  chat; question cards work without it):

  ```bash
  ( set -e; f=$(mktemp); trap 'rm -f "$f"' EXIT; curl -fsSL --connect-timeout 10 --max-time 120 https://raw.githubusercontent.com/thomasbek3/hermes-bot-kit/v2026.11.22/install.sh -o "$f"; test -s "$f"; KIT_CARDS_SKILL=1 bash "$f" )
  ```

  It goes to `<profile home>/skills/agent-cards/SKILL.md` for the root home and
  every profile; `KIT_CARDS_PROFILES=default,helper` limits it. Use
  `KIT_CARDS_SKILL=remove` to take it out again. An `agent-cards` skill that is
  not this kit's copy is left alone. Bots also need the `file` and `clarify`
  toolsets. Chats started before the install keep their old mode until the
  session restarts.
- **texting-style** (bots reply in a short texting register, only in Bot Chat):

  ```bash
  ( set -e; f=$(mktemp); trap 'rm -f "$f"' EXIT; curl -fsSL --connect-timeout 10 --max-time 120 https://raw.githubusercontent.com/thomasbek3/hermes-bot-kit/v2026.11.22/texting-style/install.sh -o "$f"; test -s "$f"; bash "$f" )
  ```

  To limit it to some profiles, pass them to the script:
  `bash "$f" --profiles default,helper`. Verify: `hermes plugins list` shows `texting-style enabled`. New
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

- **Daily auto-update** (installs each new release by itself; macOS and
  Linux): the install command from step 2 with `--auto-update on` after
  `bash "$f"`. Check it with `--auto-update status`; `--auto-update off`
  removes the job. It never restarts Hermes; after an update the person reloads
  desktop plugins (step 4). Over ssh on a Mac the job may not load right away:
  the command prints the exact `launchctl bootstrap gui/<uid> ...` line for the
  person to run in Terminal (it also loads at their next login). README: Keep
  it updated.

## Uninstall

<!-- runbook:uninstall -->
```bash
( set -e; f=$(mktemp); trap 'rm -f "$f"' EXIT; curl -fsSL --connect-timeout 10 --max-time 120 https://raw.githubusercontent.com/thomasbek3/hermes-bot-kit/v2026.11.22/install.sh -o "$f"; test -s "$f"; bash "$f" --uninstall )
```

`--uninstall` first turns the daily auto-update off (a job left behind would
install the plugins again at its next run); if that fails it stops, exits
non-zero and changes nothing else. Then it moves the `computer-viewer` and
`grokbot-override` folders out of `desktop-plugins/` to
`desktop-plugins-removed-<timestamp>-<name>` next to it, and the kit's records
(`desktop-plugins/.hermes-bot-kit-install`, the installed `MANIFEST.sha256` and
the `hermes-bot-kit/` folder with `installed-release`) to
`hermes-bot-kit-removed-<timestamp>/`. Nothing is deleted and nothing is
restarted; the person then reloads plugins (step 4). If an update is running
at that moment (including an older updater from v2026.11.22 or before), it
stops with "an update is running right now", changes nothing, and can simply
be run again a minute later. (One tiny window remains with such an older
updater: one that had already read its settings, but not yet taken its lock,
when the uninstall finished can still install once. Auto-update is turned off
first, so no new run starts; run `--uninstall` again if the plugins
reappear.) Running it again says
nothing is installed and exits 0, and `--doctor` afterwards reports the kit as
not installed. Agent plugins (texting-style, email-drafts, remote-cua, the
slack-* plugins) live per profile and may be enabled in `config.yaml`, so it
leaves them and every `config.yaml` alone: it lists where it found each one
and how to remove it. Remove the agent-cards skill with `KIT_CARDS_SKILL=remove`
(step 5). Plugin settings live in Hermes plugin storage under
`hermes.plugin.computer-viewer.*` and `hermes.plugin.grokbot-override.*`.

Without the download (fallback, same steps by hand, auto-update off first):

<!-- runbook:uninstall-manual -->
```bash
( set -e; H="${HERMES_HOME:-$HOME/.hermes}"; S="$H/hermes-bot-kit"; D="$H/desktop-plugins"; T=$(date +%Y%m%d%H%M%S); if [ -f "$S/update.sh" ]; then bash "$S/update.sh" --auto-update off; fi; for p in computer-viewer grokbot-override; do if [ -e "$D/$p" ]; then mv "$D/$p" "$H/desktop-plugins-removed-$T-$p"; fi; done; rm -f "$D/.hermes-bot-kit-install"; if [ -d "$S" ]; then mv "$S" "$H/hermes-bot-kit-removed-$T"; fi; mkdir -p "$H/hermes-bot-kit-removed-$T"; echo "removed=$T" > "$H/hermes-bot-kit-removed-$T/UNINSTALLED"; echo "moved out of $D" )
```

## Troubleshooting

**If it isn't working, run the doctor first:** the install command from step 2
with `--doctor` after `bash "$f"`, or `bash install.sh --doctor` from a clone.
It only reads, prints `OK` / `FIX` / `WARN` / `INFO` per check with the exact fix for
each `FIX`, exits 1 when anything needs fixing (2 when it can't see the
Hermes home Desktop uses, e.g. from WSL), and ends with a
`--- doctor summary ---` block (no paths, names or tokens: versions, plugin names, a home category and OK/FIX/WARN/INFO per check) to hand back to
the person or paste into an issue.

| Symptom | Cause and fix |
|---|---|
| `install.sh: sha256 mismatch for …` | A downloaded file is not the released one (proxy, partial download). Nothing was installed. Re-run; if it repeats, report it and do not use `KIT_SKIP_VERIFY`. |
| `Release -> … (GitHub API not reachable …)` | No network to api.github.com or a rate limit. The fallback release is still checked against its manifest. Fine to continue. |
| `… predates Grokbot Override; skipping it` | You pinned an old release with `KIT_REF`. Drop `KIT_REF`. |
| `MANIFEST.sha256 for … does not list …; it is incomplete` | That release's manifest lacks a file it should have. Nothing was installed. Report it; don't use `KIT_SKIP_VERIFY`. |
| `Release -- vX is installed, newer than vY; keeping it` | The automatic choice would have gone backwards (a stale API answer or the fallback). Nothing changed. To go back on purpose, set `KIT_REF=vY`. |
| The Bots tab looks unchanged after reload | The override was switched off earlier: **⌘K → Grokbot Override: toggle**. |
| The Computer pane is zero-size, or a feature is missing | Hermes Desktop is older than 0.23.0. Update the app. |
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
