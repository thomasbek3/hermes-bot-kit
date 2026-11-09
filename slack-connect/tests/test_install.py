"""Unit tests for install.py with a fake host: no launchd, systemd, Tailscale or Hermes is touched."""
import importlib.util
import json
import plistlib
import stat
import sys
from pathlib import Path

import pytest

HERE = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('slack_installer', HERE / 'install.py')
installer = importlib.util.module_from_spec(spec)
spec.loader.exec_module(installer)
DNS = 'node.example-tailnet.ts.net'


class FakeHost(installer.Host):
    def __init__(self, tmp_path, kind='darwin', *, enabled=False, public_ok=True, workspace=True, port_busy=False,
                 handlers=None, allow_funnel=True):
        home = tmp_path / 'home'
        root = home / '.hermes'
        python = root / 'hermes-agent/venv/bin/python'
        python.parent.mkdir(parents=True)
        python.write_text('')
        self.lines = []
        super().__init__(kind, home, root, python, out=self.lines.append)
        self.commands, self.loaded, self.enabled = [], set(), enabled
        self.public_ok, self.workspace, self.port_busy = public_ok, workspace, port_busy
        self.handlers = dict(handlers or {})
        self.allow_funnel = allow_funnel

    def label(self, argv):
        return argv[-1].split('/')[-1].removesuffix('.service')

    def run(self, argv, *, env=None, capture=False):
        argv = [str(a) for a in argv]
        self.commands.append(argv)
        if argv[0] == 'launchctl':
            if argv[1] == 'print':
                return (0 if self.label(argv) in self.loaded else 1), ''
            if argv[1] == 'bootstrap':
                self.loaded.add(plistlib.loads(Path(argv[3]).read_bytes())['Label'])
            if argv[1] == 'bootout':
                self.loaded.discard(self.label(argv))
            return 0, ''
        if argv[0] == 'systemctl':
            if argv[2] == 'is-active':
                return (0 if self.label(argv) in self.loaded else 3), ''
            if argv[2] == 'enable':
                self.loaded.add(self.label(argv))
            if argv[2] == 'disable':
                self.loaded.discard(self.label(argv))
            return 0, ''
        if argv[0].endswith('tailscale'):
            if argv[1:3] == ['status', '--json']:
                return 0, json.dumps({'Self': {'DNSName': DNS + '.'}})
            if argv[1:4] == ['serve', 'status', '--json']:
                web = {DNS + ':443': {'Handlers': {k: {'Proxy': v} for k, v in self.handlers.items()}}}
                return 0, json.dumps({'Web': web, 'AllowFunnel': {DNS + ':443': self.allow_funnel}})
            if argv[1] == 'funnel' and argv[-1] == 'off':
                self.handlers.pop('/slack')
                return 0, ''
            if argv[1] == 'funnel':
                self.handlers['/slack'] = argv[-1]
                return 0, ''
        if argv[0] == str(self.python) and '_set_plugin_enabled' in argv[2]:
            self.enabled = 'enable=True' in argv[2]
            return 0, ''
        raise AssertionError(f'unexpected command {argv}')

    def hermes_python(self, code):
        if 'listen_address' in code:
            return 0, 'http://127.0.0.1:8642\n'
        if 'read_home_selection' in code:
            return 0, '1\n' if self.enabled else '0\n'
        raise AssertionError(code)

    def http_get(self, url, headers=None, timeout=3):
        if url == 'http://127.0.0.1:8655/healthz' or url == 'http://127.0.0.1:9000/healthz':
            if installer.LABEL in self.loaded:
                return 200, b'ok'
            raise OSError('refused')
        if url.startswith('https://'):
            if self.public_ok and installer.LABEL in self.loaded:
                return 200, b'ok'
            raise OSError('unreachable')
        if url == 'http://127.0.0.1:9119/':
            return 200, b'<script>window.__HERMES_SESSION_TOKEN__="fake-session";</script>'
        if url.endswith('/api/plugins/slack-connect/status'):
            assert headers == {'X-Hermes-Session-Token': 'fake-session'}
            return 200, json.dumps({'mode': 'bootstrap', 'readiness': {'workspace_ready': self.workspace}}).encode()
        raise AssertionError(url)

    def port_in_use(self, port):
        return self.port_busy

    def sleep(self, seconds):
        pass

    def tailscale(self):
        return '/usr/bin/tailscale'


