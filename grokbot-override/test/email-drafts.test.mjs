// Email draft cards (core/emailDrafts.js, ui/EmailDraft.tsx): a bot's
// `email_draft_create` result becomes a card in the chat; the card reads and
// writes the draft through the bot's own gateway (plugin RPC, else the
// plugin's slash command), on the bot's route. Fake plugin, demo addresses
// only; nothing is sent anywhere.

import assert from 'node:assert/strict'
import test from 'node:test'

import {
  callDrafts,
  createSingleFlight,
  draftFromToolResult,
  draftState,
  editsFrom,
  inReplyText,
  isDirty,
  parseAddresses,
  withEmailDrafts
} from '../src/core/emailDrafts.js'
import { READY } from './loader-boot.mjs'
import { fakePlugin, ID, created, notServed, openScholar, button } from './email-drafts-fixture.mjs'

const skip = !READY && 'dev dependencies not installed'

// ── core ──────────────────────────────────────────────────────────────────

test('draftFromToolResult: the draft summary from JSON, from a clipped result, and nothing else', () => {
  assert.equal(draftFromToolResult(created()).id, ID)
  const clipped = `${created().slice(0, 90)}\n… (400 more characters)`
  assert.deepEqual(draftFromToolResult(clipped), { id: ID, status: 'pending' })
  assert.equal(draftFromToolResult(JSON.stringify({ ok: false, status: 'disabled', error: 'Email drafts are turned off' })), null)
  assert.equal(draftFromToolResult(JSON.stringify({ ok: true, email_draft: { id: '../../etc' } })), null)
  assert.equal(draftFromToolResult('file body'), null)
  assert.equal(draftFromToolResult(null), null)
})

test('withEmailDrafts: one card per draft, after the tool group that created it; later results only refresh it', () => {
  const items = [
    { kind: 'user', id: 'u1', text: 'email Sam' },
    { kind: 'tools', id: 'g1', at: 5, tools: [{ id: 't1', name: 'email_draft_create', status: 'done', result: created() }] },
    { kind: 'assistant', id: 'a1', text: 'Draft is ready.' },
    { kind: 'tools', id: 'g2', at: 9, tools: [{ id: 't2', name: 'email_draft_update', status: 'done', result: JSON.stringify({ ok: true, email_draft: { id: ID, status: 'pending', rev: 2 } }) }] },
    { kind: 'tools', id: 'g3', at: 10, tools: [{ id: 't3', name: 'email_draft_create', status: 'running' }] }
  ]
  const out = withEmailDrafts(items)
  assert.deepEqual(out.map(i => i.id), ['u1', 'g1', `email-draft:${ID}`, 'a1', 'g2', 'g3'])
  const card = out[2]
  assert.equal(card.kind, 'email-draft')
  assert.equal(card.draftId, ID)
  assert.equal(card.at, 5)
  assert.equal(card.hint.rev, 2, 'the newest summary rides along')
  const plain = [{ kind: 'tools', id: 'g', tools: [{ id: 't', name: 'read_file', status: 'done', result: 'x' }] }]
  assert.equal(withEmailDrafts(plain), plain, 'no draft: the same array')
})

