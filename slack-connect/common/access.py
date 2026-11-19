"""Who may talk to a Slack-connected bot: the chosen audience and the effective one.

The kit's default is the workspace's full members: everyone who is not a guest
(single- or multi-channel), not a Slack Connect (external org) user, not a bot
and not deactivated. Hermes has no native "members only" switch:
SLACK_ALLOW_ALL_USERS admits guests too (Hermes refuses only external-org DMs).
So the kit writes the verified member list into SLACK_ALLOWED_USERS and the
relay keeps it in step with the workspace. "owner" (only the installer) and
"list" (named member IDs) are the explicit restrictions. A record without an
`access` key was connected by an earlier release ("legacy"): nothing rewrites
its allowlist until the owner chooses.

State lives in one record per app in apps.json: access, allowed, access_rev,
owner, synced_at, sync_error, retry_after, last_members_owner_ok. Every write of
an allowlist goes through publish_allowlist(), which re-checks that record and
the profile's SLACK_APP_ID under the apps.lock, so a member sync that started
before a change of audience can never overwrite it.

Effective access is what Hermes actually honours for the profile
(gateway/authz_mixin.py _principal_authorized, reading the profile's secret
scope only, never the root .env): SLACK_ALLOW_ALL_USERS, the profile's Slack
pairing approvals, the union of SLACK_ALLOWED_USERS and GATEWAY_ALLOWED_USERS
("*" = everyone; each parsed like Hermes's _coerce_allow_set, JSON list or
comma list), and GATEWAY_ALLOW_ALL_USERS when no allowlist is set. Grants that
Hermes checks before the human allowlist (_chat_scoped_grant) qualify it: a
group-chat allowlist (env or config.yaml group_allowed_chats) and allow_bots
(SLACK_ALLOW_BOTS, else config.yaml allow_bots). Anything beyond the kit's own
list is a grant, named with its source and how to change it.
"""
import json
import re
import time
from pathlib import Path

from .core import LockedFile, _atomic_json, _read_json

MODES = ('members', 'owner', 'list')
LEGACY = 'legacy'
DEFAULT_MODE = 'members'
USER_ID = re.compile(r'^[UW][A-Z0-9]{1,31}$')
TRUTHY = {'true', '1', 'yes'}
# A workspace this size keeps SLACK_ALLOWED_USERS a single sane .env line.
MAX_MEMBERS = 20000
# An empty SLACK_ALLOWED_USERS means "no allowlist" to Hermes (it falls through
# to GATEWAY_ALLOW_ALL_USERS), so nobody is written as this value instead.
# Slack IDs start with U, W or B, so it matches no one.
NOBODY = 'NOBODY'
# A members list older than this is not trusted when Slack cannot be read.
STALE_SECONDS = 86400
GATE_KEYS = ('SLACK_ALLOWED_USERS', 'SLACK_ALLOW_ALL_USERS', 'GATEWAY_ALLOWED_USERS', 'GATEWAY_ALLOW_ALL_USERS')
# The env names of Slack's pre-allowlist grants, as Hermes declares them
# (gateway/platform_env.py bundled_authz('slack'), plugins/platforms/slack/
# gateway_env.py AUTHZ). Slack declares no group-chat env today. Used when
# Hermes cannot be imported; test_hermes_parity checks it against Hermes.
SLACK_AUTHZ = {'group_allowed_chats_env': '', 'allow_bots_env': 'SLACK_ALLOW_BOTS'}
# config.yaml keys of the Slack adapter's `extra` that Hermes reads for them.
EXTRA_KEYS = ('group_allowed_chats', 'allow_bots')
ENV_NAME = re.compile(r'^[A-Z][A-Z0-9_]{0,63}$')
SOURCES = ('administrator-managed env', 'external secret source', 'config.yaml allow_all_users')
EXPECT_KEYS = ('app_id', 'profile', 'access', 'access_rev')
MISSING_USERS_READ = 'the app lacks the users:read permission'


