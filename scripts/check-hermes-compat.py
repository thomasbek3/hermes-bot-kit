#!/usr/bin/env python3
"""Source-contract smoke check; does not replace a live Desktop test."""
import argparse
import re
from pathlib import Path

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('hermes_source', type=Path, help='Hermes Agent checkout')
args = parser.parse_args()
kit = Path(__file__).resolve().parent.parent
upstream = args.hermes_source
src = upstream / 'apps/desktop/src'
sdk = (src / 'sdk/index.ts').read_text()
areas = (src / 'sdk/areas.ts').read_text()
production = '\n'.join(p.read_text() for p in src.rglob('*')
                       if p.suffix in {'.ts', '.tsx', '.css'}
                       and '.test.' not in p.name and '.spec.' not in p.name)
errors = []
for name in ('computer-viewer',):
    plugin = (kit / name / 'plugin.js').read_text()
    for block in re.findall(r'import\s*\{([^}]+)\}\s*from [\'"]@hermes/plugin-sdk[\'"]', plugin):
        for symbol in block.split(','):
            symbol = symbol.strip().split(' as ')[0]
            if symbol and not re.search(r'\b' + re.escape(symbol) + r'\b', sdk + areas):
                errors.append(f'{name}: SDK symbol missing: {symbol}')
    for slot in sorted(set(re.findall(r'data-slot=["\x27]([\w-]+)["\x27]', plugin))):
        if slot not in production:
            errors.append(f'{name}: upstream DOM slot missing: {slot}')
for relative, tokens in {
    'hermes_cli/plugins.py': ('def register_tool(', 'def register_hook(', 'def register_system_prompt_section(', 'pre_llm_call', 'pre_tool_call'),
    'tools/bot_mode_probe.py': ('BOT_CHAT_TITLE = "Bot Chat"',),
    'apps/desktop/src/sdk/index.ts': ('focusedSessionProfile', 'paneVisibility', 'profile:', 'viewport:'),
}.items():
    content = (upstream / relative).read_text()
    if relative == 'hermes_cli/plugins.py':
        # Newer Hermes splits PluginContext out while retaining the public facade.
        content += '\n'.join(p.read_text() for p in (upstream / 'hermes_cli').glob('plugins_*.py'))
    for token in tokens:
        if token not in content:
            errors.append(f'{relative}: missing contract: {token}')
if errors:
    raise SystemExit('\n'.join(errors))
print('Hermes source contracts OK (SDK names, DOM slot names, agent registration hooks).')
print('This checks source presence, not signatures, rendering, routing, or live model calls.')
