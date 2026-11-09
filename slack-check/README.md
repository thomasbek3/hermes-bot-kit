# slack-check

A Hermes dashboard plugin with one backend route that really tests a bot's Slack connection:

```
GET /api/plugins/slack-check/test[?profile=<name>]
```

Hermes keeps Slack tokens away from desktop plugins, so the check has to run inside Hermes's
backend. The override's "Test connection" button calls this route and shows Slack's real answer,
for example "Works · @helper in Example Workspace" or the real error (`invalid_auth`,
`account_inactive`, a network error).

## What it does

For the profile the request is scoped to (`?profile=`, or the requesting profile's plugin host
under `plugins.isolation: host`):

1. Reads `SLACK_BOT_TOKEN` (the first entry if it is comma-separated) and `SLACK_APP_TOKEN`, through
   Hermes's own helpers: the profile's secret scope (`get_secret`, which also covers secret-manager
   sources), then its `.env` (`load_env` / `get_env_path`).
2. Calls Slack's `auth.test` with the bot token (stdlib `urllib`, POST, Bearer header, 8 s timeout).
3. If an app token exists, calls `apps.connections.open`. That call only mints a one-time Socket Mode
   URL. It does not open a socket, and the URL is thrown away.
4. Adds the newest `[Slack] Socket Mode connected | Authenticated as | unhealthy` line from the
   profile's `logs/gateway.log`. It reads at most the last 200 KB.

Response:

```json
{"ok": true, "configured": true, "bot": "@helper", "bot_id": "B0...", "team": "Example Workspace",
 "team_id": "T0...", "url": "https://....slack.com/", "app_token_ok": true,
 "last_log": {"ts": "2026-11-08 09:00:02,200", "text": "[Slack] Socket Mode connected (1 workspace(s))"}}
```

- No bot token: `{"ok": false, "configured": false}`, and Slack is not called.
- Slack refuses the token: `{"ok": false, "configured": true, "error": "invalid_auth"}`.
- The app token fails: `"app_token_ok": false, "app_token_error": "..."`.

## Safety

- Read-only. `auth.test` changes nothing. `apps.connections.open` returns a URL and does not connect.
- Tokens are never returned or logged. Tokens go only in the `Authorization` header, never in a URL.
  Anything token-shaped (`xox?-…`, `xapp-…`) is scrubbed from every error and log line.
- Same gates as any Hermes user plugin: the dashboard's auth, the profile's `plugins.enabled`
  allow-list, and the per-request profile scope.

## Install

Optional, and separate from the kit's root `install.sh`, which installs only the desktop plugins.
Install it on the machine that runs the Hermes backend (the gateway that serves the dashboard API),
which for a remote bot is the remote host, not your laptop. Without it the Grokbot Override's Slack
card still shows Hermes's own connection state; only **Test connection** needs this route.

```bash
bash slack-check/install.sh --dry-run     # show what would change
bash slack-check/install.sh               # copy + enable
bash slack-check/install.sh --profile helper   # also enable a profile whose token comes from a secret manager
```

The script copies the plugin to `$HERMES_HOME/plugins/slack-check/` (default `~/.hermes`). It then
adds `slack-check` to `plugins.enabled` for each profile whose `.env` has a `SLACK_BOT_TOKEN` (the
root home counts as `default`). Running it again changes nothing. A changed earlier copy is backed
up under `$HERMES_HOME/plugin-backups/`. It is kept out of `plugins/` so it is not found as a
second plugin.

`hermes plugins enable` cannot do the enable step. That command only knows agent plugins (ones with
`plugin.yaml`), and this is a dashboard-only plugin. So the script calls Hermes's own
`plugins.enabled` writer (`hermes_cli.plugins_cmd._set_plugin_enabled`), with Hermes's Python and
`HERMES_HOME` set to each profile. The writer is locked and admission-checked.

The script never restarts anything. The route is mounted by the launch profile's gateway, which
serves the dashboard API. To make it live, quit and reopen Hermes Desktop, or run
`hermes gateway restart`. Recent Hermes versions also hot-mount a newly enabled plugin's route on
its first request, so a restart is only needed if the check returns 404.

## Verify

```bash
# DASH = your dashboard base URL; TOKEN = the dashboard session token (the backend injects it into
# the dashboard page; header X-Hermes-Session-Token, or the legacy "Authorization: Bearer <token>").
curl -s -H "X-Hermes-Session-Token: $TOKEN" \
  "$DASH/api/plugins/slack-check/test?profile=helper" | python3 -m json.tool
```

Behind Caddy basic auth, add `-u user:pass`. The response must never contain `xoxb-`, `xapp-` or
`wss://`. If you get 404 `Plugin not found`, the profile has not enabled `slack-check`. If you get
a plain 404 after enabling it, restart the backend.

## Tests

```bash
~/.hermes/hermes-agent/venv/bin/python -m pytest -p no:cacheprovider slack-check/tests
```

The tests make no network calls. They cover profile env resolution (including a `?profile=` request
through Hermes's real `_config_profile_scope`), a missing token, `auth.test` success and error,
the app-token check, token scrubbing, the log tail, router mounting with FastAPI's `TestClient`, and
Hermes's own manifest discovery and enable gate.
