// Live formatting 19: a streaming bot reply renders formatted as it types
// (Grok/ChatGPT style) through the same prose path as a finished one, on a
// render-stable prefix (core/streamSafe.js): no raw `**` / fence / link /
// MEDIA: / ::card text flashing, and no jump when the reply completes.
// Demo content only.

import assert from 'node:assert/strict'
import { existsSync, rmSync } from 'node:fs'
import { dirname } from 'node:path'
import test from 'node:test'
import { pathToFileURL } from 'node:url'

import { bestTickMs } from './tick-timing.mjs'
import { HOLD_MAX, streamSafe, streamSafeParts } from '../src/core/streamSafe.js'
import { applyEvent, initialChatState } from '../src/core/reducer.js'
import { visibleItems } from '../src/core/workRows.js'

const ready = existsSync(new URL('../node_modules/esbuild', import.meta.url)) && existsSync(new URL('../node_modules/jsdom', import.meta.url))
const skip = !ready && 'dev dependencies not installed'

const SAMPLE = [
  '# Weekly plan',
  '',
  'Here is **the short version** with *a little* emphasis, `inline code` and a [link](https://example.com/page).',
  '',
  '- first item with **bold**',
  '- second item',
  '1. numbered',
  '',
  '| Day | Task |',
  '|-----|------|',
  '| Mon | Read |',
  '',
  '```js',
  'const total = items.reduce((a, b) => a + b, 0)',
  'console.log(`total: ${total}`)',
  '```',
  '',
  'MEDIA: /tmp/demo/chart.png',
  '',
  'See ::card{id="c-1" kind="task" file="cards/c-1.json"} for details. snake_case_name stays.'
].join('\n')

/** What streamSafe added beyond the prefix it kept (closers only). */
const closersOf = (input, out) => {
  const parts = streamSafeParts(input)
  const kept = input.slice(0, input.length - parts.held.length)
  assert.ok(out.startsWith(kept.replace(/\s+$/, '')), `prefix kept for ${JSON.stringify(input)}`)
  return out.slice(kept.length)
}

test('streamSafe: inline emphasis and code close temporarily; a bare trailing delimiter is held', () => {
  assert.equal(streamSafe('Here is **bol'), 'Here is **bol**')
  assert.equal(streamSafe('Here is **'), 'Here is ')
  assert.equal(streamSafe('Here is *it'), 'Here is *it*')
  assert.equal(streamSafe('Here is _it'), 'Here is _it_')
  assert.equal(streamSafe('done **bold** and *'), 'done **bold** and ')
  assert.equal(streamSafe('x `np'), 'x `np`')
  assert.equal(streamSafe('x `'), 'x ')
  assert.equal(streamSafe('run **`npm i'), 'run **`npm i`**')
  assert.equal(streamSafe('a **b '), 'a **b**', 'a closer touches the text it closes')
  assert.equal(streamSafe('snake_case_'), 'snake_case', 'an intraword underscore is not emphasis')
  assert.equal(streamSafe('foo_bar is fine'), 'foo_bar is fine')
  assert.equal(streamSafe('2 * 3 = 6'), '2 * 3 = 6', 'a lone spaced star is literal')
  assert.equal(streamSafe('- **x\n- y'), '- **x\n- y', 'emphasis never crosses list items')
  assert.equal(streamSafe('a \\*not'), 'a \\*not', 'escaped')
  assert.equal(streamSafe('`a **b'), '`a **b`', 'no emphasis inside code')
})