test('callDrafts: plugin RPC first; only a "not served" refusal falls back to the slash command, once', async () => {
  const calls = []
  const rpc = async (method, params, options) => (calls.push([method, params, options]), { ok: true, draft: { id: ID } })
  assert.equal((await callDrafts(rpc, 'get', { id: ID })).draft.id, ID)
  assert.deepEqual(calls[0].slice(0, 2), ['plugin.email-drafts.api', { op: 'get', id: ID }])

  const fallback = []
  const legacy = async (method, params) => {
    fallback.push([method, params])
    if (method === 'plugin.email-drafts.api') throw notServed()
    return { output: JSON.stringify({ ok: true, draft: { id: ID, status: 'sent' } }) }
  }
  assert.equal((await callDrafts(legacy, 'send', { id: ID, rev: 1 })).draft.status, 'sent')
  assert.deepEqual(fallback[1], ['slash.exec', { command: `/email-drafts api send {"id":"${ID}","rev":1}` }])

  // Any other failure (a timeout, a handler error) may have sent it: no second call.
  let n = 0
  const lost = async () => {
    n += 1
    throw Object.assign(new Error('timed out'), { code: -32000 })
  }
  await assert.rejects(callDrafts(lost, 'send', { id: ID }), /timed out/)
  assert.equal(n, 1)

  // A gateway without the plugin prints something that is not its JSON.
  const missing = async method => {
    if (method !== 'slash.exec') throw notServed()
    return { output: 'Unknown command: /email-drafts' }
  }
  await assert.rejects(callDrafts(missing, 'get', { id: ID }), /not enabled for this bot/)
  await assert.rejects(callDrafts(null, 'get', { id: ID }), /Open this bot/)
})

test('createSingleFlight: a second click while the first runs is dropped synchronously', async () => {
  const flight = createSingleFlight()
  let sends = 0
  let release
  const job = () => new Promise(resolve => ((release = resolve), (sends += 1)))
  const first = flight.run(job)
  const second = flight.run(job)
  assert.equal(await second, null)
  assert.equal(flight.busy, true)
  release('done')
  assert.equal(await first, 'done')
  assert.equal(sends, 1)
  assert.equal(flight.busy, false)
})

test('addresses, states and labels', () => {
  assert.deepEqual(parseAddresses('sam@example.com, Lee@Example.org; sam@example.com  <x@example.net> nope'), {
    list: ['sam@example.com', 'Lee@Example.org', 'x@example.net'],
    bad: ['nope']
  })
  const clock = () => '3:42 PM'
  assert.equal(draftState({ status: 'sent', sent_at: 1762560000, sent_by: 'human' }, clock).line, 'Sent · 3:42 PM')
  assert.equal(draftState({ status: 'sent', sent_at: 1762560000, sent_by: 'allow-rule' }, clock).line, 'Sent automatically · 3:42 PM · allowed recipient')
  assert.deepEqual(draftState({ status: 'failed', error: 'SMTP sign-in failed' }).actions, ['discard', 'retry'])
  assert.equal(draftState({ status: 'failed', error: 'SMTP sign-in failed' }).line, 'Not sent: SMTP sign-in failed')
  assert.deepEqual(draftState({ status: 'failed', delivery_unknown: true, error: 'Delivery unknown' }).actions, ['discard'], 'never Retry an unknown delivery')
  assert.deepEqual(draftState({ status: 'pending' }).actions, ['discard', 'send'])
  assert.equal(draftState({ status: 'discarded' }).editable, false)
  assert.equal(inReplyText({ subject: 'Pricing?', from: 'Sam <sam@example.com>' }), '“Pricing?” from Sam <sam@example.com>')
  const draft = { to: ['sam@example.com'], cc: [], subject: 'S', body: 'B' }
  assert.equal(isDirty({ to: 'sam@example.com', cc: '', subject: 'S', body: 'B' }, draft), false)
  assert.equal(isDirty({ to: 'sam@example.com', cc: 'x@example.net', subject: 'S', body: 'B' }, draft), true)
  assert.deepEqual(editsFrom({ to: 'a@example.com b@example.com', cc: '', subject: 's', body: 'b' }).to, ['a@example.com', 'b@example.com'])
})

// ── the card in the running plugin ────────────────────────────────────────

