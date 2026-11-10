"""Read or set only platforms.slack.enabled in one profile's Hermes config.

Runs in the profile's Hermes interpreter with HERMES_HOME set. Never prints the
config: `get` answers with its exit code only (0 = absent or on, 3 = explicitly
off); `set` writes through Hermes's own set_config_value.
"""
import sys
from pathlib import Path

sys.path.insert(0, sys.argv[1])
KEY = 'platforms.slack.enabled'
OFF = 3


def explicitly_off(value):
    if value is False or (isinstance(value, int) and not isinstance(value, bool) and value == 0):
        return True
    return isinstance(value, str) and value.strip().lower() in ('false', 'no', 'off', '0')


if sys.argv[2] == 'get':
    import yaml
    from hermes_constants import get_hermes_home
    path = Path(get_hermes_home()) / 'config.yaml'
    config = yaml.safe_load(path.read_text()) if path.is_file() else None
    platforms = config.get('platforms') if isinstance(config, dict) else None
    slack = platforms.get('slack') if isinstance(platforms, dict) else None
    if isinstance(slack, dict) and 'enabled' in slack and explicitly_off(slack['enabled']):
        sys.exit(OFF)
    sys.exit(0)
elif sys.argv[2] == 'set' and sys.argv[3] in ('true', 'false'):
    from hermes_cli.config import set_config_value
    set_config_value(KEY, sys.argv[3])
else:
    raise ValueError('invalid operation')
