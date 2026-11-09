"""Profile-scoped dashboard routes. Never return secrets in JSON."""
import importlib.util
import hashlib
import hmac
import json
import secrets
import os
import subprocess
import time
from urllib.request import Request as URLRequest, urlopen
import sys
from pathlib import Path
from fastapi import APIRouter, HTTPException, Request
from starlette.concurrency import run_in_threadpool

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))
from common.config import load_config


def load(name):
    spec = importlib.util.spec_from_file_location('hermes_slack_connect_' + name, HERE / (name + '.py'))
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module

service_module = load('service')
slack_module = load('slack_api')
platform_module = load('platform_lifecycle')
router = APIRouter()


async def request_object(request):
    try:
        value = await request.json()
        if not isinstance(value, dict):
            raise ValueError()
        return value
    except Exception:
        raise HTTPException(status_code=400, detail='Invalid Slack connection request') from None


def http_adapter_ready(profile, signing_secret, gateway_url, opener=urlopen):
    """Confirm the scoped adapter accepts a signed verification challenge."""
    if not service_module.PROFILE.fullmatch(profile) or profile == 'default' or not signing_secret:
        return False
    challenge = secrets.token_hex(16)
    body = json.dumps({'type': 'url_verification', 'challenge': challenge}, separators=(',', ':')).encode()
    timestamp = str(int(time.time()))
    signature = 'v0=' + hmac.new(signing_secret.encode(), b'v0:' + timestamp.encode() + b':' + body, hashlib.sha256).hexdigest()
    request = URLRequest(gateway_url.rstrip('/') + '/p/' + profile + '/slack/events', data=body,
                         headers={'Content-Type': 'application/json', 'X-Slack-Request-Timestamp': timestamp,
                                  'X-Slack-Signature': signature}, method='POST')
    try:
        with opener(request, timeout=2.5) as response:
            return response.status == 200 and json.loads(response.read(4096)).get('challenge') == challenge
    except Exception:
        return False