@pytest.fixture(autouse=True)
def no_xdg(monkeypatch):
    monkeypatch.delenv('XDG_CONFIG_HOME', raising=False)


def run(host, *argv):
    return installer.main(list(argv), host=host, platform='linux' if host.kind == 'linux' else 'darwin')


def mutating(host):
    return [c for c in host.commands if c[0] in ('launchctl', 'systemctl') and not {'print', 'is-active'} & set(c)
            or c[0].endswith('tailscale') and c[1] == 'funnel' or '_set_plugin_enabled' in ' '.join(c)]


def manifest(host):
    return json.loads((host.root / 'slack-connect' / installer.MANIFEST).read_text())


@pytest.mark.parametrize('kind', ['darwin', 'linux'])
def test_dry_run_changes_nothing(tmp_path, kind):
    host = FakeHost(tmp_path, kind)
    assert run(host, '--dry-run', '--public-url', 'https://your-host.example.test') == 0
    assert not (host.root / 'plugins').exists() and not (host.root / 'slack-connect').exists()
    assert not (host.home / 'Library').exists() and not (host.home / '.config').exists()
    assert mutating(host) == []
    text = '\n'.join(host.lines)
    assert 'public_url=https://your-host.example.test/slack' in text
    assert installer.LABEL in text and 'Dry run: nothing was changed' in text
    assert "Would enable slack-connect in the default profile" in text


def test_macos_install_is_complete_and_idempotent(tmp_path):
    host = FakeHost(tmp_path, workspace=True)
    assert run(host, '--public-url', 'https://your-host.example.test/slack') == 0
    root = host.root
    for rel in ('plugins/slack-connect/dashboard/plugin_api.py', 'plugins/slack-connect/common/config.py',
                'plugins/slack-connect/platform/http_adapter.py', 'slack-relay/run.py', 'slack-relay/common/config.py'):
        assert (root / rel).is_file(), rel
    plist = plistlib.loads((host.home / 'Library/LaunchAgents' / (installer.LABEL + '.plist')).read_bytes())
    assert plist['Label'] == 'ai.hermes.slack-ingress'
    assert plist['ProgramArguments'] == [str(host.python), '-I', str(root / 'slack-relay/run.py')]
    assert plist['EnvironmentVariables'] == {'HERMES_HOME': str(root)}
    config = root / 'slack-connect/config.json'
    assert stat.S_IMODE(config.stat().st_mode) == 0o600
    assert stat.S_IMODE(config.parent.stat().st_mode) == 0o700
    assert json.loads(config.read_text())['gateway_url'] == 'http://127.0.0.1:8642'
    assert stat.S_IMODE((root / 'slack-connect/state.key').stat().st_mode) == 0o600
    assert host.enabled and manifest(host)['default_enabled'] is True
    assert host.lines[-1] == 'Ready'
    assert any(c[:2] == ['launchctl', 'bootstrap'] for c in host.commands)

    host.commands.clear(); host.lines.clear()
    key = (root / 'slack-connect/state.key').read_bytes()
    assert run(host) == 0
    assert mutating(host) == []
    assert 'Already installed and up to date; nothing to change.' in host.lines
    assert (root / 'slack-connect/state.key').read_bytes() == key
    assert json.loads(config.read_text())['public_url'] == 'https://your-host.example.test/slack'


def test_linux_install_writes_systemd_user_unit(tmp_path):
    host = FakeHost(tmp_path, 'linux')
    assert run(host, '--public-url', 'https://your-host.example.test') == 0
    unit = (host.home / '.config/systemd/user' / (installer.LABEL + '.service')).read_text()
    assert f'ExecStart="{host.python}" "-I" "{host.root}/slack-relay/run.py"' in unit
    assert f'Environment="HERMES_HOME={host.root}"' in unit and 'WantedBy=default.target' in unit
    assert ['systemctl', '--user', 'enable', '--now', installer.LABEL + '.service'] in host.commands


def test_existing_token_store_and_bots_are_kept(tmp_path):
    host = FakeHost(tmp_path)
    data = host.root / 'slack-connect'
    data.mkdir(parents=True, mode=0o700)
    (data / 'config-tokens.json').write_text('{"T1": {}}')
    (data / 'state.key').write_bytes(b'k' * 32)
    assert run(host) == 0
    assert (data / 'config-tokens.json').read_text() == '{"T1": {}}'
    assert (data / 'state.key').read_bytes() == b'k' * 32
    assert 'Not ready yet. Missing: a public HTTPS address' in host.lines[-1]


