# Agent instructions for Hermes Bot Kit

You are installing desktop plugins for Hermes Desktop. Everything here is
safe to run unattended: no sudo, no prompts, idempotent, existing files are
backed up (`*.bak.<timestamp>`) before overwrite.

## Install both plugins (default)

```bash
curl -fsSL https://raw.githubusercontent.com/thomasbek3/hermes-bot-kit/master/install.sh | bash
```

Install just one:

```bash
KIT_SKIP_COMPUTER=1 bash -c "$(curl -fsSL https://raw.githubusercontent.com/thomasbek3/hermes-bot-kit/master/install.sh)"   # Bubble Mode only
KIT_SKIP_BUBBLES=1  bash -c "$(curl -fsSL https://raw.githubusercontent.com/thomasbek3/hermes-bot-kit/master/install.sh)"   # Computer viewer only
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
```

Folder names must be exactly `bubble-mode` and `computer-viewer` (they must
match the plugin ids). Do not rename them.

## After installing — needs the human or a running app

Hermes Desktop loads disk plugins at startup and on plugin reload. One of:

- In Hermes Desktop: command palette (Cmd+Shift+P / Ctrl+Shift+P) →
  **Reload plugins**, or
- Restart the Hermes Desktop app.

An agent without GUI control cannot complete this step; tell the user to do
it. Then:

- **Bubble Mode** is active immediately in Bot Mode chats. Toggle:
  palette → "Bubble Mode: toggle".
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
new sessions only (`/new` or gateway restart). Uninstall: remove
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
rm -rf ~/.hermes/desktop-plugins/bubble-mode ~/.hermes/desktop-plugins/computer-viewer
```

Then reload plugins (same as above). Plugin settings live in Hermes plugin
storage under `hermes.plugin.bubble-mode.*` / `hermes.plugin.computer-viewer.*`.

## Facts that prevent wasted debugging

- Requires Hermes Desktop ≥ 0.20.5. On older builds the Computer pane is
  zero-size; there is no workaround, update the app.
- Both plugins fail safe: if a Hermes update renames internal hooks, chats
  render stock / the pane stays empty — nothing crashes.
- The repo was formerly `hermes-computer-viewer`; old raw URLs still work
  via root shim scripts. Canonical paths are `bubble-mode/` and
  `computer-viewer/`.
- Do not curl-pipe `connect-*.sh` / `hiperf-*.sh` on the machine running
  Hermes Desktop unless the user asked to view **that** machine — they are
  host-side setup scripts for the computer being viewed, and they install
  LaunchAgents / services / scheduled tasks on it.
