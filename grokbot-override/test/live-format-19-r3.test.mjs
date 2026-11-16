// Live formatting 19, review round 3: one regression test per defect
// (LF-R3-001 … 003) on the reviewer's exact input plus the general rule
// behind it, and the documented limits (LF-R3-005, 006) pinned so they stay
// deliberate. Demo content.

import assert from 'node:assert/strict'
import { existsSync, rmSync } from 'node:fs'
import { dirname } from 'node:path'
import test from 'node:test'
import { pathToFileURL } from 'node:url'

import { extractMedia } from '../src/core/media.js'
import { streamSafe, streamSafeParts } from '../src/core/streamSafe.js'

const ready = existsSync(new URL('../node_modules/esbuild', import.meta.url)) && existsSync(new URL('../node_modules/jsdom', import.meta.url))
const skip = !ready && 'dev dependencies not installed'
const prefixes = text => Array.from({ length: text.length + 1 }, (_, i) => text.slice(0, i))

// ---- LF-R3-001: a MEDIA tag split across a line break ----

const SPLIT_MEDIA = [
  'Here:\n\nMEDIA:\n/tmp/review/chart.png.backup now',
  'Here:\n\nMEDIA:\r\n/tmp/review/chart.png.backup now',
  'Here:\n\nMEDIA:\n\n  /tmp/review/chart.png.backup now',
  'Inline MEDIA:\n"/tmp/review/a b.png" ok',
  'Inline `MEDIA:\r\n/tmp/review/chart.png.backup` ok'
]

test('LF-R3-001: the review input: no MEDIA marker and no truncated path at any prefix', () => {
  assert.equal(streamSafe('Here:\n\nMEDIA:\n'), 'Here:\n\n')
  assert.equal(streamSafe('Here:\n\nMEDIA:\n/tmp/review/chart.png'), 'Here:\n\n')
  for (const full of SPLIT_MEDIA) {
    const finals = new Set(extractMedia(full).media.map(m => m.path))
    assert.equal(finals.size, 1, `fixture parses: ${JSON.stringify(full)}`)
    for (const prefix of prefixes(full)) {
      const { text, media } = extractMedia(streamSafe(prefix))
      assert.ok(!text.includes('MEDIA'), `marker for ${JSON.stringify(prefix)}: ${JSON.stringify(text)}`)
      for (const m of media) assert.ok(finals.has(m.path), `partial path ${m.path} for ${JSON.stringify(prefix)}`)
    }
  }
})

// ---- LF-R3-002: tabs are CommonMark indentation (tab stops of 4) ----

test('LF-R3-002: tab-indented code is shown exactly: no holds, no repair', () => {
  for (const code of [
    'Example:\n\n\techo hi | sort',
    'Intro:\n\n\ta *',
    'Intro:\n\n\tx = `a',
    'Intro:\n\n  \tmixed **b',
    'Intro:\n\n \t\tdeeper _c',
    'Intro:\n\n\t1.',
    'Intro:\n\n\t- item **x'
  ]) {
    assert.equal(streamSafe(code), code, JSON.stringify(code))
  }
})

test('LF-R3-002: tabs after list and quote markers open containers and fences at the right column', () => {
  assert.equal(streamSafe('-\t```sh\n\tprintf x | sort'), '-\t```sh\n\tprintf x | sort\n    ```')
  assert.equal(streamSafe('-\t```sh\n\tprintf x | sort *'), '-\t```sh\n\tprintf x | sort *\n    ```')
  assert.equal(streamSafe('>\t```\n>\tcode **x'), '>\t```\n>\tcode **x\n>   ```')
  assert.equal(streamSafe('1.\tone\n\n\tpara **b'), '1.\tone\n\n\tpara **b**', 'a tab continues the item: a paragraph there')
  assert.equal(streamSafe('1.\tone\n\n\t\tcode *'), '1.\tone\n\n\t\tcode *', 'two tabs in the item: indented code')
  assert.equal(streamSafe('>\t\tquoted code `x'), '>\t\tquoted code `x')
})

// ---- LF-R3-003: emphasis pairs by CommonMark's delimiter rules ----

test('LF-R3-003: the review input and every **left*right** combination stay exactly as sent', () => {
  assert.equal(streamSafe('Product: **2*3**'), 'Product: **2*3**')
  // Every combination that CommonMark parses as one strong span (checked
  // against a CommonMark/GFM parser; with "(" before or ")" after the inner
  // star it is not a strong span, see PARITY known limits).
  for (const left of ['2', 'a', 'x y', '"q']) {
    for (const right of ['3', 'b', 'z w', 'q"']) {
      const done = `**${left}*${right}**`
      assert.equal(streamSafe(done), done, done)
    }
  }
  for (const done of ['*(x)*', '_(y)_', '**"q"**', '***a* b**', '***a** b*', '**a *b* c**', '*a **b** c*', '**foo*bar**', '__init__ stays', '**a _b**', '_a **b**_', 'x ~~y~~']) {
    assert.equal(streamSafe(done), done, done)
  }
})

test('LF-R3-003: while streaming, a run at the very end waits and the open runs before it are closed', () => {
  assert.equal(streamSafe('Product: **2*3*'), 'Product: **2*3**', 'the trailing `*` may become `**`')
  assert.equal(streamSafe('Product: **2*3'), 'Product: **2*3**', 'an intraword `*` is ambiguous: literal, not closed')
  assert.equal(streamSafe('2*3'), '2*3')
  assert.equal(streamSafe('**bold *ital'), '**bold *ital***')
  assert.equal(streamSafe('***a* b'), '***a* b**')
  assert.equal(streamSafe('a **b '), 'a **b**')
  assert.equal(streamSafe('done **x** and *'), 'done **x** and ')
})

