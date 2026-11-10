# Agent instructions for Hermes Bot Kit

You are installing desktop plugins for Hermes Desktop. Everything here is
safe to run unattended: no sudo, no prompts, idempotent, existing files are
backed up (`*.bak.<timestamp>`) before overwrite.

## Install the desktop plugins (default)

```bash
curl -fsSL https://raw.githubusercontent.com/thomasbek3/hermes-bot-kit/v2026.11.10/install.sh | bash
```

Install just one:

```bash
KIT_SKIP_COMPUTER=1 bash -c "$(curl -fsSL https://raw.githubusercontent.com/thomasbek3/hermes-bot-kit/v2026.11.10/install.sh)"   # Grokbot Override only
KIT_SKIP_GROKBOT=1  bash -c "$(curl -fsSL https://raw.githubusercontent.com/thomasbek3/hermes-bot-kit/v2026.11.10/install.sh)"   # Computer viewer only
```

Into a non-default Hermes home (a separate `~/.hermes`-shaped tree, e.g. a
second install):

```bash
HERMES_HOME="/path/to/other/.hermes" bash -c "$(curl -fsSL https://raw.githubusercontent.com/thomasbek3/hermes-bot-kit/v2026.11.10/install.sh)"
```

Do **not** point `HERMES_HOME` at `~/.hermes/profiles/<name>` for these desktop
plugins. Since hermes-agent `284d220ba4` the desktop-plugin root is APP-level,
never profile-scoped (`electron/desktop-plugins-root.ts`): a desktop plugin
extends the app, not an agent, so one install serves every profile, and
`migrateProfileScopedDesktopPlugins()` MOVES anything left in
`profiles/<name>/desktop-plugins/` up to `~/.hermes/desktop-plugins/` on the
next launch. The Python halves (`orgo-computer`, `texting-style`) are still
per-profile — their own installers handle that.

The script exits non-zero and installs nothing if a downloaded plugin fails
its sanity check (`node --check` + content marker).

## Verify the install

```bash
test -f ~/.hermes/desktop-plugins/computer-viewer/plugin.js && echo computer-viewer OK
test -f ~/.hermes/desktop-plugins/grokbot-override/plugin.js && echo grokbot-override OK
```

Folder names must be exactly `computer-viewer` and `grokbot-override` (they
must match the plugin ids). Do not rename them.

Bubble Mode, Bot Sections and Task Dock were retired from the kit on
2026-11-10 (Grokbot Override now owns roster sections and the work-rows
setting). An older install may still have their folders; the installer names
them and leaves them alone unless `KIT_REMOVE_RETIRED=1` is set.

## After installing — needs the human or a running app

Hermes Desktop loads disk plugins at startup and on plugin reload. One of:

- In Hermes Desktop: command palette (Cmd+Shift+P / Ctrl+Shift+P) →
  **Reload plugins**, or
- Restart the Hermes Desktop app.

An agent without GUI control cannot complete this step; tell the user to do
it. Then:

- **Grokbot Override** is installed switched **on** (it is the kit's main
  plugin): its Bots tab replaces the stock one. palette → "Grokbot Override:
  toggle" switches back to stock Bot Mode (the same command turns it on
  again); a user who switched it off before keeps it off. Work rows:
  palette → "Grokbot Override: show work rows". It is a preview: if Bot Mode
  misbehaves, switch it off rather than editing files.
- **Computer viewer** must be enabled once in Settings → Plugins
  (inventory name: **Computer**), then a computer added in the pane. Endpoint
  setup (cloud boxes, spare machines, HD mode) is interactive and documented
  in [computer-viewer/README.md](computer-viewer/README.md); host-machine
  one-liners are printed by the plugin itself.

## Optional: the agent-cards skill (cards in the Grokbot Override chat)

