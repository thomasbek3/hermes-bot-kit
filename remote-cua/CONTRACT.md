# remote-cua: what it relies on in Hermes

Supported: **Hermes `>=0.23.0,<0.24.0`** (`compat.SUPPORTED_HERMES`, mirrored in `plugin.yaml`
`requires_hermes`). Built and tested against Hermes 0.23.1, cua-driver pin 0.21.0.

## Private imports (version-gated)

All go through `compat.private()`, which checks the running version first and raises
"remote-cua needs Hermes <range>" when the version is out of range or a name is missing. Nothing
below is imported at plugin load time.

| Module | Name | Used for |
|---|---|---|
| `tools.computer_use.cua_backend` | `CuaDriverBackend` | subclassed: the whole backend runs unchanged on the remote daemon |
| `tools.computer_use.cua_backend` | `_computer_use_max_image_dimension` | same screenshot cap Hermes applies in `start()` |
| `tools.computer_use.cua_backend_session` | `_CuaDriverSession` | subclassed: only the stdio spawn (ssh) and the CLI fallback (ssh) change |
| `tools.computer_use.cua_backend_session` | `_cli_result` | parse `cua-driver call` output the same way Hermes does |
| `tools.computer_use.cua_backend_parse` | `_tool_envelope` | the `human_has_control` refusal in Hermes's result shape |
| `tools.computer_use.cua_backend_driver` | `_manifest_contract_reason` | the remote driver passes Hermes's 0.20 contract |
| `tools.computer_use.cua_backend_daemon` | `_CUA_DRIVER_TEAM_IDS` | accepted signing teams for CuaDriver.app |
| `tools.computer_use.permissions` | `CUA_DRIVER_BUNDLE_ID` | expected app identifier |
| `pm` | `ensure_import` | lazily install the MCP client SDK, as Hermes does |

Also read, not imported: `pm/lock.json` → `packages.cua-driver.version` (the gateway's pin).

`_CuaDriverSession` attributes the subclass relies on: `_embedded_daemon`, `_lifecycle_coro` (overridden),
`_populate_capabilities`, `_ready_event`, `_shutdown_event`, `_setup_error`, `_startup_phase`,
`_session`, `_started`, `_LIFECYCLE_CALLS`, `_call_tool_via_cli` (overridden), `call_tool`.
`CuaDriverBackend`: `_bridge`, `_session`, `_session_id`, `_embedded_daemon`, `_best_effort`,
`_handle_transport_reset`, `set_config`, `set_agent_cursor_enabled`.

## Public plugin APIs used

- `ctx.register_computer_use_provider` (computer-use provider discovery, `plugins/computer_use/__init__.py`),
  `tools.computer_use.backend.ComputerUseProvider`.
- `ctx.register_hook("pre_tool_call", …)` returning `{"action": "block", "message": …}`.
- `ctx.register_cli_command` (`hermes remote-cua check`).
- Dashboard plugin routes: `dashboard/manifest.json` + `api: plugin_api.py`, mounted at
  `/api/plugins/remote-cua/` behind Hermes's `/api/` auth and `plugins.enabled` consent.
- `hermes_cli.config.load_config_readonly`, `hermes_constants.get_hermes_home`,
  `hermes_cli.version_info.get_version_info`.

## Smoke test

```bash
~/.hermes/hermes-agent/venv/bin/python -m pytest -p no:cacheprovider remote-cua/tests/test_backend_contract.py
```

`test_every_private_import_resolves` imports every name above; the others load the plugin through
Hermes's real computer-use discovery and manifest parser and run Hermes's real session against a fake
driver. Run it against a new Hermes release before widening `SUPPORTED_HERMES`.
