# texting-style — bots that text like people

> Part of [**Hermes Bot Kit**](../README.md). Bubble Mode makes chats *look*
> like texting; this makes your bots *talk* like texting.

A tiny Hermes **agent plugin** (not a desktop plugin) that applies an SMS
doctrine to each bot's canonical **Bot Chat only**: reply short by default
(1-2 sentences), mirror the user's length, no headers or bullet lists in
chat, ack first then report when doing real work, and go long only when
asked or when the deliverable itself is long. Work sessions and every other
conversation stay long-form.

No tools, no network calls. The full doctrine is the `DOCTRINE` string at
the top of [`__init__.py`](__init__.py) — edit it to taste.

## Install

```bash
curl -fsSL https://raw.githubusercontent.com/thomasbek3/hermes-bot-kit/master/texting-style/install.sh | bash
```

Non-interactive it installs into **every** discovered profile (`~/.hermes`
plus `~/.hermes/profiles/*`). Pick profiles with
`--profiles default,parker`. From a clone (`bash texting-style/install.sh`)
the plugin is symlinked so `git pull` updates it; curl-piped installs copy
the files.

**Takes effect on the next message** in each Bot Chat — including chats that
already exist (see How it works). One caveat: the agent *processes* serving
open desktop chats are long-lived, so after installing or updating the
plugin code, restart Hermes Desktop (or `pkill -f "hermes --profile <name> serve"`
— they respawn on demand) so the new code actually loads.

## Config

Per profile, in the plugin's config (`config_schema` keys):

| Key | Default | Meaning |
|---|---|---|
| `enabled` | `true` | Master switch. |
| `bot_chat_only` | `true` | Apply only to Bot Mode chats — sessions titled `Bot Chat`, the desktop's canonical per-bot conversation (the exact gate Hermes core uses in `tools/bot_mode_probe.py`). Regular Sessions stay stock even in the same profile. `false` = everywhere. |
| `platforms` | `""` (all) | Comma-separated allowlist, e.g. `desktop` or `desktop,telegram` — other platforms get stock behavior. |
| `extra_rules` | `""` | One extra rule line appended to the doctrine. |

## How it works

Two delivery paths, so it works on brand-new and years-old chats alike:

1. **System-prompt section** — `register_system_prompt_section(
   "texting-style.sms-register", …)`: Hermes's cache-safe way for a plugin
   to add durable guidance to the system prompt (bounded at 4,000 chars,
   rendered once per new session, named + logged at session start).
2. **Backfill hook** — canonical Bot Chats are *eternal sessions*: their
   frozen prompt only rebuilds on a capability-epoch change, so a chat that
   predates this plugin would never render the section. A `pre_llm_call`
   hook covers the gap: each turn, if the session is a Bot Chat whose stored
   system prompt lacks the doctrine, the doctrine is injected as per-turn
   context. Once an epoch rebuild bakes the section in, the hook goes
   silent automatically. The bot will truthfully say the rules are "not in
   my frozen prompt" — they arrive with each message instead, and the
   doctrine says so.

Session titles are read from the profile's `state.db` (read-only, searching
every profile's DB — some Hermes builds mis-resolve the active profile home).
Any lookup failure fails safe to stock behavior.

Debugging: run the agent with `TS_DEBUG=1` and the hook logs each decision
(`INJECTING` / `blocked: …`) to `/tmp/texting-style-debug.log`.

Uninstall: remove `plugins/texting-style` from the profile home and drop
`texting-style` from `plugins.enabled` in its `config.yaml`.
