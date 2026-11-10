// Rough edges 16, part 3: a fenced code block in a bot bubble was drawn by
// the SDK renderer in a box capped at 7.5rem with a bare chevron and no way
// to copy it. The override draws fences itself (core/fences.js,
// ui/CodeBlock.tsx): a Copy pill top-right that copies the raw text exactly
// ("Copied" for 1.5 s), full height up to 60 lines (a ~40-line handoff
// shows whole), longer blocks folded behind "Show more" / "Show less".
// Demo content only.

import assert from 'node:assert/strict'
import { existsSync, rmSync } from 'node:fs'
import { dirname } from 'node:path'
import test from 'node:test'
import { pathToFileURL } from 'node:url'

import { CODE_FOLD_LINES, codeFolds, codeLineCount, splitFences } from '../src/core/fences.js'
import { bootPlugin, history, READY, waitFor } from './loader-boot.mjs'

const skip = !READY && 'dev dependencies not installed'

const HANDOFF = Array.from({ length: 40 }, (_, i) => (i === 0 ? 'Move these demo bots over:' : `${i}. Demo Bot ${i}  — keep its \`config\` & <notes>`)).join('\n')
const LONG = Array.from({ length: 75 }, (_, i) => `line ${i + 1}`).join('\n')
const MESSAGE = `Copy and paste this:\n\n\`\`\`text\n${HANDOFF}\n\`\`\`\n\nAnd the long one:\n\n~~~\n${LONG}\n~~~`

test('splitFences: prose and blocks in order, raw text kept exactly, language read', () => {
  const parts = splitFences(MESSAGE)
  assert.deepEqual(parts.map(p => p.kind), ['text', 'code', 'text', 'code'])
  assert.equal(parts[1].code, HANDOFF)
  assert.equal(parts[1].lang, 'text')
  assert.equal(parts[3].code, LONG)
  assert.equal(parts[3].lang, '')
  assert.equal(parts[0].text.trim(), 'Copy and paste this:')
})

test('splitFences: CommonMark edges (longer closer, indented opener, unclosed, inline backticks, no fence)', () => {
  assert.deepEqual(splitFences('````md\n```\ninner\n```\n````'), [{ kind: 'code', code: '```\ninner\n```', lang: 'md' }])
  assert.deepEqual(splitFences('  ```\n  a\n    b\n  ```'), [{ kind: 'code', code: 'a\n  b', lang: '' }])
  assert.deepEqual(splitFences('x\n```js\nopen()'), [{ kind: 'text', text: 'x' }, { kind: 'code', code: 'open()', lang: 'js' }])
  assert.deepEqual(splitFences('use ```inline``` here'), [{ kind: 'text', text: 'use ```inline``` here' }])
  assert.deepEqual(splitFences('``` a`b\nnot a fence'), [{ kind: 'text', text: '``` a`b\nnot a fence' }])
  assert.deepEqual(splitFences('    ```\n    indented code'), [{ kind: 'text', text: '    ```\n    indented code' }], 'four spaces is not a fence')
  assert.deepEqual(splitFences('plain'), [{ kind: 'text', text: 'plain' }])
  assert.deepEqual(splitFences('```\n```'), [{ kind: 'code', code: '', lang: '' }])
})

test('fold: up to 60 lines in full (a 40-line handoff), longer ones fold', () => {
  assert.equal(CODE_FOLD_LINES, 60)
  assert.equal(codeLineCount(HANDOFF), 40)
  assert.equal(codeFolds(HANDOFF), false)
  assert.equal(codeFolds(Array.from({ length: 60 }, () => 'x').join('\n')), false)
  assert.equal(codeFolds(LONG), true)
  assert.equal(codeLineCount('a\n'), 1)
})

