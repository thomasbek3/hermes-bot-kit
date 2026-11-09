"""Shared, owner-only Slack ingress configuration.

One file, ``$HERMES_HOME/slack-connect/config.json``, written by the installer
and read by the relay, the dashboard plugin and its status route::

    {"public_url": "https://your-host.example.ts.net/slack",
     "gateway_url": "http://127.0.0.1:8642",
     "relay_bind": "127.0.0.1", "relay_port": 8655}

``public_url`` may be empty while no public address is configured.
"""
import ipaddress
import json
import os
import stat
from pathlib import Path
from urllib.parse import urlsplit

DEFAULT_PORT = 8655


def config_path(root):
    return Path(root) / 'slack-connect' / 'config.json'


def normalize_public_url(value):
    """Return ``https://host[:port]/slack`` or '' for an empty value."""
    if not value:
        return ''
    parts = urlsplit(str(value).strip())
    if (parts.scheme != 'https' or not parts.hostname or parts.username or parts.password
            or parts.query or parts.fragment or parts.path.rstrip('/') not in ('', '/slack')):
        raise ValueError('public URL must be https://host or https://host/slack')
    return 'https://' + parts.netloc + '/slack'


def validate(data):
    if not isinstance(data, dict):
        raise ValueError('invalid Slack config')
    public = data.get('public_url') or ''
    if public and normalize_public_url(public) != public.rstrip('/'):
        raise ValueError('public_url must be an HTTPS /slack URL')
    gateway = urlsplit(str(data.get('gateway_url') or ''))
    if (gateway.scheme != 'http' or not gateway.hostname or gateway.username or gateway.password
            or gateway.query or gateway.fragment or gateway.path not in ('', '/') or not gateway.port):
        raise ValueError('gateway_url must be an HTTP listener URL with a port')
    bind = data.get('relay_bind')
    try:
        if not ipaddress.ip_address(bind).is_loopback:
            raise ValueError
    except (ValueError, TypeError):
        raise ValueError('relay_bind must be a loopback address') from None
    port = data.get('relay_port')
    if type(port) is not int or not 1 <= port <= 65535:
        raise ValueError('invalid relay port')
    return {'public_url': public.rstrip('/'), 'gateway_url': gateway.geturl().rstrip('/'),
            'relay_bind': bind, 'relay_port': port}


def load_config(root):
    """Read and validate the config; refuse symlinks and group/world access."""
    path = config_path(root)
    fd = os.open(path, os.O_RDONLY | getattr(os, 'O_NOFOLLOW', 0))
    with os.fdopen(fd, 'rb') as handle:
        info = os.fstat(handle.fileno())
        if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or info.st_mode & 0o077:
            raise ValueError('Slack config must be an owner-only regular file')
        data = json.loads(handle.read(65536).decode())
    return validate(data)


def write_config(root, data):
    """Atomically write a validated config with mode 600 in a 700 directory."""
    clean = validate(data)
    path = config_path(root)
    path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    tmp = path.with_name('.config.json.tmp')
    if tmp.is_symlink():
        tmp.unlink()
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC | getattr(os, 'O_NOFOLLOW', 0), 0o600)
    with os.fdopen(fd, 'w') as out:
        json.dump(clean, out, indent=2, sort_keys=True)
        out.write('\n')
        out.flush()
        os.fsync(out.fileno())
    os.chmod(tmp, 0o600)
    os.replace(tmp, path)
    return clean
