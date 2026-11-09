#!/usr/bin/env python3
"""Install, upgrade or remove the Slack one-click connect add-on on a Hermes host.

Never restarts Hermes. Only the add-on's own relay service is started or
restarted. Every file it writes is recorded in an install manifest so that a
re-run is a no-op, an upgrade replaces only files it owns, and --uninstall
removes exactly what it installed.
"""
import argparse
import hashlib
import json
import os
import plistlib
import re
import shutil
import socket
import subprocess
import sys
import time
from pathlib import Path
from urllib.request import Request, urlopen

SOURCE = Path(__file__).resolve().parent
REPO = SOURCE.parent
sys.path.insert(0, str(SOURCE))
from common.config import DEFAULT_PORT, config_path, load_config, normalize_public_url, validate, write_config  # noqa: E402

LABEL = 'ai.hermes.slack-ingress'
MANIFEST = 'install-manifest.json'
PLUGIN = 'slack-connect'
PLUGIN_FILES = ('common/__init__.py', 'common/core.py', 'common/token_store.py', 'common/config.py',
                'dashboard/manifest.json', 'dashboard/plugin_api.py', 'dashboard/service.py',
                'dashboard/slack_api.py', 'dashboard/platform_lifecycle.py', 'dashboard/platform_selection.py',
                'dashboard/dist/index.js')
PLATFORM_FILES = ('plugin.yaml', '__init__.py', 'http_adapter.py')
RELAY_FILES = ('relay.py', 'run.py', 'profile_helper.py')
COMMON_FILES = ('__init__.py', 'core.py', 'token_store.py', 'config.py')
TAILSCALE_APP = '/Applications/Tailscale.app/Contents/MacOS/Tailscale'
HEALTH_WAIT = 15


class InstallError(Exception):
    pass


def digest(data):
    return hashlib.sha256(data).hexdigest()


def file_digest(path):
    try:
        return digest(Path(path).read_bytes())
    except OSError:
        return None


class Host:
    """Everything that touches the machine outside plain file writes; replaced in tests."""

    def __init__(self, kind, home, root, python, out=print):
        self.kind, self.home, self.root, self.python, self.out = kind, Path(home), Path(root), Path(python), out

    def run(self, argv, *, env=None, capture=False):
        result = subprocess.run([str(a) for a in argv], env=env, check=False, text=True,
                                stdout=subprocess.PIPE if capture else subprocess.DEVNULL,
                                stderr=subprocess.DEVNULL)
        return result.returncode, (result.stdout or '') if capture else ''

    def hermes_env(self, home=None):
        return dict(os.environ, HERMES_HOME=str(home or self.root), PYTHONPATH=str(self.root / 'hermes-agent'),
                    HERMES_DISABLE_LAZY_INSTALLS='1', PYTHONDONTWRITEBYTECODE='1')

    def hermes_python(self, code):
        return self.run([self.python, '-c', code], env=self.hermes_env(), capture=True)

    def http_get(self, url, headers=None, timeout=3):
        with urlopen(Request(url, headers=headers or {}), timeout=timeout) as response:
            return response.status, response.read(1 << 20)

    def port_in_use(self, port):
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
            sock.settimeout(0.5)
            return sock.connect_ex(('127.0.0.1', port)) == 0

    def sleep(self, seconds):
        time.sleep(seconds)

    def tailscale(self):
        found = shutil.which('tailscale')
        if found:
            return found
        return TAILSCALE_APP if Path(TAILSCALE_APP).exists() else None


# ---------------------------------------------------------------- service units

def service_path(host, label=LABEL):
    if host.kind == 'darwin':
        return host.home / 'Library/LaunchAgents' / (label + '.plist')
    config = Path(os.environ.get('XDG_CONFIG_HOME') or host.home / '.config')
    return config / 'systemd/user' / (label + '.service')


