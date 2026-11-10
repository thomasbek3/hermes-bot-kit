// Cards 8: a live `::card` sits in the choice card's shell. The title is the
// bold heading, a one-line body the question under it, the actions lettered
// rows (no pills, no filled primary); chips only for running, done and error.

import assert from 'node:assert/strict'
import { existsSync, readFileSync, rmSync } from 'node:fs'
import { dirname } from 'node:path'
import test from 'node:test'
import { pathToFileURL } from 'node:url'

import { cardChip, cardLead, validateCard } from '../src/core/directives.js'

const ready = existsSync(new URL('../node_modules/esbuild', import.meta.url)) && existsSync(new URL('../node_modules/react-dom', import.meta.url))

const base = {
  schema: 'card.v1',
  kind: 'approval',
  title: 'Quick check',
  status: { state: 'awaiting-approval', label: 'Your choice' },
  body: [{ type: 'text', text: 'Can you see this card?' }],
  actions: [
    { label: 'Yes', style: 'primary', send: 'yes' },
    { label: 'No', send: 'no' },
    { label: 'Delete it', style: 'danger', send: 'delete' }
  ]
}

test('chips: none for approval cards or waiting states; running, done and error keep one', () => {
  assert.equal(cardChip(validateCard(base)), null)
  assert.equal(cardChip(validateCard({ ...base, status: { state: 'done' } })), null, 'an approval card never shows a chip')
  for (const state of ['pending', 'awaiting-approval']) assert.equal(cardChip(validateCard({ ...base, kind: 'task', status: { state } })), null, state)
  assert.deepEqual(cardChip(validateCard({ ...base, kind: 'task', status: { state: 'running' } })), { state: 'running', label: 'Running' })
  assert.deepEqual(cardChip(validateCard({ ...base, kind: 'task', status: { state: 'done', label: 'Sorted' } })), { state: 'done', label: 'Sorted' })
  assert.equal(cardChip(validateCard({ ...base, kind: 'draft-email', status: { state: 'error' } })).state, 'error')
})

test('the question line: one short text line under a title; anything else stays a body block', () => {
  assert.equal(cardLead(validateCard(base)), 'Can you see this card?')
  assert.equal(cardLead(validateCard({ ...base, body: [] })), null, 'no body: the title alone is the question')
  assert.equal(cardLead(validateCard({ ...base, body: [{ type: 'text', text: 'one\ntwo' }] })), null)
  assert.equal(cardLead(validateCard({ ...base, body: [{ type: 'text', text: 'x'.repeat(201) }] })), null)
  assert.equal(cardLead(validateCard({ ...base, body: [...base.body, { type: 'kv', rows: [['a', 'b']] }] })), null)
})

test('action styles: primary and danger kept, anything else default', () => {
  const card = validateCard({ ...base, actions: [...base.actions.slice(0, 2), { label: 'x', style: 'loud', send: 'x' }] })
  assert.deepEqual(card.actions.map(a => a.style), ['primary', 'default', 'default'])
  assert.equal(validateCard(base).actions[2].style, 'danger')
})