Off by default. It teaches bots to show approval, task and email-draft cards
in the Grokbot Override chat (question cards need no skill: they come from
Hermes's built-in `clarify` tool). From a clone, or from a release newer than
v2026.11.10 (older release manifests do not list the skill; the installer says
so and skips it):

```bash
KIT_CARDS_SKILL=1 bash install.sh                               # default profile + every profile
KIT_CARDS_SKILL=1 KIT_CARDS_PROFILES=default,helper bash install.sh
KIT_CARDS_SKILL=remove bash install.sh                          # remove it again; installs nothing
```

It lands at `<profile-home>/skills/agent-cards/SKILL.md` (the root home is
`default`). An `agent-cards` skill that is not this kit's copy is left alone,
on install and on remove. Bots also need the `file` and `clarify` toolsets
for Desktop chat. A chat started before the install keeps its old mode until
its session restarts. Details:
[grokbot-override/README.md](grokbot-override/README.md#cards).

## Optional: texting-style (agent plugin, per profile)

Makes bots reply in a short SMS register. Installs into Hermes profile homes
and enables itself in each profile's `config.yaml`:

```bash
curl -fsSL https://raw.githubusercontent.com/thomasbek3/hermes-bot-kit/v2026.11.10/texting-style/install.sh | bash          # all profiles
curl -fsSL https://raw.githubusercontent.com/thomasbek3/hermes-bot-kit/v2026.11.10/texting-style/install.sh | bash -s -- --profiles default,helper
```

Verify: `hermes plugins list` shows `texting-style enabled`. Takes effect on
the next message in each Bot Chat (a pre_llm_call backfill hook covers
existing eternal sessions whose frozen prompt predates the plugin) — but the
NEW PLUGIN CODE only loads when the agent process restarts: after
install/update, restart Hermes Desktop or gracefully restart the exact per-profile serve process after verifying
its ownership (do not use broad process-name kills). Debug: `TS_DEBUG=1` logs hook decisions to
`/tmp/texting-style-debug.log`. Uninstall: remove
`<profile-home>/plugins/texting-style` and its `plugins.enabled` entry.

## Optional: give bots hands (agent plugin, Orgo computers)

Separate from the desktop plugins. Installs the `orgo-computer` agent plugin
into Hermes profiles so bots can run shell/screenshot/click/type on a pinned
Orgo computer:

```bash
git clone https://github.com/thomasbek3/hermes-bot-kit.git
bash hermes-bot-kit/computer-viewer/install-agent-plugin.sh --profiles <name1>,<name2> --yes --api-key-stdin <<< "$ORGO_API_KEY"
```

Requires an Orgo API key from the user. The key never appears in argv or
shell history this way. Never invent or reuse keys found in files without
the user's say-so.

## Uninstall

```bash
rm -rf ~/.hermes/desktop-plugins/computer-viewer ~/.hermes/desktop-plugins/grokbot-override
```

The agent-cards skill, if you installed it: `KIT_CARDS_SKILL=remove bash install.sh`.

Then reload plugins (same as above). Plugin settings live in Hermes plugin
storage under `hermes.plugin.computer-viewer.*` / `hermes.plugin.grokbot-override.*`.

## Facts that prevent wasted debugging

- Requires Hermes Desktop ≥ 0.20.5. On older builds the Computer pane is
  zero-size; there is no workaround, update the app.
- Desktop Bot Chats are served by long-lived per-profile
  `hermes --profile <name> serve` daemons that SURVIVE app restarts. If a
  plugin change "doesn't take", verify the exact daemon owner and gracefully
  restart only that process (it respawns on demand)
  — do not keep redeploying files.
- "Bot Chat" is the desktop's canonical per-bot conversation (session
  literally titled `Bot Chat`, user-locked). Grokbot Override opens that same
  session, and texting-style's doctrine gates on it; every other session
  renders stock by design.
- A serve restart under an open Bot Chat tab can scramble the tab's caption
  (stock Hermes bug; data unaffected); the caption is restored by: close tab
  → quit app → relaunch → click the bot.
- CLI probes cannot reach a canonical Bot Chat: `-z --continue "Bot Chat"`
  and `--resume <id>` both fork new sessions. Only the desktop UI talks to
  the real one.
- Desktop plugins fail safe: if a Hermes update renames internal hooks, chats
  render stock / the pane stays empty / the roster stays stock — nothing
  crashes.
- The repo was formerly `hermes-computer-viewer`. The host scripts live in
  `computer-viewer/` (`computer-viewer/connect-mac.sh` and so on); the old
  root shims were removed on 2026-11-10, so use the `computer-viewer/` path
  (one-liners pinned to an older release tag keep working).
- Do not curl-pipe `connect-*.sh` / `hiperf-*.sh` on the machine running
  Hermes Desktop unless the user asked to view **that** machine — they are
  host-side setup scripts for the computer being viewed, and they install
  LaunchAgents / services / scheduled tasks on it.
