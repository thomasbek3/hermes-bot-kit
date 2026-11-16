// The composer's "delivery unknown" note follows the bubble's history check
// (core/drafts.js deliveryNote, src/ui/Composer.tsx): "checking" while the
// chat looks for the message, gone once it is found (markDelivered), a short
// "couldn't confirm" once the check finds nothing or cannot read the history,
// and cleared by the next send or a bot switch. A definite refusal keeps its
// draft-recovery note. Hand-run timers and microtask flushes only, no sleeps.

import assert from 'node:assert/strict'
import { existsSync, rmSync } from 'node:fs'
import { dirname } from 'node:path'
import test, { afterEach } from 'node:test'
import { pathToFileURL } from 'node:url'

import { CHECKING_DELIVERY_NOTE, deliveryNote, failureNote, UNCONFIRMED_DELIVERY_NOTE, unknownSendId } from '../src/core/drafts.js'
import { createChatController } from '../src/core/session.js'
import { BOT, flush, gateway } from './harness.mjs'

const settle = async (n = 10) => {
  for (let i = 0; i < n; i += 1) await flush()
}

// A submit that gets no answer (the dispatch probe tore the connection down):
// no code = "no answer" = delivery unknown (core/outcomes.js).
const noAnswer = () => {
  throw new Error('connection closed before the gateway answered')
}
const tail = rows => ({ session_id: 'tip', messages: rows, pagination: { limit: 120, offset: 0, order: 'latest', returned: rows.length } })
const OPEN_ROWS = [
  { id: 1, role: 'user', content: 'hi', timestamp: 1762560000 },
  { id: 2, role: 'assistant', content: 'hello', timestamp: 1762560001 }
]

async function unknownSend(restAfter) {
  let reads = 0
  const gw = gateway({
    'prompt.submit': noAnswer,
    REST: () => ((reads += 1), reads === 1 ? tail(OPEN_ROWS) : restAfter())
  })
  const chat = createChatController(BOT, gw.deps)
  await chat.open()
  const result = await chat.sendDraft('second message', [])
  return { gw, chat, result }
}

test('unknown → found: "checking", then the note clears once the history shows the message', async () => {
  const { gw, chat, result } = await unknownSend(() =>
    tail([...OPEN_ROWS, { id: 3, role: 'user', content: 'second message', timestamp: 1762560010 }, { id: 4, role: 'assistant', content: 'got it', timestamp: 1762560030 }])
  )
  assert.equal(result.delivery, 'unknown')
  const id = unknownSendId(result)
  assert.ok(id)
  assert.equal(deliveryNote(chat.get().chat.items, id), CHECKING_DELIVERY_NOTE)
  await gw.runTimers()
  await settle()
  assert.equal(deliveryNote(chat.get().chat.items, id), '', 'confirmed: no note')
  chat.dispose()
})

test('unknown → not found, or the history unreadable: the short "couldn’t confirm" note', async () => {
  for (const restAfter of [
    () => tail(OPEN_ROWS),
    () => {
      throw new Error('history unavailable')
    }
  ]) {
    const { gw, chat, result } = await unknownSend(restAfter)
    const id = unknownSendId(result)
    for (let i = 0; i < 5; i += 1) {
      await gw.runTimers()
      await settle()
    }
    const note = deliveryNote(chat.get().chat.items, id)
    assert.equal(note, UNCONFIRMED_DELIVERY_NOTE)
    assert.ok(!/retry|send again|resend it/i.test(note), 'never invites a blind resend')
    chat.dispose()
  }
})

test('unknown, then found by a later idle refresh: the note clears', async () => {
  let found = false
  const { gw, chat, result } = await unknownSend(() =>
    tail(found ? [...OPEN_ROWS, { id: 3, role: 'user', content: 'second message', timestamp: 1762560010 }] : OPEN_ROWS)
  )
  const id = unknownSendId(result)
  await gw.runTimers()
  await settle()
  assert.equal(deliveryNote(chat.get().chat.items, id), UNCONFIRMED_DELIVERY_NOTE)
  found = true
  await chat.refresh()
  assert.equal(deliveryNote(chat.get().chat.items, id), '')
  chat.dispose()
})