test('live cards render in the choice card shell, light and dark', { skip: !ready && 'dev dependencies not installed' }, async t => {
  const { bundlePreview } = await import('../dev/bundle.mjs')
  const file = await bundlePreview()
  t.after(() => rmSync(dirname(file), { recursive: true, force: true }))
  const m = await import(pathToFileURL(file).href)
  const page = (items, files, theme = 'dark') => {
    const html = m.render({ theme, botIndex: 1, items, busy: false, hasMore: false, directiveFiles: files })
    const start = html.indexOf('<div class="gbo-dcard')
    return { html, card: html.slice(start, html.indexOf('</button></div>', html.indexOf('gbo-dcard-rows', start)) + 9) }
  }

  for (const theme of ['light', 'dark']) {
    const { html, card } = page(m.LIVE_APPROVAL_ITEMS, m.LIVE_APPROVAL_FILES, theme)
    assert.ok(html.includes('data-gbo-card="approval"'))
    assert.match(card, /class="gbo-dcard-title"[^>]*>Quick check</)
    assert.match(card, /class="gbo-dcard-text is-lead">Can you see this card\?</, 'the one-line body is the question at body size')
    assert.ok(!card.includes('gbo-dcard-status'), 'no chip on a waiting approval card')
    assert.ok(!card.includes('Your choice'))
    assert.ok(!card.includes('gbo-pill-btn'), 'no pill buttons')
    assert.ok(!card.includes('is-primary'), 'primary is not styled differently')
    const rows = card.match(/<button[^>]*class="gbo-ask-row[^"]*"[^>]*>.*?<\/button>/g)
    assert.equal(rows.length, 2)
    assert.match(rows[0], /class="gbo-ask-key"[^>]*>A<.*class="gbo-ask-label">Yes</)
    assert.match(rows[1], /class="gbo-ask-key"[^>]*>B<.*class="gbo-ask-label">No</)
    assert.ok(rows.every(r => r.includes('role="radio"') && !r.includes('disabled')), 'waiting: clickable rows')
  }

  const settled = page(m.LIVE_APPROVAL_SETTLED_ITEMS, m.LIVE_APPROVAL_SETTLED_FILES).card
  assert.ok(settled.includes('gbo-dcard-rows is-settled'))
  assert.ok(!settled.includes('gbo-dcard-status'), 'resolved approval: still no chip')
  const rows = settled.match(/<button[^>]*>.*?<\/button>/g)
  assert.ok(rows.every(r => r.includes('disabled')), 'resolved: rows frozen')
  assert.match(rows[0], /class="gbo-ask-row is-on"/)
  assert.match(rows[0], /aria-checked="true"/)
  assert.ok(rows[0].includes('gbo-ask-check'), 'the chosen row is checked as the settled clarify card does')
  assert.match(rows[1], /class="gbo-ask-row"/)

  const task = m.render({ theme: 'dark', botIndex: 1, items: m.LIVE_TASK_ITEMS, busy: true, hasMore: false, directiveFiles: m.LIVE_TASK_FILES })
  assert.match(task, /class="gbo-dcard-status is-running" role="status"><span class="gbo-dcard-spin"[^>]*><\/span>Running</)
  assert.ok(task.includes('Merging duplicates and sorting by date added.'), 'a text block with other blocks stays a body block')
  assert.ok(task.includes('<dt>Checked</dt><dd>42 of 60</dd>'))
  assert.match(task, /class="gbo-ask-row is-danger"/, 'danger keeps a red label only')

  const email = m.render({ theme: 'light', botIndex: 1, items: m.LIVE_EMAIL_ITEMS, busy: false, hasMore: false, directiveFiles: m.DIRECTIVE_FILES })
  assert.match(email, /class="gbo-dcard-title"[^>]*>This week’s reading</)
  assert.ok(email.includes('<dt>To</dt><dd>book-club@example.com</dd>'))
  assert.ok(email.includes('gbo-dcard-text is-email'))
  assert.ok(!/data-gbo-card="draft-email"[\s\S]*?gbo-dcard-status/.test(email.slice(0, email.indexOf('Send it'))), 'awaiting approval: no chip')
  assert.match(email, /class="gbo-ask-label">Send it</)

  const CSS = readFileSync(new URL('../src/ui/styles-adapt.ts', import.meta.url), 'utf8')
  for (const rule of ['.gbo-dcard {', '.gbo-dcard-rows.is-settled .gbo-ask-row:not(.is-on)', '.gbo-ask-row.is-danger .gbo-ask-label', '.gbo-dcard-text.is-lead']) {
    assert.ok(CSS.includes(rule), rule)
  }
  assert.ok(!/\.gbo-dcard-actions|\.gbo-dcard-foot/.test(CSS), 'the old pill row is gone')
})
