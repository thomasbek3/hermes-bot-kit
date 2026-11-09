import importlib.util
from pathlib import Path

import pytest

file = Path(__file__).resolve().parents[1] / 'dashboard' / 'platform_lifecycle.py'
spec = importlib.util.spec_from_file_location('test_lifecycle_module', file)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


def test_profile_shadow_lifecycle_and_reload_retry(tmp_path):
    source = tmp_path / 'source'
    source.mkdir()
    for name in module.FILES:
        (source / name).write_text(name)
    home = tmp_path / 'profile'
    home.mkdir()
    calls = []
    answer = {'reloaded': True, 'plugins': ['platforms/slack'],
              'activations': [{'key': 'platforms/slack', 'name': 'slack-platform'}]}
    def enable(value):
        calls.append(('enable', value))
    def reload():
        calls.append(('reload', (home / 'plugins/platforms/slack').exists()))
        return answer.copy()
    lifecycle = module.PlatformLifecycle(home, source, enable, reload)
    lifecycle.install()
    assert calls == [('enable', True), ('reload', True)]
    lifecycle.install()
    answer['reloaded'] = False
    with pytest.raises(module.GatewayReloadError):
        lifecycle.remove()
    assert not lifecycle.target.exists() and lifecycle.pending.exists()
    answer['reloaded'] = True
    lifecycle.remove()
    assert not lifecycle.pending.exists()
    previous = list(calls)
    lifecycle.remove()
    assert calls == previous


def test_existing_unowned_shadow_is_untouched(tmp_path):
    home, source = tmp_path / 'profile', tmp_path / 'source'
    source.mkdir()
    target = home / 'plugins/platforms/slack'
    target.mkdir(parents=True)
    (target / 'user-file').write_text('keep')
    lifecycle = module.PlatformLifecycle(home, source, lambda _: pytest.fail('must not enable'),
                                         lambda: pytest.fail('must not reload'))
    with pytest.raises(module.GatewayReloadError):
        lifecycle.install()
    with pytest.raises(module.GatewayReloadError):
        lifecycle.remove()
    assert (target / 'user-file').read_text() == 'keep'


def test_gateway_refusal_names_unserved_profile_without_echoing_arbitrary_error(tmp_path):
    source = tmp_path / 'source'
    source.mkdir()
    for name in module.FILES:
        (source / name).write_text(name)
    answer = {'reloaded': False, 'error': 'home is not served by this gateway'}
    lifecycle = module.PlatformLifecycle(tmp_path / 'profile', source, lambda _: None, lambda: answer)
    with pytest.raises(module.GatewayReloadError, match='home is not served by this gateway'):
        lifecycle.install()
    answer['error'] = 'unsafe arbitrary output'
    with pytest.raises(module.GatewayReloadError, match='refused or did not answer'):
        lifecycle.install()
