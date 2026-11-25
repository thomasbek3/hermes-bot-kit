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

What the kit uses is read from the kit's sources, or (--surfaces) from
scripts/hermes-surfaces.json, the same list written ahead of time by --write-surfaces, so
the doctor and the installer can check a person's own Hermes without the kit's sources.
--doctor prints machine-readable lines for them (VERSION, OK, MISSING, INCOMPLETE) and
always exits 0 on a finished check. Runs on Python 3.8 and newer (macOS /usr/bin/python3 is
3.9).
"""
import argparse
import json
import re
import sys
from pathlib import Path

GBO = 'Grokbot Override'
CV = 'Computer viewer'
TS = 'texting-style'

# The agent contracts: (file, token, kit parts that rely on it).
AGENT_CONTRACTS = [
    ('hermes_cli/plugins.py', 'def register_tool(', [TS]),
    ('hermes_cli/plugins.py', 'def register_hook(', [TS]),
    ('hermes_cli/plugins.py', 'def register_system_prompt_section(', [TS]),
    ('hermes_cli/plugins.py', 'pre_llm_call', [TS]),
    ('hermes_cli/plugins.py', 'pre_tool_call', [TS]),
    ('tools/bot_mode_probe.py', 'BOT_CHAT_TITLE = "Bot Chat"', [GBO, TS]),
]
AREAS = ['sdk', 'host', 'host.state', 'ctx', 'icons', 'gateway', 'rest', 'bridge', 'dom', 'dom.slot', 'dom.class']

# Read off the namespace and feature-detected at the call site, absent upstream so far.
OPTIONAL_SDK = {'createPortal'}
# `host` is also a URL hostname string in a few helpers.
STRING_MEMBERS = {'endsWith', 'includes', 'slice', 'split', 'startsWith', 'length', 'toLowerCase', 'replace', 'is'}
# `ctx` is also a canvas 2D context, and `__gboSmoke` is the kit's own test seam.
NOT_PLUGIN_CTX = {'drawImage', 'getImageData', 'putImageData', 'imageSmoothingQuality', 'imageSmoothingEnabled', 'fillRect', 'clearRect', '__gboSmoke'}
# The kit's own strings that share a gateway namespace.
KIT_STRINGS = {
    'image.png',                                            # a file name
    'agent.reasoning_effort', 'agent.service_tier',          # config.yaml keys
    'message.channels', 'message.groups', 'message.im',      # Slack event subscriptions
    'message.mpim', 'message.member', 'message.user',
}
LITERAL = r'[\'"]([a-z_]+(?:\.[a-z_]+)+)[\'"]'  # backticked names are prose in comments


class Missing(Exception):
    """An upstream path the check needs is not in the checkout."""


def read(path, root=None):
    try:
        return path.read_text(encoding='utf-8', errors='replace')
    except FileNotFoundError:
        raise Missing(str(path.relative_to(root)) if root else str(path))


# ── what the kit uses ────────────────────────────────────────────────────
def extract(gbo_all, cv, kit_all, namespaces):
    """Every surface one part of the kit uses: {area: set of names}.

    gbo_all / cv are the part's own text ('' for the other part); kit_all is all of the kit
    (data-* attributes the kit sets itself are never Hermes anchors, whichever part sets them).
    """
    both = gbo_all + '\n' + cv
    used = {}
    sdk = set(re.findall(r'\(sdk as any\)\.(\w+)', gbo_all))
    for block in re.findall(r'import\s*\{([^}]+)\}\s*from\s*[\'"]@hermes/plugin-sdk[\'"]', cv):
        sdk |= {s.strip().split(' as ')[0] for s in block.split(',') if s.strip()}
    sdk |= set(re.findall(r'HermesSdk\.(\w+)', cv))
    used['sdk'] = sdk
    used['host'] = set(re.findall(r'\bhost\??\.(\w+)', both)) - STRING_MEMBERS
    used['host.state'] = set(re.findall(r'\bhost\??\.state\??\.(\w+)', both))
    used['ctx'] = set(re.findall(r'\bctx\??\.(\w+)', both)) - NOT_PLUGIN_CTX
    bare = {name for name, alt in re.findall(r'icons\.(\w+)(\s*\|\|)?', cv) if not alt}
    alts = set(re.findall(r'\|\|\s*icons\.(\w+)', cv))
    used['icons'] = bare - alts
    used['gateway'] = {n for n in re.findall(LITERAL, both) if n.split('.')[0] in namespaces} - KIT_STRINGS
    rest = set()
    for raw in re.findall(r'(?<![\w.-])(/api/[A-Za-z0-9_./{}\-]+)', re.sub(r'\$\{[^}]*\}', '{}', both)):
        path = re.sub(r'\{[^}]*\}', '{}', raw).rstrip('.')
        if not path.startswith('/api/plugins/') and path.rstrip('/') != '/api' and not re.search(r'\.(ts|tsx|js|py)$', path):
            rest.add(path)
    used['rest'] = rest
    bridge = set(re.findall(r'hermesDesktop\??\.(\w+)', both))
    bridge |= set(re.findall(r'\b(?:desktop|bridge)\??\.(\w+)', both))
    bridge |= set(re.findall(r"kind: 'bridge', target: '(\w+)'", gbo_all))
    used['bridge'] = bridge
    selected = set(re.findall(r'\[(data-[a-z-]+)', both))
    self_set = set(re.findall(r'(?<![\[\w-])[\'"]?(data-[a-z-]+)[\'"]?\s*(?:=\{|:\s)', kit_all))
    self_set |= set(re.findall(r'(?<![\[\w-])(data-[a-z-]+)="', kit_all))
    self_set |= set(re.findall(r'setAttribute\(\s*[\'"](data-[a-z-]+)', kit_all))
    self_set |= {'data-' + re.sub(r'([A-Z])', lambda c: '-' + c.group(1).lower(), k) for k in re.findall(r'\bdataset\.(\w+)', kit_all)}
    used['dom'] = {a for a in selected - self_set if not a.startswith(('data-gbo', 'data-cv'))}
    used['dom.slot'] = set(re.findall(r'data-slot=\\?["\x27]([\w-]+)', both))
    used['dom.class'] = {'aui-md'} if 'aui-md' in both else set()
    return used


def kit_surfaces(kit, namespaces):
    """{area: {name: [kit parts]}} from the kit's own sources."""
    def text(p):
        return p.read_text(encoding='utf-8', errors='replace')
    gbo_src = kit / 'grokbot-override/src'
    gbo_all = '\n'.join(text(p) for p in sorted(gbo_src.rglob('*')) if p.suffix in {'.ts', '.tsx', '.js'})
    cv = text(kit / 'computer-viewer/plugin.js')
    kit_all = gbo_all + '\n' + cv
    out = {area: {} for area in AREAS}
    for part, used in ((GBO, extract(gbo_all, '', kit_all, namespaces)), (CV, extract('', cv, kit_all, namespaces))):
        for area, names in used.items():
            for name in names:
                out[area].setdefault(name, []).append(part)
    # dom.class is always checked (as before): the override restyles .aui-md.
    if not out['dom.class']:
        out['dom.class']['aui-md'] = [GBO]
    return out


