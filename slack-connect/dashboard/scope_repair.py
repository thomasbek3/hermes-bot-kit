#!/usr/bin/env python3
"""Check and repair the required Slack bot scopes of a Hermes bot's Slack app.

    python3 scope_repair.py check  [--profile NAME ...]     read-only; every Slack bot if none named
    python3 scope_repair.py repair --profile NAME [--dry-run] [--app-id A...] [--team T...]
    python3 scope_repair.py verify --profile NAME           after the reinstall: exit 0 when granted
    python3 scope_repair.py restore --app-id A... --team T... --from BACKUP.json

``repair`` adds only the missing required bot scopes (see common/scopes.py) to the app's manifest
with the workspace configuration token slack-connect keeps (rotated under the plugin's own lock),
saves the before-manifest under ``<root>/slack-connect/manifest-backups/`` and prints the app's
reinstall page. Slack grants the scope only after someone clicks Reinstall / Allow there; then run
``verify``. Nothing here restarts Hermes, changes a profile or sends a Slack message. Tokens are
never printed. Output is one JSON object per line.

Exit codes: 0 ok, 1 a required scope is still missing, 2 usage, 3 a Slack or token failure.
"""
import argparse
import json
import os
import sys
import time
import urllib.request
from pathlib import Path

sys.dont_write_bytecode = True
HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))
sys.path.insert(0, str(HERE))

from common import scopes  # noqa: E402
from common.core import _atomic_json, _read_json  # noqa: E402
import service as service_module  # noqa: E402
from slack_api import SlackAPI  # noqa: E402

TEAM = service_module.TEAM


def out(value):
    print(json.dumps(value, sort_keys=True), flush=True)


def profile_home(root, profile):
    if profile == 'default':
        return root
    if not service_module.PROFILE.fullmatch(profile):
        raise ValueError('invalid profile name')
    return root / 'profiles' / profile


def read_env(home):
    """KEY=VALUE pairs of the profile's .env (quotes and an `export ` prefix allowed)."""
    values = {}
    try:
        text = (home / '.env').read_text()
    except OSError:
        return values
    for line in text.splitlines():
        line = line.strip()
        if not line or line.startswith('#') or '=' not in line:
            continue
        key, value = line.split('=', 1)
        key = key.strip()
        if key.startswith('export '):
            key = key[7:].strip()
        value = value.strip()
        if len(value) >= 2 and value[0] == value[-1] and value[0] in '"\'':
            value = value[1:-1]
        values[key] = value
    return values


def bot_token(env):
    return (env.get('SLACK_BOT_TOKEN') or '').split(',')[0].strip()


def slack_profiles(root):
    names = ['default'] if bot_token(read_env(root)) else []
    profiles = root / 'profiles'
    if profiles.is_dir():
        for home in sorted(profiles.iterdir()):
            if home.is_dir() and service_module.PROFILE.fullmatch(home.name) and bot_token(read_env(home)):
                names.append(home.name)
    return names


def app_id_for(slack, token, bot_id, env):
    """The app behind a bot token: bots.info first, then the profile's SLACK_APP_ID."""
    if bot_id:
        try:
            answer = slack.post('bots.info', token, {'bot': bot_id})
            app = (answer.get('bot') or {}).get('app_id') if answer.get('ok') else None
            if isinstance(app, str) and scopes.APP_ID.fullmatch(app):
                return app
        except Exception:
            pass
    app = env.get('SLACK_APP_ID', '').strip()
    return app if scopes.APP_ID.fullmatch(app) else None


def check_profile(root, profile, slack, opener):
    env = read_env(profile_home(root, profile))
    token = bot_token(env)
    row = {'profile': profile}
    if not token:
        return {**row, 'ok': False, 'error': 'no_bot_token'}, None, env
    result = scopes.check_token(token, opener)
    row.update(result)
    if result.get('ok'):
        row['app_id'] = app_id_for(slack, token, result.get('bot_id'), env)
    return row, token, env