def service_content(host):
    script = host.root / 'slack-relay/run.py'
    if host.kind == 'darwin':
        return plistlib.dumps({'Label': LABEL, 'ProgramArguments': [str(host.python), '-I', str(script)],
                               'EnvironmentVariables': {'HERMES_HOME': str(host.root)}, 'RunAtLoad': True,
                               'KeepAlive': True, 'ThrottleInterval': 10})

    def quote(value):  # systemd quoting, not shell quoting
        return '"' + str(value).replace('\\', '\\\\').replace('"', '\\"').replace('%', '%%') + '"'
    return ('[Unit]\nDescription=Hermes Slack ingress relay\nAfter=network-online.target\n\n'
            '[Service]\nEnvironment=' + quote('HERMES_HOME=' + str(host.root)) + '\n'
            'ExecStart=' + ' '.join(map(quote, (host.python, '-I', script))) + '\n'
            'Restart=always\nRestartSec=10\n\n[Install]\nWantedBy=default.target\n').encode()


def service_loaded(host, label=LABEL):
    if host.kind == 'darwin':
        return host.run(['launchctl', 'print', f'gui/{os.getuid()}/{label}'])[0] == 0
    return host.run(['systemctl', '--user', 'is-active', '--quiet', label + '.service'])[0] == 0


def service_start(host):
    if host.kind == 'darwin':
        cmd = ['launchctl', 'bootstrap', f'gui/{os.getuid()}', str(service_path(host))]
        if host.run(cmd)[0]:
            # launchd sometimes reports a transient I/O error right after a bootout.
            host.sleep(2)
            if host.run(cmd)[0] and not service_loaded(host):
                raise InstallError('launchctl bootstrap failed for ' + LABEL)
        return
    for cmd in (['systemctl', '--user', 'daemon-reload'], ['systemctl', '--user', 'enable', '--now', LABEL + '.service']):
        if host.run(cmd)[0]:
            raise InstallError('failed: ' + ' '.join(cmd))


def service_restart(host):
    cmd = (['launchctl', 'kickstart', '-k', f'gui/{os.getuid()}/{LABEL}'] if host.kind == 'darwin'
           else ['systemctl', '--user', 'restart', LABEL + '.service'])
    if host.run(cmd)[0]:
        raise InstallError('failed: ' + ' '.join(cmd))


def service_stop(host, label=LABEL):
    if not service_loaded(host, label):
        return
    if host.kind == 'darwin':
        cmd = ['launchctl', 'bootout', f'gui/{os.getuid()}/{label}']
    else:
        cmd = ['systemctl', '--user', 'disable', '--now', label + '.service']
    if host.run(cmd)[0] and service_loaded(host, label):
        raise InstallError('could not stop service ' + label)
    for _ in range(20):
        if not service_loaded(host, label):
            return
        host.sleep(0.5)


def foreign_service_runs_relay(host, label):
    """An earlier service for this relay (another label) that --replace-service may remove."""
    path = service_path(host, label)
    if not path.is_file():
        raise InstallError(f'--replace-service: no service file at {path}')
    script = str(host.root / 'slack-relay/run.py')
    if host.kind == 'darwin':
        try:
            args = plistlib.loads(path.read_bytes()).get('ProgramArguments') or []
        except Exception:
            raise InstallError(f'--replace-service: {path} is not a readable launchd plist') from None
        ok = any(str(Path(a).expanduser()) == script for a in args)
    else:
        ok = script in path.read_text(errors='replace')
    if not ok:
        raise InstallError(f'--replace-service: {path} does not run {script}; refusing to touch it')
    return path


# ---------------------------------------------------------------- Hermes helpers

def discover_gateway(host):
    code = '''from gateway.config import load_gateway_config, Platform
from gateway.platforms.api_server import listen_address
c = load_gateway_config().platforms.get(Platform.API_SERVER)
if not c or not c.enabled: raise SystemExit(3)
h, p = listen_address(c.extra)
if h in ("0.0.0.0", "::", ""): h = "127.0.0.1"
if ":" in h: h = "[" + h + "]"
print("http://%s:%d" % (h, p))'''
    code_rc, out = host.hermes_python(code)
    url = out.strip().splitlines()[-1] if code_rc == 0 and out.strip() else ''
    return url


def default_selected(host):
    code = ('from pm.plugins_state import read_home_selection; from hermes_constants import get_hermes_home; '
            's = read_home_selection(get_hermes_home()) or {}; '
            'print(int("slack-connect" in (s.get("plugins") or {}).get("enabled", [])))')
    rc, out = host.hermes_python(code)
    if rc:
        raise InstallError("could not read the default profile's plugin selection")
    return out.strip() == '1'