test('pure rules: only an unknown send is followed; a refusal keeps its recovery note', () => {
  assert.equal(unknownSendId({ ok: false, delivery: 'unknown', clientId: 'local:1' }), 'local:1')
  assert.equal(unknownSendId({ ok: false, delivery: 'not-sent', clientId: 'local:1' }), '')
  assert.equal(unknownSendId({ ok: true, delivery: 'sent', clientId: 'local:1' }), '')
  assert.equal(deliveryNote([{ id: 'local:1', kind: 'user', failed: 'x', delivery: 'unknown', checked: false }], 'local:1'), CHECKING_DELIVERY_NOTE)
  assert.equal(deliveryNote([{ id: 'local:1', kind: 'user', pending: true }], 'local:1'), '', 'a retry under the same id: no note')
  assert.equal(deliveryNote([], 'local:1'), '')
  assert.match(failureNote({ ok: false, delivery: 'not-sent', error: 'session busy' }, true), /^Not sent: session busy\. Your message is back in the composer\.$/)
  assert.equal(failureNote({ ok: false, delivery: 'unknown' }, false), UNCONFIRMED_DELIVERY_NOTE)
})

// ── the mounted Composer (jsdom + react-dom) ─────────────────────────────

const ready = ['esbuild', 'jsdom', 'react-dom'].every(dep => existsSync(new URL(`../node_modules/${dep}`, import.meta.url)))
const skip = !ready && 'dev dependencies not installed'
const roots = new Set()
afterEach(() => {
  for (const unmount of [...roots]) unmount()
})

let env = null
async function setup(t) {
  if (env) return env
  const { JSDOM } = await import('jsdom')
  const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/', pretendToBeVisual: true })
  const w = dom.window
  const set = (key, value) => Object.defineProperty(globalThis, key, { value, configurable: true, writable: true })
  for (const key of ['window', 'document', 'navigator', 'HTMLElement', 'HTMLTextAreaElement', 'Element', 'Node', 'Text', 'Event', 'KeyboardEvent', 'MouseEvent', 'MutationObserver', 'getComputedStyle', 'File', 'FileReader', 'Blob']) {
    set(key, key === 'getComputedStyle' ? w.getComputedStyle.bind(w) : w[key])
  }
  set('IS_REACT_ACT_ENVIRONMENT', false)
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

const bot = name => ({
  name,
  display_name: name,
  connectionId: 'local',
  connectionKind: 'local',
  sourceScoped: true,
  route: { connectionId: 'local', mode: 'local', profile: name, targetProfile: name }
})

async function mountComposer(t) {
  const { m, React, createRoot, flushSync } = await setup(t)
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  let done = false
  const unmount = () => {
    if (done) return
    done = true
    roots.delete(unmount)
    root.unmount()
    container.remove()
  }
  roots.add(unmount)
  const sends = []
  const props = {
    bot: bot('scholar'),
    name: 'Scholar',
    busy: false,
    disabled: false,
    roster: [],
    items: [],
    onSend: async text => {
      const answer = sends.next?.shift?.() || { ok: true, delivery: 'sent', clientId: `local:${sends.length + 1}` }
      sends.push(text)
      return answer
    },
    onStop: () => undefined
  }
  sends.next = []
  const render = patch => {
    Object.assign(props, patch)
    flushSync(() => root.render(React.createElement(m.Composer, { key: props.bot.name, ...props })))
  }
  render({})
  const send = async value => {
    const box = container.querySelector('textarea')
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set
    flushSync(() => {
      setter.call(box, value)
      box.setSelectionRange(value.length, value.length)
      box.dispatchEvent(new window.Event('input', { bubbles: true }))
    })
    flushSync(() => box.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true })))
    await settle()
  }
  const note = () => container.querySelector('.gbo-composer-note')?.textContent || ''
  return { container, render, send, note, sends, unmount }
}

const unknownItem = patch => ({ kind: 'user', id: 'local:1', text: 'second message', failed: 'no answer', delivery: 'unknown', checked: false, ...patch })

test('mounted: unknown → "checking" → found (bubble gone) clears the note', { skip }, async t => {
  const c = await mountComposer(t)
  c.sends.next.push({ ok: false, delivery: 'unknown', error: 'no answer', clientId: 'local:1' })
  await c.send('second message')
  c.render({ items: [unknownItem()] })
  assert.equal(c.note(), CHECKING_DELIVERY_NOTE)
  c.render({ items: [{ kind: 'user', id: 'row:3', text: 'second message' }] })
  assert.equal(c.note(), '', 'markDelivered replaced the bubble: no note')
})

