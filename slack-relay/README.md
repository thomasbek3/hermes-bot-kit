# Slack ingress relay

An aiohttp relay bound to loopback (default `127.0.0.1:8655`). It exposes
health, Slack events, and the OAuth callback. Both stripped and unstripped
`/slack` paths are accepted; all other paths return 404. Hermes's backend stays
private.

Its settings come from `$HERMES_HOME/slack-connect/config.json` (public URL,
gateway listener, bind address and port). Install, upgrade and remove it with
`slack-connect/install.sh`, which also runs it as a user service (launchd on
macOS, systemd on Linux). See `slack-connect/README.md`.
