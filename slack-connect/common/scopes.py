"""Required Slack bot scopes: check an installed bot token, and add a missing one to an app.

"Required" is a short explicit list, separate from the full default list in ``core.BOT_SCOPES``,
so the check never nags about optional scopes. Each entry says what the user loses without it.

Slack only grants a scope that was added to an app's manifest after the app is reinstalled, and a
reinstall needs a person to click Allow in Slack. So the repair adds the scope to the manifest
(``apps.manifest.export`` / ``validate`` / ``update`` with a workspace configuration token) and
hands back the app's reinstall page; ``check_token`` run afterwards confirms the grant.

Stdlib only. Tokens go only in the Authorization header and are never returned or logged.
"""
import copy
import json
import re
import urllib.request

REQUIRED_BOT_SCOPES = (
    ('reactions:write', 'acknowledge messages with an emoji'),
)
APP_ID = re.compile(r'^[A-Z0-9]{2,32}$')
_SCOPE = re.compile(r'^[a-z_]+(?::[a-z_.]+)*$')
_SAFE_ERROR = re.compile(r'^[a-z_]{1,80}$')


class RepairError(Exception):
    """The repair stopped; ``stage`` says where. Nothing was changed unless ``stage`` is 'verify'."""

    def __init__(self, stage, error):
        self.stage, self.error = stage, safe_error(error)
        super().__init__(f'{stage} failed: {self.error}')


def safe_error(value):
    return value if isinstance(value, str) and _SAFE_ERROR.fullmatch(value) else 'unknown_error'


def parse_scopes(header):
    """The scopes in an ``x-oauth-scopes`` header value, or None when the header is absent."""
    if header is None:
        return None
    return {part.strip() for part in str(header).split(',') if _SCOPE.fullmatch(part.strip())}


def missing_required(granted):
    """[{scope, reason}] for every required scope not in ``granted`` (a set of scope names)."""
    return [{'scope': scope, 'reason': reason} for scope, reason in REQUIRED_BOT_SCOPES if scope not in granted]


def warning_text(missing):
    """One plain sentence for the user, or '' when nothing is missing."""
    if not missing:
        return ''
    names = ', '.join(item['scope'] for item in missing)
    losses = '; '.join(item['reason'] for item in missing)
    return (f'This Slack app is missing {names}, so the bot cannot {losses}. '
            'Run the Slack scope repair for this bot, then reinstall the app in Slack.')


def _header(response, name):
    headers = getattr(response, 'headers', None)
    if headers is None:
        return None
    try:
        value = headers.get(name)
    except Exception:
        return None
    if value is None and isinstance(headers, dict):
        lowered = {str(k).lower(): v for k, v in headers.items()}
        value = lowered.get(name.lower())
    return value


def auth_test(token, opener=urllib.request.urlopen):
    """POST ``auth.test`` with ``token``. Returns (answer, granted scopes or None)."""
    request = urllib.request.Request('https://slack.com/api/auth.test', data=b'', method='POST',
                                     headers={'Authorization': 'Bearer ' + token,
                                              'Content-Type': 'application/x-www-form-urlencoded'})
    with opener(request, timeout=15) as response:
        granted = parse_scopes(_header(response, 'x-oauth-scopes'))
        answer = json.load(response)
    return (answer if isinstance(answer, dict) else {'ok': False, 'error': 'bad_response'}), granted


def check_token(token, opener=urllib.request.urlopen):
    """Is this bot token missing a required scope? Read-only.

    Returns {ok, error?, team_id?, bot_id?, scopes_known, missing: [{scope, reason}], warning}.
    ``scopes_known`` is False when Slack did not send the granted-scope header; then nothing is
    reported missing (no guessing)."""
    try:
        answer, granted = auth_test(token, opener)
    except Exception:
        return {'ok': False, 'error': 'request_failed', 'scopes_known': False, 'missing': [], 'warning': ''}
    if not answer.get('ok'):
        return {'ok': False, 'error': safe_error(answer.get('error')), 'scopes_known': False,
                'missing': [], 'warning': ''}
    missing = missing_required(granted) if granted is not None else []
    result = {'ok': True, 'scopes_known': granted is not None, 'missing': missing,
              'warning': warning_text(missing)}
    for key in ('team_id', 'bot_id'):
        if isinstance(answer.get(key), str) and APP_ID.fullmatch(answer[key]):
            result[key] = answer[key]
    return result


def _bot_scopes(manifest):
    scopes = ((manifest.get('oauth_config') or {}).get('scopes') or {}).get('bot')
    return list(scopes) if isinstance(scopes, list) else []


def _without_bot_scopes(manifest):
    rest = copy.deepcopy(manifest)
    scopes = (rest.get('oauth_config') or {}).get('scopes')
    if isinstance(scopes, dict):
        scopes.pop('bot', None)
    return rest