test('mounted: unknown → not found → the short "couldn’t confirm" note, no resend offered', { skip }, async t => {
  const c = await mountComposer(t)
  c.sends.next.push({ ok: false, delivery: 'unknown', error: 'no answer', clientId: 'local:1' })
  await c.send('second message')
  c.render({ items: [unknownItem({ checked: true })] })
  assert.equal(c.note(), UNCONFIRMED_DELIVERY_NOTE)
  c.render({ items: [unknownItem({ checked: true, checkFailed: true })] })
  assert.equal(c.note(), UNCONFIRMED_DELIVERY_NOTE)
  assert.equal(c.container.querySelector('textarea').value, '', 'the text is not put back for a resend')
})

test('mounted: unknown, then the user sends another message: the note clears', { skip }, async t => {
  const c = await mountComposer(t)
  c.sends.next.push({ ok: false, delivery: 'unknown', error: 'no answer', clientId: 'local:1' })
  await c.send('second message')
  c.render({ items: [unknownItem({ checked: true })] })
  assert.equal(c.note(), UNCONFIRMED_DELIVERY_NOTE)
  await c.send('third message')
  assert.equal(c.note(), '', 'cleared by the next send while the old bubble is still unknown')
  assert.deepEqual(c.sends.slice(), ['second message', 'third message'])
})

test('mounted: unknown, then a bot switch: the note clears', { skip }, async t => {
  const c = await mountComposer(t)
  c.sends.next.push({ ok: false, delivery: 'unknown', error: 'no answer', clientId: 'local:1' })
  await c.send('second message')
  c.render({ items: [unknownItem()] })
  assert.equal(c.note(), CHECKING_DELIVERY_NOTE)
  c.render({ bot: bot('security'), name: 'Security', items: [] })
  assert.equal(c.note(), '')
  // Same chat items carried over by mistake still show nothing: the id is not followed any more.
  c.render({ items: [unknownItem()] })
  assert.equal(c.note(), '')
})

test('mounted: a definite refusal (not-sent) keeps its recovery: the draft and note come back', { skip }, async t => {
  const c = await mountComposer(t)
  c.sends.next.push({ ok: false, delivery: 'not-sent', error: 'session busy', clientId: 'local:1' })
  await c.send('refused message')
  assert.equal(c.container.querySelector('textarea').value, 'refused message')
  assert.equal(c.note(), 'Not sent: session busy. Your message is back in the composer.')
})

// ── review round 1 (DU-R1-01, DU-R1-02) ──────────────────────────────────

function deferred() {
  let resolve
  const promise = new Promise(res => (resolve = res))
  return { promise, resolve }
}
const UNKNOWN_A = { ok: false, delivery: 'unknown', error: 'connection closed', clientId: 'local:A' }
const itemA = patch => unknownItem({ id: 'local:A', text: 'message A', ...patch })
const itemB = patch => unknownItem({ id: 'local:B', text: 'message B', ...patch })

test('DU-R1-01: A pending, B sent, then A comes back unknown: no note returns for the older send', { skip }, async t => {
  const c = await mountComposer(t)
  const a = deferred()
  c.sends.next.push(a.promise, { ok: true, delivery: 'sent', clientId: 'local:B' })
  await c.send('message A')
  await c.send('message B')
  assert.equal(c.note(), '')
  a.resolve(UNKNOWN_A)
  await settle()
  c.render({ items: [itemA()] })
  assert.equal(c.note(), '', 'B dismissed the note; A settling later does not bring it back')
})

test('DU-R1-01: A pending, B unknown and unconfirmed, then A unknown: the note stays on B', { skip }, async t => {
  const c = await mountComposer(t)
  const a = deferred()
  c.sends.next.push(a.promise, { ok: false, delivery: 'unknown', error: 'connection closed', clientId: 'local:B' })
  await c.send('message A')
  await c.send('message B')
  c.render({ items: [itemB({ checked: true })] })
  assert.equal(c.note(), UNCONFIRMED_DELIVERY_NOTE)
  a.resolve(UNKNOWN_A)
  await settle()
  c.render({ items: [itemA(), itemB({ checked: true })] })
  assert.equal(c.note(), UNCONFIRMED_DELIVERY_NOTE, 'follows the newest send (B), not the one that settled last')
})

