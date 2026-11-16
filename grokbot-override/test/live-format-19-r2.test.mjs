// Live formatting 19, review round 2: one regression test per finding
// (LF-R2-001 … 005) on the reviewer's exact failing input plus the general
// rule behind it, and the further classes an every-prefix check against a
// real CommonMark/GFM parser found (block containers, inline tokens, tables,
// references, trailing escapes). Demo content.

import assert from 'node:assert/strict'
import { existsSync, rmSync } from 'node:fs'
import { dirname } from 'node:path'
import test, { afterEach } from 'node:test'
import { pathToFileURL } from 'node:url'

import { streamSafe, streamSafeParts } from '../src/core/streamSafe.js'

const ready = existsSync(new URL('../node_modules/esbuild', import.meta.url)) && existsSync(new URL('../node_modules/jsdom', import.meta.url))

// Every mounted root is unmounted after its test, pass or fail: a failed
// assertion before an explicit unmount must not leave a streaming timer
// alive (it would keep the test process from exiting, INT-05).
const mountedRoots = new Set()
function trackRoot(root, container) {
  let done = false
  const unmount = () => {
    if (done) return
    done = true
    mountedRoots.delete(unmount)
    root.unmount()
    container.remove()
  }
  mountedRoots.add(unmount)
  return unmount
}
afterEach(() => {
  for (const unmount of [...mountedRoots]) unmount()
})
const skip = !ready && 'dev dependencies not installed'
const prefixes = text => Array.from({ length: text.length + 1 }, (_, i) => text.slice(0, i))

/** A streaming open fence: the input kept exactly, then one closing line. */
const closedWith = (input, closer) => assert.equal(streamSafe(input), `${input}\n${closer}`, JSON.stringify(input))

// ---- LF-R2-001: fence context ----

test('LF-R2-001: the review inputs keep their code exactly', () => {
  closedWith('```text\nliteral\n    ```\n**more', '```')
  closedWith('```text\nliteral\n> ```\n**more', '```')
  closedWith('- > ```text\n  > const s = "**x', '  > ```')
  assert.equal(streamSafe('>     ```\n>     const s = "**x'), '>     ```\n>     const s = "**x', 'a quoted indented code block is not a fence and is never repaired')
})

test('LF-R2-001: fences are opened and closed under their own containers, at any nesting', () => {
  closedWith('> - ```\n>   **a', '>   ```')
  closedWith('1. > - ```js\n   >   x = "*"', '   >   ```')
  closedWith('- a\n\n  ```\n  b_\n      ```', '  ```') // four spaces past the item's indent: content, not a closer
  assert.equal(streamSafe('- a\n\n  ```\n  b_\n     ```\nafter **c'), '- a\n\n  ```\n  b_\n     ```\nafter **c**', 'three spaces past it do close (CommonMark)')
  closedWith('```\n  ```x\n_y', '```') // an "opener" with an info string cannot close
  closedWith('````\n```\n**z', '````') // a shorter run cannot close
  // A container that ends ends the fence: what follows is prose again.
  assert.equal(streamSafe('> ```\n> a\nafter **b'), '> ```\n> a\nafter **b**')
  assert.equal(streamSafe('- ```\n  a\nnext **b'), '- ```\n  a\nnext **b**')
  // A line that is only its container prefix (or indentation) so far waits.
  assert.equal(streamSafe('> ```\n> a\n>'), '> ```\n> a\n> ```')
  assert.equal(streamSafe('- ```\n  a\n '), '- ```\n  a\n  ```')
  // Indented code (top level, in a quote, in an item) is never repaired.
  for (const input of ['x\n\n    a **b', '>     a **b', '- x\n\n      a `b']) assert.equal(streamSafe(input), input, JSON.stringify(input))
})

// ---- LF-R2-002: link destinations and other non-prose tokens ----

test('LF-R2-002: complete links, autolinks, bare URLs, MEDIA tags and directives get no closers', () => {
  for (const done of [
    'Open [docs](https://example.com/_docs)',
    'Open [docs](https://example.com/a*b)',
    'See [w](https://e.com/Foo_(bar_)) now',
    'See [t](https://e.com/x "a *title") now',
    'See [t](<https://e.com/a b_>) now',
    'Mail <https://e.com/_x_> and <me@example.com>',
    'Bare https://e.com/_init_/a*b ok',
    'Image ![a_b](/tmp/_x.png) ok',
    'Ref [x][r_] ok\n\n[r_]: https://e.com/_y',
    'Card ::card{file="cards/_a.json"} ok'
  ]) {
    assert.equal(streamSafe(done), done, done)
  }
  // Emphasis opened inside a finished link's label never gets a closer outside it.
  assert.equal(streamSafe('[**a](https://e.com) b'), '[**a](https://e.com) b')
})

