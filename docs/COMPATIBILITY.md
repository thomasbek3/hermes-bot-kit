# Hermes compatibility

**Supported: Hermes Desktop v0.23.0 and newer.** Checked 2026-11-21 against:

| Hermes | Commit | Result |
|---|---|---|
| stable **v0.23.3** (released 2026-11-20) | `caafe5389ae585ef77387a962aee05b1bcf17029` | every surface present; no breaking change in the contracts the kit uses (only optional fields and new methods added); agent-plugin tests pass on its real code |
| stable **v0.23.2** (2026-11-16) | `ae2a81ccc00e9b7c06301523e5bb09608397149c` | every surface present (checked 2026-11-19) |
| stable **v0.23.0** (2026-11-05) | `2bd378ed1b8d6bf2192cb26e0a55ff3091e6bd19` | every surface present; agent-plugin tests pass on its real code (the minimum) |
| main / canary (2026-11-21) | `25a1302eacb563c59eb3b7454c1a53f8c89f274c` | every surface present |
| v0.22.7 | `b200f5bc60e31588ba2cb60e288029c4a54ba5fa` | not supported: no `groups.continue` (a group chat's Continue button fails) |
| v0.21.7 | `71d34bad1045610252eda02ee79549436896e784` | not supported: 9 surfaces missing (`ctx.files`, `session.rewind`, ...) |

v0.22.0 to v0.22.6 and v0.23.1 were not checked.
[v0.23.3 release](https://github.com/NousResearch/hermes-agent/releases/tag/v0.23.3).

## What changed in v0.23.3 for the kit

- **remote-cua: the cua-driver pin moved from 0.21.0 to 0.52.0** (`pm/lock.json`).
  remote-cua follows the gateway's pin, so after the gateway's Hermes is on
  v0.23.3 the remote Mac needs cua-driver 0.52.0 (with its `CuaDriver.app`)
  too. Until then the Computer pane's check and every `computer_use` call
  refuse: with the old driver on PATH they say "cua-driver on <host> is 0.21.0,
  but this gateway's Hermes pins 0.52.0"; if the old driver is only in its
  versioned tools folder and not on PATH, they report that 0.52.0 was not found.
  Every private name remote-cua imports, and the daemon and MCP launch flags,
  are unchanged. Not run live against a 0.52.0 driver yet.
- **Stock Bot Mode gained a "teammate waits" banner** above a Bot Chat's
  composer (`plugins/hermes-bots/teammate-waits.tsx`, new `bot_delivery.list`
  method). Grokbot Override draws its own composer, so the banner does not show
  there; stock Bot Mode (⌘K → Grokbot Override: toggle) has it.
- Everything else the kit uses is unchanged or only gained optional fields: the
  plugin SDK barrel (one new export, `useComposerSession`), the runtime loader,
  the plugin manifest parser, `plugin_validate_desktop.py`, the desktop-plugins
  folder rules the installer and doctor rely on, the gateway contracts, and the
  bundled Slack adapter's internals slack-http extends (Socket Mode and vault
  code handling moved into mixins; the names are still on `SlackAdapter`).

## What was checked

Every Hermes surface the two desktop plugins (Grokbot Override, Computer) and
texting-style use, read from the kit's sources (`grokbot-override/src`,
`computer-viewer/plugin.js`), not the built bundle:

- **Plugin SDK**: 49 names read off `@hermes/plugin-sdk`, 23 `host` members,
  8 `host.state` members, 12 plugin-context members (`ctx.*`), and the SDK
  icons the Computer plugin draws without a fallback. The SDK barrel, the plugin
  context and the runtime loader's import pipeline are the same in v0.23.0,
  v0.23.2, v0.23.3 and main, apart from log wording and new exports.
- **Gateway**: 91 RPC method, server-request and event names. The
  `tui_gateway/contracts` declarations only gain optional fields and new
  methods from v0.23.0 through v0.23.3 and main; nothing the kit sends or reads
  was removed or renamed.
- **REST** (19 dashboard routes), the `window.hermesDesktop` bridge (8 members),
  and the Hermes DOM anchors the override hides or restyles (17 `data-*`
  attributes, the `statusbar` slot, `.aui-md`).