test('CSS: block, pill and fold rules; the block colour is set for light and dark', { skip }, async () => {
  const { bundlePreview } = await import('../dev/bundle.mjs')
  const file = await bundlePreview()
  try {
    const { CSS } = await import(pathToFileURL(file).href)
    assert.match(CSS, /\[data-gbo-root\] \{[^}]*--g-color-code-block: #FAFAFA;/)
    assert.match(CSS, /\.dark \[data-gbo-root\], \[data-gbo-root\]\[data-gbo-theme="dark"\] \{[^}]*--g-color-code-block: #1A1A1A;/)
    assert.ok(CSS.includes('.gbo-code-copy'), 'the Copy pill')
    // Folded height = 40 lines at the block's own line height (px scaled to Hermes's zoom) + padding.
    const lineHeight = /\.md:where\(\[data-gbo-root\], \[data-gbo-root\] \*\) pre \{[^}]*line-height: ([\d.]+)px;/.exec(CSS)?.[1]
    assert.ok(lineHeight, 'the bubble pre line height')
    assert.ok(CSS.includes(`.gbo-code pre.is-folded { max-height: calc(var(--gbo-code-lines) * ${lineHeight}px + 17.86px); overflow-y: hidden; }`))
    assert.match(CSS, /\.gbo-code pre \{[^}]*background: var\(--g-color-code-block\)/)
  } finally {
    rmSync(dirname(file), { recursive: true, force: true })
  }
})

test('loader: every block has Copy that copies the exact text, Copied for 1.5 s; the long block has Show more / Show less', { skip }, async t => {
  const written = []
  const withCode = profile => {
    const page = history(profile)
    page.messages = [...page.messages, { id: 30, role: 'assistant', content: MESSAGE, timestamp: 1762560100 }]
    return page
  }
  const booted = await bootPlugin(t, { historyFor: withCode })
  Object.defineProperty(globalThis.navigator, 'clipboard', { configurable: true, value: { writeText: async text => void written.push(text) } })
  const rosterEl = booted.mount(booted.panes.find(p => p.id === 'roster').render)
  ;(await waitFor(() => [...rosterEl.querySelectorAll('button.gbo-row')].find(b => b.textContent.includes('Scholar')), 'row')).click()
  const workspace = await waitFor(() => booted.workspaces.get('grokbot-override'), 'workspace')
  const chatEl = booted.mount(workspace.render)
  const blocks = await waitFor(() => {
    const found = chatEl.querySelectorAll('.bubble.is-agent .gbo-code')
    return found.length === 2 ? [...found] : null
  }, 'two code blocks')
  assert.equal(blocks[0].querySelector('pre').textContent, HANDOFF, 'the block shows the raw text')
  assert.ok(chatEl.textContent.includes('Copy and paste this:'), 'the prose around it still renders')

  const copy = blocks[0].querySelector('button.gbo-code-copy')
  assert.equal(copy.textContent, 'Copy')
  copy.click()
  await waitFor(() => copy.textContent === 'Copied', 'Copied')
  assert.deepEqual(written, [HANDOFF], 'exactly the block text')
  await waitFor(() => copy.textContent === 'Copy', 'back to Copy', 2500)

  assert.equal(blocks[0].querySelector('.gbo-code-more'), null, 'a 40-line handoff shows in full, no Show more')
  assert.equal(blocks[0].querySelector('pre').classList.contains('is-folded'), false)
  const more = blocks[1].querySelector('button.gbo-code-more')
  assert.equal(more.textContent, 'Show more')
  assert.ok(blocks[1].querySelector('pre').classList.contains('is-folded'))
  more.click()
  await waitFor(() => more.textContent === 'Show less', 'Show less')
  assert.equal(blocks[1].querySelector('pre').classList.contains('is-folded'), false)
  assert.equal(more.getAttribute('aria-expanded'), 'true')
  more.click()
  await waitFor(() => more.textContent === 'Show more', 'folded again')
  blocks[1].querySelector('button.gbo-code-copy').click()
  await waitFor(() => written.length === 2, 'second copy')
  assert.equal(written[1], LONG, 'a folded block copies all of it')
})