// ---- LF-R2-003: links are tracked, not matched by one regex ----

test('LF-R2-003: an inline link waits until its destination closes, nested parentheses included', () => {
  const full = 'Read [wiki](https://example.com/Foo(bar)) ok'
  const done = full.indexOf(')) ok') + 2
  for (const prefix of prefixes(full)) {
    const out = streamSafe(prefix)
    if (prefix.length < full.indexOf('[')) continue
    if (prefix.length < done) assert.equal(out, 'Read ', JSON.stringify(prefix))
    else assert.ok(out.startsWith('Read [wiki](https://example.com/Foo(bar))'), JSON.stringify(prefix))
  }
  assert.equal(streamSafe('Read [wiki](https://example.com/Foo(bar)'), 'Read ')
  assert.equal(streamSafe('See [t](https://e.com "a title'), 'See ', 'an open title waits')
})

test('LF-R2-003: complete reference links show at once; an undefined trailing [label] waits', () => {
  for (const done of [
    '[ref]: https://example.com\nRead [ref]',
    '[ref]: https://example.com\n\nRead [label][ref]',
    '[ref]: https://example.com\n\nRead [ref][]',
    '[Ref  One]: https://example.com\n\nRead [ref one]',
    'Read [x][ref] then\n\n[ref]: https://example.com'
  ]) {
    assert.equal(streamSafe(done), done, done)
  }
  assert.equal(streamSafe('[ref]: https://example.com\n\nRead [label]['), '[ref]: https://example.com\n\nRead ')
  assert.equal(streamSafe('Read [later]'), 'Read ', 'it may still become an inline link')
  assert.equal(streamSafe('Read [later] on'), 'Read [later] on')
  assert.equal(streamSafe('ok\n\n[ref]:'), 'ok\n\n', 'a definition without its destination would show as text')
  assert.equal(streamSafe('ok\n[ref]: x'), 'ok\n[ref]: x', 'a definition cannot interrupt a paragraph: it is text there')
})

// ---- LF-R2-004: GFM rows with omitted cells ----

test('LF-R2-004: a short body row is a complete GFM row: shown while streaming', () => {
  for (const table of ['| A | B |\n|---|---|\n| 1 |', '| A | B |\n|---|---|\n| 1 |\n| 2 | 3 |', '| A | B | C |\n|---|---|---|\n| 1', 'A | B\n--|--\nx', '| A | B |\n|---|---|\n|']) {
    assert.equal(streamSafe(table), table, JSON.stringify(table))
  }
  assert.equal(streamSafe('A | B\n--|--\n1'), 'A | B\n--|--\n', 'a bare number may still become an ordered list, which ends the table')
  // Only the growing last cell is repaired (cells split on pipes first).
  assert.equal(streamSafe('| A | B |\n|---|---|\n| `a` | **b'), '| A | B |\n|---|---|\n| `a` | **b**')
})

// ---- the classes the every-prefix parser check found ----