class SlackReadError(Exception):
    """Slack's member list could not be read. `error` is Slack's error code (or
    a short word), `retry_after` the seconds Slack asked to wait, if any."""

    def __init__(self, error='request_failed', retry_after=None):
        self.error = error if isinstance(error, str) and re.fullmatch(r'[a-z_]{1,80}', error) else 'request_failed'
        self.retry_after = retry_after
        super().__init__(self.error)


def mode_of(value):
    """The record's audience; no (or an unknown) value is a legacy record."""
    value = str(value or '').strip().lower()
    return value if value in MODES else LEGACY


def rev_of(item):
    rev = (item or {}).get('access_rev')
    return rev if type(rev) is int else 0


def expect_of(item):
    """What publish_allowlist must find unchanged."""
    item = item or {}
    return {'app_id': item.get('app_id'), 'profile': item.get('profile'),
            'access': item.get('access'), 'access_rev': rev_of(item)}


def owner_of(item, pending=None):
    """The installer's member ID, if known."""
    for value in ((item or {}).get('owner'), (pending or {}).get('owner')):
        if isinstance(value, str) and USER_ID.fullmatch(value):
            return value
    return None


def parse_ids(text):
    """Member IDs from a comma/space separated string; refuses anything else."""
    if isinstance(text, (list, tuple)):
        items = [str(x).strip() for x in text]
    else:
        items = [x.strip() for x in re.split(r'[\s,]+', str(text or ''))]
    items = [x for x in items if x]
    bad = [x for x in items if not USER_ID.fullmatch(x)]
    if bad:
        raise ValueError('not Slack member IDs: ' + ', '.join(bad[:5]))
    return sorted(set(items))


def full_members(users, team_id):
    """IDs of full members of `team_id` among Slack users.list entries."""
    ids = set()
    for user in users or ():
        if not isinstance(user, dict):
            continue
        uid = user.get('id')
        if not isinstance(uid, str) or not USER_ID.fullmatch(uid) or uid == 'USLACKBOT':
            continue
        if user.get('deleted') or user.get('is_bot') or user.get('is_app_user'):
            continue
        if user.get('is_restricted') or user.get('is_ultra_restricted'):
            continue  # single- and multi-channel guests
        if user.get('is_stranger') or user.get('is_invited_user'):
            continue
        if team_id and user.get('team_id') != team_id:
            continue  # Slack Connect: another organisation's user
        ids.add(uid)
    if len(ids) > MAX_MEMBERS:
        raise SlackReadError('workspace_too_large')
    return sorted(ids)


def allowlist(mode, owner, members=(), named=()):
    """SLACK_ALLOWED_USERS ids for an audience. Members mode is the verified
    member list only; "owner" and "list" always include the installer."""
    mode = mode_of(mode)
    if mode == 'members':
        return sorted(set(members))
    ids = {owner} if owner else set()
    if mode == 'list':
        ids |= set(named)
    return sorted(ids)


def env_value(ids):
    """The .env value for a list of ids; never empty (empty means everyone)."""
    ids = [x for x in ids if x and x != NOBODY]
    return ','.join(ids) if ids else NOBODY


def coerce_allow_set(raw):
    """An allowlist value parsed exactly as Hermes's _coerce_allow_set
    (gateway/authz_mixin.py): a list, or a string whose first non-space
    character is "[" and that parses as a JSON list, gives its stripped,
    non-empty items; anything else is split on commas."""
    if raw is None:
        return set()
    if isinstance(raw, str) and raw.lstrip()[:1] == '[':
        try:
            loaded = json.loads(raw)
        except ValueError:
            loaded = raw
        if isinstance(loaded, list):
            raw = loaded
    if isinstance(raw, list):
        return {str(part).strip() for part in raw if str(part).strip()}
    return {part.strip() for part in str(raw).split(',') if part.strip()}


def _ids(value):
    return coerce_allow_set(value) - {NOBODY}


def _truthy(value):
    return str(value or '').strip().lower() in TRUTHY


