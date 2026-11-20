"""A test subprocess whose environment is replaced must get a throwaway HOME.

Without HOME, Python's expanduser falls back to the password database, i.e.
the real home of whoever runs the tests (and ~/.hermes with it). Every dict
literal handed to a subprocess as `env` (or assigned to a name `env`) in these
suites either extends os.environ (`{**os.environ, ...}`) or sets HOME and
USERPROFILE itself.
"""
import ast
from pathlib import Path

KIT = Path(__file__).resolve().parents[2]
SUITES = ('slack-connect/tests', 'slack-check/tests', 'remote-cua/tests')


def env_literals(tree):
    for node in ast.walk(tree):
        if isinstance(node, ast.Call):
            yield from (k.value for k in node.keywords if k.arg == 'env' and isinstance(k.value, ast.Dict))
        elif isinstance(node, ast.Assign) and isinstance(node.value, ast.Dict):
            if any(isinstance(t, ast.Name) and t.id == 'env' for t in node.targets):
                yield node.value


def test_every_replaced_subprocess_env_sets_a_temp_home():
    bad, seen = [], 0
    for suite in SUITES:
        for path in sorted((KIT / suite).glob('*.py')):
            for literal in env_literals(ast.parse(path.read_text(encoding='utf-8'))):
                seen += 1
                if None in literal.keys:   # {**os.environ, ...} keeps the caller's HOME
                    continue
                names = {k.value for k in literal.keys if isinstance(k, ast.Constant)}
                if not {'HOME', 'USERPROFILE'} <= names:
                    bad.append(f'{path.relative_to(KIT)}:{literal.lineno}')
    assert seen, 'the scan found no env literals at all'
    assert bad == [], 'subprocess env without HOME and USERPROFILE: ' + ', '.join(bad)