test('streamSafe: links, images, MEDIA lines and directives on their way are held back', () => {
  assert.deepEqual(streamSafeParts('see [lin'), { text: 'see ', held: '[lin', directive: false, pending: null })
  assert.equal(streamSafe('see [link]'), 'see ')
  assert.equal(streamSafe('see [link](https://exa'), 'see ')
  assert.equal(streamSafe('see ![alt](/tmp/x.p'), 'see ')
  assert.equal(streamSafe('see [link](https://example.com) ok'), 'see [link](https://example.com) ok')
  assert.equal(streamSafe(`[${'x'.repeat(HOLD_MAX + 5)}`), `[${'x'.repeat(HOLD_MAX + 5)}`, 'a stray bracket in a long line is text after all')
  for (const partial of ['M', 'MED', 'MEDIA', 'MEDIA:', 'MEDIA: /tmp/de', '`MEDIA: /tmp/demo/chart.p']) {
    assert.equal(streamSafe(`ok\n${partial}`), 'ok\n', partial)
  }
  assert.equal(streamSafe('look MEDIA:/tmp/a.pn'), 'look ', 'an inline tag')
  assert.equal(streamSafe('ok\nMEDIA: /tmp/a.png\nmore'), 'ok\nMEDIA: /tmp/a.png\nmore', 'a complete line passes (extractMedia lifts it)')
  assert.deepEqual(streamSafeParts('See ::card{id="c-1" file="cards/c'), { text: 'See ', held: '::card{id="c-1" file="cards/c', directive: true, pending: { name: 'card', attrs: { id: 'c-1', file: 'cards/c' } } })
  assert.deepEqual(streamSafeParts('See ::prev'), { text: 'See ', held: '::prev', directive: false, pending: null })
  assert.equal(streamSafe('See ::card{id="c-1"} done'), 'See ::card{id="c-1"} done')
  assert.equal(streamSafe('time 10:'), 'time 10:', 'a colon after a word is text')
  assert.equal(streamSafe('code `::card{x'), 'code `::card{x`', 'inside inline code it is text')
})

test('streamSafe: fences close temporarily and grow; half block markers and table rows are held', () => {
  assert.equal(streamSafe('a\n```py'), 'a\n', 'the opener waits for its language')
  assert.equal(streamSafe('a\n```py\n'), 'a\n```py\n```')
  assert.equal(streamSafe('a\n```py\nprint(1)'), 'a\n```py\nprint(1)\n```')
  assert.equal(streamSafe('a\n```py\nprint(1)\n``'), 'a\n```py\nprint(1)\n```', 'a half closer is held')
  assert.equal(streamSafe('a\n```py\nx = **y'), 'a\n```py\nx = **y\n```', 'nothing inside a fence is touched')
  assert.equal(streamSafe('a\n~~~\nx'), 'a\n~~~\nx\n~~~')
  assert.equal(streamSafe('a\n```\nx\n```\nafter **b'), 'a\n```\nx\n```\nafter **b**')
  assert.equal(streamSafe('a\n- '), 'a\n')
  assert.equal(streamSafe('a\n1.'), 'a\n')
  assert.equal(streamSafe('a\n## '), 'a\n')
  assert.equal(streamSafe('a\n---'), 'a\n', 'a rule or setext underline is held')
  assert.equal(streamSafe('| a | b |'), '')
  assert.equal(streamSafe('| a | b |\n|--'), '', 'the header waits for its separator')
  assert.equal(streamSafe('| a | b |\n|---|---|\n| 1 |'), '| a | b |\n|---|---|\n| 1 |', 'a short row is a valid GFM row (omitted cells are empty): shown')
  assert.equal(streamSafe('| a | b |\n|---|---|\n| 1 | 2 |\n'), '| a | b |\n|---|---|\n| 1 | 2 |\n')
})

