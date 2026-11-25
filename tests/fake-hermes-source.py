#!/usr/bin/env python3
"""Write a fake Hermes Agent source tree for the offline doctor/installer tests.

  python3 tests/fake-hermes-source.py <dir> [--drop AREA:NAME ...] [--tag vX.Y.Z]

Every surface in scripts/hermes-surfaces.json (and the agent contracts) is written where
scripts/check-hermes-compat.py looks for it, so the check passes; each --drop leaves one
out, so the check reports it missing. A minimal .git (HEAD, packed-refs with the tag)
names the version. Nothing here is real Hermes code.
"""
import argparse
import json
import re
from pathlib import Path

ap = argparse.ArgumentParser()
ap.add_argument('dest', type=Path)
ap.add_argument('--drop', action='append', default=[])
ap.add_argument('--tag', default='v0.23.3')
args = ap.parse_args()
kit = Path(__file__).resolve().parent.parent
surfaces = json.loads((kit / 'scripts/hermes-surfaces.json').read_text())['surfaces']
drop = {tuple(d.split(':', 1)) for d in args.drop}


def names(area):
    return sorted(n for n in surfaces.get(area, {}) if (area, n) not in drop)


def write(rel, body):
    p = args.dest / rel
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(body)


desk = 'apps/desktop/src'
host_keys = ''.join(f'  {n}: 1,\n' for n in names('host'))
state_keys = ''.join(f'    {n}: 1,\n' for n in names('host.state'))
write(f'{desk}/sdk/index.ts', ''.join(f'export const {n} = 1\n' for n in names('sdk'))
      + 'export const host = {\n' + host_keys + '  state: {\n' + state_keys + '  },\n}\n')
write(f'{desk}/sdk/areas.ts', '\n')
write(f'{desk}/contrib/plugin.ts', 'export interface PluginContext {\n' + ''.join(f'  {n}: unknown\n' for n in names('ctx')) + '}\n')
write(f'{desk}/lib/icons.ts', ''.join(f'export const {n} = 1\n' for n in names('icons')))
dom = ''.join(f'// {n}\n' for n in names('dom') + names('dom.class'))
dom += ''.join(f'const s{i} = "{n}"\n' for i, n in enumerate(names('dom.slot')))
dom += ''.join(f"const g{i} = '{n}'\n" for i, n in enumerate(names('gateway')))
write(f'{desk}/app/surfaces.ts', dom)
write('apps/desktop/electron/preload.ts', 'const api = {\n' + ''.join(f'  {n}: () => 1,\n' for n in names('bridge')) + '}\n')
write('tui_gateway/contracts/methods.py', 'method("fake.placeholder")\n')
write('gateway/run.py', '\n')
routes = []
for i, path in enumerate(names('rest')):
    route = re.sub(r'\{\}+', '{x}', path.rstrip('/'))
    routes.append(f'@router.get("{route}")\ndef r{i}():\n    pass\n')
write('hermes_cli/web_routers/routes.py', ''.join(routes))
agent = {
    'register_tool': 'def register_tool(', 'register_hook': 'def register_hook(',
    'register_system_prompt_section': 'def register_system_prompt_section(',
    'pre_llm_call': 'pre_llm_call', 'pre_tool_call': 'pre_tool_call',
}
write('hermes_cli/plugins.py', ''.join(f'{tok}\n' for key, tok in agent.items() if ('agent', key) not in drop))
write('tools/bot_mode_probe.py', 'BOT_CHAT_TITLE = "Bot Chat"\n')
commit = 'c0ffee' + '0' * 34
write('.git/HEAD', 'ref: refs/heads/main\n')
write('.git/packed-refs', f'# pack-refs with: peeled fully-peeled sorted\n{commit} refs/heads/main\n{commit} refs/tags/{args.tag}\n')
print(args.dest)