def read_env_file(path):
    """KEY=value pairs of a .env file (the plain shapes Hermes writes)."""
    values = {}
    try:
        text = Path(path).read_text(encoding='utf-8-sig', errors='replace')
    except OSError:
        return values
    for line in text.splitlines():
        line = line.strip()
        if line.startswith('export '):
            line = line[7:].lstrip()
        key, sep, value = line.partition('=')
        if not sep or not key.strip() or key.lstrip().startswith('#'):
            continue
        value = value.strip()
        if len(value) >= 2 and value[0] == value[-1] and value[0] in '"\'':
            value = value[1:-1]
        values[key.strip()] = value
    return values


# ---- the one write path -------------------------------------------------

def publish_allowlist(data_dir, key, expect, ids, write_env, *, read_env=None, fields=None, env_extra=None):
    """Write SLACK_ALLOWED_USERS (and the record `fields`) for app `key`, only
    if the record still matches `expect` and the profile's .env SLACK_APP_ID is
    that app. `ids=None` updates the record only. `env_extra` are values the
    connect flow writes in the same .env write. Returns False, writing nothing,
    on any mismatch. Both checks and the write happen under apps.lock."""
    data = Path(data_dir)
    profile = expect.get('profile')
    if not isinstance(profile, str) or not expect.get('app_id'):
        return False
    with LockedFile(data / 'apps.lock'):
        apps = _read_json(data / 'apps.json', {})
        item = apps.get(key)
        if not isinstance(item, dict) or expect_of(item) != {k: expect.get(k) for k in EXPECT_KEYS}:
            return False
        env = read_env() if read_env else read_env_file(data.parent / 'profiles' / profile / '.env')
        if env.get('SLACK_APP_ID') != expect['app_id']:
            return False
        values = dict(env_extra or {})
        if ids is not None and (values or (env.get('SLACK_ALLOWED_USERS') or '') != env_value(ids)):
            values['SLACK_ALLOWED_USERS'] = env_value(ids)
        if values:
            write_env(values)
        item.update(fields or {})
        _atomic_json(data / 'apps.json', apps)
    return True


def sync_success(owner, members, now):
    """(ids, record fields) after a complete, successful member read."""
    return list(members), {'synced_at': int(now), 'sync_error': None, 'retry_after': None,
                           'last_members_owner_ok': bool(owner) and owner in members}


def sync_failure(item, owner, exc, now):
    """(ids or None to keep the current list, record fields) after a failed
    member read. A list older than STALE_SECONDS (or never read) is not kept:
    the installer stays only if Slack last said they are a full member."""
    error = exc.error if isinstance(exc, SlackReadError) else 'request_failed'
    fields = {'sync_error': sync_error_text(error)}
    wait = getattr(exc, 'retry_after', None)
    if error == 'ratelimited' or wait is not None:
        try:
            wait = int(float(wait))
        except (TypeError, ValueError):
            wait = 60
        fields['retry_after'] = int(now) + min(max(wait, 1), STALE_SECONDS)
    if not is_stale(item, now):
        return None, fields
    return stale_ids(item, owner), fields


def sync_error_text(error):
    if error == 'missing_scope':
        return MISSING_USERS_READ
    if error == 'ratelimited':
        return 'Slack is rate-limiting the member list'
    if error == 'workspace_too_large':
        return f'the workspace has more than {MAX_MEMBERS} members'
    return f"Slack's member list could not be read ({error})"


def is_stale(item, now):
    synced = (item or {}).get('synced_at')
    return type(synced) is not int or now - synced > STALE_SECONDS


def stale_ids(item, owner):
    """The allowlist once the member list is too old to keep: the installer
    if Slack last said they are a full member, else nobody."""
    return [owner] if owner and (item or {}).get('last_members_owner_ok') is True else []


def committed(item):
    """Whether the Connect callback committed credentials and access for this
    record (the member sync and audience changes need nothing else)."""
    return type((item or {}).get('installed_at')) is int


# ---- the profile's gate settings, as Hermes reads them -------------------

