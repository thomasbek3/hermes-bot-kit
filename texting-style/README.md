# texting-style — bots that text like people

> Part of [**Hermes Bot Kit**](../README.md). Bubble Mode makes chats *look*
> like texting; this makes your bots *talk* like texting.

A tiny Hermes **agent plugin** (not a desktop plugin) that adds one bounded
system-prompt section to new **Bot Mode chats only** (by default): reply
short (1-2 sentences), mirror the user's length, no headers or bullet lists in chat, ack
first then report when doing real work, and go long only when asked or when
the deliverable itself is long.

No tools, no hooks, no network calls. The full doctrine is the `DOCTRINE`
string at the top of [`__init__.py`](__init__.py) — edit it to taste.

## Install

```bash
curl -fsSL https://raw.githubusercontent.com/thomasbek3/hermes-bot-kit/master/texting-style/install.sh | bash
```

Non-interactive it installs into **every** discovered profile (`~/.hermes`
plus `~/.hermes/profiles/*`). Pick profiles with
`--profiles default,parker`. From a clone (`bash texting-style/install.sh`)
the plugin is symlinked so `git pull` updates it; curl-piped installs copy
the files.

Takes effect on **new sessions** (prompt sections are frozen per session):
`/new` in a chat, or restart the gateway.

## Config

Per profile, in the plugin's config (`config_schema` keys):

| Key | Default | Meaning |
|---|---|---|
| `enabled` | `true` | Master switch (next session). |
| `bot_chat_only` | `true` | Apply only to Bot Mode chats — sessions titled `Bot Chat`, the desktop's canonical per-bot conversation (the exact gate Hermes core uses in `tools/bot_mode_probe.py`). Regular Sessions stay stock even in the same profile. `false` = everywhere. |
| `platforms` | `""` (all) | Comma-separated allowlist, e.g. `desktop` or `desktop,telegram` — other platforms get stock behavior. |
| `extra_rules` | `""` | One extra rule line appended to the doctrine. |

## How it works

`register_system_prompt_section("texting-style.sms-register", …)` — Hermes's
cache-safe way for a plugin to add durable guidance to the system prompt
(bounded at 4,000 chars, rendered once per new session, named + logged at
session start). Nothing is injected per turn and the prompt cache stays warm.

Uninstall: remove `plugins/texting-style` from the profile home and drop
`texting-style` from `plugins.enabled` in its `config.yaml`.