test('DU-R1-01: A pending, B refused (draft back), then A unknown: the refusal note and draft stay', { skip }, async t => {
  const c = await mountComposer(t)
  const a = deferred()
  c.sends.next.push(a.promise, { ok: false, delivery: 'not-sent', error: 'session busy', clientId: 'local:B' })
  await c.send('message A')
  await c.send('message B')
  const refused = 'Not sent: session busy. Your message is back in the composer.'
  assert.equal(c.note(), refused)
  assert.equal(c.container.querySelector('textarea').value, 'message B')
  a.resolve(UNKNOWN_A)
  await settle()
  c.render({ items: [itemA()] })
  assert.equal(c.note(), refused)
  assert.equal(c.container.querySelector('textarea').value, 'message B')
})

test('DU-R1-02: the same bot side by side: a send in the second tab dismisses the first tab’s note', { skip }, async t => {
  const first = await mountComposer(t)
  const second = await mountComposer(t)
  first.sends.next.push(UNKNOWN_A)
  await first.send('message A')
  first.render({ items: [itemA()] })
  second.render({ items: [itemA()] })
  assert.equal(first.note(), CHECKING_DELIVERY_NOTE)
  await second.send('message B')
  assert.equal(first.note(), '', 'the user sent another message to this chat')
  assert.equal(second.note(), '')
})

test('DU-R1-02 control: a send to a different bot leaves this bot’s note alone', { skip }, async t => {
  const first = await mountComposer(t)
  const other = await mountComposer(t)
  other.render({ bot: bot('security'), name: 'Security' })
  first.sends.next.push(UNKNOWN_A)
  await first.send('message A')
  first.render({ items: [itemA()] })
  assert.equal(first.note(), CHECKING_DELIVERY_NOTE)
  await other.send('to security')
  assert.equal(first.note(), CHECKING_DELIVERY_NOTE)
})

// ── review round 2 (DU-R2-01): a newer validation error shows over the status ──

async function withUnknown(t) {
  const c = await mountComposer(t)
  c.sends.next.push(UNKNOWN_A)
  await c.send('message A')
  c.render({ items: [itemA()] })
  assert.equal(c.note(), CHECKING_DELIVERY_NOTE)
  return c
}

async function pick(c, files) {
  const input = c.container.querySelector('input[type="file"]')
  Object.defineProperty(input, 'files', { value: files, configurable: true })
  input.dispatchEvent(new window.Event('change', { bubbles: true }))
  for (let i = 0; i < 5; i += 1) await settle()
}

test('DU-R2-01: unknown bubble, then an oversized file: the size error shows', { skip }, async t => {
  const c = await withUnknown(t)
  await pick(c, [{ name: 'too-large.bin', size: 26 * 1024 * 1024, type: 'application/octet-stream' }])
  assert.equal(c.note(), 'too-large.bin is larger than 25 MB.')
})

test('DU-R2-01: unknown bubble, then a slash command with an attachment: the command error shows', { skip }, async t => {
  const c = await withUnknown(t)
  await pick(c, [new window.File(['hello'], 'notes.txt', { type: 'text/plain' })])
  assert.ok(c.container.textContent.includes('notes.txt'), 'the attachment chip is there')
  await c.send('/help')
  assert.equal(c.note(), 'A command can’t carry attachments: remove them, or send the text without the leading /.')
  assert.deepEqual(c.sends.slice(), ['message A'], 'nothing sent')
})

test('DU-R2-01: unknown bubble, then a clarify answer with an attachment: the answer error shows', { skip }, async t => {
  const answers = []
  const c = await withUnknown(t)
  c.render({ answering: true, onAnswer: async text => (answers.push(text), { ok: true }) }) // a question arrived
  await pick(c, [new window.File(['hello'], 'notes.txt', { type: 'text/plain' })])
  await c.send('my answer')
  assert.equal(c.note(), 'An answer can’t carry attachments: remove them, or answer first and send them after.')
  assert.deepEqual(answers, [], 'not answered')
})

test('DU-R2-01 control: after the error, the next send clears it and a new unknown status shows again', { skip }, async t => {
  const c = await withUnknown(t)
  await pick(c, [{ name: 'too-large.bin', size: 26 * 1024 * 1024, type: 'application/octet-stream' }])
  c.sends.next.push({ ok: false, delivery: 'unknown', error: 'connection closed', clientId: 'local:B' })
  await c.send('message B')
  c.render({ items: [itemA(), itemB()] })
  assert.equal(c.note(), CHECKING_DELIVERY_NOTE, 'the stale error does not hide the new status')
})
