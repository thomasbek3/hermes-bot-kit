# Hermes v0.23.0 compatibility

Target: NousResearch/hermes-agent v0.23.0, commit `2bd378ed1b8d`.

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

## Verify a checkout

Run the repository CI checks, then with an installed Hermes source checkout
whose Node dependencies are already present:

```sh
node scripts/check-hermes-compat.mjs /path/to/hermes-agent
bash scripts/make-manifest.sh --check
```

The SDK check parses Hermes's actual ESM export list using its installed esbuild,
checks all four desktop plugins' named imports and syntax, and checks the focused
owner contract. Behavioral regressions cover same-name profiles, different gateway
IDs, unresolved owners, local fallback and same-session-ID task-cache isolation.
The Python, installer and host-script suites cover their respective local fixtures.
These checks do not establish live VNC/Orgo connectivity or exercise every tool,
model login, desktop layout, or OS. This branch has not been installed into a live
Desktop session; live visual acceptance remains outstanding before release.

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