def gate_names(authz=None):
    """Every env key the gate reads: the four allowlist keys and the
    pre-allowlist grant names."""
    authz = SLACK_AUTHZ if authz is None else authz
    return GATE_KEYS + tuple(v for v in authz.values() if v and v not in GATE_KEYS)


def scope_from_env(env, label, complete=True, extra=None, authz=None):
    """Gate scope from one .env mapping: only the gate keys, each with its source."""
    authz = dict(SLACK_AUTHZ if authz is None else authz)
    scope = {k: {'value': str(env[k]).strip(), 'source': label} for k in gate_names(authz)
             if isinstance(env.get(k), str) and env[k].strip()}
    return {'keys': scope, 'complete': complete, 'authz': authz, 'extra': extra or {}}


def hermes_authz():
    """SLACK_AUTHZ read from Hermes's own declaration, or the constant."""
    try:
        from gateway.platform_env import bundled_authz
        found = bundled_authz('slack')
    except Exception:
        return dict(SLACK_AUTHZ)
    return {k: found.get(k) if isinstance(found.get(k), str) else '' for k in SLACK_AUTHZ}


def config_extra(home):
    """(The Slack adapter's config.yaml grant settings, read ok). Read the way
    PlatformConfig.from_dict builds `extra`: platforms.slack.extra, then
    platforms.slack, then the top-level slack: section (bridged into extra)."""
    path = Path(home) / 'config.yaml'
    if not path.is_file():
        return {}, True
    try:
        try:
            from hermes_yaml import safe_load
        except ImportError:
            from yaml import safe_load
        data = safe_load(path.read_text(encoding='utf-8-sig'))
    except Exception:
        return {}, False
    data = data if isinstance(data, dict) else {}
    platforms = data.get('platforms') if isinstance(data.get('platforms'), dict) else {}
    block = platforms.get('slack') if isinstance(platforms.get('slack'), dict) else {}
    layers = [block.get('extra') if isinstance(block.get('extra'), dict) else {}, block,
              data.get('slack') if isinstance(data.get('slack'), dict) else {}]
    found = {}
    for key in EXTRA_KEYS:
        value = next((layer[key] for layer in layers if layer.get(key) is not None), None)
        if isinstance(value, (list, tuple)):
            value = json.dumps([str(v) for v in value])
        if value is not None and str(value).strip():
            found[key] = {'value': str(value).strip(), 'source': str(path)}
    return found, True


def local_scope(home):
    """The profile .env and config.yaml alone (no Hermes): marked incomplete."""
    home = Path(home)
    extra, _ = config_extra(home)
    return scope_from_env(read_env_file(home / '.env'), f'{home}/.env', complete=False, extra=extra)


def valid_scope(scope):
    """A gate scope from the helper's JSON, checked, or None."""
    if not isinstance(scope, dict):
        return None
    keys, authz, extra = scope.get('keys'), scope.get('authz', SLACK_AUTHZ), scope.get('extra', {})
    entry = lambda v: isinstance(v, dict) and isinstance(v.get('value'), str) and isinstance(v.get('source'), str)
    if not (isinstance(authz, dict) and set(authz) == set(SLACK_AUTHZ) and
            all(isinstance(v, str) and (not v or ENV_NAME.fullmatch(v)) for v in authz.values())):
        return None
    if not (isinstance(keys, dict) and set(keys) <= set(gate_names(authz)) and all(map(entry, keys.values()))):
        return None
    if not (isinstance(extra, dict) and set(extra) <= set(EXTRA_KEYS) and all(map(entry, extra.values()))):
        return None
    return {'keys': keys, 'complete': scope.get('complete') is True, 'authz': authz, 'extra': extra}