- **Agent plugins**: the registration hooks texting-style uses, and every
  Hermes module and name the agent plugins import (remote-cua, email-drafts,
  slack-http, slack-connect, slack-check), present in v0.23.0, v0.23.2,
  v0.23.3 and main. On 2026-11-21 their test suites also ran against the real
  v0.23.0 and v0.23.3 code (a throwaway venv with Hermes's declared
  dependencies, `HERMES_AGENT_DIR` pointing at the checkout): remote-cua 105
  passed (1 live test skipped), slack-connect 114, slack-check 26, email-drafts
  70, texting-style 7, the same on both. `hermes plugins validate` from each
  release passes email-drafts, remote-cua, slack-http and texting-style with the
  same output on both (three warnings about private core access, one for remote-cua and two for slack-http: remote-cua
  gates its private imports on the Hermes version, slack-http checks every
  adapter name it needs before HTTP mode starts and otherwise stops with
  "slack-http plugin incompatible with this Hermes version").

Grokbot Override already feature-detects the SDK names it reads (a namespace
import, so a missing name is `undefined`, never a module link error). The
Computer plugin's named imports are all present from v0.23.0 on. No fallback was
needed for v0.23.2 or v0.23.3.

## Repeat the checks

Against a separate, clean Hermes Agent source checkout:

```sh
python3 -I scripts/check-hermes-compat.py /path/to/hermes-agent
node --test computer-viewer/plugin.test.mjs
npm ci --prefix grokbot-override && npm test --prefix grokbot-override
python3 -m unittest discover -s texting-style/tests
```

## Check your own Hermes

`bash install.sh --doctor` runs the same check against the Hermes Agent source
on your machine (`<home>/hermes-agent`, or `KIT_HERMES_SOURCE=/path`), and the
installer runs it as its last step. Either way it is read-only and never fatal:

- `OK    Hermes source v0.23.3 (commit caafe5389): every surface the kit uses is there`
- `WARN  Hermes … lacks N surface(s) the kit uses; the kit may misbehave on this Hermes; check docs/COMPATIBILITY.md / update the kit`,
  then one `- <area>: <name> (affects: <kit part>)` line per missing name
- `INFO  Hermes source check: skipped (<why>)`: no source there, no python3
  3.8 or newer (macOS's `/usr/bin/python3` 3.9 works once the Command Line
  Tools are installed; it is never run as the installer stub), or a partial
  source tree.

What the kit uses comes from `scripts/hermes-surfaces.json` (written by
`python3 scripts/check-hermes-compat.py --write-surfaces scripts/hermes-surfaces.json <hermes v0.23.3 checkout>`;
CI fails when it no longer matches the kit's sources), so the doctor fetched
on its own, without the kit's sources, can run it. The version comes from the
checkout's `.git` files (git itself is not run).

`check-hermes-compat.py` reads the checkout as text, never imports or runs it,
and prints how many names each area checked. CI runs it against stable
`v0.23.3`, the minimum `v0.23.0` and upstream `main` on pushes, PRs and a weekly schedule. It checks
that names are present, not TypeScript signatures, behaviour, CSS layout or model
responses. A pass is an early warning, not proof of runtime compatibility.

The Grokbot Override tests load the built `plugin.js` through a copy of Hermes's
runtime loader (`test/hermes-loader.mjs`, ported from v0.23.0, unchanged
through v0.23.3) with a stub SDK. Loading it into the real v0.23.3 SDK needs a
full Desktop build and was not done.

The agent-plugin tests against a real Hermes checkout:

```sh
HERMES_AGENT_DIR=/path/to/hermes-agent /path/to/hermes-venv/bin/python -m pytest -p no:cacheprovider -q remote-cua/tests slack-connect/tests slack-check/tests
```

## Not verified

- **Live rendering on a v0.23.3 Desktop.** No stable Desktop app was run; the
  results above come from source. Still needed, in a test Desktop: install from
  the checkout, run **Reload desktop plugins** from the command palette
  (⌘K, or Ctrl+K on Windows and Linux), then check the Bot Chat,
  approvals, roster sections, a test computer, texting-style and a bot's
  `computer_use` calls with a configured model. Include two connections with
  identically named profiles for a multi-gateway fleet.
- **remote-cua with cua-driver 0.52.0** (v0.23.3's pin) on a real Mac. The
  contract tests use a fake driver.
- Windows PowerShell parsing is covered by Windows CI, not by this check.

This kit does not select, pin, download or upgrade a model. Choose a
provider and model in Hermes.

Install snippets stay pinned to the published kit release. Updating this source
tree does not publish a release. Use `bash install.sh` from this checkout to
test it, and cut a release through `scripts/release.sh` before changing the
public install pin.
