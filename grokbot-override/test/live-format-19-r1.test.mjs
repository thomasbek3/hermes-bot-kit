// Live formatting 19, review round 1: one regression test per finding
// (LF-R1-001 … 009), each on the failing input the review reproduced.
// Pure checks on core/streamSafe.js, and mounted checks of the real
// AssistantBody (react-dom client on jsdom, the dev fake SDK). Demo content.

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

// ---- LF-R1-001: inline MEDIA tags (spaced, quoted, Unicode) ----

const MEDIA_CASES = [
  ['See MEDIA: /tmp/review/chart.png.backup and more', '/tmp/review/chart.png.backup'],
  ['See MEDIA: "/tmp/review/report draft é.png" ok', '/tmp/review/report draft é.png'],
  ["See MEDIA: '/tmp/review/日本 chart.png' ok", '/tmp/review/日本 chart.png'],
  ['See MEDIA: `/tmp/review/x y.png` ok', '/tmp/review/x y.png'],
  ['Look `MEDIA:/tmp/review/a.png` here', '/tmp/review/a.png'],
  ['Two MEDIA: /tmp/review/one.png and MEDIA: /tmp/review/two.png!', null]
]

test('LF-R1-001: the review inputs show no marker and no partial path', () => {
  for (const input of ['See MEDIA: ', 'See MEDIA: /tmp/report.p', 'See MEDIA: "/tmp/report draft.p']) {
    assert.equal(streamSafe(input), 'See ', JSON.stringify(input))
  }
})

test('LF-R1-001: every byte of inline, spaced, quoted and Unicode MEDIA tags: never a raw marker, never a truncated path', () => {
  for (const [full, path] of MEDIA_CASES) {
    const finals = new Set(extractMedia(full).media.map(m => m.path))
    if (path) assert.ok(finals.has(path), `fixture parses: ${full}`)
    for (const prefix of prefixes(full)) {
      const { text, media } = extractMedia(streamSafe(prefix))
      assert.ok(!text.includes('MEDIA'), `raw marker for ${JSON.stringify(prefix)}: ${JSON.stringify(text)}`)
      for (const m of media) assert.ok(finals.has(m.path), `partial path ${m.path} for ${JSON.stringify(prefix)}`)
    }
  }
})

// ---- LF-R1-002: combined emphasis closers ----

test('LF-R1-002: a closing run closes every delimiter it covers; complete emphasis is left exactly as sent', () => {
  for (const done of ['**bold *italic***', '***both***', '*a **b***', '**a _b_**', '_a **b**_', '**bold** and *it*', '**a *b* c**']) {
    assert.equal(streamSafe(done), done, done)
  }
  assert.equal(streamSafe('**bold *italic'), '**bold *italic***')
  assert.equal(streamSafe('**bold *italic*'), '**bold *italic***')
  assert.equal(streamSafe('**a _b**'), '**a _b**', 'a closer for the outer run drops the inner opener')
})

// ---- LF-R1-003: fences in blockquotes and list items ----

test('LF-R1-003: a fence in a quote or list item is closed with its container prefix; its code is never repaired', () => {
  assert.equal(streamSafe('> ```js\n> const star = "**x'), '> ```js\n> const star = "**x\n> ```')
  assert.equal(streamSafe('- ```js\n  const x = "**b'), '- ```js\n  const x = "**b\n  ```')
  assert.equal(streamSafe('1. step\n\n   ```sh\n   echo `a'), '1. step\n\n   ```sh\n   echo `a\n   ```')
  assert.equal(streamSafe('> - ```\n>   a_b *c'), '> - ```\n>   a_b *c\n>   ```')
  assert.equal(streamSafe('- ~~~\n  x_`~'), '- ~~~\n  x_`~\n  ~~~')
  assert.equal(streamSafe('> ```js\r\n> a **b'), '> ```js\r\n> a **b\n> ```', 'CRLF')
  assert.equal(streamSafe('> ```js\n> x\n> ```\n> after **b'), '> ```js\n> x\n> ```\n> after **b**', 'after a closed quote fence, prose is repaired again')
  assert.equal(streamSafe('- ```js'), '', 'a list fence opener waits for its language')
  assert.equal(streamSafe('text\n\n    indented **code'), 'text\n\n    indented **code', 'an indented code block is never repaired')
  // The code body is always kept exactly: the output starts with the input.
  for (const input of ['> ```\n> **x', '- ```\n  `y', '> ```\n> _z_ **', '- ```py\n  a = "*"']) {
    assert.ok(streamSafe(input).startsWith(input), JSON.stringify(input))
  }
})