def gate_scope(home):
    """The gate keys of a profile exactly as Hermes's platform_gate_env reads
    them under multiplexing: build_profile_secret_scope(home), i.e. the
    profile .env, external secret sources, the default profile's bridged
    config.yaml allow_all_users and the administrator-managed env (which
    overrides). Never the root .env. Each value carries its source. The grant
    env names come from Hermes (hermes_authz), the adapter's config.yaml
    settings from config_extra. Without Hermes (tests, the relay's own
    interpreter) only the profile .env and config.yaml are read and
    `complete` is False."""
    home = Path(home)
    label = f'{home}/.env'
    try:
        from agent.secret_scope import build_profile_secret_scope, load_env_file
    except Exception:
        return local_scope(home)
    authz = hermes_authz()
    extra, extra_ok = config_extra(home)
    try:
        from hermes_cli.env_loader import hydrate_profile_secret_sources, get_secret_source_values
        hydrate_profile_secret_sources(home)
        external = get_secret_source_values(home)
    except Exception:
        external = {}
    try:
        from hermes_cli.managed_scope import load_managed_env
        managed = load_managed_env()
    except Exception:
        managed = {}
    scope = build_profile_secret_scope(home)
    dotenv = load_env_file(home / '.env')
    keys = {}
    for name in gate_names(authz):
        value = scope.get(name)
        if value is None or not str(value).strip():
            continue
        source = (SOURCES[0] if name in managed else SOURCES[1] if name in external
                  else label if name in dotenv else SOURCES[2])
        keys[name] = {'value': str(value).strip(), 'source': source}
    return {'keys': keys, 'complete': extra_ok, 'authz': authz, 'extra': extra}


def pairing_approved(profile_home):
    """Slack user IDs approved through Hermes pairing for this profile
    (platforms/pairing/slack-approved.json, or the older pairing/ folder)."""
    found = set()
    for sub in ('platforms/pairing', 'pairing'):
        path = Path(profile_home) / sub / 'slack-approved.json'
        try:
            data = json.loads(path.read_text(encoding='utf-8-sig'))
        except (OSError, ValueError):
            continue
        if isinstance(data, dict):
            found |= {k for k in data if isinstance(k, str)}
    return found


# ---- the one effective-access result --------------------------------------

def _when(epoch):
    return time.strftime('%Y-%m-%d %H:%M UTC', time.gmtime(epoch))


def _people(n):
    return f'{n} person' if n == 1 else f'{n} people'


def sync_view(record, now):
    """Member-list health, a separate line from who can talk to the bot."""
    record = record or {}
    if mode_of(record.get('access')) != 'members':
        return {'ok_at': None, 'error': None, 'stale': False, 'text': ''}
    ok_at = record.get('synced_at') if type(record.get('synced_at')) is int else None
    error = record.get('sync_error') if isinstance(record.get('sync_error'), str) else None
    stale = is_stale(record, now)
    if stale:
        text = f'Member list stale since {_when(ok_at)}' if ok_at else 'Member list never read'
    else:
        text = f'Member list read {_when(ok_at)}'
    text += f': {error}.' if error else '.'
    wait = record.get('retry_after')
    if type(wait) is int and wait > now:
        text += f' Slack asked to wait; next try after {_when(wait)}.'
    elif error or stale:
        text += ' The relay retries every 15 minutes.'
    return {'ok_at': ok_at, 'error': error, 'stale': stale, 'text': text}


