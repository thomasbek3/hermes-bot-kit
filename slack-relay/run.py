"""Start the loopback relay without access logging request URLs."""
import logging
import os
import sys
from logging.handlers import RotatingFileHandler
from pathlib import Path

here = Path(__file__).resolve().parent
sys.path.insert(0, str(here))
if not (here / 'common').is_dir():
    # Running from a source checkout: shared code lives in slack-connect/common.
    sys.path.insert(0, str(here.parent / 'slack-connect'))
from aiohttp import web
from relay import Relay
from common.config import load_config


def log_file():
    if sys.platform == 'darwin':
        return Path.home() / 'Library' / 'Logs' / 'hermes-slack-ingress.log'
    state = Path(os.environ.get('XDG_STATE_HOME') or Path.home() / '.local' / 'state')
    return state / 'hermes-slack-ingress.log'


root = Path(os.environ.get('HERMES_HOME', str(Path.home() / '.hermes')))
log_path = log_file()
log_path.parent.mkdir(parents=True, exist_ok=True)
handler = RotatingFileHandler(log_path, maxBytes=5_000_000, backupCount=3)
handler.setFormatter(logging.Formatter('%(asctime)s %(levelname)s %(message)s'))
logging.getLogger('slack_relay').addHandler(handler)
logging.getLogger('slack_relay').setLevel(logging.INFO)
config = load_config(root)
relay = Relay(root, root / 'hermes-agent' / 'venv' / 'bin' / 'python', here / 'profile_helper.py',
              base_url=config['public_url'], upstream=config['gateway_url'])
web.run_app(relay.application(), host=config['relay_bind'], port=config['relay_port'], access_log=None, print=None)
