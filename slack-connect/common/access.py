"""Who may talk to a Slack-connected bot: the chosen audience and the effective one.

The kit's default is the workspace's full members: everyone who is not a guest
(single- or multi-channel), not a Slack Connect (external org) user, not a bot
and not deactivated. Hermes has no native "members only" switch:
SLACK_ALLOW_ALL_USERS admits guests too (Hermes refuses only external-org DMs).
So the kit writes the member list into SLACK_ALLOWED_USERS and the relay keeps it
in step with the workspace. "owner" (only the installer) and "list" (named
member IDs) are the explicit restrictions.

Effective access is what Hermes actually honours for the profile
(gateway/authz_mixin.py _principal_authorized): SLACK_ALLOW_ALL_USERS, the
union of SLACK_ALLOWED_USERS and GATEWAY_ALLOWED_USERS ("*" = everyone), the
profile's Slack pairing approvals, and GATEWAY_ALLOW_ALL_USERS when no
allowlist is set. Anything that admits more than the chosen audience is an
extra grant and is named, never hidden.
"""
import json
import re
from pathlib import Path

MODES = ('members', 'owner', 'list')
DEFAULT_MODE = 'members'
USER_ID = re.compile(r'^[UW][A-Z0-9]{1,31}$')
TRUTHY = {'true', '1', 'yes'}
# A workspace this size keeps SLACK_ALLOWED_USERS a single sane .env line.
MAX_MEMBERS = 20000


def mode_of(value):
    value = str(value or '').strip().lower()
    return value if value in MODES else DEFAULT_MODE


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
    return sorted(ids)


def chosen_ids(mode, owner, members=(), named=()):
    """The SLACK_ALLOWED_USERS the chosen audience needs. The installer is
    always included so they can reach their own bot."""
    mode = mode_of(mode)
    ids = set()
    if owner:
        ids.add(owner)
    if mode == 'members':
        ids |= set(members)
    elif mode == 'list':
        ids |= set(named)
    return sorted(ids)


def _ids(value):
    return {x.strip() for x in str(value or '').split(',') if x.strip()}


def _truthy(value):
    return str(value or '').strip().lower() in TRUTHY


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


def effective(env, pairing=(), gateway_env=None):
    """Who Hermes lets talk to the bot, from the profile's settings.

    `env` is the profile's .env; `gateway_env` the values the gateway may also
    see from elsewhere (the root .env, config.yaml's allow_all_users)."""
    other = gateway_env or {}
    slack_ids = _ids(env.get('SLACK_ALLOWED_USERS'))
    gateway_ids = _ids(env.get('GATEWAY_ALLOWED_USERS')) | _ids(other.get('GATEWAY_ALLOWED_USERS'))
    any_list = bool(slack_ids or gateway_ids)
    open_reasons = []
    if _truthy(env.get('SLACK_ALLOW_ALL_USERS')) or _truthy(other.get('SLACK_ALLOW_ALL_USERS')):
        open_reasons.append('SLACK_ALLOW_ALL_USERS=true')
    if '*' in slack_ids:
        open_reasons.append('SLACK_ALLOWED_USERS contains *')
    if '*' in gateway_ids:
        open_reasons.append('GATEWAY_ALLOWED_USERS contains *')
    if not any_list and (_truthy(env.get('GATEWAY_ALLOW_ALL_USERS')) or _truthy(other.get('GATEWAY_ALLOW_ALL_USERS'))):
        open_reasons.append('GATEWAY_ALLOW_ALL_USERS=true with no allowlist')
    return {
        'open': bool(open_reasons),
        'open_reasons': open_reasons,
        'slack_allowed': sorted(slack_ids - {'*'}),
        'gateway_allowed': sorted(gateway_ids - {'*'}),
        'pairing': sorted(set(pairing)),
        'ids': sorted((slack_ids | gateway_ids | set(pairing)) - {'*'}),
    }


def extra_grants(chosen, eff, profile='<profile>'):
    """Grants that admit more people than the chosen audience, each with how
    to remove it. `fixable` ones the kit can remove from the profile itself."""
    chosen = set(chosen)
    extras = []
    for reason in eff['open_reasons']:
        key = reason.split('=')[0].split(' ')[0]
        extras.append({
            'grant': reason,
            'who': 'anyone who can message the bot, including guests',
            'fixable': key in ('SLACK_ALLOW_ALL_USERS', 'SLACK_ALLOWED_USERS'),
            'how': f"remove {key} from this bot's .env" if key != 'GATEWAY_ALLOWED_USERS' else
                   'remove * from GATEWAY_ALLOWED_USERS (it applies to every messaging platform of this bot)',
        })
    gw_extra = sorted(set(eff['gateway_allowed']) - chosen)
    if gw_extra:
        extras.append({'grant': 'GATEWAY_ALLOWED_USERS', 'who': ', '.join(gw_extra), 'ids': gw_extra, 'fixable': False,
                       'how': 'edit GATEWAY_ALLOWED_USERS (it applies to every messaging platform of this bot)'})
    pair_extra = sorted(set(eff['pairing']) - chosen)
    if pair_extra:
        extras.append({'grant': 'pairing approvals', 'who': ', '.join(pair_extra), 'ids': pair_extra, 'fixable': True,
                       'how': f'hermes -p {profile} pairing revoke slack <member id>'})
    return extras


def describe(mode, chosen, eff, team_name='the workspace'):
    """One honest sentence about who can talk to the bot."""
    mode = mode_of(mode)
    if eff['open']:
        return ('Anyone who can message the bot in Slack can talk to it, including guests '
                '(' + '; '.join(eff['open_reasons']) + ').')
    count = len(eff['ids'])
    extra = len(set(eff['ids']) - set(chosen))
    base = {
        'members': f'Full members of {team_name} ({len(chosen)} people; not guests or Slack Connect users)',
        'owner': 'Only you',
        'list': f'The {len(chosen)} people you named',
    }[mode]
    if extra:
        return f'{base}, plus {extra} more allowed by other settings ({count} people in all).'
    return base + '.'
