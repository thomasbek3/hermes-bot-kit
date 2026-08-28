# Build notes -- orgo-computer agent plugin (control)

Built from `docs/SPEC-CONTROL.md` (resolved spec v1.1). Korgo source
`references/korgo-agent/orgo_agent_mcp.py` was studied for `_agent_endpoint`,
limits, `_safe_error_message`, `_response_text`, `_parse_result`, and
`_ComputerRunLock`. It is not imported.

Working copy: `build-control/` only.

## What shipped

| Path | Role |
|---|---|
| `agent-plugin/orgo-computer/plugin.yaml` | Manifest v2 |
| `agent-plugin/orgo-computer/__init__.py` | `register(ctx)` |
| `agent-plugin/orgo-computer/schemas.py` | Tool schemas |
| `agent-plugin/orgo-computer/tools.py` | Handlers, lock, list/pin, CLI, hook |
| `agent-plugin/orgo-computer/skills/computer-basics/SKILL.md` | Bundled opt-in skill |
| `install-agent-plugin.sh` | Multi-profile installer |
| `README.md` | New section "Give your bots hands (agent plugin)" |
| `docs/SPEC-CONTROL.md` | Copy of the resolved spec |

Tools: `orgo_computer_run`, `orgo_computer_bash` (`toolset="orgo_computer"`,
`is_async=True`). Slash: `/computer` plus alias `/orgo-computer`. CLI:
`hermes orgo-computer list|set`. Hook: `pre_tool_call` approval escalation.

## Self-checks

1. `python3 -m py_compile` on `__init__.py`, `schemas.py`, `tools.py` -- pass.
2. `bash -n install-agent-plugin.sh` -- pass.
3. Zero non-ASCII in authored plugin files and the installer (python scan;
   macOS `/usr/bin/grep` has no `-P`). `docs/SPEC-CONTROL.md` is a byte copy
   of the spec and therefore keeps the spec's own Unicode punctuation. The
   pre-existing README body already had Unicode; the new agent-plugin section
   is ASCII.
4. No top-level `import httpx` -- only inside `_import_httpx()` (called from
   handlers / list helpers).
5. `ast.parse` on the three `.py` files -- pass.
6. `hermes plugins doctor agent-plugin/orgo-computer --ci` -- pass. Output:

```
Plugin Doctor:
/Users/thomasbekkers/Documents/hermes-computer-viewer-spec/build-control/agent-p
lugin/orgo-computer
  manifest: orgo-computer 1.0.0 (standalone)
  OK: runtime discovery, manifest parsing, import, and registration passed
  registrations: 2 tool(s), 1 hook(s)
```

Doctor uses a temp `HERMES_HOME` with no `ORGO_API_KEY`; that was not a
failure. Missing-env disable is a runtime tool-availability check, not a
`register()` crash.

7. Acceptance criteria 1, 3, 10 (see below). Live-box criteria were not run.

## Spec section 8 -- AC 1, 3, 10

**AC1 (doctor / compile / bash -n / ASCII):** Satisfied in this workspace as
the self-checks above. Doctor did not import httpx at load and did not touch
the network.

**AC3 (installer isolation):** Satisfied with a fake `HOME` (not the real
`~/.hermes`):

- `--profiles default,ava --yes --api-key ...` created symlink +
  `plugins.enabled: [orgo-computer]` + `.env` `ORGO_API_KEY` on default and
  ava.
- Unselected profile `other` got no `plugins/` dir, no `.env`, and no
  `orgo-computer` in `config.yaml`.
- Re-run left the existing non-empty key in place (`sk-should-not-overwrite`
  was not written).

**AC10 (clamps / error JSON / never raise):** Satisfied in-process (no live
Orgo box):

- model outside the enum -> `{"error": "model must be one of: ..."}`
- `max_steps` 0 and 101 -> `{"error": "max_steps must be between 1 and 100."}`
- task > 20000 chars -> too-long error JSON
- no pin -> the spec no-pin JSON (do not retry; tell the user to run
  `/computer`)
- 401 mapping uses the spec copy (profile `.env` + 2026-08-22 rotate note)
- handlers wrap everything; unexpected exceptions become error JSON
- lock: second in-process acquire on the same computer_id returns the
  lock-busy copy after the wait (measured ~0.75s with a 0.6s wait)

Wrong API key and network-cut-mid-run need a live box / induced net fail.
Those paths use the same `_safe_error_message` / timeout / HTTPError mapping
as Korgo and never raise out of the handler.

## VERIFY resolutions