test('parser check: half constructs at the very end wait; nothing raw flashes', () => {
  assert.equal(streamSafe('A | B'), '', 'any line with a pipe may be a table header (GFM)')
  assert.equal(streamSafe('A | B\n-'), '', 'its separator may be starting')
  assert.equal(streamSafe('A | B\nok'), 'A | B\nok', 'not a separator: the line was text after all')
  assert.equal(streamSafe('Escapes \\'), 'Escapes ', 'a trailing backslash')
  assert.equal(streamSafe('See !'), 'See ', 'may start an image')
  assert.equal(streamSafe('Go <htt'), 'Go ', 'may become an autolink')
  assert.equal(streamSafe('Go </sp'), 'Go ', 'a closing tag')
  assert.equal(streamSafe('Tom &am'), 'Tom ', 'an entity')
  assert.equal(streamSafe('Strike ~~ol'), 'Strike ~~ol~~', 'GFM strikethrough')
  assert.equal(streamSafe('Strike ~~'), 'Strike ')
  assert.equal(streamSafe('fence-ish ~~~ text'), 'fence-ish ~~~ text', 'three tildes are literal')
  assert.equal(streamSafe('Code `` '), 'Code ', 'code content that is only padding waits')
  assert.equal(streamSafe('- a\n- [ ] '), '- a\n', 'a task marker with no text yet')
  assert.equal(streamSafe('> quote **bold\n>'), '> quote **bold**', 'a bare container marker line waits')
  assert.equal(streamSafe('- a\n- [b'), '- a\n', 'a held line keeps no bare list marker')
  assert.equal(streamSafe('    lead **x'), '    lead **x**', 'the renderer trims the message: leading spaces are not code')
  assert.equal(streamSafe('Footnote[^1].\n\n[^1]: The **no'), 'Footnote[^1].\n\n[^1]: The **no**', 'a footnote definition is visible text')
  // Integration with source links: a bare http(s) URL at the very end waits whole (its chip label depends on
  // the whole URL), which also keeps GFM's trailing-punctuation trim from flashing; once a space arrives it shows.
  assert.equal(streamSafe('https://e.com/a_'), '', 'a bare URL still typing waits whole (source links)')
  assert.equal(streamSafe('https://e.com/a_ ok'), 'https://e.com/a_ ok')
  assert.equal(streamSafe('www.e.com/a_'), 'www.e.com/a', 'GFM trims trailing punctuation from a bare www URL')
})

// ---- mounted (LF-R2-004 DOM parity, LF-R2-005) ----

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
  w.hermesDesktop = { readFileDataUrl: async () => 'data:image/png;base64,AAAA', api: async () => ({ text: '' }) }
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
  env = { m, React, createRoot, flushSync }
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

function mountBody({ m, React, createRoot, flushSync }, files = {}) {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  const scope = { bot: BOT, sessionId: 's-root', sendIntent: async () => ({ ok: true }), recent: new Set(), preload: files }
  const draw = (text, streaming = true) => {
    const item = { kind: 'assistant', id: 'a1', text, at: 1_762_560_030_000, ...(streaming ? { streaming: true } : {}) }
    const el = React.createElement(m.DirectiveContext.Provider, { value: scope }, React.createElement(m.AssistantBody, { item, bot: BOT, pos: '' }))
    flushSync(() => root.render(el))
  }
  return { container, draw, unmount: trackRoot(root, container) }
}

test('LF-R2-004 (mounted): a table ending in a short row draws the same markup streaming and done', { skip }, async t => {
  const e = await setup(t)
  for (const table of ['| A | B |\n|---|---|\n| 1 |', 'Intro\n\n| A | B |\n|---|---|\n| 1 |']) {
    const live = mountBody(e)
    live.draw(table)
    const done = mountBody(e)
    done.draw(table, false)
    assert.equal(live.container.innerHTML.replace(/ is-streaming/g, ''), done.container.innerHTML)
    // The fake SDK draws a GFM table since source links (header and cells); either way the short row is there.
    assert.ok(live.container.textContent.includes('| 1 |') || [...live.container.querySelectorAll('tbody td')].some(td => td.textContent === '1'), 'the row is there while streaming')
    live.unmount()
    done.unmount()
  }
})

test('LF-R2-005: a bare unquoted height sizes the placeholder; the brace arriving with completion changes nothing', { skip }, async t => {
  const e = await setup(t)
  assert.deepEqual(streamSafeParts('::preview{file="pages/chart.html" height=360').pending, { name: 'preview', attrs: { file: 'pages/chart.html', height: '360' } })
  const view = mountBody(e, { 'pages/chart.html': { text: '<p>chart</p>' } })
  view.draw('Pages:\n\n::preview{file="pages/chart.html" height=360')
  const shell = view.container.querySelector('.gbo-directive.is-pending > .gbo-preview.is-loading')
  assert.ok(shell, 'the preview placeholder')
  assert.equal(shell.style.height, '360px')
  view.draw('Pages:\n\n::preview{file="pages/chart.html" height=360}', false)
  await new Promise(resolve => setTimeout(resolve, 0))
  assert.equal(view.container.querySelector('iframe.gbo-preview-frame')?.style.height, '360px')
  view.unmount()
  // A quoted value still being typed counts as it stands, too.
  assert.equal(streamSafeParts('::preview{height="36').pending.attrs.height, '36')
})