# ── upstream ─────────────────────────────────────────────────────────────
class Upstream:
    def __init__(self, up):
        self.up = up
        self.desk = up / 'apps/desktop/src'
        self._cache = {}

    def text(self, rel):
        if rel not in self._cache:
            self._cache[rel] = read(self.up / rel, self.up)
        return self._cache[rel]

    def production(self, rel, suffixes):
        root = self.up / rel
        if not root.is_dir():
            raise Missing(rel)
        return '\n'.join(read(p, self.up) for p in sorted(root.rglob('*'))
                         if p.suffix in suffixes and p.is_file()
                         and '.test.' not in p.name and '.spec.' not in p.name
                         and 'tests' not in p.relative_to(root).parts and not p.name.startswith('test_'))

    def namespaces(self):
        contracts = self.production('tui_gateway/contracts', {'.py'})
        declared = set(re.findall(r'^(?:method|event|server_request|canonical_method)\(\s*"([a-z_.]+)"', contracts, re.M))
        return {name.split('.')[0] for name in declared}

    def have(self):
        """{area: predicate(name) -> bool} for every area."""
        sdk_index = self.text('apps/desktop/src/sdk/index.ts')
        sdk_text = sdk_index + '\n' + self.text('apps/desktop/src/sdk/areas.ts')
        desk_prod = self.production('apps/desktop/src', {'.ts', '.tsx', '.css'})
        py_prod = self.production('tui_gateway', {'.py'}) + '\n' + self.production('gateway', {'.py'})

        exported = set(re.findall(r'export\s+(?:declare\s+)?(?:const|let|function|async\s+function|class)\s+(\w+)', sdk_text))
        exported |= set(re.findall(r'export\s+\*\s+as\s+(\w+)', sdk_text))
        for block in re.findall(r'export\s+(?:type\s+)?\{([^}]*)\}', sdk_text, re.S):
            for item in block.split(','):
                item = re.sub(r'^\s*type\s+', '', item).strip()
                if item:
                    exported.add(item.split(' as ')[-1].strip())

        m = re.search(r'^export const host = \{\n(.*?)^\}', sdk_index, re.S | re.M)
        host_block = m.group(1) if m else ''
        host_keys = set(re.findall(r'^  (?:async\s+)?(\w+)\s*[:(,]', host_block, re.M))
        s = re.search(r'^  state: \{\n(.*?)^  \}', host_block, re.S | re.M)
        state_keys = set(re.findall(r'^    (\w+)\s*[:(,]', s.group(1), re.M)) if s else set()

        m = re.search(r'^export interface PluginContext \{\n(.*?)^\}', self.text('apps/desktop/src/contrib/plugin.ts'), re.S | re.M)
        ctx_keys = set(re.findall(r'^  (\w+)\??\s*[:(]', m.group(1), re.M)) if m else set()

        icon_names = set(re.findall(r'\b(\w+)\b', self.text('apps/desktop/src/lib/icons.ts')))
        upstream_literals = set(re.findall(LITERAL, py_prod + '\n' + desk_prod))

        routes = set()
        rdir = self.up / 'hermes_cli/web_routers'
        if not rdir.is_dir():
            raise Missing('hermes_cli/web_routers')
        for p in sorted(rdir.glob('*.py')):
            routes |= {re.sub(r'\{[^}]*\}', '{}', r) for r in
                       re.findall(r'@\w+\.(?:get|post|put|patch|delete|websocket)\(\s*"(/api/[^"]+)"', read(p, self.up))}

        def route_ok(path):
            # Segment by segment; `{}` on either side is any one segment. A path ending in `/` (or in a
            # `{}{}` join) is a prefix the code completes at run time.
            want = path.rstrip('/').split('/')
            prefix = path.endswith('/') or '{}{}' in path
            want = [seg if '{}' not in seg else '{}' for seg in want]
            for route in routes:
                hv = route.split('/')
                if len(hv) < len(want) or (len(hv) > len(want) and not prefix):
                    continue
                if all(a == b or '{}' in (a, b) for a, b in zip(want, hv)):
                    return True
            return False

        preload = set(re.findall(r'^\s+(\w+)\s*:', self.text('apps/desktop/electron/preload.ts'), re.M))
        return {
            'sdk': lambda n: n in exported or n in OPTIONAL_SDK,
            'host': lambda n: n in host_keys,
            'host.state': lambda n: n in state_keys,
            'ctx': lambda n: n in ctx_keys,
            'icons': lambda n: n in icon_names,
            'gateway': lambda n: n in upstream_literals,
            'rest': route_ok,
            'bridge': lambda n: n in preload,
            'dom': lambda n: n in desk_prod,
            'dom.slot': lambda n: f'"{n}"' in desk_prod or f"'{n}'" in desk_prod,
            'dom.class': lambda n: n in desk_prod,
        }

    def agent_missing(self):
        out = []
        files = {}
        for rel, token, parts in AGENT_CONTRACTS:
            if rel not in files:
                content = self.text(rel)
                if rel == 'hermes_cli/plugins.py':
                    # Newer Hermes splits PluginContext out while retaining the public facade.
                    content += '\n'.join(read(p, self.up) for p in sorted((self.up / 'hermes_cli').glob('plugins_*.py')))
                files[rel] = content
            if token not in files[rel]:
                out.append((rel, token, parts))
        return out


