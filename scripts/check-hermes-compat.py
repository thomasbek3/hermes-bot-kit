#!/usr/bin/env python3
"""Source-contract smoke check of the kit's Hermes surfaces; does not replace a live Desktop test.

Reads a Hermes Agent checkout as text only (never imports or runs it) and checks that what
the two desktop plugins (grokbot-override/src, computer-viewer/plugin.js) and texting-style
use still exists there:

  sdk      names imported from / read off @hermes/plugin-sdk (sdk/index.ts, sdk/areas.ts)
  host     host.* and host.state.* members (the `export const host = {` object)
  ctx      plugin-context members (contrib/plugin.ts PluginContext)
  icons    SDK icons a plugin draws with no fallback (lib/icons.ts)
  gateway  RPC methods, server requests and event types: every gateway-shaped string the
           plugins use must appear as a quoted literal in upstream production source
  rest     REST routes (hermes_cli/web_routers)
  bridge   window.hermesDesktop members (apps/desktop/electron/preload.ts)
  dom      Hermes data-* attribute anchors, data-slot names, the .aui-md class
  agent    agent-plugin registration hooks (texting-style)

Checkout paths it needs: apps/desktop/src, apps/desktop/electron/preload.ts, tui_gateway,
gateway, hermes_cli/web_routers, hermes_cli/plugins*.py, tools/bot_mode_probe.py.
"""
import argparse
import re
from pathlib import Path

parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
parser.add_argument('hermes_source', type=Path, help='Hermes Agent checkout')
args = parser.parse_args()
kit = Path(__file__).resolve().parent.parent
up = args.hermes_source
errors = []


def text(path):
    try:
        return path.read_text(encoding='utf-8', errors='replace')
    except FileNotFoundError:
        raise SystemExit(f'upstream path missing: {path.relative_to(up)} (add it to the checkout)')


def production(root, suffixes):
    if not root.is_dir():
        raise SystemExit(f'upstream path missing: {root.relative_to(up)} (add it to the checkout)')
    return '\n'.join(text(p) for p in sorted(root.rglob('*'))
                     if p.suffix in suffixes and p.is_file()
                     and '.test.' not in p.name and '.spec.' not in p.name
                     and 'tests' not in p.relative_to(root).parts and not p.name.startswith('test_'))


# ── the kit ──────────────────────────────────────────────────────────────
gbo_src = kit / 'grokbot-override/src'
gbo = {p.relative_to(kit).as_posix(): text(p) for p in sorted(gbo_src.rglob('*')) if p.suffix in {'.ts', '.tsx', '.js'}}
cv = text(kit / 'computer-viewer/plugin.js')
gbo_all = '\n'.join(gbo.values())
kit_all = gbo_all + '\n' + cv

# ── upstream ─────────────────────────────────────────────────────────────
desk = up / 'apps/desktop/src'
sdk_index = text(desk / 'sdk/index.ts')
sdk_text = sdk_index + '\n' + text(desk / 'sdk/areas.ts')
desk_prod = production(desk, {'.ts', '.tsx', '.css'})
py_prod = production(up / 'tui_gateway', {'.py'}) + '\n' + production(up / 'gateway', {'.py'})


def report(area, missing, checked):
    for item in sorted(missing):
        errors.append(f'{area}: missing upstream: {item}')
    counts.append(f'{area} {len(checked)}')


counts = []

# sdk: names exported by the SDK barrel.
exported = set(re.findall(r'export\s+(?:declare\s+)?(?:const|let|function|async\s+function|class)\s+(\w+)', sdk_text))
exported |= set(re.findall(r'export\s+\*\s+as\s+(\w+)', sdk_text))
for block in re.findall(r'export\s+(?:type\s+)?\{([^}]*)\}', sdk_text, re.S):
    for item in block.split(','):
        item = re.sub(r'^\s*type\s+', '', item).strip()
        if item:
            exported.add(item.split(' as ')[-1].strip())