def test_upgrade_replaces_owned_files_and_restarts_only_the_relay(tmp_path):
    host = FakeHost(tmp_path)
    run(host, '--public-url', 'https://your-host.example.test')
    target = host.root / 'slack-relay/relay.py'
    target.write_text('# older release\n')
    record = manifest(host)
    record['files'][str(target)] = installer.digest(b'# older release\n')
    (host.root / 'slack-connect' / installer.MANIFEST).write_text(json.dumps(record))
    host.commands.clear()
    assert run(host) == 0
    assert target.read_bytes() == (installer.REPO / 'slack-relay/relay.py').read_bytes()
    assert [c[:3] for c in mutating(host)] == [['launchctl', 'kickstart', '-k']]


def test_edited_or_foreign_files_are_refused_then_adopted_with_backup(tmp_path):
    host = FakeHost(tmp_path)
    foreign = host.root / 'plugins/slack-connect/dashboard/service.py'
    foreign.parent.mkdir(parents=True)
    foreign.write_text('# earlier manual install\n')
    with pytest.raises(installer.InstallError, match='not installed by this installer'):
        run(host)
    assert foreign.read_text() == '# earlier manual install\n' and mutating(host) == []
    assert run(host, '--adopt') == 0
    backups = list((host.root / 'slack-connect/backups').rglob('service.py'))
    assert len(backups) == 1 and backups[0].read_text() == '# earlier manual install\n'
    assert stat.S_IMODE((host.root / 'slack-connect/backups').stat().st_mode) == 0o700
    assert foreign.read_bytes() == (installer.SOURCE / 'dashboard/service.py').read_bytes()
    foreign.write_text('# edited after install\n')
    with pytest.raises(installer.InstallError, match='edited since'):
        run(host)


def test_port_in_use_is_refused(tmp_path):
    host = FakeHost(tmp_path, port_busy=True)
    with pytest.raises(installer.InstallError, match='already in use'):
        run(host)
    assert not (host.root / 'plugins').exists()


def test_replace_service_moves_earlier_relay_service(tmp_path):
    host = FakeHost(tmp_path, port_busy=True)
    old = host.home / 'Library/LaunchAgents/org.example.old-slack-relay.plist'
    old.parent.mkdir(parents=True)
    old.write_bytes(plistlib.dumps({'Label': 'org.example.old-slack-relay',
                                    'ProgramArguments': ['python', '-I', str(host.root / 'slack-relay/run.py')]}))
    host.loaded.add('org.example.old-slack-relay')
    host.port_busy = False
    assert run(host, '--replace-service', 'org.example.old-slack-relay', '--dry-run') == 0
    assert old.exists() and mutating(host) == []
    assert run(host, '--replace-service', 'org.example.old-slack-relay') == 0
    assert not old.exists() and 'org.example.old-slack-relay' not in host.loaded
    assert installer.LABEL in host.loaded
    assert list((host.root / 'slack-connect/backups').rglob('org.example.old-slack-relay.plist'))


def test_replace_service_refuses_unrelated_service(tmp_path):
    host = FakeHost(tmp_path)
    other = host.home / 'Library/LaunchAgents/org.example.other.plist'
    other.parent.mkdir(parents=True)
    other.write_bytes(plistlib.dumps({'Label': 'org.example.other', 'ProgramArguments': ['/usr/bin/true']}))
    with pytest.raises(installer.InstallError, match='refusing to touch it'):
        run(host, '--replace-service', 'org.example.other')
    assert other.exists()


def test_tailscale_funnel_adds_only_slack_path_after_local_health(tmp_path):
    host = FakeHost(tmp_path, handlers={'/other': 'http://127.0.0.1:3000'})
    assert run(host, '--tailscale-funnel', '--dry-run') == 0
    assert any('Would run: /usr/bin/tailscale funnel --bg --set-path=/slack http://127.0.0.1:8655' == l for l in host.lines)
    assert '/slack' not in host.handlers
    assert run(host, '--tailscale-funnel') == 0
    assert host.handlers == {'/other': 'http://127.0.0.1:3000', '/slack': 'http://127.0.0.1:8655'}
    funnel = [c for c in host.commands if c[0].endswith('tailscale') and c[1] == 'funnel']
    assert funnel == [['/usr/bin/tailscale', 'funnel', '--bg', '--set-path=/slack', 'http://127.0.0.1:8655']]
    assert json.loads((host.root / 'slack-connect/config.json').read_text())['public_url'] == f'https://{DNS}/slack'
    assert manifest(host)['funnel']['dns'] == DNS