def set_default_enabled(host, enable):
    # Hermes's own selection writer; never `hermes plugins enable` (it may resync shared dependencies).
    code = ('from hermes_cli.plugins_cmd import _set_plugin_enabled; '
            f'_set_plugin_enabled("slack-connect", enable={bool(enable)})')
    if host.run([host.python, '-c', code], env=host.hermes_env())[0]:
        raise InstallError('could not ' + ('enable' if enable else 'disable') + ' slack-connect in the default profile')


# ---------------------------------------------------------------- Tailscale Funnel

def funnel_state(host, port):
    """(dns_name, current /slack proxy on dns:443 or None, other 443 paths, funnel_allowed)."""
    ts = host.tailscale()
    if not ts:
        raise InstallError('--tailscale-funnel: the tailscale CLI was not found')
    rc, out = host.run([ts, 'status', '--json'], capture=True)
    if rc:
        raise InstallError('--tailscale-funnel: `tailscale status` failed; is Tailscale running and logged in?')
    dns = (json.loads(out).get('Self') or {}).get('DNSName', '').rstrip('.')
    if not dns:
        raise InstallError('--tailscale-funnel: this machine has no Tailscale DNS name (enable MagicDNS and HTTPS)')
    rc, out = host.run([ts, 'serve', 'status', '--json'], capture=True)
    serve = json.loads(out or '{}') if rc == 0 else {}
    handlers = ((serve.get('Web') or {}).get(dns + ':443') or {}).get('Handlers') or {}
    current = (handlers.get('/slack') or {}).get('Proxy')
    others = sorted(p for p in handlers if p != '/slack')
    allowed = bool((serve.get('AllowFunnel') or {}).get(dns + ':443'))
    return ts, dns, current, others, allowed


def funnel_target(port):
    return f'http://127.0.0.1:{port}'


# ---------------------------------------------------------------- plan

def payload(root):
    files = {root / 'plugins' / PLUGIN / f: (SOURCE / f).read_bytes() for f in PLUGIN_FILES}
    files.update({root / 'plugins' / PLUGIN / 'platform' / f: (REPO / 'slack-http' / f).read_bytes() for f in PLATFORM_FILES})
    files.update({root / 'slack-relay' / f: (REPO / 'slack-relay' / f).read_bytes() for f in RELAY_FILES})
    files.update({root / 'slack-relay/common' / f: (SOURCE / 'common' / f).read_bytes() for f in COMMON_FILES})
    return files


def read_manifest(root):
    path = root / 'slack-connect' / MANIFEST
    if not path.exists():
        return None
    try:
        data = json.loads(path.read_text())
        assert isinstance(data, dict) and isinstance(data.get('files'), dict)
        return data
    except Exception:
        raise InstallError(f'{path} is unreadable; inspect it before re-running') from None


def write_private(path, data):
    path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    tmp = path.with_name('.' + path.name + '.tmp')
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, 'wb') as out:
        out.write(data)
        out.flush()
        os.fsync(out.fileno())
    os.replace(tmp, path)


def write_file(path, data, mode=0o644):
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name('.' + path.name + '.slack-install.tmp')
    with open(tmp, 'wb') as out:
        out.write(data)
        out.flush()
        os.fsync(out.fileno())
    os.chmod(tmp, mode)
    os.replace(tmp, path)


def classify(files, owned):
    """Split targets into new, unchanged, update (owned, untouched since install) and conflict."""
    plan = {'new': [], 'same': [], 'update': [], 'conflict': []}
    for path, data in files.items():
        current = file_digest(path)
        if current is None and not path.exists():
            plan['new'].append(path)
        elif current == digest(data):
            plan['same'].append(path)
        elif str(path) in owned and owned[str(path)] == current:
            plan['update'].append(path)
        else:
            plan['conflict'].append(path)
    return plan


