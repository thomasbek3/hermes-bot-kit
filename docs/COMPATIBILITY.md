# Hermes compatibility

Checked 2026-11-07 against NousResearch/hermes-agent stable **v0.23.0**, commit
`2bd378ed1b8d6bf2192cb26e0a55ff3091e6bd19`.
[Official release](https://github.com/NousResearch/hermes-agent/releases/tag/v0.23.0).

The four Desktop plugins use the Desktop plugin SDK and DOM markers. The
optional texting-style and orgo-computer plugins use Agent plugin registration
APIs. These are separate from the language model: this kit does not select,
pin, download, or upgrade a model. Choose a provider/model through Hermes;
texting-style supplies prompt context and orgo-computer supplies tools. Actual
model behavior and tool calling still require a configured provider test.

## Multi-gateway ownership (v0.23)

Desktop now keeps registered gateways connected simultaneously. An agent is
identified by its gateway and profile, not its profile name alone. The kit
uses `host.state.focusedSessionOwner` for Computer bindings and Task Dock
snapshots, including focused remote tiles. While ownership is unresolved,
the viewer disconnects and the task dock hides rather than using another agent.

Existing local profile settings keep their keys. Remote bindings use a separate
key per gateway/profile. Re-select the computer endpoint for each remote agent
in Computer settings after upgrading: an old unqualified `pricing` binding is
not automatically copied to every remote agent named `pricing`. An explicitly
configured global endpoint remains global. Gateway IDs are stable registry IDs;
removing and re-adding a gateway may require selecting its bindings again.

Bot Sections uses the disambiguated handle from fleet roster rows. Shared display
names no longer apply old section overrides to multiple machines. Existing saved
layouts remain in storage; assign a qualified handle to restore an ambiguous row.
Bubble Mode continues to use the canonical Bot Chat gate; regular sessions stay
stock. Python plugins run on the owning backend and remain per-profile.

## Repeat the checks

Against a separate, clean Hermes Agent source checkout:

```sh
python3 scripts/check-hermes-compat.py /path/to/hermes-agent
node --test bubble-mode/plugin.test.mjs bot-sections/plugin.test.mjs task-dock/plugin.test.mjs computer-viewer/plugin.test.mjs
python3 -m unittest discover -s texting-style/tests
python3 -m unittest discover -s computer-viewer/agent-plugin/orgo-computer/tests
```

Deeper SDK check (local, needs a Hermes source checkout with its Node
dependencies installed) and the manifest check:

```sh
node scripts/check-hermes-compat.mjs /path/to/hermes-agent
bash scripts/make-manifest.sh --check
```

The Node check parses Hermes's actual ESM export list using its installed esbuild,
checks all four desktop plugins' named imports and syntax, and checks the focused
owner contract. Behavioral regressions cover same-name profiles, different gateway
IDs, unresolved owners, local fallback and same-session-ID task-cache isolation.
The Python, installer and host-script suites cover their respective local fixtures.
These checks do not establish live VNC/Orgo connectivity or exercise every tool,
model login, desktop layout, or OS.

CI checks the pinned stable baseline and upstream main on pushes, PRs, and a
weekly schedule. Source checks detect removed SDK names, literal DOM slot names,
and agent registration hooks. They do not validate TypeScript signatures,
transitive exports, CSS layout, RPC routing, or model responses. A passing source
check is an early warning check, not a guarantee of full runtime compatibility.

## Live acceptance still required

In a test Desktop setup, install from the checkout and reload plugins. Inspect
Bot Chat bubbles, approvals and group/regular session exclusions; move/collapse
roster sections; switch bots with a saved Task Dock; connect a test computer;
and exercise texting-style and Orgo tools with a configured model. Include two
connections with identically named profiles when checking a multi-gateway fleet.
No live Desktop files, model settings, services, or remote computers were changed
by this source audit. Windows PowerShell parsing remains covered by Windows CI.

Install snippets remain pinned to the existing published kit release. Updating
this source tree does not publish a new release or change what those URLs serve.
Use `bash install.sh` from this checkout to test the updated source. Cut a new
kit release through `scripts/release.sh` before changing the public install pin.

## Install and restart

This is an unreleased source change. Published install commands remain pinned to
the previous release until a new tag is deliberately cut. For a local checkout,
`KIT_SOURCE_DIR=. bash install.sh` installs the manifest-verified desktop files;
then use Desktop's Reload plugins. Do not install only on the remote backend:
desktop plugins belong to the machine running the app, once per app-level home.

Agent-plugin updates require a graceful restart of their owning gateway on their
owning machine. Gateways persist after Desktop closes; use the supported gateway
restart, preserve running work, and avoid broad process-name kills. Changing
which gateway is visible does not move sessions or plugin configuration.