// ---- documented limits (PARITY known limits), pinned ----

test('LF-R3-005 / 006: deliberate holds that only completion releases', () => {
  assert.equal(streamSafe('Use left | right'), '', 'a line with a pipe may be a table header')
  assert.equal(streamSafe('Hi!'), 'Hi', 'a final "!" may start an image')
  assert.equal(streamSafe('a*"b"*'), 'a*"b"', 'a literal delimiter run at the very end (CommonMark leaves this one unpaired)')
  assert.equal(streamSafe('Title\n==='), 'Title\n', 'a setext underline at the end')
  assert.equal(streamSafe('[ref]:\n  https://example.com\n\nRead [ref]'), '[ref]:\n  https://example.com\n\nRead ', 'multi-line definitions are not looked up')
  assert.equal(streamSafe('[ref]: https://example.com\n\nRead [ref]'), '[ref]: https://example.com\n\nRead [ref]', 'one-line definitions are')
  assert.equal(streamSafe('Footnote[^1] here.'), 'Footnote[^1] here.', 'a reference used before its definition is text until the definition arrives')
  assert.equal(streamSafe('***4** end'), '***4** end*', 'an opener never closed: closed while streaming, literal at completion')
  assert.equal(streamSafe('| A |\n|---|\n| `a|b'), '| A |\n|---|\n| `a|b', 'a pipe inside backticks in a cell splits it (GFM): not repaired across it')
  const long = `[${'x'.repeat(600)}`
  assert.equal(streamSafe(long), long, 'a bracket held more than HOLD_MAX characters is text after all')
})

// ---- mounted: no media read on a split tag (LF-R3-001) ----

let env = null
async function setup(t) {
  if (env) return env
  const { JSDOM } = await import('jsdom')
  const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/', pretendToBeVisual: true })
  const w = dom.window
  const set = (key, value) => Object.defineProperty(globalThis, key, { value, configurable: true, writable: true })
  for (const key of ['window', 'document', 'navigator', 'HTMLElement', 'HTMLIFrameElement', 'Element', 'Node', 'Text', 'Event', 'MouseEvent', 'MutationObserver', 'getComputedStyle']) {
    set(key, key === 'getComputedStyle' ? w.getComputedStyle.bind(w) : w[key])
  }
  set('IS_REACT_ACT_ENVIRONMENT', false)
  const reads = []
  w.hermesDesktop = {
    readFileDataUrl: async path => (reads.push(path), 'data:image/png;base64,AAAA'),
    api: async request => (reads.push(request?.path || ''), { text: '' })
  }
  const { bundlePreview } = await import('../dev/bundle.mjs')
  const file = await bundlePreview()
  const m = await import(pathToFileURL(file).href)
  const React = (await import('react')).default
  const { createRoot } = await import('react-dom/client')
  const { flushSync } = await import('react-dom')
  t.after(() => {
    rmSync(dirname(file), { recursive: true, force: true })
    dom.window.close()
  })
  env = { m, React, createRoot, flushSync, reads }
  return env
}

const BOT = {
  name: 'scholar',
  display_name: 'Scholar',
  connectionId: 'local',
  connectionKind: 'local',
  sourceScoped: true,
  route: { connectionId: 'local', mode: 'local', profile: 'scholar', targetProfile: 'scholar' },
  canonical_session: { id: 's-root' }
}

test('LF-R3-001 (mounted): a MEDIA tag split across LF or CRLF starts no read before its path ends, and never shows its marker', { skip }, async t => {
  const e = await setup(t)
  const { m, React, createRoot, flushSync } = e
  for (const full of SPLIT_MEDIA.slice(0, 2)) {
    e.reads.length = 0
    for (const prefix of prefixes(full)) {
      const container = document.createElement('div')
      document.body.appendChild(container)
      const root = createRoot(container)
      const scope = { bot: BOT, sessionId: 's-root', sendIntent: async () => ({ ok: true }), recent: new Set(), preload: {} }
      const item = { kind: 'assistant', id: 'a1', text: prefix, at: 1_762_560_030_000, streaming: true }
      flushSync(() => root.render(React.createElement(m.DirectiveContext.Provider, { value: scope }, React.createElement(m.AssistantBody, { item, bot: BOT, pos: '' }))))
      await new Promise(resolve => setTimeout(resolve, 0))
      assert.ok(!container.textContent.includes('MEDIA'), JSON.stringify(prefix))
      root.unmount()
      container.remove()
    }
    assert.ok(e.reads.every(path => path === '/tmp/review/chart.png.backup'), `reads for ${JSON.stringify(full)}: ${JSON.stringify(e.reads)}`)
  }
})

test('performance: a 20k-character reply with tabs, emphasis and tables stays well under a frame per tick', () => {
  const block = 'Para **bold *it*** and 2*3 and [l](https://example.com/a_(b)).\n\n\tcode | x *\n\n> - item `c`\n\n| A | B |\n|---|---|\n| 1 |\n\n'
  const big = block.repeat(Math.ceil(20_000 / block.length)).slice(0, 20_000)
  let worst = 0
  for (let i = 40; i <= big.length; i += 40) {
    const t0 = performance.now()
    streamSafeParts(big.slice(0, i))
    worst = Math.max(worst, performance.now() - t0)
  }
  assert.ok(worst < 16, `worst tick ${worst.toFixed(2)}ms`)
})
