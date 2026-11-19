"""Shipped Slack files must not carry one machine's host names, addresses, users or workspace.

The forbidden words are stored as hashes (same scheme as tests/privacy-guard.test.mjs:
lowercase runs of a-z0-9, every run of one to three words, sha256, first 20 hex), so this
file never spells them. Tailnet addresses and home folders are checked by pattern.
"""
import hashlib
import re
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
SHIPPED = ('slack-connect', 'slack-relay', 'slack-http', 'slack-check', 'grokbot-override/src')
SHIPPED_FILES = ('grokbot-override/plugin.js',)
FORBIDDEN_HASHES = frozenset({
    'dd5a575848579835c0b3', '335a5e95e9a849cbd08b', 'a3587249db361ec4b575',
    '4f7cc4847130c6e7896e', '97d56ced0b40767d75cc',
})
MAX_WORDS = 3
# Tailscale's 100.64.0.0/10 range: only the 100.64.0.x documentation examples.
TAILNET_IP = re.compile(r'(?<![\d.])100\.(?:6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.\d{1,3}\.\d{1,3}(?!\d)')
HOME_DIR = re.compile(r'/(?:Users|home)/([A-Za-z0-9._-]+)')
HOME_OK = {'you', 'me', 'user', 'username', 'example', 'runner', 'name', 'cache'}


def _hash(text):
    return hashlib.sha256(text.encode()).hexdigest()[:20]


def scan(text):
    """Kinds of private value found in `text` (never the value itself)."""
    hits = []
    words = re.split(r'[^a-z0-9]+', text.lower())
    words = [w for w in words if w]
    for i in range(len(words)):
        for n in range(1, MAX_WORDS + 1):
            if i + n <= len(words) and _hash(' '.join(words[i:i + n])) in FORBIDDEN_HASHES:
                hits.append('private word')
    hits += ['tailnet address' for m in TAILNET_IP.finditer(text) if not m.group(0).startswith('100.64.0.')]
    hits += ['home folder' for m in HOME_DIR.finditer(text) if m.group(1).lower() not in HOME_OK]
    return hits


def shipped_files():
    for top in SHIPPED:
        for path in (REPO / top).rglob('*'):
            parts = set(path.relative_to(REPO).parts)
            if path.is_file() and not parts & {'tests', 'test', 'node_modules', '__pycache__', '.pytest_cache'}:
                yield path
    for name in SHIPPED_FILES:
        yield REPO / name


def test_shipped_files_have_no_machine_specific_values():
    hits = []
    files = list(shipped_files())
    assert len(files) > 20
    for path in files:
        text = path.read_bytes().decode('utf-8', 'replace')
        hits += [f'{path.relative_to(REPO)}: {kind}' for kind in scan(text)]
    assert hits == []


def test_scan_catches_each_kind():
    planted = '\n'.join([
        'host ' + '.'.join(['100', '100', '1', '2']),
        'path ' + '/Us' + 'ers/' + 'somebody/x',
    ])
    assert scan(planted) == ['tailnet address', 'home folder']
    assert scan('/Users/you/x 100.64.0.9') == []
