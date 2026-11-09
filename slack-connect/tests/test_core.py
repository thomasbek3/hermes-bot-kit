import json
import os
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from common.core import BOT_SCOPES, consume_state, issue_state, manifest, verify_slack_signature
from common.token_store import TokenStore


def test_published_signature():
    body = (b'token=xyzz0WbapA4vBCDEFasx0q6G&team_id=T1DC2JH3J&team_domain=testteamnow&channel_id=G8PSS9T3V&channel_name=foobar&user_id=U2CERLKJA&user_name=roadrunner&command=%2Fwebhook-collect&text=&response_url=https%3A%2F%2Fhooks.slack.com%2Fcommands%2FT1DC2JH3J%2F397700885554%2F96rGlfmibIGlgcZRskXaIFfN&trigger_id=398738663015.47445629121.803a0bc887a14d10d2c447fce8b6703c')
    secret = '8f742231b10e8888abcd99yyyzzz85a5'
    signature = 'v0=a2114d57b48eac39b9ad189dd8316235a7b4a8d21a10bd27519666489c69b503'
    assert verify_slack_signature(secret, '1531420618', body, signature, now=1531420618)
    assert not verify_slack_signature(secret, '1531420618', body, signature, now=1531420919)
    assert not verify_slack_signature(secret, '1531420618', body + b'x', signature, now=1531420618)
    assert not verify_slack_signature(secret, 'bad', body, signature, now=1531420618)


def test_manifest_has_exact_owner_scopes_and_reply_enabled():
    expected = {'app_mentions:read', 'assistant:write', 'canvases:write', 'channels:history', 'channels:read', 'chat:write', 'commands', 'files:read', 'files:write', 'groups:history', 'groups:read', 'groups:write', 'groups:write.invites', 'groups:write.topic', 'im:history', 'im:read', 'im:write', 'mpim:history', 'mpim:read', 'reactions:read', 'usergroups:read', 'usergroups:write', 'users:read'}
    result = manifest('Bot', 'https://example.test/slack', 'a' * 32)
    assert len(BOT_SCOPES) == 23 and set(result['oauth_config']['scopes']['bot']) == expected
    assert result['features']['app_home']['messages_tab_read_only_enabled'] is False
    assert result['settings']['event_subscriptions']['request_url'] == 'https://example.test/slack/events/' + 'a' * 32
    assert result['settings']['socket_mode_enabled'] is False


@pytest.mark.parametrize('base,key', [('http://example.test', 'a' * 32), ('https://example.test?q=x', 'a' * 32), ('https://example.test', '../x')])
def test_manifest_rejects_unsafe_url(base, key):
    with pytest.raises(ValueError):
        manifest('Bot', base, key)


def test_state_once_across_instances_and_expired(tmp_path):
    key = b'k' * 32
    state = issue_state(key, 'bot', 'a' * 32, 'team', now=1000)
    path = tmp_path / 'used.json'
    assert consume_state(key, state, path, now=1001)['profile'] == 'bot'
    with pytest.raises(ValueError):
        consume_state(key, state, path, now=1002)
    expired = issue_state(key, 'bot', 'a' * 32, 'team', now=1000)
    with pytest.raises(ValueError):
        consume_state(key, expired, path, now=1600)
    assert os.stat(path).st_mode & 0o777 == 0o600


def test_state_tampering_and_wrong_key(tmp_path):
    key = b'k' * 32
    state = issue_state(key, 'bot', 'key', 'team', now=1000)
    data, signature = state.split('.')
    with pytest.raises(ValueError):
        consume_state(key, data + '.' + ('A' if signature[0] != 'A' else 'B') + signature[1:], tmp_path / 'used', now=1001)
    with pytest.raises(ValueError):
        consume_state(b'z' * 32, state, tmp_path / 'used', now=1001)


def test_rotation_commits_pair_before_return(tmp_path):
    path = tmp_path / 'tokens.json'
    path.write_text(json.dumps({'T1': {'access': 'old', 'refresh': 'old-refresh'}}))
    def rotate(refresh):
        assert refresh == 'old-refresh'
        assert json.loads(path.read_text())['T1']['rotation_pending'] is True
        return {'ok': True, 'team_id': 'T1', 'token': 'new-access', 'refresh_token': 'new-refresh'}
    result = TokenStore(path).rotate('T1', rotate)
    assert result == json.loads(path.read_text())['T1']
    assert (result['access'], result['refresh'], result['rotation_pending']) == ('new-access', 'new-refresh', False)
    assert os.stat(path).st_mode & 0o777 == 0o600


def test_ambiguous_rotation_never_retries(tmp_path):
    path = tmp_path / 'tokens.json'
    path.write_text(json.dumps({'T1': {'access': 'old', 'refresh': 'old'}}))
    store = TokenStore(path)
    def timeout(_):
        raise TimeoutError('response lost')
    with pytest.raises(TimeoutError):
        store.rotate('T1', timeout)
    with pytest.raises(RuntimeError, match='recovery'):
        store.rotate('T1', lambda _: pytest.fail('must not retry'))


def test_rotation_request_uses_post_body():
    import io
    from urllib.parse import parse_qs
    from common.token_store import request_rotation
    def opener(request, timeout):
        assert request.full_url == 'https://slack.com/api/tooling.tokens.rotate'
        assert request.method == 'POST' and timeout == 15
        assert parse_qs(request.data.decode()) == {'refresh_token': ['fake-refresh']}
        return io.BytesIO(b'{"ok":true}')
    assert request_rotation('fake-refresh', opener=opener) == {'ok': True}


def test_unexpected_team_keeps_rotated_pair_for_recovery(tmp_path):
    path = tmp_path / 'tokens.json'
    path.write_text(json.dumps({'T1': {'access': 'old', 'refresh': 'old'}}))
    result = {'ok': True, 'team_id': 'T2', 'token': 'next-access', 'refresh_token': 'next-refresh'}
    with pytest.raises(RuntimeError, match='recovery'):
        TokenStore(path).rotate('T1', lambda _: result)
    saved = json.loads(path.read_text())['T1']
    assert saved['rotation_pending'] is True and saved['refresh'] == 'next-refresh'


def test_rejected_refresh_reports_expired(tmp_path):
    from common.token_store import TokenExpired
    path = tmp_path / 'tokens.json'
    path.write_text(json.dumps({'T1': {'access': 'old', 'refresh': 'old'}}))
    with pytest.raises(TokenExpired, match='Slack setup token expired, add a new one'):
        TokenStore(path).rotate('T1', lambda _: {'ok': False, 'error': 'invalid_refresh_token'})