def gather(args, host):
    root = host.root
    manifest = read_manifest(root) or {}
    owned = dict(manifest.get('files') or {})
    existing = None
    if config_path(root).exists():
        try:
            existing = load_config(root)
        except (OSError, ValueError, UnicodeDecodeError, json.JSONDecodeError) as exc:
            raise InstallError(f'{config_path(root)} is invalid ({exc}); fix or remove it first') from None
    port = args.relay_port or (existing or {}).get('relay_port') or DEFAULT_PORT
    gateway = args.gateway_url or (existing or {}).get('gateway_url') or discover_gateway(host)
    gateway_missing = not gateway
    if gateway_missing:
        if not args.dry_run:
            raise InstallError("could not find Hermes's API server listener; enable Hermes's API server "
                               "or pass --gateway-url http://HOST:PORT")
        gateway = 'http://127.0.0.1:8642'  # placeholder so the rest of the plan can be shown
    funnel = None
    if args.tailscale_funnel:
        ts, dns, current, others, allowed = funnel_state(host, port)
        if current and current.rstrip('/') != funnel_target(port):
            raise InstallError(f'Funnel path /slack on {dns} already points at {current}; refusing to change it')
        if not current and others and not allowed:
            raise InstallError(f'{dns}:443 already serves {", ".join(others)} to your tailnet only; turning on Funnel '
                               'for /slack would make those public too. Use --public-url with another address instead.')
        funnel = {'tailscale': ts, 'dns': dns, 'exists': bool(current),
                  'command': [ts, 'funnel', '--bg', '--set-path=/slack', funnel_target(port)]}
        public = 'https://' + dns + '/slack'
    elif args.public_url:
        public = normalize_public_url(args.public_url)
    else:
        public = (existing or {}).get('public_url', '')
    config = validate({'public_url': public, 'gateway_url': gateway, 'relay_bind': '127.0.0.1', 'relay_port': port})
    files = payload(root)
    unit_path, unit = service_path(host), service_content(host)
    files_plan = classify({**files, unit_path: unit}, owned)
    replace = foreign_service_runs_relay(host, args.replace_service) if args.replace_service else None
    if replace and replace == unit_path:
        raise InstallError('--replace-service names this installer\'s own service')
    return {'manifest': manifest, 'owned': owned, 'existing': existing, 'config': config, 'files': files,
            'gateway_missing': gateway_missing,
            'unit_path': unit_path, 'unit': unit, 'plan': files_plan, 'funnel': funnel, 'replace': replace}


# ---------------------------------------------------------------- install