def canonical(manifest):
    return json.dumps(manifest, sort_keys=True, separators=(',', ':'), ensure_ascii=False)


def with_required_scopes(manifest):
    """(new manifest, added scopes). Appends only missing REQUIRED bot scopes; removes nothing and
    touches nothing else (user scopes, events, socket mode, URLs and settings are kept as they are)."""
    if not isinstance(manifest, dict):
        raise RepairError('export', 'bad_manifest')
    current = _bot_scopes(manifest)
    added = [scope for scope, _ in REQUIRED_BOT_SCOPES if scope not in current]
    updated = copy.deepcopy(manifest)
    if added:
        oauth = updated.setdefault('oauth_config', {})
        scopes = oauth.setdefault('scopes', {})
        scopes['bot'] = current + added
    return updated, added


def only_scopes_added(before, after, added):
    """True when ``after`` is ``before`` plus exactly ``added`` at the end of the bot scopes."""
    return (canonical(_without_bot_scopes(before)) == canonical(_without_bot_scopes(after))
            and _bot_scopes(after) == _bot_scopes(before) + list(added))


def reinstall_url(app_id):
    """The app's OAuth & Permissions page; its Reinstall button grants the new scope."""
    if not isinstance(app_id, str) or not APP_ID.fullmatch(app_id):
        raise ValueError('invalid app id')
    return f'https://api.slack.com/apps/{app_id}/oauth'


def repair_app(slack, token, app_id, save_backup, *, dry_run=False):
    """Add the missing REQUIRED bot scopes to one app's manifest.

    ``slack`` is the plugin's SlackAPI (``post`` and ``update``), ``token`` a workspace
    configuration access token, ``save_backup(app_id, manifest)`` stores the before-manifest and
    returns where. Export -> add -> self-check -> backup -> validate -> update -> export again.
    Idempotent: when the manifest already has every required scope nothing is written, and the
    reinstall link is still returned (the token may not have the grant yet).
    Raises RepairError; before the 'update' stage succeeds Slack's copy is untouched."""
    link = reinstall_url(app_id)
    exported = slack.post('apps.manifest.export', token, {'app_id': app_id})
    if not exported.get('ok') or not isinstance(exported.get('manifest'), dict):
        raise RepairError('export', exported.get('error') or 'bad_manifest')
    before = exported['manifest']
    updated, added = with_required_scopes(before)
    result = {'ok': True, 'app_id': app_id, 'added': added, 'changed': False, 'reinstall_url': link,
              'bot_scopes_before': len(_bot_scopes(before))}
    if not added:
        return result
    if not only_scopes_added(before, updated, added):
        raise RepairError('build', 'unexpected_change')
    if dry_run:
        validated = slack.post('apps.manifest.validate', token,
                               {'app_id': app_id, 'manifest': json.dumps(updated, separators=(',', ':'))})
        if not validated.get('ok'):
            raise RepairError('validate', validated.get('error'))
        return {**result, 'dry_run': True}
    result['backup'] = str(save_backup(app_id, before))
    validated = slack.post('apps.manifest.validate', token,
                           {'app_id': app_id, 'manifest': json.dumps(updated, separators=(',', ':'))})
    if not validated.get('ok'):
        raise RepairError('validate', validated.get('error'))
    answer = slack.update(token, app_id, updated)
    if not answer.get('ok'):
        raise RepairError('update', answer.get('error'))
    result['changed'] = True
    result['permissions_updated'] = answer.get('permissions_updated')
    after = slack.post('apps.manifest.export', token, {'app_id': app_id})
    if after.get('ok') and isinstance(after.get('manifest'), dict):
        result['rest_unchanged'] = canonical(_without_bot_scopes(before)) == canonical(_without_bot_scopes(after['manifest']))
        result['scopes_present'] = all(scope in _bot_scopes(after['manifest']) for scope in added)
    else:
        result['rest_unchanged'] = None
        result['scopes_present'] = None
    return result


def restore_app(slack, token, app_id, manifest):
    """Put a saved before-manifest back (rollback). Validates first."""
    if not isinstance(manifest, dict) or not APP_ID.fullmatch(str(app_id)):
        raise ValueError('invalid restore input')
    validated = slack.post('apps.manifest.validate', token,
                           {'app_id': app_id, 'manifest': json.dumps(manifest, separators=(',', ':'))})
    if not validated.get('ok'):
        raise RepairError('validate', validated.get('error'))
    answer = slack.update(token, app_id, manifest)
    if not answer.get('ok'):
        raise RepairError('update', answer.get('error'))
    return {'ok': True, 'app_id': app_id, 'restored': True}
