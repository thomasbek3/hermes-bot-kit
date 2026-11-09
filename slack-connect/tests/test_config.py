import json
from pathlib import Path
import sys

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from common.config import load_config


def config(tmp_path, **changes):
    path = tmp_path / 'slack-connect' / 'config.json'
    path.parent.mkdir(exist_ok=True)
    data = {'public_url': 'https://your-host.example.test/slack', 'gateway_url': 'http://127.0.0.1:8642',
            'relay_bind': '127.0.0.1', 'relay_port': 8655}
    data.update(changes)
    path.write_text(json.dumps(data))
    path.chmod(0o600)
    return path


def test_load_config_and_missing_public_url(tmp_path):
    config(tmp_path)
    assert load_config(tmp_path)['gateway_url'] == 'http://127.0.0.1:8642'
    config(tmp_path, public_url='')
    assert load_config(tmp_path)['public_url'] == ''


@pytest.mark.parametrize('change', [
    {'public_url': 'http://example.test/slack'}, {'public_url': 'https://example.test/other'},
    {'gateway_url': 'http://user:pass@example.test:12'}, {'gateway_url': 'http://example.test'},
    {'relay_bind': '0.0.0.0'}, {'relay_port': 65536}, {'relay_port': True},
])
def test_invalid_config_is_rejected(tmp_path, change):
    config(tmp_path, **change)
    with pytest.raises(ValueError):
        load_config(tmp_path)


def test_config_permissions_are_checked(tmp_path):
    path = config(tmp_path)
    path.chmod(0o644)
    with pytest.raises(ValueError):
        load_config(tmp_path)