def effective_access(scope, pairing_ids, record, now=None, team_name='the workspace'):
    """Who Hermes lets talk to the bot, in one result. `scope` is gate_scope()'s
    output; `record` the app's apps.json record (its `profile`, `access`,
    `owner`). Returns {people, ids, open, chats, bots, grants, text, sync}:
    `ids` the people whose DMs Hermes admits (all of Slack when `open`),
    `chats` the channel IDs where anyone is admitted ("*" = every channel),
    `bots` whether bot and workflow posts are admitted."""
    now = time.time() if now is None else now
    record = record or {}
    keys = (scope or {}).get('keys') or {}
    authz = {**SLACK_AUTHZ, **((scope or {}).get('authz') or {})}
    extra = (scope or {}).get('extra') or {}
    home_env = next((v['source'] for v in keys.values() if v['source'].endswith('/.env')), '<profile home>/.env')
    profile = record.get('profile') or '<profile>'
    owner = owner_of(record)
    mode = mode_of(record.get('access'))

    def value(name):
        return (keys.get(name) or {}).get('value') or ''

    def source(name):
        return (keys.get(name) or {}).get('source') or home_env

    def how(name, what, where=None):
        where = where or source(name)
        if where == SOURCES[0]:
            return f'{what} is set by the administrator-managed env; change it there'
        if where == SOURCES[1]:
            return f"{what} comes from an external secret source; change it in that source (the bot's .env cannot override it)"
        if where == SOURCES[2]:
            return "set allow_all_users to false in the default profile's config.yaml"
        return f'remove {what} from {where}'

    grants, open_, reasons = [], False, []

    def opened(what, name):
        reasons.append(f'{what} in {source(name)}')
        return True
    # Grants Hermes checks before the human allowlist (_chat_scoped_grant):
    # a channel allowlist (env, then config.yaml) and allow_bots (env wins
    # over config.yaml). They let in people or bots the list does not name.
    chats, chat_reasons = set(), []
    for name, entry in ((authz['group_allowed_chats_env'], keys.get(authz['group_allowed_chats_env'] or '')),
                        ('group_allowed_chats', extra.get('group_allowed_chats'))):
        found = coerce_allow_set(entry['value']) if entry else set()
        if found:
            chats |= found
            chat_reasons.append(f"{name} in {entry['source']}")
            grants.append({'source': entry['source'], 'what': name, 'ids': None, 'chats': sorted(found),
                           'how_to_change': how(name, name, entry['source'])})
    # No allow_bots env declared: Hermes admits no bots (fails closed).
    bots_env, bots = authz['allow_bots_env'], None
    for name, entry in ((bots_env, keys.get(bots_env or '')), ('allow_bots', extra.get('allow_bots'))):
        if bots_env and entry and entry['value'].strip():
            mode_value = entry['value'].lower().strip()
            if mode_value in ('mentions', 'all'):
                bots = {'source': entry['source'], 'what': f'{name}={mode_value}', 'ids': None, 'bots': True,
                        'how_to_change': how(name, name, entry['source'])}
                grants.append(bots)
            break

    if _truthy(value('SLACK_ALLOW_ALL_USERS')):
        open_ = opened('SLACK_ALLOW_ALL_USERS=true', 'SLACK_ALLOW_ALL_USERS')
        grants.append({'source': source('SLACK_ALLOW_ALL_USERS'), 'what': 'SLACK_ALLOW_ALL_USERS=true', 'ids': None,
                       'how_to_change': how('SLACK_ALLOW_ALL_USERS', 'SLACK_ALLOW_ALL_USERS')})
    slack_raw, gateway_raw = _ids(value('SLACK_ALLOWED_USERS')), _ids(value('GATEWAY_ALLOWED_USERS'))
    slack_kit = source('SLACK_ALLOWED_USERS') == home_env
    if '*' in slack_raw:
        open_ = opened('SLACK_ALLOWED_USERS=*', 'SLACK_ALLOWED_USERS')
        grants.append({'source': source('SLACK_ALLOWED_USERS'), 'what': 'SLACK_ALLOWED_USERS=*', 'ids': None,
                       'how_to_change': (f"choose who can talk to it in this bot's Slack window (that replaces the *)"
                                         if slack_kit else how('SLACK_ALLOWED_USERS', 'the *'))})
    if '*' in gateway_raw:
        open_ = opened('GATEWAY_ALLOWED_USERS=*', 'GATEWAY_ALLOWED_USERS')
        grants.append({'source': source('GATEWAY_ALLOWED_USERS'), 'what': 'GATEWAY_ALLOWED_USERS=*', 'ids': None,
                       'how_to_change': how('GATEWAY_ALLOWED_USERS', 'the * in GATEWAY_ALLOWED_USERS') +
                       ' (it applies to every messaging platform of this bot)'})
    # Hermes reads "is an allowlist set" from the raw values: NOBODY counts.
    if not (value('SLACK_ALLOWED_USERS') or value('GATEWAY_ALLOWED_USERS')) and _truthy(value('GATEWAY_ALLOW_ALL_USERS')):
        open_ = opened('GATEWAY_ALLOW_ALL_USERS=true with no allowlist', 'GATEWAY_ALLOW_ALL_USERS')
        grants.append({'source': source('GATEWAY_ALLOW_ALL_USERS'), 'what': 'GATEWAY_ALLOW_ALL_USERS=true with no allowlist',
                       'ids': None, 'how_to_change': how('GATEWAY_ALLOW_ALL_USERS', 'GATEWAY_ALLOW_ALL_USERS')})

    base = sorted(slack_raw - {'*'})
    seen = set(base)
    added = []   # (count, label) for "plus N from X"
    if not slack_kit and base:
        # The kit writes only the bot's .env; a value from elsewhere wins over it.
        grants.append({'source': source('SLACK_ALLOWED_USERS'), 'what': 'SLACK_ALLOWED_USERS', 'ids': base,
                       'how_to_change': how('SLACK_ALLOWED_USERS', 'SLACK_ALLOWED_USERS')})
    gw = sorted(gateway_raw - {'*'} - seen)
    if gw:
        seen |= set(gw)
        added.append((len(gw), f"GATEWAY_ALLOWED_USERS ({source('GATEWAY_ALLOWED_USERS')})"))
        grants.append({'source': source('GATEWAY_ALLOWED_USERS'), 'what': 'GATEWAY_ALLOWED_USERS', 'ids': gw,
                       'how_to_change': how('GATEWAY_ALLOWED_USERS', 'these IDs from GATEWAY_ALLOWED_USERS') +
                       ' (it applies to every messaging platform of this bot)'})
    pair = sorted(set(pairing_ids or ()) - seen)
    if pair:
        seen |= set(pair)
        added.append((len(pair), 'Slack pairing approvals'))
        grants.append({'source': 'Hermes pairing store', 'what': 'Slack pairing approvals', 'ids': pair,
                       'how_to_change': f'hermes -p {profile} pairing revoke slack <member id>, for each of them'})
    ids = sorted(seen)
    people = len(ids)

    where = 'any channel it is in' if '*' in chats else 'channels ' + ', '.join(sorted(chats))
    why = '; '.join(chat_reasons)
    if open_:
        text = f"Anyone in Slack who can message this bot, including guests ({'; '.join(reasons)})."
    elif people == 0 and chats:
        text = f'Only people posting in {where} can talk to this bot ({why}).'
    elif people == 0:
        text = 'Nobody can talk to this bot in Slack.'
    elif people == 1 and ids == [owner] and not chats:
        text = 'Only you can talk to this bot.'
    else:
        n = len(base)
        if not base:
            what = ''
        elif not slack_kit:
            what = f"the {_people(n)} in SLACK_ALLOWED_USERS ({source('SLACK_ALLOWED_USERS')})"
        elif mode == 'members':
            what = f"the {n} full member{'s' if n != 1 else ''} of {team_name}"
        elif mode == 'owner' and base == [owner]:
            what = 'you'
        elif mode == 'list':
            what = f'the {_people(n)} you named'
        else:
            what = f'the {_people(n)} in SLACK_ALLOWED_USERS'
        parts = [what] if what else []
        parts += [f'{"plus " if parts or i else ""}{c} from {label}' for i, (c, label) in enumerate(added)]
        text = f'{_people(people)} can talk to this bot: ' + ', '.join(parts) + '.'
    if chats and people and not open_:
        text = text[:-1] + f', and anyone posting in {where} ({why}).'
    if bots:
        text += f" Bots and workflows are also let in ({bots['what']} in {bots['source']})."
    if not (scope or {}).get('complete', True):
        text += " (Hermes's own settings could not be read, so only the bot's .env was counted.)"
    return {'people': people, 'ids': ids, 'open': open_, 'chats': sorted(chats), 'bots': bool(bots), 'grants': grants,
            'text': text, 'sync': sync_view(record, now)}