def refuse(*_args, **_kwargs):
    raise RuntimeError('scope repair never changes profile state')


def config_token(root, slack, team):
    # Service.access rotates the workspace configuration token under the plugin's lock when it is
    # near expiry, exactly as Connect does. The profile name only labels this throwaway service.
    service = service_module.Service(root, 'scope-repair', slack, refuse, refuse, refuse, refuse, refuse)
    return service.access(team)


def backup_writer(root):
    def save(app_id, manifest):
        stamp = time.strftime('%Y%m%dT%H%M%SZ', time.gmtime())
        path = root / 'slack-connect' / 'manifest-backups' / f'{app_id}-{stamp}.json'
        _atomic_json(path, manifest)
        return path
    return save


def verify_command(profile):
    return f'python3 {HERE / "scope_repair.py"} verify --profile {profile}'


def main(argv=None, *, slack=None, opener=urllib.request.urlopen, root=None):
    parser = argparse.ArgumentParser(description='Check or repair required Slack bot scopes.')
    parser.add_argument('command', choices=('check', 'repair', 'verify', 'restore'))
    parser.add_argument('--profile', action='append', default=[])
    parser.add_argument('--root', default=os.environ.get('HERMES_ROOT') or str(Path.home() / '.hermes'))
    parser.add_argument('--app-id')
    parser.add_argument('--team')
    parser.add_argument('--dry-run', action='store_true')
    parser.add_argument('--from', dest='source')
    args = parser.parse_args(argv)
    root = Path(root or args.root)
    slack = slack or SlackAPI()
    try:
        if args.command == 'check':
            worst = 0
            for profile in args.profile or slack_profiles(root):
                row, _, _ = check_profile(root, profile, slack, opener)
                worst = max(worst, 3 if not row.get('ok') else 1 if row.get('missing') else 0)
                out(row)
            return worst
        if args.command == 'restore':
            if not (args.app_id and args.team and args.source) or not TEAM.fullmatch(args.team):
                parser.error('restore needs --app-id, --team and --from')
            manifest = _read_json(args.source, None)
            if not isinstance(manifest, dict):
                parser.error('--from must be a saved manifest')
            out(scopes.restore_app(slack, config_token(root, slack, args.team), args.app_id, manifest))
            return 0
        if len(args.profile) != 1:
            parser.error(f'{args.command} takes exactly one --profile')
        profile = args.profile[0]
        row, token, env = check_profile(root, profile, slack, opener)
        if args.command == 'verify':
            out(row)
            return 3 if not row.get('ok') else 1 if row.get('missing') or not row.get('scopes_known') else 0
        if not row.get('ok') and not (args.app_id and args.team):
            out(row)
            return 3
        app_id = args.app_id or row.get('app_id')
        team = args.team or row.get('team_id')
        if not app_id or not scopes.APP_ID.fullmatch(app_id) or not team or not TEAM.fullmatch(team):
            out({'profile': profile, 'ok': False, 'error': 'app_or_team_unknown',
                 'hint': 'pass --app-id and --team'})
            return 3
        result = scopes.repair_app(slack, config_token(root, slack, team), app_id, backup_writer(root),
                                   dry_run=args.dry_run)
        result.update({'profile': profile, 'granted_now': not row.get('missing') if row.get('scopes_known') else None,
                       'verify': verify_command(profile)})
        out(result)
        return 0
    except scopes.RepairError as exc:
        out({'ok': False, 'stage': exc.stage, 'error': exc.error})
        return 3
    except service_module.TokenExpired:
        out({'ok': False, 'stage': 'config_token', 'error': 'config_token_expired'})
        return 3
    except (service_module.Conflict, RuntimeError, OSError, ValueError) as exc:
        out({'ok': False, 'error': service_module.public_text(type(exc).__name__ + ': ' + str(exc))[:200]})
        return 3


if __name__ == '__main__':
    sys.exit(main())
