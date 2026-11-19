"""Write profile values from stdin; credentials never appear in arguments.

--notify <profile>      tell the multiplexed gateway the profile changed
--gate-scope <home>     print the profile's Slack gate keys (the four
                        allowlist keys and the pre-allowlist grant envs that
                        Hermes declares, and only those) with their sources,
                        plus config.yaml allow_bots / group_allowed_chats
"""
import json
import os
import sys

sys.path.insert(0, os.environ.get('HERMES_AGENT_DIR', os.path.expanduser('~/.hermes/hermes-agent')))

if len(sys.argv) == 3 and sys.argv[1] == '--notify':
    from hermes_cli.gateway_multiplex_served import notify_multiplexer_profiles_changed
    notify_multiplexer_profiles_changed(sys.argv[2])
elif len(sys.argv) == 3 and sys.argv[1] == '--gate-scope':
    # The shared logic lives in common/access.py: next to this file once
    # installed, in ../slack-connect in a clone of the kit.
    here = os.path.dirname(os.path.abspath(__file__))
    if not os.path.isdir(os.path.join(here, 'common')):
        sys.path.insert(0, os.path.join(os.path.dirname(here), 'slack-connect'))
    sys.path.insert(0, here)
    from common.access import gate_scope
    print(json.dumps(gate_scope(sys.argv[2])))
else:
    from hermes_cli.config import save_env_value
    values = json.load(sys.stdin)
    allowed = {'SLACK_BOT_TOKEN', 'SLACK_TEAM_ID', 'SLACK_TEAM_NAME', 'SLACK_ALLOWED_USERS'}
    if not isinstance(values, dict) or not set(values).issubset(allowed) or not all(isinstance(v, str) for v in values.values()):
        raise SystemExit(2)
    # A value is one .env line: refuse control characters (CR, LF, NUL, ...),
    # line separators and anything longer than a Slack value can be.
    if any(any(ord(c) < 32 or ord(c) == 127 or 0x80 <= ord(c) < 0xA0 or c in '  ' for c in v)
           for v in values.values()):
        raise SystemExit(2)
    # One Slack value is short; the member allowlist is a comma list of IDs
    # (a whole workspace), checked character by character, or exactly NOBODY.
    # Never empty: Hermes reads an empty allowlist as "no allowlist".
    import re
    for key, value in values.items():
        if key == 'SLACK_ALLOWED_USERS':
            if len(value) > 400000 or (value != 'NOBODY' and not re.fullmatch(r'[UW][A-Z0-9]{1,31}(,[UW][A-Z0-9]{1,31})*', value)):
                raise SystemExit(2)
        elif len(value) > 512:
            raise SystemExit(2)
    # save_env_value refuses a locked key (managed Hermes, an administrator-
    # pinned key) by printing and returning. Ask first, for every key, so a
    # refusal writes nothing and fails the write. Older Hermes lacks the check.
    try:
        from hermes_cli.config import require_env_writable
    except ImportError:
        require_env_writable = None
    if require_env_writable:
        for key in values:
            try:
                require_env_writable(key, 'set')
            except ValueError as exc:
                print(str(exc), file=sys.stderr)
                raise SystemExit(3)
    for key, value in values.items():
        save_env_value(key, value)