test('streamSafe: every prefix of a long reply is a kept prefix plus closers, never loses text, and is fast', () => {
  for (let i = 0; i <= SAMPLE.length; i += 1) {
    const input = SAMPLE.slice(0, i)
    const { text, held } = streamSafeParts(input)
    assert.ok(input.endsWith(held), 'held is the tail')
    const extra = closersOf(input, text)
    assert.match(extra, /^(\n?(```|~~~)|[`*_]*)$/, `only closers added at ${i}: ${JSON.stringify(extra)}`)
    assert.ok(!/\bMEDIA:\s*\S*$/.test(text.split('\n').at(-1) || '') || /\.png$/.test(text), `no half MEDIA path at ${i}`)
    assert.ok(!/::card\{[^}]*$/.test(text), `no half directive at ${i}`)
  }
  assert.equal(streamSafe(SAMPLE), SAMPLE, 'a complete reply comes back unchanged')
  // 20k characters, streamed in 40-character ticks: every tick well under a frame.
  const big = `${SAMPLE}\n\n`.repeat(Math.ceil(20_000 / SAMPLE.length)).slice(0, 20_000)
  // CPU time, best of 3 runs per tick (test/tick-timing.mjs): load-robust.
  const { worst, total } = bestTickMs(streamSafe, big)
  assert.ok(worst < 16, `worst tick ${worst.toFixed(2)}ms`)
  assert.ok(total < 2000, `total ${total.toFixed(0)}ms`)
})

test('silence: a streaming [SILENT] prefix still never shows', () => {
  let s = applyEvent(initialChatState(), { type: 'message.start', payload: {} }, 1)
  s = applyEvent(s, { type: 'message.delta', payload: { text: '[SIL' } }, 2)
  assert.deepEqual(visibleItems(s.items, true), [])
  assert.equal(streamSafe('[SIL'), '', 'and it is a half link to streamSafe too')
})

// ---- render harness (dev/preview-entry.tsx, the real components) ----

let preview = null
async function harness(t) {
  if (!preview) {
    const { bundlePreview } = await import('../dev/bundle.mjs')
    const file = await bundlePreview()
    t.after(() => rmSync(dirname(file), { recursive: true, force: true }))
    preview = await import(pathToFileURL(file).href)
  }
  return preview
}

const CARD_FILES = {
  'cards/c-1.json': { text: JSON.stringify({ schema: 'card.v1', kind: 'task', title: 'Demo task', status: { state: 'running' } }) }
}

async function botMessage(t, text, { streaming, cards = false } = {}) {
  const { render } = await harness(t)
  const { JSDOM } = await import('jsdom')
  const items = [
    { kind: 'user', id: 'u1', text: 'plan my week', at: 1_762_560_000_000 },
    { kind: 'assistant', id: 'a1', text, at: 1_762_560_030_000, ...(streaming ? { streaming: true } : {}) }
  ]
  const html = render({ items, busy: Boolean(streaming), directiveFiles: cards ? CARD_FILES : null, panelOpen: false })
  const doc = new JSDOM(html).window.document
  const msg = doc.querySelector('.gbo-msg.is-bot')
  assert.ok(msg, 'the bot message')
  return msg
}

/** The message's prose markup, the streaming class and caret taken out. */
const proseMarkup = msg => {
  const copy = msg.cloneNode(true)
  copy.querySelectorAll('.gbo-msg-actions, [class*="gbo-actions"], .gbo-hover-actions').forEach(el => el.remove())
  const bubbles = [...copy.querySelectorAll('.bubble-wrap')].map(el => el.outerHTML.replace(/ is-streaming/g, ''))
  return bubbles.join('\n')
}

test('render: a streaming **bold mid-way draws bold, never raw **', { skip }, async t => {
  const msg = await botMessage(t, 'Here is **the short ver', { streaming: true })
  const bubble = msg.querySelector('.bubble.is-agent')
  assert.ok(bubble.classList.contains('is-streaming'), 'the live caret class stays')
  assert.ok(bubble.querySelector('.md'), 'the same prose element as a finished reply')
  assert.equal(bubble.querySelector('.bubble__plain'), null, 'no plain-text streaming box')
  assert.equal(bubble.querySelector('strong')?.textContent, 'the short ver')
  assert.ok(!bubble.textContent.includes('**'), bubble.textContent)
  const trailing = await botMessage(t, 'Here is **', { streaming: true })
  assert.ok(!trailing.textContent.includes('**'))
})

