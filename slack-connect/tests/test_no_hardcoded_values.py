"""Shipped Slack files must not carry one machine's host names, addresses, users or workspace."""
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
SHIPPED = ('slack-connect', 'slack-relay', 'slack-http', 'slack-check', 'grokbot-override/src')
SHIPPED_FILES = ('grokbot-override/plugin.js',)
# Assembled at runtime so this file does not match itself.
FORBIDDEN = ('tail' + '0d5eb6', '100.86' + '.195.9', '/Users/' + 'thomas', 'com.' + 'thomas',
             'T01H5' + 'UWT0L8', 'slackhttp' + 'test', 'ai-mac' + '-mini')


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
        text = path.read_bytes().decode('utf-8', 'replace').lower()
        hits += [f'{path.relative_to(REPO)}: {value}' for value in FORBIDDEN if value.lower() in text]
    assert hits == []