# Read off the namespace and feature-detected at the call site, absent upstream so far.
OPTIONAL_SDK = {'createPortal'}
used_sdk = set(re.findall(r'\(sdk as any\)\.(\w+)', gbo_all))
for block in re.findall(r'import\s*\{([^}]+)\}\s*from\s*[\'"]@hermes/plugin-sdk[\'"]', cv):
    used_sdk |= {s.strip().split(' as ')[0] for s in block.split(',') if s.strip()}
used_sdk |= set(re.findall(r'HermesSdk\.(\w+)', cv))
report('sdk', used_sdk - exported - OPTIONAL_SDK, used_sdk)

# host / host.state: keys of `export const host = {`.
m = re.search(r'^export const host = \{\n(.*?)^\}', sdk_index, re.S | re.M)
host_block = m.group(1) if m else ''
host_keys = set(re.findall(r'^  (?:async\s+)?(\w+)\s*[:(,]', host_block, re.M))
s = re.search(r'^  state: \{\n(.*?)^  \}', host_block, re.S | re.M)
state_keys = set(re.findall(r'^    (\w+)\s*[:(,]', s.group(1), re.M)) if s else set()
# `host` is also a URL hostname string in a few helpers.
STRING_MEMBERS = {'endsWith', 'includes', 'slice', 'split', 'startsWith', 'length', 'toLowerCase', 'replace', 'is'}
used_host = set(re.findall(r'\bhost\??\.(\w+)', kit_all)) - STRING_MEMBERS
report('host', used_host - host_keys, used_host)
used_state = set(re.findall(r'\bhost\??\.state\??\.(\w+)', kit_all))
report('host.state', used_state - state_keys, used_state)

# ctx: PluginContext members.
m = re.search(r'^export interface PluginContext \{\n(.*?)^\}', text(desk / 'contrib/plugin.ts'), re.S | re.M)
ctx_keys = set(re.findall(r'^  (\w+)\??\s*[:(]', m.group(1), re.M)) if m else set()
# `ctx` is also a canvas 2D context, and `__gboSmoke` is the kit's own test seam.
NOT_PLUGIN_CTX = {'drawImage', 'getImageData', 'putImageData', 'imageSmoothingQuality', 'imageSmoothingEnabled', 'fillRect', 'clearRect', '__gboSmoke'}
used_ctx = set(re.findall(r'\bctx\??\.(\w+)', kit_all)) - NOT_PLUGIN_CTX
report('ctx', used_ctx - ctx_keys, used_ctx)

# icons: an icon drawn without an `|| icons.Other` / SVG fallback must exist.
icon_names = set(re.findall(r'\b(\w+)\b', text(desk / 'lib/icons.ts')))
bare = {name for name, alt in re.findall(r'icons\.(\w+)(\s*\|\|)?', cv) if not alt}
alts = set(re.findall(r'\|\|\s*icons\.(\w+)', cv))
report('icons', (bare - alts) - icon_names, bare - alts)

# gateway: method / server-request / event names (quoted literals in the namespaces upstream
# declares). The kit's own strings that share a namespace are listed here.
KIT_STRINGS = {
    'image.png',                                            # a file name
    'agent.reasoning_effort', 'agent.service_tier',          # config.yaml keys
    'message.channels', 'message.groups', 'message.im',      # Slack event subscriptions
    'message.mpim', 'message.member', 'message.user',
}
contracts = production(up / 'tui_gateway/contracts', {'.py'})
declared = set(re.findall(r'^(?:method|event|server_request|canonical_method)\(\s*"([a-z_.]+)"', contracts, re.M))
namespaces = {name.split('.')[0] for name in declared}
literal = r'[\'"]([a-z_]+(?:\.[a-z_]+)+)[\'"]'  # backticked names are prose in comments
upstream_literals = set(re.findall(literal, py_prod + '\n' + desk_prod))
used_gateway = {n for n in re.findall(literal, kit_all) if n.split('.')[0] in namespaces} - KIT_STRINGS
report('gateway', used_gateway - upstream_literals, used_gateway)

# rest: dashboard routes the plugins call (the kit's own /api/plugins/* routes excluded).
routes = set()
for p in sorted((up / 'hermes_cli/web_routers').glob('*.py')):
    routes |= {re.sub(r'\{[^}]*\}', '{}', r) for r in
               re.findall(r'@\w+\.(?:get|post|put|patch|delete|websocket)\(\s*"(/api/[^"]+)"', text(p))}