test('render: an open fence draws the Copy code block, and it grows', { skip }, async t => {
  const one = await botMessage(t, 'Run this:\n\n```sh\nnpm ci', { streaming: true })
  const two = await botMessage(t, 'Run this:\n\n```sh\nnpm ci\nnpm test', { streaming: true })
  assert.equal(one.querySelector('.gbo-code pre').textContent, 'npm ci')
  assert.equal(two.querySelector('.gbo-code pre').textContent, 'npm ci\nnpm test')
  assert.ok(two.querySelector('.gbo-code button.gbo-code-copy'), 'Copy is there while it streams')
  assert.ok(!two.textContent.includes('```'))
})

test('render: the last streaming tick and the finished reply draw the same prose markup', { skip }, async t => {
  for (const text of ['Plain words.', 'Here is **bold** and `code`.\n\n- one\n- two', 'Run:\n\n```sh\nnpm ci\n```\n\nDone.', SAMPLE]) {
    const live = await botMessage(t, text, { streaming: true, cards: true })
    const done = await botMessage(t, text, { cards: true })
    assert.equal(proseMarkup(live), proseMarkup(done), JSON.stringify(text.slice(0, 30)))
    assert.equal(live.querySelectorAll('.gbo-directive').length, done.querySelectorAll('.gbo-directive').length)
  }
})

test('render: a directive half-way shows a placeholder; complete, the card', { skip }, async t => {
  const half = await botMessage(t, 'On it.\n\n::card{id="c-1" kind="task" file="cards/c-', { streaming: true, cards: true })
  assert.ok(half.querySelector('.gbo-directive.is-pending .gbo-dcard-skeleton'), 'the skeleton placeholder')
  assert.ok(!half.textContent.includes('::card'), half.textContent)
  const whole = await botMessage(t, 'On it.\n\n::card{id="c-1" kind="task" file="cards/c-1.json"}', { streaming: true, cards: true })
  assert.equal(whole.querySelector('.gbo-directive.is-pending'), null)
  assert.ok(whole.querySelector('.gbo-directive .gbo-dcard'), 'the card')
  assert.ok(!whole.textContent.includes('::card'))
})

test('render: a MEDIA line never shows as raw text while it streams', { skip }, async t => {
  for (let i = 1; i <= 'MEDIA: /tmp/demo/chart.png'.length; i += 1) {
    const text = `Chart below.\n${'MEDIA: /tmp/demo/chart.png'.slice(0, i)}`
    const msg = await botMessage(t, text, { streaming: true })
    assert.ok(!msg.textContent.includes('MEDIA'), JSON.stringify(text))
    assert.ok(!msg.textContent.includes('/tmp/demo'), JSON.stringify(text))
  }
})

test('render: the finished reply is drawn from its full text, untouched', { skip }, async t => {
  // Text streamSafe would hold or close while streaming draws in full once done.
  const text = 'Trailing star *\n\nsee [x] and ::prev\n\n| a |'
  const done = await botMessage(t, text)
  assert.ok(!done.querySelector('.is-streaming'))
  for (const piece of ['Trailing star *', 'see [x] and ::prev', '| a |']) assert.ok(done.textContent.includes(piece), piece)
  const live = await botMessage(t, text, { streaming: true })
  assert.ok(!live.textContent.includes('| a |'), 'held while streaming')
})

test('CSS: the live caret sits inline after the last text line', { skip }, async t => {
  const { CSS } = await harness(t)
  // Scoped to the override's root (styles.ts): `.bubble.is-streaming:where(…) .md …`.
  assert.match(CSS, /\.bubble\.is-streaming:where\([^)]*\) \.md > :last-child::after \{ content: none; \}/)
  assert.match(CSS, /\.bubble\.is-streaming:where\([^)]*\) \.md > :last-child > :is\(p, h1, h2, h3, h4, h5, h6\):last-child::after/)
  assert.ok(CSS.includes('.gbo-dcard-skeleton'))
})
