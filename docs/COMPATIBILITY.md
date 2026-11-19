# Hermes compatibility

**Supported: Hermes Desktop v0.23.0 and newer.** Checked 2026-11-19 against:

| Hermes | Commit | Result |
|---|---|---|
| stable **v0.23.2** (2026-11-16) | `ae2a81ccc00e9b7c06301523e5bb09608397149c` | every surface present, same params and fields as main |
| stable **v0.23.0** (2026-11-05) | `2bd378ed1b8d6bf2192cb26e0a55ff3091e6bd19` | every surface present; v0.23.2 only added optional fields |
| main / canary (2026-11-18) | `93790765c57a16d289fd69ea9861abb3144e3f8f` | every surface present (the kit was built and live-tested here) |
| v0.22.7 | `b200f5bc60e31588ba2cb60e288029c4a54ba5fa` | not supported: no `groups.continue` (a group chat's Continue button fails) |
| v0.21.7 | `71d34bad1045610252eda02ee79549436896e784` | not supported: 9 surfaces missing (`ctx.files`, `session.rewind`, ...) |

v0.22.0 to v0.22.6 and v0.23.1 were not checked.
[v0.23.2 release](https://github.com/NousResearch/hermes-agent/releases/tag/v0.23.2).

## What was checked

Every Hermes surface the two desktop plugins (Grokbot Override, Computer) and
texting-style use, read from the kit's sources (`grokbot-override/src`,
`computer-viewer/plugin.js`), not the built bundle:

- **Plugin SDK**: 49 names read off `@hermes/plugin-sdk`, 23 `host` members,
  8 `host.state` members, 12 plugin-context members (`ctx.*`), and the SDK
  icons the Computer plugin draws without a fallback. The SDK barrel, the plugin
  context and the runtime loader's import pipeline are the same in v0.23.0,
  v0.23.2 and main, apart from log wording.
- **Gateway**: 91 RPC method, server-request and event names. The
  `tui_gateway/contracts` declarations differ between v0.23.2 and main only in
  comments. From v0.23.0 to v0.23.2 they only gain optional fields, none of which
  the kit sends.
- **REST** (19 dashboard routes), the `window.hermesDesktop` bridge (8 members),
  and the Hermes DOM anchors the override hides or restyles (17 `data-*`
  attributes, the `statusbar` slot, `.aui-md`).
- **Agent plugins**: the registration hooks texting-style uses.

Grokbot Override already feature-detects the SDK names it reads (a namespace
import, so a missing name is `undefined`, never a module link error). The
Computer plugin's named imports are all present from v0.23.0 on. No fallback was
needed for v0.23.2.

## Repeat the checks

Against a separate, clean Hermes Agent source checkout:

```sh
python3 -I scripts/check-hermes-compat.py /path/to/hermes-agent
node --test computer-viewer/plugin.test.mjs
npm ci --prefix grokbot-override && npm test --prefix grokbot-override
python3 -m unittest discover -s texting-style/tests
```

`check-hermes-compat.py` reads the checkout as text, never imports or runs it,
and prints how many names each area checked. CI runs it against stable
`v0.23.2` and upstream `main` on pushes, PRs and a weekly schedule. It checks
that names are present, not TypeScript signatures, behaviour, CSS layout or model
responses. A pass is an early warning, not proof of runtime compatibility.

The Grokbot Override tests load the built `plugin.js` through a copy of Hermes's
runtime loader (`test/hermes-loader.mjs`, ported from v0.23.0, unchanged
through v0.23.2) with a stub SDK. Loading it into the real v0.23.2 SDK needs a
full Desktop build and was not done.

## Not verified

- **Live rendering on a v0.23.2 Desktop.** No stable Desktop app was run; the
  results above come from source. Still needed, in a test Desktop: install from
  the checkout, run **Reload desktop plugins** from the command palette
  (⌘K, or Ctrl+K on Windows and Linux), then check the Bot Chat,
  approvals, roster sections, a test computer, texting-style and a bot's
  `computer_use` calls with a configured model. Include two connections with
  identically named profiles for a multi-gateway fleet.
- Windows PowerShell parsing is covered by Windows CI, not by this check.

This kit does not select, pin, download or upgrade a model. Choose a
provider and model in Hermes.

Install snippets stay pinned to the published kit release. Updating this source
tree does not publish a release. Use `bash install.sh` from this checkout to
test it, and cut a release through `scripts/release.sh` before changing the
public install pin.