test('loader: create → card renders (work rows hidden), read through the remote bot’s own route', { skip }, async t => {
  const plugin = fakePlugin()
  const { booted, chatEl, card } = await openScholar(t, plugin)
  assert.equal(card.dataset.draftId, ID)
  assert.equal(chatEl.querySelectorAll('.gbo-email-draft').length, 1)
  assert.equal(chatEl.querySelector('.gbo-tools'), null, 'tool rows stay hidden; the card does not')
  assert.equal(card.querySelector('.gbo-ed-subject').value, 'Re: pricing')
  const rows = [...card.querySelectorAll('.gbo-ed-row')].map(r => r.textContent)
  assert.deepEqual(rows.slice(0, 2), ['Fromme@example.com', 'In reply to“pricing” from Sam <sam@example.com>'])
  assert.equal(card.querySelector('input[aria-label="To"]').value, 'sam@example.com')
  assert.equal(card.querySelector('input[aria-label="Cc"]').getAttribute('placeholder'), 'name@example.com')
  assert.equal(card.querySelector('textarea.gbo-ed-body').value, 'Hi Sam,\n\nThe price sheet is attached.')
  assert.equal(card.querySelector('.gbo-ed-signature').textContent, 'Demo Sender\nexample.com')
  const file = card.querySelector('.gbo-file-card')
  assert.equal(file.dataset.path, '/workspace/demo/price-sheet.csv', 'attachments use the chat’s file card')
  assert.equal(card.querySelector('.gbo-ed-rules').textContent, 'Needs approval')
  assert.ok(button(card, 'Discard') && button(card, 'Send'))
  // The bubble under it is the bot's one line.
  assert.ok(chatEl.textContent.includes('Draft to Sam is ready on the card above.'))
  // Read through the bot's own route and its attached runtime: a remote bot's
  // draft lives on its own machine.
  const read = booted.calls.find(c => c.method === 'plugin.email-drafts.api')
  assert.equal(read.via, 'home-server::scholar')
  assert.deepEqual(read.params, { op: 'get', id: ID, session_id: 'rt-scholar' })
  assert.equal(plugin.ops.filter(o => o.op === 'send').length, 0, 'drawing never sends')
})

test('CSS: the card, its rows, body box, footer and rules dialog are scoped; their tokens exist in light and dark', { skip }, async () => {
  const { rmSync } = await import('node:fs')
  const { dirname } = await import('node:path')
  const { pathToFileURL } = await import('node:url')
  const { bundlePreview } = await import('../dev/bundle.mjs')
  const file = await bundlePreview()
  try {
    const { CSS } = await import(pathToFileURL(file).href)
    const scope = ':where([data-gbo-root], [data-gbo-root] *)'
    const block = sel => {
      const start = CSS.indexOf(`${sel}${scope} {`)
      return start < 0 ? '' : CSS.slice(start, CSS.indexOf('}', start))
    }
    assert.match(block('.gbo-email-draft'), /border-radius: 22\.32px;[\s\S]*background: var\(--g-color-bg-elevated\);[\s\S]*box-shadow: var\(--g-shadow-card\);/)
    assert.match(block('.gbo-ed-row'), /border-bottom: 0\.5px solid var\(--g-color-border-tertiary\);/)
    assert.match(block('.gbo-ed-body'), /background: var\(--g-color-bg-subtle\);/)
    assert.match(block('.gbo-ed-send'), /background: var\(--g-color-primary\);[\s\S]*color: var\(--g-color-bg-chrome\);/)
    assert.match(block('.gbo-ed-signature'), /color: var\(--g-color-text-tertiary\);/)
    for (const token of ['bg-elevated', 'bg-subtle', 'border-tertiary', 'primary', 'bg-chrome', 'text-tertiary', 'danger-text', 'success-text']) {
      assert.match(CSS, new RegExp(`\\[data-gbo-root\\] \\{[^}]*--g-color-${token}: `), `light ${token}`)
      assert.match(CSS, new RegExp(`\\.dark \\[data-gbo-root\\], \\[data-gbo-root\\]\\[data-gbo-theme="dark"\\] \\{[^}]*--g-color-${token}: `), `dark ${token}`)
    }
  } finally {
    rmSync(dirname(file), { recursive: true, force: true })
  }
})