def install(args, host):
    out = host.out
    root = host.root
    if not host.python.exists():
        raise InstallError(f'Hermes Python not found at {host.python}; install Hermes first or pass --hermes-python')
    g = gather(args, host)
    plan, config = g['plan'], g['config']
    if plan['conflict'] and not args.adopt:
        listing = '\n  '.join(map(str, plan['conflict']))
        raise InstallError('these files exist but were not installed by this installer (or were edited since):\n  '
                           + listing + '\nInspect them; re-run with --adopt to back them up and replace them.')
    enabled = default_selected(host)
    loaded = service_loaded(host)
    port_busy = not loaded and host.port_in_use(config['relay_port'])
    if port_busy and not g['replace']:
        raise InstallError(f"port {config['relay_port']} is already in use; pass --relay-port or --replace-service")
    changed = plan['new'] + plan['update'] + plan['conflict']
    unit_changed = g['unit_path'] in changed
    code_changed = any(p != g['unit_path'] for p in changed)
    config_changed = g['existing'] != config
    state_key = root / 'slack-connect' / 'state.key'

    verb = 'Would' if args.dry_run else 'Will'
    out(f'Hermes home: {root}')
    out(f'Relay service: {g["unit_path"]} ({host.kind}, label {LABEL})')
    gateway_text = ("(not found: enable Hermes's API server or pass --gateway-url; a real install stops here)"
                    if g['gateway_missing'] else config['gateway_url'])
    out(f'Config: public_url={config["public_url"] or "(none)"} gateway_url={gateway_text} '
        f'relay=127.0.0.1:{config["relay_port"]}')
    out(f'Files: {len(plan["new"])} new, {len(plan["update"])} upgraded, {len(plan["same"])} unchanged'
        + (f', {len(plan["conflict"])} adopted (backed up first)' if plan['conflict'] else ''))
    actions = []
    if config_changed:
        actions.append(f'write {config_path(root)} (mode 600)')
    if not state_key.exists():
        actions.append(f'create {state_key} (mode 600)')
    if not enabled:
        actions.append("enable slack-connect in the default profile (Hermes's _set_plugin_enabled)")
    if g['replace']:
        actions.append(f'stop service {args.replace_service} and move {g["replace"]} into the backup')
    if not loaded or g['replace']:
        actions.append('start the relay service')
    elif unit_changed or code_changed or config_changed:
        actions.append('restart the relay service (Hermes itself is not restarted)')
    if g['funnel'] and not g['funnel']['exists']:
        actions.append('run: ' + ' '.join(map(str, g['funnel']['command'])))
    elif g['funnel']:
        actions.append(f'keep the existing Funnel path /slack on {g["funnel"]["dns"]}')
    for action in actions:
        out(f'{verb} {action}')
    if not actions and not changed:
        out('Already installed and up to date; nothing to change.')
    if args.dry_run:
        out('Dry run: nothing was changed. Hermes is never restarted by this installer.')
        return 0

    backup = None
    if plan['conflict'] or g['replace']:
        backup = root / 'slack-connect' / 'backups' / time.strftime('%Y%m%d-%H%M%S')
        backup.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
        os.chmod(backup.parent, 0o700)
        backup.mkdir(mode=0o700, exist_ok=False)
        for path in plan['conflict'] + ([g['replace']] if g['replace'] else []):
            rel = path.relative_to(host.home) if path.is_relative_to(host.home) else Path(*path.parts[1:])
            dest = backup / rel
            dest.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(path, dest)
        out(f'Backed up {len(plan["conflict"]) + bool(g["replace"])} file(s) to {backup}')

    manifest = dict(g['manifest'])
    manifest.update({'version': 1, 'label': LABEL, 'kind': host.kind, 'service_file': str(g['unit_path'])})
    owned = dict(g['owned'])
    for path, data in {**g['files'], g['unit_path']: g['unit']}.items():
        if path in changed:
            write_file(path, data)
        owned[str(path)] = digest(data)
    manifest['files'] = owned
    if config_changed:
        write_config(root, config)
    if not state_key.exists():
        write_private(state_key, os.urandom(32))
    if not enabled:
        set_default_enabled(host, True)
        manifest['default_enabled'] = True
    elif args.adopt:
        manifest['default_enabled'] = True
    manifest.setdefault('default_enabled', False)
    # Record ownership before touching services so a failure below can still be uninstalled.
    write_private(root / 'slack-connect' / MANIFEST, json.dumps(manifest, indent=2, sort_keys=True).encode())

    if g['replace']:
        service_stop(host, args.replace_service)
        g['replace'].unlink()
        loaded = False
        for _ in range(20):
            if not host.port_in_use(config['relay_port']):
                break
            host.sleep(0.5)
    if not loaded:
        service_start(host)
    elif unit_changed:
        service_stop(host)
        service_start(host)
    elif code_changed or config_changed:
        service_restart(host)
    local = wait_health(host, config)
    if g['funnel'] and not g['funnel']['exists']:
        if not local:
            raise InstallError('relay is not healthy locally; Funnel was not changed')
        out('Running: ' + ' '.join(map(str, g['funnel']['command'])))
        if host.run(g['funnel']['command'])[0]:
            raise InstallError('tailscale funnel failed; run the command above yourself to see why')
        manifest['funnel'] = {'dns': g['funnel']['dns'], 'path': '/slack', 'target': funnel_target(config['relay_port'])}
    elif g['funnel'] and args.adopt:
        manifest['funnel'] = {'dns': g['funnel']['dns'], 'path': '/slack', 'target': funnel_target(config['relay_port'])}
    write_private(root / 'slack-connect' / MANIFEST, json.dumps(manifest, indent=2, sort_keys=True).encode())
    out('Installed. Hermes was not restarted.')
    return self_check(args, host, config)


def wait_health(host, config):
    url = f"http://127.0.0.1:{config['relay_port']}/healthz"
    for _ in range(HEALTH_WAIT * 2):
        if healthy(host, url):
            return True
        host.sleep(0.5)
    return False


def healthy(host, url):
    try:
        status, body = host.http_get(url, timeout=5)
        return status == 200 and body[:2] == b'ok'
    except Exception:
        return False


