"""Write profile values from stdin; credentials never appear in arguments."""
import json
import os
import sys

sys.path.insert(0, os.environ.get('HERMES_AGENT_DIR', os.path.expanduser('~/.hermes/hermes-agent')))

if len(sys.argv) == 3 and sys.argv[1] == '--notify':
    from hermes_cli.gateway_multiplex_served import notify_multiplexer_profiles_changed
    notify_multiplexer_profiles_changed(sys.argv[2])
else:
    from hermes_cli.config import save_env_value
    values = json.load(sys.stdin)
    allowed = {'SLACK_BOT_TOKEN', 'SLACK_TEAM_ID', 'SLACK_TEAM_NAME', 'SLACK_ALLOWED_USERS'}
    if not isinstance(values, dict) or not set(values).issubset(allowed) or not all(isinstance(v, str) for v in values.values()):
        raise SystemExit(2)
    for key, value in values.items():
        save_env_value(key, value)