def set_platform_enabled(home, root, enabled):
    # Plugin hosts may run from the bare tool-store interpreter, which lacks
    # Hermes's dependencies. Use the selected application environment instead.
    from pm.environments import project_python
    env = dict(os.environ, HERMES_HOME=str(home), HERMES_DISABLE_LAZY_INSTALLS='1', PYTHONDONTWRITEBYTECODE='1')
    python = project_python(root / 'hermes-agent')
    result = subprocess.run([str(python), '-I', str(HERE / 'platform_selection.py'),
                             str(root / 'hermes-agent'), 'enable' if enabled else 'disable'],
                            env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    if result.returncode:
        raise platform_module.GatewayReloadError('Slack platform selection failed; Hermes dependencies may be out of date. No shared dependency rebuild was requested.')


def check_profile_idle(root, profile):
    from gateway.control_socket import query_gateway_control
    answer = query_gateway_control(root, 'active-work', params={'profile': profile})
    if not isinstance(answer, dict) or answer.get('profile') != profile or answer.get('active_agents') != 0:
        raise platform_module.GatewayReloadError('Wait for this bot to finish its work, then try removing Slack again.')


def recycle_profile(root, profile):
    from gateway.control_socket import request_unserve_profile, request_serve_profile_hot
    stopped = request_unserve_profile(root, profile)
    if not isinstance(stopped, dict) or (stopped.get('unserved') != profile and stopped.get('error') != f"profile '{profile}' is not served"):
        raise platform_module.GatewayReloadError('Could not refresh this bot after removing Slack. Try again.')
    started = request_serve_profile_hot(root, profile)
    if not isinstance(started, dict) or started.get('served') != profile:
        # A concurrent rescan may already have served it; retrying Remove is safe.
        raise platform_module.GatewayReloadError('Could not confirm this bot restarted after removing Slack. Try again.')


def make_service():
    from hermes_constants import get_default_hermes_root, get_hermes_home
    from hermes_cli.config import load_env, save_env_value, remove_env_value
    from hermes_cli.gateway_multiplex_served import notify_multiplexer_profiles_changed
    from gateway.control_socket import reload_gateway_plugins
    home = Path(get_hermes_home())
    root = Path(get_default_hermes_root())
    if home.parent != root / 'profiles':
        raise ValueError('a named profile is required')
    def save(values):
        for key, value in values.items():
            save_env_value(key, value)
    def remove(keys):
        for key in keys:
            remove_env_value(key)
    slack = slack_module.SlackAPI()
    def set_enabled(enabled):
        set_platform_enabled(home, root, enabled)
    lifecycle = platform_module.PlatformLifecycle(home, HERE.parent / 'platform', set_enabled,
        lambda: reload_gateway_plugins(root, profile_home=home))
    def live(env):
        token = env.get('SLACK_BOT_TOKEN')
        if not token:
            return False
        if not http_adapter_ready(home.name, env.get('SLACK_SIGNING_SECRET'), load_config(root)['gateway_url']):
            return False
        return slack.post('auth.test', token, {}).get('ok') is True
    return service_module.Service(root, home.name, slack,
        load_env, save, remove, lambda: notify_multiplexer_profiles_changed(home.name), lambda: slack_module.profile_icon(home), live, lifecycle,
        lambda: check_profile_idle(root, home.name), lambda: recycle_profile(root, home.name))


def homes():
    from hermes_constants import get_default_hermes_root, get_hermes_home
    return Path(get_default_hermes_root()), Path(get_hermes_home())


def workspace_service():
    root, home = homes()
    if home != root:
        return make_service()
    # Workspace tokens belong to the backend, not a profile. Only workspace
    # routes use this service; provisioning still requires a named profile.
    return service_module.Service(root, 'bootstrap', slack_module.SlackAPI(),
        lambda: {}, lambda _: None, lambda _: None, lambda: None, lambda: None)


def bootstrap_profile(profile):
    root, home = homes()
    if home != root:
        raise HTTPException(status_code=404, detail='Not found')
    profiles = root / 'profiles'
    if not isinstance(profile, str) or not service_module.PROFILE.fullmatch(profile) or profile == 'default':
        raise HTTPException(status_code=400, detail='Invalid profile')
    target = profiles / profile
    if target.is_symlink() or not target.is_dir() or target.resolve().parent != profiles.resolve():
        raise HTTPException(status_code=404, detail='Profile not found')
    from pm.environments import project_python
    env = dict(os.environ, HERMES_HOME=str(target), PYTHONPATH=str(root / 'hermes-agent'),
               HERMES_DISABLE_LAZY_INSTALLS='1', PYTHONDONTWRITEBYTECODE='1')
    result = subprocess.run([str(project_python(root / 'hermes-agent')), '-c',
        'from hermes_cli.plugins_cmd import _set_plugin_enabled; _set_plugin_enabled("slack-connect", enable=True)'],
        env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    if result.returncode:
        raise HTTPException(status_code=503, detail='Could not enable Slack for this bot')
    return {'ok': True}


def handle(action, factory=None):
    try:
        return action((factory or make_service)())
    except service_module.TokenExpired:
        raise HTTPException(status_code=409, detail='Slack setup token expired, add a new one') from None
    except service_module.Conflict as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from None
    except platform_module.GatewayReloadError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from None
    except ValueError:
        raise HTTPException(status_code=400, detail='Invalid Slack connection request') from None
    except Exception:
        raise HTTPException(status_code=503, detail='Slack connection could not be completed; check recovery status') from None


@router.get('/workspaces')
def workspaces():
    return handle(lambda service: service.workspaces(), workspace_service)


@router.post('/workspaces')
async def add_workspace(request: Request):
    body = await request_object(request)
    return await run_in_threadpool(lambda: handle(lambda service: service.add_workspace(body.get('refresh_token')), workspace_service))


@router.post('/bootstrap')
async def bootstrap(request: Request):
    body = await request_object(request)
    return await run_in_threadpool(bootstrap_profile, body.get('profile'))


@router.post('/connect')
async def connect(request: Request):
    body = await request_object(request)
    team, name = body.get('team_id'), body.get('bot_name', 'Hermes')
    if not isinstance(team, str) or not isinstance(name, str):
        raise HTTPException(status_code=400, detail='Invalid Slack connection request')
    return await run_in_threadpool(lambda: handle(lambda service: service.connect(team, name)))


_infrastructure_cache = {}
INFRASTRUCTURE_TTL = 30


def infrastructure_missing(root, opener=urlopen):
    """None when config, local relay and public URL are healthy; else the first missing piece."""
    try:
        config = load_config(root)
    except (OSError, ValueError, TypeError, UnicodeDecodeError, json.JSONDecodeError):
        return 'config'
    if not config['public_url']:
        return 'public_url'
    host = config['relay_bind']
    if ':' in host:
        host = '[' + host + ']'
    for name, url in (('relay', f"http://{host}:{config['relay_port']}/healthz"),
                      ('public_url', config['public_url'] + '/healthz')):
        try:
            with opener(url, timeout=2.5) as response:
                if response.status != 200 or response.read(16) != b'ok':
                    raise ValueError('unhealthy')
        except Exception:
            return name
    return None


def readiness(root, opener=None):
    """One-click readiness: config, relay and public URL healthy, plus a usable workspace token."""
    if opener is None:
        # Status is polled; probe the relay and the public URL at most every 30 s.
        cached = _infrastructure_cache.get(str(root))
        if cached and time.monotonic() - cached[0] < INFRASTRUCTURE_TTL:
            missing = cached[1]
        else:
            missing = infrastructure_missing(root)
            _infrastructure_cache[str(root)] = (time.monotonic(), missing)
    else:
        missing = infrastructure_missing(root, opener)
    if missing:
        return {'ready': False, 'infrastructure_ready': False, 'workspace_ready': False, 'missing': missing}
    try:
        entries = workspace_service().workspaces()
        workspace_ready = any(row.get('ok') for row in entries)
    except Exception:
        workspace_ready = False
    return {'ready': workspace_ready, 'infrastructure_ready': True, 'workspace_ready': workspace_ready,
            'missing': None if workspace_ready else 'workspace_token'}


@router.get('/status')
def status():
    root, home = homes()
    result = {'phase': 'none', 'mode': 'bootstrap'} if home == root else handle(lambda service: service.status())
    return {**result, 'readiness': readiness(root)}


@router.delete('/connect')
def disconnect():
    return handle(lambda service: service.delete())