def check(up, surfaces):
    """(missing [(area, name, parts)], agent_missing [(file, token, parts)], counts [str])."""
    have = up.have()
    missing, counts = [], []
    for area in AREAS:
        names = surfaces.get(area, {})
        for name in sorted(names):
            if not have[area](name):
                missing.append((area, name, names[name]))
        counts.append(f'{area} {len(names)}')
    agent = up.agent_missing()
    counts.append(f'agent {len(AGENT_CONTRACTS)}')
    return missing, agent, counts


# ── which Hermes this is (from .git, read as files; git itself is never run) ─────
def hermes_version(up):
    gitdir = up / '.git'
    try:
        if gitdir.is_file():
            m = re.match(r'gitdir:\s*(.+)', gitdir.read_text().strip())
            if not m:
                return 'version unknown'
            gitdir = (up / m.group(1)).resolve()
        common = gitdir
        if (gitdir / 'commondir').is_file():
            common = (gitdir / (gitdir / 'commondir').read_text().strip()).resolve()
        head = (gitdir / 'HEAD').read_text().strip()
    except OSError:
        return 'version unknown (not a git checkout)'
    refs = {}
    packed = common / 'packed-refs'
    last = None
    if packed.is_file():
        for line in packed.read_text(errors='replace').splitlines():
            if line.startswith('^') and last:
                refs[last + '^{}'] = line[1:].strip()
            elif line and not line.startswith('#'):
                parts = line.split(' ', 1)
                if len(parts) == 2:
                    refs[parts[1].strip()] = parts[0]
                    last = parts[1].strip()
    tags_dir = common / 'refs/tags'
    if tags_dir.is_dir():
        for p in tags_dir.rglob('*'):
            if p.is_file():
                refs[p.relative_to(common).as_posix()] = p.read_text().strip()
    commit = head
    if head.startswith('ref: '):
        ref = head[5:].strip()
        loose = common / ref
        commit = loose.read_text().strip() if loose.is_file() else refs.get(ref, '')
    if not re.fullmatch(r'[0-9a-f]{40,64}', commit or ''):
        return 'version unknown'
    tags = sorted({k[len('refs/tags/'):].replace('^{}', '') for k, v in refs.items()
                   if k.startswith('refs/tags/') and v == commit})
    release = [t for t in tags if re.fullmatch(r'v\d+(\.\d+)+', t)]
    shown = (release or tags or [None])[0]
    return f'{shown} (commit {commit[:9]})' if shown else f'commit {commit[:9]}'


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('hermes_source', type=Path, nargs='?', help='Hermes Agent checkout')
    parser.add_argument('--surfaces', type=Path, help='read what the kit uses from this JSON file (scripts/hermes-surfaces.json)')
    parser.add_argument('--write-surfaces', type=Path, metavar='FILE', help='write what the kit uses to FILE and stop (needs a Hermes checkout for the gateway namespaces)')
    parser.add_argument('--check-surfaces', type=Path, metavar='FILE', help='exit 1 when FILE is not what --write-surfaces would write')
    parser.add_argument('--doctor', action='store_true', help='machine-readable lines for the doctor and the installer')
    args = parser.parse_args()
    kit = Path(__file__).resolve().parent.parent

    if args.hermes_source is None:
        parser.error('a Hermes Agent checkout is required')
    up = Upstream(args.hermes_source)

    if args.write_surfaces or args.check_surfaces:
        try:
            surfaces = kit_surfaces(kit, up.namespaces())
        except Missing as e:
            raise SystemExit(f'upstream path missing: {e} (add it to the checkout)')
        body = json.dumps({'format': 1, 'surfaces': {a: {n: sorted(p) for n, p in sorted(surfaces[a].items())} for a in AREAS}},
                          indent=1, sort_keys=False) + '\n'
        if args.write_surfaces:
            args.write_surfaces.write_text(body, encoding='utf-8')
            print(f'wrote {args.write_surfaces}')
            return 0
        have = args.check_surfaces.read_text(encoding='utf-8') if args.check_surfaces.is_file() else ''
        if have != body:
            raise SystemExit(f'{args.check_surfaces} is out of date: run python3 scripts/check-hermes-compat.py --write-surfaces scripts/hermes-surfaces.json <hermes checkout>')
        print(f'{args.check_surfaces} is current')
        return 0

    if args.doctor:
        print(f'VERSION {hermes_version(args.hermes_source)}')
    try:
        if args.surfaces:
            data = json.loads(args.surfaces.read_text(encoding='utf-8'))
            if data.get('format') != 1:
                raise SystemExit(f'{args.surfaces}: unknown format')
            surfaces = data['surfaces']
        else:
            surfaces = kit_surfaces(kit, up.namespaces())
        missing, agent, counts = check(up, surfaces)
    except Missing as e:
        if args.doctor:
            print(f'INCOMPLETE {e}')
            return 0
        raise SystemExit(f'upstream path missing: {e} (add it to the checkout)')

    if args.doctor:
        for area, name, parts in missing:
            print(f'MISSING {area}: {name}\t{", ".join(parts)}')
        for rel, token, parts in agent:
            print(f'MISSING agent: {token} in {rel}\t{", ".join(parts)}')
        if not missing and not agent:
            print(f'OK {", ".join(counts)}')
        return 0

    errors = [f'{area}: missing upstream: {name}' for area, name, _ in missing]
    errors += [f'agent: missing contract in {rel}: {token}' for rel, token, _ in agent]
    if errors:
        raise SystemExit('\n'.join(errors))
    print(f'Hermes source contracts OK ({", ".join(counts)} names checked).')
    print('This checks source presence, not signatures, rendering, routing, or live model calls.')
    return 0


if __name__ == '__main__':
    sys.exit(main())