used_rest = set()
for raw in re.findall(r'(?<![\w.-])(/api/[A-Za-z0-9_./{}\-]+)', re.sub(r'\$\{[^}]*\}', '{}', kit_all)):
    path = re.sub(r'\{[^}]*\}', '{}', raw).rstrip('.')
    if not path.startswith('/api/plugins/') and path.rstrip('/') != '/api' and not re.search(r'\.(ts|tsx|js|py)$', path):
        used_rest.add(path)


def route_ok(path):
    # Segment by segment; `{}` on either side is any one segment. A path ending in `/` (or in a
    # `{}{}` join) is a prefix the code completes at run time.
    want = path.rstrip('/').split('/')
    prefix = path.endswith('/') or '{}{}' in path
    want = [seg if '{}' not in seg else '{}' for seg in want]
    for route in routes:
        have = route.split('/')
        if len(have) < len(want) or (len(have) > len(want) and not prefix):
            continue
        if all(a == b or '{}' in (a, b) for a, b in zip(want, have)):
            return True
    return False


report('rest', {p for p in used_rest if not route_ok(p)}, used_rest)

# bridge: window.hermesDesktop members.
preload = set(re.findall(r'^\s+(\w+)\s*:', text(up / 'apps/desktop/electron/preload.ts'), re.M))
used_bridge = set(re.findall(r'hermesDesktop\??\.(\w+)', kit_all))
used_bridge |= set(re.findall(r'\b(?:desktop|bridge)\??\.(\w+)', kit_all))
used_bridge |= set(re.findall(r"kind: 'bridge', target: '(\w+)'", gbo_all))
report('bridge', used_bridge - preload, used_bridge)

# dom: data-* attributes the plugins select on but never set themselves.
selected = set(re.findall(r'\[(data-[a-z-]+)', kit_all))
self_set = set(re.findall(r'(?<![\[\w-])[\'"]?(data-[a-z-]+)[\'"]?\s*(?:=\{|:\s)', kit_all))
self_set |= set(re.findall(r'(?<![\[\w-])(data-[a-z-]+)="', kit_all))
self_set |= set(re.findall(r'setAttribute\(\s*[\'"](data-[a-z-]+)', kit_all))
self_set |= {'data-' + re.sub(r'([A-Z])', lambda c: '-' + c.group(1).lower(), k) for k in re.findall(r'\bdataset\.(\w+)', kit_all)}
anchors = {a for a in selected - self_set if not a.startswith(('data-gbo', 'data-cv'))}
report('dom', {a for a in anchors if a not in desk_prod}, anchors)
slots = set(re.findall(r'data-slot=\\?["\x27]([\w-]+)', kit_all))
report('dom.slot', {s for s in slots if f'"{s}"' not in desk_prod and f"'{s}'" not in desk_prod}, slots)
report('dom.class', set() if 'aui-md' in desk_prod else {'aui-md'}, {'aui-md'})

# agent: texting-style's registration hooks, and Bot Mode's chat title.
for relative, tokens in {
    'hermes_cli/plugins.py': ('def register_tool(', 'def register_hook(', 'def register_system_prompt_section(', 'pre_llm_call', 'pre_tool_call'),
    'tools/bot_mode_probe.py': ('BOT_CHAT_TITLE = "Bot Chat"',),
}.items():
    content = text(up / relative)
    if relative == 'hermes_cli/plugins.py':
        # Newer Hermes splits PluginContext out while retaining the public facade.
        content += '\n'.join(text(p) for p in (up / 'hermes_cli').glob('plugins_*.py'))
    for token in tokens:
        if token not in content:
            errors.append(f'agent: missing contract in {relative}: {token}')
counts.append('agent 6')

if errors:
    raise SystemExit('\n'.join(errors))
print(f'Hermes source contracts OK ({", ".join(counts)} names checked).')
print('This checks source presence, not signatures, rendering, routing, or live model calls.')
