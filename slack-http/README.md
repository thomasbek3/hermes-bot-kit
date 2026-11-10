# Slack HTTP transport

Install this plugin in the target profile's `plugins/platforms/slack` directory
and enable `platforms/slack` in that profile. This shadows the bundled Slack
manifest using Hermes' matching category and directory. It calls the bundled
registration unchanged except for wrapping its adapter and HTTP requirements.
Only `SLACK_CONNECTION_MODE=http` selects HTTP; Socket Mode delegates to the
bundled connect implementation. The private adapter contract is checked at
HTTP startup and fails closed if it changes. Restarting a gateway or forcing a
profile plugin reload may be needed after installing; installation never does so.

The HTTP listener binds `SLACK_HTTP_HOST` (default `127.0.0.1`, port
`SLACK_HTTP_PORT`, default 8656). A non-loopback host is refused with a clear
error unless `SLACK_HTTP_ALLOW_NONLOOPBACK=1` is set: the public ingress is the
relay, which forwards over loopback.
