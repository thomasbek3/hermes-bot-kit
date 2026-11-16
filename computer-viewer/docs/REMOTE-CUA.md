# remote-cua routes: take over / hand back for a remote Mac

The [remote-cua](../../remote-cua/README.md) agent plugin lets a bot drive a remote Mac with Hermes's
own `computer_use`. Hermes's native Screen lease (`display.lease.*`) cannot be used for those machines:
it needs a `viewer_id` minted by `display.observe`, which only exists for Hermes's own Linux screen.
So the plugin ships its own lease, and the computer-viewer pane changes it through these routes.

## Mechanism

**A dashboard plugin HTTP route**, the mechanism Hermes gives user plugins for backend calls
(same as the kit's slack-check): `remote-cua/dashboard/manifest.json` declares
`"api": "plugin_api.py"`, and Hermes mounts its FastAPI router at **`/api/plugins/remote-cua/`**.

- **Auth:** Hermes's own. Every `/api/` route requires the dashboard session token
  (`X-Hermes-Session-Token`, or `Authorization: Bearer`) or Hermes Desktop's native ticket; unauthenticated
  requests get 401 before the plugin runs. The plugin must also be in the profile's `plugins.enabled`,
  else 404 `Plugin not found`.
- **Profile scope:** `?profile=<name>` (Hermes binds that profile's home before the handler runs);
  without it, the launch profile. A secondary profile's request is served by that profile's own copy.
- **From the desktop pane:** the same request object the kit already uses for slack-check, through
  the plugin SDK's REST call on the bot's connection:
  `{connectionId?, profile, path: "/api/plugins/remote-cua/lease", method: "GET"}`.

Lease file: `<profile home>/remote-cua/lease.json`, written atomically (tmp + rename, under a lock):

```json
{"holder": "human", "viewer": "pane-7f3a", "since": 1763251200.5, "epoch": 4}
```

No file = `{"holder": "agent", "viewer": null, "since": 0, "epoch": 0}`. `epoch` goes up by one on every
change. `viewer` is any id the pane picks (1-128 of `A-Z a-z 0-9 . _ : -`). The pane mints a **new**
viewer id on every load (ids are never kept across reloads), and after a `take` or `release` that
timed out it switches to another fresh id. So a late `release` that still names the old id gets
409 `not_holder` and cannot revoke a newer grant. A human lease left from before a reload is cleared
with **Hand back (force)** (`release` with `"force": true` and the `"epoch"` of the lease the pane saw),
which clears only that lease: a forced release that commits late gets 409 `stale_force` once the lease
has moved on, so it cannot revoke a newer grant either.

## Endpoints

### `GET /api/plugins/remote-cua/lease`

```json
200 {"ok": true,
     "lease": {"holder": "agent", "viewer": null, "since": 0, "epoch": 0},
     "configured": true,
     "machine": {"host": "100.64.0.10", "user": "you", "os": "macos", "driver": "", "vnc": ""}}
```

Unconfigured profile: `"configured": false, "machine": null, "error": "this profile has no remote_cua block …"`.

### `POST /api/plugins/remote-cua/take` `{"viewer": "pane-7f3a"}`

| Status | Body |
|---|---|
| 200 | `{"ok": true, "lease": {"holder": "human", "viewer": "pane-7f3a", "since": …, "epoch": 5}}` (same viewer again: unchanged, 200) |
| 409 | `{"ok": false, "error": "held_by_other_viewer", "message": "Another viewer has control of this computer", "lease": {…}}` |
| 409 | `{"ok": false, "error": "not_configured", "message": "…", "lease": {…}}` (profile has no `remote_cua`) |
| 400 | `{"ok": false, "error": "bad_viewer", "message": "…"}` |

From 200 on, the bot's `computer_use` is refused with `human_has_control`, and a call already running
when you took over has its result discarded.

### `POST /api/plugins/remote-cua/release` `{"viewer": "pane-7f3a", "force": false}` or `{"viewer": "pane-7f3a", "force": true, "epoch": 5}`

| Status | Body |
|---|---|
| 200 | `{"ok": true, "lease": {"holder": "agent", "viewer": null, "since": …, "epoch": 6}}` (already agent: unchanged, 200) |
| 409 | `{"ok": false, "error": "not_holder", "message": "This viewer does not hold control; use force to hand back anyway", "lease": {…}}` |
| 409 | `{"ok": false, "error": "stale_force", "message": "Control changed since this hand back was sent; nothing was released", "lease": {…}}` (forced, and `epoch` is not the current human lease's) |
| 400 | `{"ok": false, "error": "bad_viewer", …}` (no viewer and no `"force": true`) |
| 400 | `{"ok": false, "error": "bad_epoch", …}` (`epoch` present but not an integer) |
| 400 | `{"ok": false, "error": "force_needs_epoch", "message": "force needs the epoch of the lease to clear: GET /lease and send its epoch"}` (`"force": true` with no `epoch`, or `"epoch": null`) |

`{"force": true, "epoch": n}` (viewer optional) clears the human lease at epoch `n` whatever viewer
holds it: the pane's **Hand back (force)** after a reload, since the reloaded pane has a new viewer id and
its plain `release` would get `not_holder`. A lease that has since changed hands is left alone
(`stale_force`). `epoch` is **required** with force: there is no unconditional force, because a delayed
one could revoke a later take-over. Scripts read `GET /lease` first and send its `epoch`; an older pane
that sends force without one gets `force_needs_epoch` and must be updated.

### `GET /api/plugins/remote-cua/status[?fresh=1]`

A few short SSH sessions to the Mac (cached 20 s per profile; `fresh=1` skips the cache): driver
discovery, then a short-lived private daemon (the same managed lifecycle as the bot's: recorded before
launch, always stopped, swept later if the stop cannot be confirmed) that answers `check_permissions`
with `prompt: false` (never a dialog) and `list_windows`.

```json
200 {"ok": true, "configured": true, "supported": true,
     "machine": {"host": "100.64.0.10", "user": "you", "os": "macos", "driver": "", "vnc": ""},
     "reachable": true,
     "driver": {"found": true, "path": "/Users/you/.hermes/tools/cua-driver-0.21.0-darwin-arm64/cua-driver",
                "version": "0.21.0", "pin": "0.21.0", "ok": true, "problem": ""},
     "permissions": {"accessibility": true, "screen_recording": true, "ok": true},
     "screen_awake": true, "windows": 10, "logged_in": true,
     "error": "", "checked_at": 1763251200.1, "cached": false,
     "summary": ["Reachable over SSH", "Driver ready: cua-driver 0.21.0",
                 "Permissions OK (Accessibility and Screen Recording)", "Screen awake"]}
```

Always 200; `ok` says whether the machine is ready, and needs positive evidence: both permissions
granted **and** at least one visible window. A probe that could not tell (driver error, unreadable
answer) is `ok: false` with the driver's words in `error` and in `summary` (e.g. "Window check failed:
cannot enumerate screen"), never READY. `summary` is plain words for the pane, one line per
check. Failure shapes:

- unreachable: `"reachable": false, "error": "could not reach you@100.64.0.10 over SSH (Permission denied (publickey).)"`
- wrong driver: `"driver": {"ok": false, "problem": "cua-driver on 100.64.0.10 is 0.28.2, but this gateway's Hermes pins 0.21.0. …"}`
- permissions: `"permissions": {"accessibility": true, "screen_recording": false, "ok": false}`
- asleep/locked: `"screen_awake": false` ("Screen asleep or locked: no windows are visible")
- Windows: `"supported": false, "error": "Windows support coming: needs cua Session proxy. …"` (no SSH made)
- not configured: `"configured": false, "error": "remote_cua.host is not set"`

`null` in a field means "not checked" (an earlier step failed).

## Pane behaviour (Package V)

Copy Hermes's Bot Screen wording: chip **Bot is in control** / **You're in control**; **Take over**
(red border, input on), **Hand back**; closing the pane releases; a dropped connection keeps the
human lease until reconnect; after a reload, when `lease` says `human` with another viewer, show
**Hand back (force)** (`release` with `force: true`). While the bot holds control the pane is
view-only for that machine. The lease is a tool-level fence: the pane itself must drop input while
it does not hold control.