def self_check(args, host, config):
    out = host.out
    missing = []
    local = healthy(host, f"http://127.0.0.1:{config['relay_port']}/healthz")
    out('Check: local relay health ' + ('OK' if local else 'FAILED'))
    if not local:
        missing.append(f"the relay is not answering on 127.0.0.1:{config['relay_port']} (see the relay log)")
    if not config['public_url']:
        out('Check: public URL not configured')
        missing.append('a public HTTPS address: re-run with --public-url https://... or --tailscale-funnel')
    else:
        public = healthy(host, config['public_url'] + '/healthz')
        out('Check: public health ' + config['public_url'] + '/healthz ' + ('OK' if public else 'FAILED'))
        if not public:
            missing.append(f"{config['public_url']}/healthz is not reachable; point it at 127.0.0.1:{config['relay_port']}")
    status = bootstrap_status(host, args.dashboard_url)
    if status is None:
        out(f'Check: bootstrap route not reachable through {args.dashboard_url}')
        missing.append('the slack-connect bootstrap route: start Hermes (or reload its plugins) so the dashboard '
                       f'loads slack-connect, or pass --dashboard-url (tried {args.dashboard_url})')
    else:
        out('Check: bootstrap route ' + ('OK' if status.get('mode') == 'bootstrap' else 'unexpected answer'))
        if status.get('mode') != 'bootstrap':
            missing.append('the default profile\'s slack-connect route did not answer as the bootstrap route')
        readiness = status.get('readiness')
        if isinstance(readiness, dict) and not readiness.get('workspace_ready'):
            missing.append('a workspace configuration token: open a bot\'s Slack window in Hermes and add one')
    out('Ready' if not missing else 'Not ready yet. Missing: ' + '; '.join(missing))
    return 0


def bootstrap_status(host, base):
    base = base.rstrip('/')
    try:
        _, page = host.http_get(base + '/', timeout=5)
        match = re.search(rb'__HERMES_SESSION_TOKEN__\s*=\s*"([^"]+)"', page)
        headers = {'X-Hermes-Session-Token': match.group(1).decode()} if match else {}
        status, body = host.http_get(base + '/api/plugins/slack-connect/status', headers=headers, timeout=10)
        return json.loads(body) if status == 200 else None
    except Exception:
        return None


# ---------------------------------------------------------------- uninstall

def uninstall(args, host):
    out = host.out
    root = host.root
    manifest = read_manifest(root)
    if not manifest:
        out('Nothing to uninstall: no install manifest at ' + str(root / 'slack-connect' / MANIFEST))
        return 0
    verb = 'Would' if args.dry_run else 'Will'
    files = {Path(p): h for p, h in manifest['files'].items()}
    remove = [p for p, h in files.items() if file_digest(p) == h]
    kept = [p for p, h in files.items() if p.exists() and file_digest(p) != h]
    unit = Path(manifest.get('service_file') or service_path(host))
    funnel = manifest.get('funnel')
    funnel_off = None
    if funnel:
        try:
            ts, dns, current, _, _ = funnel_state(host, int(funnel['target'].rsplit(':', 1)[1]))
            if dns == funnel['dns'] and current and current.rstrip('/') == funnel['target']:
                funnel_off = [ts, 'funnel', '--set-path=/slack', 'off']
            else:
                out('Funnel path /slack no longer points at the relay; leaving Funnel alone.')
        except InstallError as exc:
            out(f'Funnel not checked ({exc}); leaving it alone.')
    apps = read_json_quiet(root / 'slack-connect' / 'apps.json')
    out(f'{verb} stop and remove the relay service {LABEL} ({unit})')
    if funnel_off:
        out(f'{verb} run: ' + ' '.join(map(str, funnel_off)))
    out(f'{verb} remove {len(remove)} installed file(s)' + (f'; keep {len(kept)} edited file(s)' if kept else ''))
    if manifest.get('default_enabled'):
        out(f"{verb} disable slack-connect in the default profile (Hermes's _set_plugin_enabled)")
    out(f'{verb} remove {config_path(root)} and the install manifest')
    out('Kept: the workspace token store and state key in ' + str(root / 'slack-connect') +
        ' (delete them yourself when no bot needs them).')
    if apps:
        out(f'{len(apps)} bot(s) are still connected through this relay. Their Slack apps are left alone; they stop '
            'receiving Slack events once the relay is gone. Use Remove from Slack on each bot first if you want '
            'the apps deleted.')
    else:
        out('Slack apps of connected bots are never touched by the installer.')
    if args.dry_run:
        out('Dry run: nothing was changed.')
        return 0
    service_stop(host)
    if host.kind == 'linux':
        host.run(['systemctl', '--user', 'daemon-reload'])
    if funnel_off and host.run(funnel_off)[0]:
        out('tailscale funnel off failed; run it yourself: ' + ' '.join(map(str, funnel_off)))
    for path in remove:
        path.unlink()
    dirs = {root / 'plugins' / PLUGIN, root / 'slack-relay'}
    for top in dirs:
        for cache in sorted(top.rglob('__pycache__')) if top.is_dir() else []:
            if cache.is_dir() and not cache.is_symlink():
                shutil.rmtree(cache)
        for path in sorted((p for p in top.rglob('*') if p.is_dir()), key=lambda p: len(p.parts), reverse=True) if top.is_dir() else []:
            try_rmdir(path)
        try_rmdir(top)
    if host.kind == 'linux':
        host.run(['systemctl', '--user', 'daemon-reload'])
    if manifest.get('default_enabled'):
        set_default_enabled(host, False)
    for path in (config_path(root), root / 'slack-connect' / MANIFEST):
        if path.exists():
            path.unlink()
    out('Uninstalled. Hermes was not restarted; plugin processes that already loaded slack-connect keep it '
        'until Hermes next reloads them.')
    return 0