def test_tailscale_funnel_refuses_foreign_slack_path_and_private_neighbours(tmp_path):
    host = FakeHost(tmp_path, handlers={'/slack': 'http://127.0.0.1:9999'})
    with pytest.raises(installer.InstallError, match='refusing to change it'):
        run(host, '--tailscale-funnel')
    host = FakeHost(tmp_path / 'b', handlers={'/private': 'http://127.0.0.1:3000'}, allow_funnel=False)
    with pytest.raises(installer.InstallError, match='make those public'):
        run(host, '--tailscale-funnel')
    assert host.handlers == {'/private': 'http://127.0.0.1:3000'}


@pytest.mark.parametrize('kind', ['darwin', 'linux'])
def test_uninstall_removes_exactly_what_was_installed(tmp_path, kind):
    host = FakeHost(tmp_path, kind, handlers={'/other': 'http://127.0.0.1:3000'})
    data = host.root / 'slack-connect'
    data.mkdir(parents=True, mode=0o700)
    (data / 'config-tokens.json').write_text('{}')
    (data / 'apps.json').write_text('{"0123": {"profile": "bot"}}')
    neighbour = host.root / 'plugins/other-plugin/plugin.yaml'
    neighbour.parent.mkdir(parents=True)
    neighbour.write_text('name: other\n')
    assert run(host, '--tailscale-funnel') == 0
    (host.root / 'slack-relay/__pycache__').mkdir()
    (host.root / 'slack-relay/__pycache__/relay.cpython-312.pyc').write_bytes(b'')
    unit = Path(manifest(host)['service_file'])
    assert unit.exists()
    host.commands.clear(); host.lines.clear()
    assert run(host, '--uninstall', '--dry-run') == 0
    assert mutating(host) == [] and unit.exists()
    assert run(host, '--uninstall') == 0
    assert not unit.exists() and installer.LABEL not in host.loaded
    assert not (host.root / 'plugins/slack-connect').exists() and not (host.root / 'slack-relay').exists()
    assert not (data / 'config.json').exists() and not (data / installer.MANIFEST).exists()
    assert (data / 'config-tokens.json').exists() and (data / 'state.key').exists() and (data / 'apps.json').exists()
    assert neighbour.exists() and host.handlers == {'/other': 'http://127.0.0.1:3000'}
    assert host.enabled is False
    assert any('Their Slack apps are left alone' in l for l in host.lines)


def test_uninstall_keeps_funnel_and_selection_it_did_not_create(tmp_path):
    host = FakeHost(tmp_path, enabled=True, handlers={'/slack': 'http://127.0.0.1:8655'})
    assert run(host, '--tailscale-funnel') == 0
    record = manifest(host)
    assert record['default_enabled'] is False and 'funnel' not in record
    assert run(host, '--uninstall') == 0
    assert host.handlers == {'/slack': 'http://127.0.0.1:8655'} and host.enabled is True


def test_windows_exits_cleanly(capsys):
    assert installer.main([], platform='win32') == 0
    assert 'paste-tokens dialog' in capsys.readouterr().out


def test_profile_home_is_refused(tmp_path, monkeypatch):
    monkeypatch.setenv('HERMES_HOME', str(tmp_path / 'profiles' / 'bot'))
    with pytest.raises(installer.InstallError, match='profile'):
        installer.main(['--dry-run'], platform='darwin')


def test_missing_gateway_listener_is_reported_and_stops_a_real_install(tmp_path):
    host = FakeHost(tmp_path)
    host.hermes_python = lambda code: (3, '') if 'listen_address' in code else (0, '0\n')
    assert run(host, '--dry-run') == 0
    assert any("gateway_url=(not found" in line for line in host.lines)
    with pytest.raises(installer.InstallError, match='--gateway-url'):
        run(host)
    assert not (host.root / 'plugins').exists()
    assert run(host, '--gateway-url', 'http://127.0.0.1:8642', '--public-url', 'https://your-host.example.test') == 0
    assert json.loads((host.root / 'slack-connect/config.json').read_text())['gateway_url'] == 'http://127.0.0.1:8642'
