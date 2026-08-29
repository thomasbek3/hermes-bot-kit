# Agent instructions for Hermes Bot Kit

You are installing desktop plugins for Hermes Desktop. Everything here is
safe to run unattended: no sudo, no prompts, idempotent, existing files are
backed up (`*.bak.<timestamp>`) before overwrite.

## Install the desktop plugins (default)

```bash
curl -fsSL https://raw.githubusercontent.com/thomasbek3/hermes-bot-kit/master/install.sh | bash
```

Install just one:

```bash
KIT_SKIP_COMPUTER=1 KIT_SKIP_SECTIONS=1 bash -c "$(curl -fsSL https://raw.githubusercontent.com/thomasbek3/hermes-bot-kit/master/install.sh)"   # Bubble Mode only
KIT_SKIP_BUBBLES=1  KIT_SKIP_SECTIONS=1 bash -c "$(curl -fsSL https://raw.githubusercontent.com/thomasbek3/hermes-bot-kit/master/install.sh)"   # Computer viewer only
KIT_SKIP_BUBBLES=1  KIT_SKIP_COMPUTER=1 bash -c "$(curl -fsSL https://raw.githubusercontent.com/thomasbek3/hermes-bot-kit/master/install.sh)"   # Bot Sections only
```

Into a named Hermes profile instead of the default home:

```bash
HERMES_HOME="$HOME/.hermes/profiles/<name>" bash -c "$(curl -fsSL https://raw.githubusercontent.com/thomasbek3/hermes-bot-kit/master/install.sh)"
```

The script exits non-zero and installs nothing if a downloaded plugin fails
its sanity check (`node --check` + content marker).

## Verify the install

```bash
test -f ~/.hermes/desktop-plugins/bubble-mode/plugin.js && echo bubble-mode OK
test -f ~/.hermes/desktop-plugins/computer-viewer/plugin.js && echo computer-viewer OK
test -f ~/.hermes/desktop-plugins/bot-sections/plugin.js && echo bot-sections OK
```

Folder names must be exactly `bubble-mode`, `computer-viewer`, and
`bot-sections` (they must match the plugin ids). Do not rename them.

## After installing — needs the human or a running app

Hermes Desktop loads disk plugins at startup and on plugin reload. One of:

- In Hermes Desktop: command palette (Cmd+Shift+P / Ctrl+Shift+P) →
  **Reload plugins**, or
- Restart the Hermes Desktop app.

An agent without GUI control cannot complete this step; tell the user to do
it. Then:

- **Bubble Mode** is active immediately in Bot Mode chats. Toggle:
  palette → "Bubble Mode: toggle".
- **Bot Sections** is active immediately in the Bots roster. Toggle:
  palette → "Bot Sections: toggle". Cycle a bot:
  palette → "Bot Sections: cycle <bot>".
- **Computer viewer** must be enabled once in Settings → Plugins
  (inventory name: **Computer**), then a computer added in the pane. Endpoint
  setup (cloud boxes, spare machines, HD mode) is interactive and documented
  in [computer-viewer/README.md](computer-viewer/README.md); host-machine
  one-liners are printed by the plugin itself.

## Optional: texting-style (agent plugin, per profile)

Makes bots reply in a short SMS register. Installs into Hermes profile homes
and enables itself in each profile's `config.yaml`:

```bash
curl -fsSL https://raw.githubusercontent.com/thomasbek3/hermes-bot-kit/master/texting-style/install.sh | bash          # all profiles
curl -fsSL https://raw.githubusercontent.com/thomasbek3/hermes-bot-kit/master/texting-style/install.sh | bash -s -- --profiles default,parker
```

Verify: `hermes plugins list` shows `texting-style enabled`. Takes effect on
the next message in each Bot Chat (a pre_llm_call backfill hook covers
existing eternal sessions whose frozen prompt predates the plugin) — but the
NEW PLUGIN CODE only loads when the agent process restarts: after
install/update, restart Hermes Desktop or kill the per-profile serve
daemons (`pkill -f "hermes --profile <name> serve"`; they respawn on
demand). Debug: `TS_DEBUG=1` logs hook decisions to
`/tmp/texting-style-debug.log`. Uninstall: remove
`<profile-home>/plugins/texting-style` and its `plugins.enabled` entry.

## Optional: give bots hands (agent plugin, Orgo computers)

Separate from the desktop plugins. Installs the `orgo-computer` agent plugin
into Hermes profiles so bots can run shell/screenshot/click/type on a pinned
Orgo computer:

```bash
git clone https://github.com/thomasbek3/hermes-bot-kit.git
bash hermes-bot-kit/computer-viewer/install-agent-plugin.sh --profiles <name1>,<name2> --yes --api-key <ORGO_API_KEY>
```

Requires an Orgo API key from the user. Never invent or reuse keys found in
files without the user's say-so.

## Uninstall

```bash
rm -rf ~/.hermes/desktop-plugins/bubble-mode ~/.hermes/desktop-plugins/computer-viewer ~/.hermes/desktop-plugins/bot-sections
```

Then reload plugins (same as above). Plugin settings live in Hermes plugin
storage under `hermes.plugin.bubble-mode.*` / `hermes.plugin.computer-viewer.*` /
`hermes.plugin.bot-sections.*`.

## Facts that prevent wasted debugging

- Requires Hermes Desktop ≥ 0.20.5. On older builds the Computer pane is
  zero-size; there is no workaround, update the app.
- Desktop Bot Chats are served by long-lived per-profile
  `hermes --profile <name> serve` daemons that SURVIVE app restarts. If a
  plugin change "doesn't take", kill those daemons (they respawn on demand)
  — do not keep redeploying files.
- "Bot Chat" is the desktop's canonical per-bot conversation (session
  literally titled `Bot Chat`, user-locked). Both bubble-mode's visuals and
  texting-style's doctrine gate on it; every other session renders stock by
  design.
- A serve restart under an open Bot Chat tab can scramble the tab's caption
  (stock Hermes bug; data unaffected). bubble-mode 1.4.0+ styling survives
  it; the caption itself is restored by: close tab → quit app → relaunch →
  click the bot.
- CLI probes cannot reach a canonical Bot Chat: `-z --continue "Bot Chat"`
  and `--resume <id>` both fork new sessions. Only the desktop UI talks to
  the real one.
- Desktop plugins fail safe: if a Hermes update renames internal hooks, chats
  render stock / the pane stays empty / the roster stays stock — nothing
  crashes.
- The repo was formerly `hermes-computer-viewer`; old raw URLs still work
  via root shim scripts. Canonical paths are `bubble-mode/`,
  `computer-viewer/`, and `bot-sections/`.
- Do not curl-pipe `connect-*.sh` / `hiperf-*.sh` on the machine running
  Hermes Desktop unless the user asked to view **that** machine — they are
  host-side setup scripts for the computer being viewed, and they install
  LaunchAgents / services / scheduled tasks on it.