def try_rmdir(path):
    try:
        path.rmdir()
    except OSError:
        pass


def read_json_quiet(path):
    try:
        data = json.loads(path.read_text())
        return data if isinstance(data, dict) else {}
    except Exception:
        return {}


# ---------------------------------------------------------------- entry point

def parser():
    p = argparse.ArgumentParser(description='Install the Slack one-click connect add-on on this Hermes host.')
    group = p.add_mutually_exclusive_group()
    group.add_argument('--public-url', help='your own HTTPS address that forwards /slack to the relay')
    group.add_argument('--tailscale-funnel', action='store_true', help='publish /slack with Tailscale Funnel')
    p.add_argument('--gateway-url', help="Hermes's API server listener (default: discovered from Hermes)")
    p.add_argument('--relay-port', type=int, help=f'loopback port for the relay (default {DEFAULT_PORT})')
    p.add_argument('--dashboard-url', default='http://127.0.0.1:9119', help='Hermes backend used by the self-check')
    p.add_argument('--hermes-python', help='Python of the Hermes install (default: $HERMES_HOME/hermes-agent/venv/bin/python)')
    p.add_argument('--replace-service', metavar='NAME', help='an earlier launchd label or systemd unit that runs this relay')
    p.add_argument('--adopt', action='store_true', help='back up and replace files from an earlier manual install')
    p.add_argument('--dry-run', action='store_true', help='show what would change; change nothing')
    p.add_argument('--uninstall', action='store_true', help='remove what this installer installed')
    return p


def platform_kind(platform=None):
    platform = platform or sys.platform
    if platform.startswith('win') or platform.startswith('cygwin'):
        return 'windows'
    if platform == 'darwin':
        return 'darwin'
    if platform.startswith('linux'):
        return 'linux'
    return None


def main(argv=None, host=None, platform=None):
    args = parser().parse_args(argv)
    kind = platform_kind(platform)
    if kind == 'windows':
        print('Windows is not supported yet; use the paste-tokens dialog in Hermes instead.')
        return 0
    if kind is None:
        print('This platform is not supported; use the paste-tokens dialog in Hermes instead.', file=sys.stderr)
        return 1
    if host is None:
        home = Path.home()
        root = Path(os.environ.get('HERMES_HOME') or home / '.hermes').expanduser().resolve()
        if root.parent.name == 'profiles':
            raise InstallError('HERMES_HOME points at a profile; run this against the Hermes root home')
        python = Path(args.hermes_python) if args.hermes_python else root / 'hermes-agent/venv/bin/python'
        host = Host(kind, home, root, python)
    return uninstall(args, host) if args.uninstall else install(args, host)


if __name__ == '__main__':
    try:
        sys.exit(main())
    except (InstallError, ValueError, OSError) as exc:
        print('Slack installer: ' + str(exc), file=sys.stderr)
        sys.exit(1)
