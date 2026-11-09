# Slack HTTP transport

Install this plugin in the target profile's `plugins/platforms/slack` directory
and enable `platforms/slack` in that profile. This shadows the bundled Slack
manifest using Hermes' matching category and directory. It calls the bundled
registration unchanged except for wrapping its adapter and HTTP requirements.
Only `SLACK_CONNECTION_MODE=http` selects HTTP; Socket Mode delegates to the
bundled connect implementation. The private adapter contract is checked at
HTTP startup and fails closed if it changes. Restarting a gateway or forcing a
profile plugin reload may be needed after installing; installation never does so.