**1. Plugin-tool approval gating.** Hermes does not send plugin tools through
terminal command-approval by default. `pre_tool_call` returning
`{"action": "approve"}` does escalate to `request_tool_approval` (same
`[o]nce/[s]ession/[a]lways/[d]eny` gate). Chosen: register `pre_tool_call`
for `orgo_computer_run` and `orgo_computer_bash`, declare
`provides_hooks: [pre_tool_call]`. README states `--yolo` still auto-approves
and untrusted profiles should not enable the plugin.

**2. Multiplex `get_config`/`set_config`.** Source-verified: both read/write
`plugins.entries.<id>.settings` under `get_hermes_home()`, and
`get_hermes_home()` honors `_HERMES_HOME_OVERRIDE`. Gateway/TUI multiplex
sets that contextvar per session. `/computer` therefore uses
`ctx.set_config("computer_id", uuid)` as specified. `ctx.state` fallback was
not added because state is also `HERMES_HOME`-scoped, so it would not help
if the override were missing. CLI `set` never uses `ctx.set_config`.

**3. Host tool timeout vs 900s CUA.** Hermes sequential/concurrent tool
deadline defaults to 420s (`timeouts.tools.sequential_call` inherits
`concurrent_batch`, default 420). Gateway inactivity timeout is 1800s (not
the cap). Chosen: lower plugin `timeout_seconds` default from Korgo's 900 to
420 so httpx and the host bound agree. Operators who want 900s runs must
raise both the host timeout keys and this plugin setting. Env
`ORGO_AGENT_TIMEOUT_SECONDS` and config still override.

**4. `computer_id` on `/v1/chat/completions`.** No extra handling. 402/403
mapping from Korgo covers plan/key rejection.

## Deviations from the spec (and why)

1. **`timeout_seconds` default 420, not 900** -- VERIFY 3, above.
2. **`provides_hooks: [pre_tool_call]`** added to the DECIDED `plugin.yaml`
   block -- required by the VERIFY 1 fallback so doctor does not warn about
   an undeclared hook.
3. **Task / max_steps / model are validated before the pin check** so AC10
   bad-input JSON is returned even when no computer is pinned. Korgo ran
   `_credentials()` first. Same error strings.
4. **List key fallbacks** are the union of the spec's short list and the
   viewer's proven keys: workspaces `projects|workspaces|data|items|results`,
   computers `desktops|computers|instances|data|items|results`. Pin is still
   desktop `id`, never `fly_instance_id`. Bare `GET /computers` is never
   called.
5. **`ORGO_AGENT_MODEL` env** is accepted as a model fallback (spec's
   "config-first, env-fallback ... etc."). Default remains `claude-sonnet-5`.
6. **`docs/SPEC-CONTROL.md` Unicode** -- faithful copy of the spec, not
   transliterated.
7. **No `ctx.state` pin mirror** -- VERIFY 2 resolved as unnecessary.

## Kept from Korgo (not listed as adaptations, so unchanged)

- `_agent_endpoint()` including `/v1`-suffix handling and `ORGO_AGENT_API_URL`
- Limits: task 20000, result 50000, max_steps 1-100, default steps 30
- Model allow-list literal (schema enum too)
- `_response_text` / `_parse_result` (except `computer_id` omitted from the
  dumped success JSON)
- `_safe_error_message` status mapping (401 copy replaced per spec)
- Env fallbacks `ORGO_AGENT_MAX_STEPS`, `ORGO_AGENT_TIMEOUT_SECONDS`,
  `ORGO_AGENT_LOCK_WAIT_SECONDS`
- Flock path `$TMPDIR/hermes-orgo-agent-<computer_id>.lock`, 5s wait, 0.25s
  poll, lock held for the whole HTTP call
- Request body `{model, computer_id, messages, max_steps}`

## Locking

Acquisition order: in-process `threading.Lock` per computer_id (timeout),
then `fcntl.flock`. Both held for the run. On `ImportError: fcntl`
(Windows): in-process lock only, one warning. Sync variant
`_computer_run_lock_sync` uses `time.sleep` for a sync-httpx fallback; the
shipped handlers are async.

## Not verified live (separate)

- Real Orgo `echo hello` bash shape against Hermes Computer
- Stopped-computer "instance not available" mapping against a live 400
- Delegated CUA 2xx + viewer pane ritual
- Cross-process flock between two `hermes -p` processes (in-process lock
  was tested)
- Gateway multiplex pin isolation across two live profiles
- Missing-httpx first tool call (code path is `_import_httpx()` -> error
  JSON containing `pip install 'httpx>=0.27,<1'`)
