"""Locked, durable rotation of the host's authoritative workspace token store."""
from pathlib import Path
import json
from urllib.parse import urlencode
from urllib.request import Request, urlopen
from .core import LockedFile, _atomic_json, _read_json


class TokenExpired(Exception):
    pass


def request_rotation(refresh_token, *, opener=urlopen):
    body = urlencode({'refresh_token': refresh_token}).encode()
    request = Request('https://slack.com/api/tooling.tokens.rotate', data=body, method='POST')
    with opener(request, timeout=15) as response:
        return json.load(response)


class TokenStore:
    def __init__(self, path):
        self.path = Path(path)

    def rotate(self, team_id, rotate_request):
        with LockedFile(str(self.path) + '.lock'):
            entries = _read_json(self.path, {})
            old = entries[team_id]
            if old.get('expired'):
                raise TokenExpired('Slack setup token expired, add a new one')
            if old.get('rotation_pending'):
                raise RuntimeError('workspace token needs recovery')
            # A lost response may mean the single-use refresh token was consumed.
            old['rotation_pending'] = True
            _atomic_json(self.path, entries)
            result = rotate_request(old['refresh'])
            if not isinstance(result, dict) or not result.get('ok'):
                if isinstance(result, dict) and result.get('error') in ('invalid_refresh_token', 'invalid_token', 'token_revoked', 'token_expired'):
                    old['expired'] = True
                    _atomic_json(self.path, entries)
                    raise TokenExpired('Slack setup token expired, add a new one')
                raise RuntimeError('Slack token rotation failed')
            if not all(isinstance(result.get(k), str) and result[k] for k in ('token', 'refresh_token')):
                raise RuntimeError('Slack rotation returned an incomplete pair')
            pair = {**old, 'access': result['token'], 'refresh': result['refresh_token'],
                    'exp': result.get('exp'), 'user_id': result.get('user_id')}
            pair['rotation_pending'] = result.get('team_id') != team_id
            entries[team_id] = pair
            _atomic_json(self.path, entries)
            if pair['rotation_pending']:
                raise RuntimeError('workspace token needs recovery')
            return dict(pair)
