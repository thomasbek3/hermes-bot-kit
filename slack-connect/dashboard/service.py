"""Profile-scoped app provisioning, with injected Slack operations."""
import json
import logging
import os
import re
import secrets
import time
from pathlib import Path
from urllib.parse import urlencode

from common.core import BOT_SCOPES, ENV_KEYS, LockedFile, _atomic_json, _read_json, issue_state, manifest
from common.token_store import TokenStore, TokenExpired
from common.config import load_config

LOG = logging.getLogger(__name__)

PROFILE = re.compile(r'^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$')
TEAM = re.compile(r'^[A-Z0-9]{2,32}$')
APP = re.compile(r'^[A-Z0-9]{2,32}$')
TOKEN_LIKE = re.compile(r'\b(?:xoxe[.-]|xox[a-z]-|xapp-)[A-Za-z0-9.-]+')


def public_text(value):
    return TOKEN_LIKE.sub('[redacted]', str(value or ''))


class Conflict(Exception):
    pass


class SlackRefused(Conflict):
    pass


class Service:
    def __init__(self, root, profile, slack, read_env, save_env, remove_env, notify, icon, live=None, lifecycle=None,
                 check_idle=None, recycle_profile=None):
        self.root, self.profile = Path(root), profile
        if not PROFILE.fullmatch(profile) or profile == 'default':
            raise ValueError('a named profile is required')
        self.data = self.root / 'slack-connect'
        self.slack = slack
        self.read_env, self.save_env, self.remove_env, self.notify, self.icon = read_env, save_env, remove_env, notify, icon
        self.live = live or (lambda _env: False)
        self.lifecycle = lifecycle
        self.check_idle = check_idle or (lambda: None)
        self.recycle_profile = recycle_profile or (lambda: None)
        self.base = None
        self.tokens = TokenStore(self.data / 'config-tokens.json')

    def workspaces(self):
        entries = _read_json(self.tokens.path, {})
        now = int(time.time())
        return [{'team_id': team, 'team_name': public_text(v.get('team_name')),
                 'ok': not v.get('rotation_pending', False) and not v.get('expired', False) and bool(v.get('refresh')), 'expires_in': max(0, int(v.get('exp') or 0) - now)}
                for team, v in entries.items() if TEAM.fullmatch(team)]

    def access(self, team):
        if not TEAM.fullmatch(team):
            raise ValueError('invalid team')
        with LockedFile(str(self.tokens.path) + '.lock'):
            entry = _read_json(self.tokens.path, {}).get(team)
            if entry and entry.get('expired'):
                raise TokenExpired('Slack setup token expired, add a new one')
            if not entry or entry.get('rotation_pending'):
                raise Conflict('workspace token needs recovery')
            if int(entry.get('exp') or 0) > time.time() + 600:
                return entry['access']
        result = self.tokens.rotate(team, self.slack.rotate)
        return result['access']

    def add_workspace(self, refresh):
        if not isinstance(refresh, str) or not refresh.startswith('xoxe-') or any(ch.isspace() for ch in refresh):
            raise ValueError('invalid refresh token')
        # Preserve an in-flight marker if the single-use request is ambiguous.
        with LockedFile(str(self.tokens.path) + '.lock'):
            entries = _read_json(self.tokens.path, {})
            marker = self.data / 'workspace-rotation-pending.json'
            if marker.exists():
                raise Conflict('workspace rotation needs recovery')
            _atomic_json(marker, {'refresh': refresh, 'phase': 'inflight'})
            result = self.slack.rotate(refresh)
            team = result.get('team_id')
            if not result.get('ok') or not isinstance(team, str) or not TEAM.fullmatch(team):
                if result.get('error') in ('invalid_refresh_token', 'invalid_token', 'token_revoked', 'token_expired'):
                    marker.unlink()
                    raise TokenExpired('Slack setup token expired, add a new one')
                raise RuntimeError('workspace rotation did not return a valid team')
            access, next_refresh = result.get('token'), result.get('refresh_token')
            if not all(isinstance(x, str) and x for x in (access, next_refresh)):
                raise RuntimeError('workspace rotation returned an incomplete pair')
            entry = {'access': access, 'refresh': next_refresh, 'exp': result.get('exp'),
                     'user_id': result.get('user_id')}
            entries[team] = entry
            _atomic_json(self.tokens.path, entries)
            marker.unlink()
            return {'team_id': team}

    def connect(self, team, bot_name):
        self.base = load_config(self.root)['public_url']
        if not self.base:
            raise Conflict('Configure a public HTTPS address before connecting Slack')
        env = self.read_env()
        if env.get('SLACK_APP_TOKEN') or env.get('SLACK_APP_ID') or env.get('SLACK_BOT_TOKEN'):
            raise Conflict('profile already has a Slack connection')
        bot_name = str(bot_name or '').strip() or 'Hermes'
        if TOKEN_LIKE.search(bot_name):
            raise ValueError('invalid bot name')
        token = self.access(team)
        key = secrets.token_hex(16)
        apps_path = self.data / 'apps.json'
        pending_path = self.data / 'pending' / (key + '.json')
        with LockedFile(self.data / 'apps.lock'):
            apps = _read_json(apps_path, {})
            if any(isinstance(v, dict) and v.get('profile') == self.profile for v in apps.values()):
                raise Conflict('profile already has an app in progress')
            apps[key] = {'profile': self.profile, 'team_id': team, 'bot_name': bot_name,
                         'prior_allowed_users': env.get('SLACK_ALLOWED_USERS')}
            _atomic_json(apps_path, apps)
            _atomic_json(pending_path, {'phase':'pending', 'at':int(time.time())})
        app_id = None
        try:
            if self.lifecycle is None:
                raise RuntimeError('Slack platform lifecycle unavailable')
            self.lifecycle.install()
        except Exception:
            with LockedFile(self.data / 'apps.lock'):
                apps = _read_json(apps_path, {})
                apps.pop(key, None)
                _atomic_json(apps_path, apps)
                pending_path.unlink(missing_ok=True)
            raise
        try:
            app_manifest = manifest(bot_name, self.base, key)
            response = self.slack.create(token, app_manifest)
            if response.get('ok') is False and not response.get('app_id'):
                raise SlackRefused('Slack refused to create the app. Check workspace permissions and try again.')
            app_id = response.get('app_id')
            credentials = response.get('credentials') or {}
            if not response.get('ok') or not isinstance(app_id, str) or not APP.fullmatch(app_id) or not all(credentials.get(k) for k in ('client_id', 'client_secret', 'signing_secret')):
                raise RuntimeError('Slack app creation failed')
            try:
                self.slack.set_icon(token, app_id, self.icon())
                icon_result = 'ok'
            except self.slack.IconUnavailable as exc:
                error = str(exc)
                safe_error = error if re.fullmatch(r'[a-z_]{1,80}', error) else 'unknown_error'
                icon_result = safe_error
                LOG.info('Slack app icon unavailable: %s', safe_error)
            self.save_env({'SLACK_CONNECTION_MODE':'http', 'SLACK_APP_ID':app_id,
                           'SLACK_CLIENT_ID':credentials['client_id'], 'SLACK_CLIENT_SECRET':credentials['client_secret'],
                           'SLACK_SIGNING_SECRET':credentials['signing_secret']})
            with LockedFile(self.data / 'apps.lock'):
                apps = _read_json(apps_path, {})
                apps[key]['app_id'] = app_id
                apps[key]['icon_result'] = icon_result
                _atomic_json(apps_path, apps)
                _atomic_json(pending_path, {'phase':'created', 'at':int(time.time())})
            # Ask Slack once to recheck after the relay can read the signing secret.
            # Verification is advisory: delivery may work even when Slack's UI says otherwise.
            try:
                updated = self.slack.update(token, app_id, app_manifest)
                error = updated.get('error')
                safe_error = error if isinstance(error, str) and re.fullmatch(r'[a-z_]{1,80}', error) else 'unknown_error'
                update_result = 'ok' if updated.get('ok') else safe_error
                LOG.info('Slack manifest update: %s', update_result)
            except Exception:
                update_result = 'request_failed'
                LOG.warning('Slack manifest update request failed')
            with LockedFile(self.data / 'apps.lock'):
                apps = _read_json(apps_path, {})
                apps[key]['manifest_update_result'] = update_result
                _atomic_json(apps_path, apps)
            state = issue_state((self.data / 'state.key').read_bytes(), self.profile, key, team)
            authorize = 'https://slack.com/oauth/v2/authorize?' + urlencode({'client_id':credentials['client_id'], 'scope':','.join(BOT_SCOPES), 'redirect_uri':self.base + '/oauth/callback', 'state':state, 'team':team})
            return {'authorize_url':authorize, 'app_id':app_id}
        except SlackRefused:
            self.lifecycle.remove()
            with LockedFile(self.data / 'apps.lock'):
                apps = _read_json(apps_path, {})
                apps.pop(key, None)
                _atomic_json(apps_path, apps)
                pending_path.unlink(missing_ok=True)
            raise
        except Exception:
            if app_id:
                # Delete only the exact app created by this call. A failed or
                # ambiguous delete leaves its identity for explicit recovery.
                try:
                    deleted = self.slack.delete(token, app_id)
                    if not deleted.get('ok') and deleted.get('error') != 'app_not_found':
                        raise RuntimeError('rollback failed')
                except Exception:
                    with LockedFile(self.data / 'apps.lock'):
                        apps = _read_json(apps_path, {})
                        if key in apps:
                            apps[key]['app_id'] = app_id
                            _atomic_json(apps_path, apps)
                        _atomic_json(pending_path, {'phase':'error', 'at':int(time.time())})
                    raise RuntimeError('Slack app rollback needs recovery') from None
                self.remove_env(('SLACK_CONNECTION_MODE', 'SLACK_APP_ID', 'SLACK_CLIENT_ID',
                                 'SLACK_CLIENT_SECRET', 'SLACK_SIGNING_SECRET'))
                self.lifecycle.remove()
                with LockedFile(self.data / 'apps.lock'):
                    apps = _read_json(apps_path, {})
                    apps.pop(key, None)
                    _atomic_json(apps_path, apps)
                    pending_path.unlink(missing_ok=True)
            else:
                # Create may have succeeded despite a lost response. Retain the
                # marker and never automatically retry an uncertain write.
                _atomic_json(pending_path, {'phase':'error', 'at':int(time.time())})
            raise RuntimeError('Slack app creation could not be completed') from None

    def status(self):
        env = self.read_env()
        if env.get('SLACK_APP_TOKEN'):
            return {'phase':'none', 'mode':'socket'}
        for key, item in _read_json(self.data / 'apps.json', {}).items():
            if isinstance(item, dict) and item.get('profile') == self.profile:
                pending = _read_json(self.data / 'pending' / (key + '.json'), {})
                phase = pending.get('phase', 'error')
                if phase == 'installed':
                    try:
                        if self.live(env):
                            phase = 'connected'
                    except Exception:
                        pass
                return {'phase':phase, 'team_name':public_text(pending.get('team_name')),
                        'bot':public_text(item.get('bot_name')), 'mode':'http',
                        'icon_result':item.get('icon_result'),
                        'manifest_update_result':item.get('manifest_update_result')}
        return {'phase':'none', 'mode':'http'}

    def delete(self):
        env = self.read_env()
        if env.get('SLACK_APP_TOKEN'):
            raise Conflict('Socket Mode apps cannot be removed here')
        path = self.data / 'apps.json'
        with LockedFile(self.data / 'apps.lock'):
            apps = _read_json(path, {})
            found = [(key, item) for key, item in apps.items() if isinstance(item, dict) and item.get('profile') == self.profile]
            if not found:
                if self.lifecycle is not None:
                    self.lifecycle.remove()
                return {'ok':True}
            if len(found) != 1 or not found[0][1].get('app_id'):
                raise Conflict('app identity requires manual recovery')
            key, item = found[0]
            if env.get('SLACK_APP_ID') and env['SLACK_APP_ID'] != item['app_id']:
                raise Conflict('profile and app identity do not match')
            # Hermes does not remove a live secondary adapter on an env rescan.
            # If ours is running, re-serve this profile after its keys are gone.
            recycle = item.get('recycle_pending') is True or bool(env.get('SLACK_BOT_TOKEN'))
            if recycle:
                self.check_idle()
                item['recycle_pending'] = True
                _atomic_json(path, apps)
            token = self.access(item['team_id'])
            result = self.slack.delete(token, item['app_id'])
            if not result.get('ok') and result.get('error') != 'app_not_found':
                raise RuntimeError('Slack app removal failed')
            self.remove_env(tuple(key for key in ENV_KEYS if key != 'SLACK_ALLOWED_USERS'))
            prior = item.get('prior_allowed_users')
            if prior is None:
                self.remove_env(('SLACK_ALLOWED_USERS',))
            else:
                self.save_env({'SLACK_ALLOWED_USERS': prior})
            if self.lifecycle is None:
                raise RuntimeError('Slack platform lifecycle unavailable')
            self.lifecycle.remove()
            if recycle:
                self.recycle_profile()
            apps.pop(key)
            _atomic_json(path, apps)
            (self.data / 'pending' / (key + '.json')).unlink(missing_ok=True)
        self.notify()
        return {'ok':True}