// ---- LF-R1-004: inline-code closers next to literal backticks ----

test('LF-R1-004: a literal backtick run at the end of open code is held, so the closer never merges with it', () => {
  assert.equal(streamSafe('Use ``this `'), 'Use ``this ``')
  assert.equal(streamSafe('Use ``this ` tick'), 'Use ``this ` tick``')
  for (const open of ['`', '``', '```']) {
    for (const run of ['`', '``', '```', '````']) {
      if (run === open) continue
      const out = streamSafe(`a ${open}x ${run}`)
      const last = /`+$/.exec(out)?.[0] || ''
      assert.equal(last, open, `${open}x ${run} -> ${out}`)
    }
  }
})

// ---- LF-R1-005: a complete final table row ----

test('LF-R1-005: a table ending in a complete row or separator shows whole while streaming', () => {
  for (const table of ['| A | B |\n|---|---|\n| 1 | 2 |', '| A | B |\n|---|---|', 'A | B\n--|--\n1 | 2', '| A | B |\n|:--|--:|\n| 1 | 2', 'x\n\n| A |\n|---|\n| 1 |']) {
    assert.equal(streamSafe(table), table, JSON.stringify(table))
  }
  assert.equal(streamSafe('| A | B |\n|---|---|\n| 1 |'), '| A | B |\n|---|---|\n| 1 |', 'a short row is valid GFM (review round 2, LF-R2-004)')
  assert.equal(streamSafe('| A | B |\n|---|'), '', 'a separator short of columns waits with its header')
  assert.equal(streamSafe('A | B\n--|'), '', 'a header without a leading pipe waits with its half separator (no raw pipes flash)')
})

// ---- mounted harness ----

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

const settle = (ms = 0) => new Promise(resolve => setTimeout(resolve, ms))

function mountBody(e, { files = {}, strict = false } = {}) {
  const { m, React, createRoot, flushSync } = e
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  const scope = { bot: BOT, sessionId: 's-root', sendIntent: async () => ({ ok: true }), recent: new Set(), preload: files }
  const draw = (text, streaming = true) => {
    const item = { kind: 'assistant', id: 'a1', text, at: 1_762_560_030_000, ...(streaming ? { streaming: true } : {}) }
    let el = React.createElement(m.AssistantBody, { item, bot: BOT, pos: '' })
    el = React.createElement(m.DirectiveContext.Provider, { value: scope }, el)
    if (strict) el = React.createElement(React.StrictMode, null, el)
    flushSync(() => root.render(el))
  }
  return { container, draw, unmount: () => (root.unmount(), container.remove()) }
}

test('LF-R1-001 (mounted): no media read starts for a partial inline path', { skip }, async t => {
  const e = await setup(t)
  const full = 'See MEDIA: /tmp/review/chart.png.backup now'
  e.reads.length = 0
  for (const prefix of prefixes(full)) {
    const view = mountBody(e)
    view.draw(prefix)
    await settle()
    assert.ok(!view.container.textContent.includes('MEDIA'), JSON.stringify(prefix))
    view.unmount()
  }
  assert.ok(e.reads.every(path => path === '/tmp/review/chart.png.backup'), `reads: ${JSON.stringify(e.reads)}`)
})

test('LF-R1-005 (mounted): the last streaming tick of a table and the finished reply draw the same markup', { skip }, async t => {
  const e = await setup(t)
  for (const table of ['| A | B |\n|---|---|\n| 1 | 2 |', 'Intro\n\n| A | B |\n|---|---|']) {
    const live = mountBody(e)
    live.draw(table)
    const done = mountBody(e)
    done.draw(table, false)
    assert.equal(live.container.innerHTML.replace(/ is-streaming/g, ''), done.container.innerHTML)
    assert.ok(live.container.textContent.includes(table.includes('| 1 |') ? '1' : 'B'))
    live.unmount()
    done.unmount()
  }
})

test('LF-R1-006: the first directive completing keeps the prose before it mounted; an expanded code block stays open', { skip }, async t => {
  const e = await setup(t)
  const code = Array.from({ length: 70 }, (_, i) => `line ${i + 1}`).join('\n')
  const head = `Here:\n\n\`\`\`text\n${code}\n\`\`\`\n\n`
  for (const finishTogether of [false, true]) {
    const view = mountBody(e)
    view.draw(`${head}::card{file="cards/a`)
    await settle()
    const pre = view.container.querySelector('.gbo-code pre')
    assert.ok(pre.classList.contains('is-folded'))
    assert.ok(view.container.querySelector('.gbo-directive.is-pending'), 'the placeholder')
    const more = view.container.querySelector('.gbo-code-more')
    more.click()
    await settle()
    assert.equal(more.textContent, 'Show less')
    if (!finishTogether) {
      view.draw(`${head}::card{file="cards/a.json"}`)
      await settle(80)
    }
    view.draw(`${head}::card{file="cards/a.json"}`, false)
    await settle()
    assert.equal(view.container.querySelector('.gbo-code pre'), pre, 'the same <pre> node')
    assert.ok(!pre.classList.contains('is-folded'), 'still expanded')
    assert.equal(view.container.querySelector('.gbo-code-more').textContent, 'Show less')
    assert.ok(view.container.querySelector('.gbo-directive .gbo-dcard'), 'the card')
    assert.equal(view.container.querySelector('.gbo-directive.is-pending'), null)
    view.unmount()
  }
})

test('LF-R1-007: deltas between throttled ticks never re-run the markdown renderer; the last chunk shows; unmount stops the timer', { skip }, async t => {
  const e = await setup(t)
  const view = mountBody(e)
  view.draw('Start')
  await settle()
  const before = e.m.markdownRenders.count
  for (let i = 1; i <= 20; i += 1) view.draw(`Start ${i}`)
  const during = e.m.markdownRenders.count - before
  assert.ok(during <= 1, `markdown renders during 20 deltas: ${during}`)
  assert.ok(!view.container.textContent.includes('Start 20'))
  await settle(e.m.STREAM_RENDER_MS * 2 + 20)
  assert.ok(view.container.textContent.includes('Start 20'), 'the last chunk is flushed')
  view.unmount()
  const after = e.m.markdownRenders.count
  await settle(e.m.STREAM_RENDER_MS * 2)
  assert.equal(e.m.markdownRenders.count, after, 'nothing renders after unmount')
})

test('LF-R1-008: a streaming preview reserves the preview shell at its own height, the height the frame starts at', { skip }, async t => {
  const e = await setup(t)
  const html = { text: '<p>chart</p>' }
  const view = mountBody(e, { files: { 'pages/chart.html': html } })
  view.draw('Pages:\n\n::preview{file="pages/chart.html" height="360"')
  const shell = view.container.querySelector('.gbo-directive.is-pending > .gbo-preview.is-loading')
  assert.ok(shell, 'a preview shell, not a card shell')
  assert.equal(view.container.querySelector('.gbo-directive.is-pending .gbo-dcard'), null)
  assert.equal(shell.style.height, '360px')
  view.draw('Pages:\n\n::preview{file="pages/chart.html" height="360"}', false)
  await settle()
  const frame = view.container.querySelector('.gbo-directive iframe.gbo-preview-frame')
  assert.ok(frame, 'the frame')
  assert.equal(frame.style.height, '360px')
  view.unmount()
  // Not preloaded: the loading shell between them is the same height.
  const cold = mountBody(e)
  cold.draw('::preview{file="pages/other.html" height="360"}', false)
  assert.equal(cold.container.querySelector('.gbo-directive .gbo-preview.is-loading')?.style.height, '360px')
  cold.unmount()
})

test('LF-R1-009: under StrictMode the stream keeps updating', { skip }, async t => {
  const e = await setup(t)
  const { React, createRoot, flushSync, m } = e
  const container = document.createElement('div')
  const root = createRoot(container)
  const Probe = ({ text, streaming }) => React.createElement('span', null, m.useStreamText(text, streaming))
  const draw = (text, streaming) => flushSync(() => root.render(React.createElement(React.StrictMode, null, React.createElement(Probe, { text, streaming }))))
  draw('one', true)
  draw('one two', true)
  await settle(m.STREAM_RENDER_MS + 30)
  assert.equal(container.textContent, 'one two')
  draw('one two three', true)
  await settle(m.STREAM_RENDER_MS + 30)
  assert.equal(container.textContent, 'one two three')
  draw('one two three four', false)
  assert.equal(container.textContent, 'one two three four', 'done: the full text at once')
  root.unmount()
  // And the whole AssistantBody under StrictMode.
  const view = mountBody(e, { strict: true })
  view.draw('Hello')
  view.draw('Hello **world')
  await settle(m.STREAM_RENDER_MS + 30)
  assert.equal(view.container.querySelector('strong')?.textContent, 'world')
  view.unmount()
})
