"""Publish one plugin selection only if Hermes can avoid a dependency rebuild."""
import os
import sys
from pathlib import Path

sys.path.insert(0, sys.argv[1])
from hermes_constants import get_hermes_home
from pm.client import sync_venv
from pm.plugin_inputs import Selection
from pm.plugins_state import read_home_selection

home = Path(get_hermes_home())
config = read_home_selection(home) or {}
plugins = config.get('plugins') or {}
enabled, disabled = set(plugins.get('enabled') or ()), set(plugins.get('disabled') or ())
key = 'platforms/slack'
if sys.argv[2] == 'enable':
    if {key, 'slack', 'slack-platform'} & disabled:
        raise RuntimeError('Slack platform is explicitly disabled')
    enabled.add(key)
elif sys.argv[2] == 'disable':
    enabled.discard(key)
else:
    raise ValueError('invalid operation')
os.environ['HERMES_DISABLE_LAZY_INSTALLS'] = '1'
sync_venv(explicit=False, plugins=Selection({'home':str(home.resolve()), 'enabled':sorted(enabled),
                                            'disabled':sorted(disabled), 'settled':[key]}))
