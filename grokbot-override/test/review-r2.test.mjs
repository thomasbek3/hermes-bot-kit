// Regression tests for the round-2 review findings (reviews/override-r2.md).
// Controller and pure-core findings; the app-level ones (#1 cron owner, #5
// workspace close, #6 handoff UI) are in review-r2-app.test.mjs. No network.

import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'

import { createChatController } from '../src/core/session.js'
import { draftOwnerKey, restoreAfterFailure } from '../src/core/drafts.js'
import { drawerKeyDown, trapFocus } from '../src/core/focus.js'
import { handoffBlocked, placeDraft } from '../src/core/handoff.js'
import { retainBotRoute } from '../src/core/routing.js'
import { BOT, flush, gateway, pooledGateway } from './harness.mjs'

// A legacy tui_gateway refuses the submission_id key before any handler runs
// (contracts/base.py extra="forbid" -> rpc_dispatch 4000): the override then
// sends once without it, and that identityless send is what these tests are
// about (C6 keeps the never-twice rule for it).
const legacy = fail => params => {
  if (params?.submission_id) throw Object.assign(new Error('invalid params for prompt.submit: submission_id: Extra inputs are not permitted'), { code: 4000 })
  return fail(params)
}

const FIX = JSON.parse(fs.readFileSync(new URL('./fixtures/approvals.json', import.meta.url), 'utf8'))

const deferred = () => {
  let resolve
  let reject
  const promise = new Promise((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

const settle = async (n = 8) => {
  for (let i = 0; i < n; i += 1) await flush()
}

const ROWS = [
  { id: 1, role: 'user', content: 'hi', timestamp: 1762560000 },
  { id: 2, role: 'assistant', content: 'hello', timestamp: 1762560001 }
]
const assistants = chat => chat.get().chat.items.filter(i => i.kind === 'assistant')
const count = (gw, method) => gw.calls.filter(c => c.method === method).length

// ── #2 resume window and runtime loss ──────────────────────────────────────

test('#2 a completion that lands between snapshot capture and the resume reply is not lost', async () => {
  let gw
  let done = false
  gw = gateway({
    'session.resume': () => {
      // the turn finishes after the snapshot below was captured, before its reply arrives
      gw.emit({ type: 'message.complete', session_id: 'rt-1', payload: { text: 'done' } })
      done = true
      return { session_id: 'rt-1', running: true, inflight: { assistant: 'partial', streaming: true } }
    },
    'session.active_list': () => ({ sessions: [{ id: 'rt-1', status: done ? 'idle' : 'working' }] }),
    REST: () => ({ messages: done ? [...ROWS, { id: 3, role: 'assistant', content: 'done', timestamp: 1762560002 }] : ROWS })
  })
  const chat = createChatController(BOT, gw.deps)
  await chat.open()
  await settle()
  assert.equal(chat.get().chat.busy, false, 'busy is not restored by the older snapshot')
  assert.equal(assistants(chat).at(-1).text, 'done')
  assert.ok(!chat.get().chat.items.some(i => i.streaming), 'no bubble left streaming')
  assert.ok(!chat.get().chat.items.some(i => i.text === 'partial'))
  assert.equal(count(gw, 'prompt.submit'), 0)
})

test('#2 an approval that lands in the resume window is shown', async () => {
  let gw
  gw = gateway({
    'session.resume': () => {
      gw.emit({ type: 'approval.request', session_id: 'rt-1', payload: FIX.approval })
      return { session_id: 'rt-1', running: true }
    },
    'session.active_list': () => ({ sessions: [{ id: 'rt-1', status: 'waiting' }] })
  })
  const chat = createChatController(BOT, gw.deps)
  await chat.open()
  await settle()
  const card = chat.get().chat.items.find(i => i.kind === 'approval')
  assert.ok(card, 'the approval card is there')
  assert.equal(card.status, 'pending')
})

test('#2 text in the resume window is reconciled from a fresh snapshot, never appended blindly', async () => {
  for (const firstSnapshot of ['hello', 'hello world']) {
    let gw
    let resumes = 0
    gw = gateway({
      'session.resume': () => {
        resumes += 1
        if (resumes === 1) {
          gw.emit({ type: 'message.delta', session_id: 'rt-1', payload: { text: ' world' } })
          return { session_id: 'rt-1', running: true, inflight: { assistant: firstSnapshot, streaming: true } }
        }
        return { session_id: 'rt-1', running: true, inflight: { assistant: 'hello world', streaming: true } }
      },
      'session.active_list': () => ({ sessions: [{ id: 'rt-1', status: 'working' }] })
    })
    const chat = createChatController(BOT, gw.deps)
    await chat.open()
    await settle()
    const bubbles = assistants(chat).filter(i => i.streaming)
    assert.equal(bubbles.length, 1, `one live bubble (${firstSnapshot})`)
    assert.equal(bubbles[0].text, 'hello world', `snapshot said ${JSON.stringify(firstSnapshot)}`)
    gw.emit({ type: 'message.delta', session_id: 'rt-1', payload: { text: '!' } })
    assert.equal(assistants(chat).filter(i => i.streaming)[0].text, 'hello world!', 'later deltas extend it')
    assert.equal(count(gw, 'prompt.submit'), 0)
    chat.dispose()
  }
})

test('#2 a runtime found gone reattaches by itself (bounded), never re-sending the prompt', async () => {
  let gone = false
  let resumes = 0
  const gw = gateway({
    'session.resume': () => ({ session_id: `rt-${(resumes += 1)}`, running: false }),
    'approval.pending': () => {
      if (gone) throw Object.assign(new Error('session not found'), { code: 4001 })
      return { approvals: [] }
    },
    'session.active_list': params => ({ sessions: [{ id: params.current_session_id, status: 'working' }] })
  })
  const chat = createChatController(BOT, gw.deps)
  await chat.open()
  await chat.send('long job')
  gone = true
  for (let i = 0; i < 4 && chat.get().runtimeId !== 'rt-2'; i += 1) await gw.runTimers()
  await settle()
  assert.equal(chat.get().runtimeId, 'rt-2', 're-attached to the stored chat')
  assert.equal(count(gw, 'prompt.submit'), 1, 'the prompt is not re-sent')
  gw.emit({ type: 'message.start', session_id: 'rt-2', payload: {} })
  gw.emit({ type: 'message.delta', session_id: 'rt-2', payload: { text: 'back' } })
  assert.equal(assistants(chat).at(-1).text, 'back', 'events on the new runtime are applied')
})

test('#2 a replay gap reconciles; duplicate sequenced frames apply once', async () => {
  const gw = gateway({
    'session.resume': () => ({ session_id: 'rt-1', running: true, inflight: { assistant: 'a', streaming: true } }),
    'session.active_list': () => ({ sessions: [{ id: 'rt-1', status: 'working' }] })
  })
  const chat = createChatController(BOT, gw.deps)
  await chat.open()
  await settle()
  const frame = { type: 'message.delta', session_id: 'rt-1', seq: 7, payload: { text: 'b' } }
  gw.emit(frame)
  gw.emit({ ...frame, replayed: true })
  assert.equal(assistants(chat).at(-1).text, 'ab')
  const before = count(gw, 'session.active_list')
  gw.emit({ type: 'session.replay_gap', session_id: 'rt-1', payload: { latest_seq: 40 } })
  await settle()
  assert.ok(count(gw, 'session.active_list') > before, 'the gap asks the gateway for the real state')
})

// ── #3 completion is authoritative; busy watchdog ──────────────────────────

test('#3 a completion that beats the prompt.submit receipt is not overwritten by it', async () => {
  let gw
  gw = gateway({
    'prompt.submit': () => {
      gw.emit({ type: 'message.start', session_id: 'rt-1', payload: {} })
      gw.emit({ type: 'message.complete', session_id: 'rt-1', payload: { text: 'done' } })
      return { status: 'streaming' }
    }
  })
  const chat = createChatController(BOT, gw.deps)
  await chat.open()
  await chat.send('quick')
  assert.equal(chat.get().chat.busy, false)
  assert.equal(assistants(chat).at(-1).text, 'done')
})

test('#3 a lost completion is reconciled by the watchdog; approval polling stops; nothing re-sent', async () => {
  let finished = false
  const gw = gateway({
    'session.active_list': () => ({ sessions: [{ id: 'rt-1', status: finished ? 'idle' : 'working' }] }),
    REST: () => ({ messages: finished ? [...ROWS, { id: 3, role: 'user', content: 'go' }, { id: 4, role: 'assistant', content: 'finished' }] : ROWS })
  })
  const chat = createChatController(BOT, gw.deps)
  await chat.open()
  await chat.send('go')
  assert.equal(chat.get().chat.busy, true)
  finished = true // message.complete never arrives
  for (let i = 0; i < 4 && chat.get().chat.busy; i += 1) await gw.runTimers()
  await settle()
  assert.equal(chat.get().chat.busy, false, 'busy no longer latched')
  assert.equal(assistants(chat).at(-1).text, 'finished', 'the stored transcript is read')
  const polls = count(gw, 'approval.pending')
  await gw.runTimers()
  await gw.runTimers()
  assert.equal(count(gw, 'approval.pending'), polls, 'approval polling stopped')
  assert.equal(count(gw, 'prompt.submit'), 1)
})

test('#3 long-running work and a dropped connection keep the turn running; nothing re-sent', async () => {
  for (const activeList of [() => ({ sessions: [{ id: 'rt-1', status: 'working' }] }), () => { throw new Error('socket closed') }]) {
    const gw = gateway({ 'session.active_list': activeList })
    const chat = createChatController(BOT, gw.deps)
    await chat.open()
    await chat.send('long')
    const reads = count(gw, 'REST')
    for (let i = 0; i < 4; i += 1) await gw.runTimers()
    await settle()
    assert.equal(chat.get().chat.busy, true, 'still running (or unknown): never treated as complete')
    assert.equal(count(gw, 'REST'), reads, 'no history rebuild while running')
    assert.equal(count(gw, 'prompt.submit'), 1)
    assert.ok(count(gw, 'session.active_list') >= 1, 'the watchdog asked')
    chat.dispose()
  }
})

// ── #4 failed route retention ──────────────────────────────────────────────

test('#4 a failed retain on a pooled route makes no session call, fails the send definitively, and is retried', async () => {
  let failing = true
  const pool = pooledGateway({ retainFails: () => failing })
  const chat = createChatController(BOT, pool.deps)
  await chat.open()
  assert.equal(chat.get().phase, 'ready', 'history still shows')
  assert.equal(count(pool, 'session.resume'), 0, 'no session-scoped call without the lease')
  assert.match(chat.get().attachError, /keep the connection/i)
  const result = await chat.sendDraft('hello')
  assert.equal(result.ok, false)
  assert.equal(result.delivery, 'not-sent')
  assert.equal(count(pool, 'prompt.submit'), 0)
  assert.deepEqual(pool.failures, [], 'no RPC hit a reaped runtime')
  failing = false
  const again = await chat.sendDraft('hello')
  assert.equal(again.ok, true, 'acquisition is retried')
  assert.deepEqual(pool.failures, [])
  chat.dispose()
  assert.equal(pool.leases(), 0)
})

test('#4 retainBotRoute: required routes fail loudly, exempt routes are no-ops', async () => {
  const remote = BOT
  const active = { name: 'default' } // not scoped: rides the active gateway
  const local = { ...BOT, connectionId: 'local', connectionKind: 'local', remoteSource: false, route: { connectionId: 'local', mode: 'local', profile: 'scholar', targetProfile: 'scholar' } }

  await assert.rejects(retainBotRoute({ retainProfile: async () => { throw new Error('dial failed') } }, remote), /dial failed/)
  const release = () => undefined
  assert.equal(await retainBotRoute({ retainProfile: async () => release }, remote), release)

  // an older host: the relay pin is a real retention; nothing at all is refused
  let pinned = 0
  const relay = await retainBotRoute({ retainProfileSocket: () => (pinned += 1, () => (pinned -= 1)) }, remote)
  assert.equal(pinned, 1)
  relay()
  assert.equal(pinned, 0)
  await assert.rejects(retainBotRoute({}, remote), error => error.code === 'GBO_NO_RETENTION')

  assert.equal(typeof (await retainBotRoute({}, active)), 'function', 'active gateway: exempt')
  assert.equal(typeof (await retainBotRoute({}, local)), 'function', 'local route on an older host: exempt')
})

// ── #5 controller lifetime ─────────────────────────────────────────────────

test('#5 retiring an idle chat releases its lease, listener and timers at once', async () => {
  const pool = pooledGateway()
  const chat = createChatController(BOT, pool.deps)
  await chat.open()
  assert.equal(chat.retire(), false, 'nothing left to finish')
  assert.equal(pool.leases(), 0)
  assert.equal(pool.listenerCount(), 0)
  const reads = count(pool, 'REST')
  await pool.runTimers()
  assert.equal(count(pool, 'REST'), reads, 'no idle refresh after close')
})

test('#5 retiring during attachment staging keeps the lease until the send and its turn settle', async () => {
  const gate = deferred()
  let pool
  pool = pooledGateway({
    handlers: {
      'image.attach_bytes': async params => {
        await gate.promise
        pool.live('image.attach_bytes', params.session_id)
        return { attached: true }
      }
    }
  })
  const chat = createChatController(BOT, pool.deps)
  await chat.open()
  const sending = chat.sendDraft('look', [{ id: 'f1', kind: 'image', name: 'a.png', data: 'data:image/png;base64,AAAA', owner: draftOwnerKey(BOT) }])
  await flush()
  assert.equal(chat.retire(), true, 'kept alive for the in-flight send')
  gate.resolve()
  const result = await sending
  assert.equal(result.ok, true)
  assert.deepEqual(pool.failures, [], 'prompt.submit reached a live runtime')
  assert.equal(pool.releases, 0, 'still held while the turn runs')
  pool.emit({ type: 'message.complete', session_id: 'rt-1', payload: { text: 'seen' } })
  await settle()
  assert.equal(pool.releases, 1, 'released when the turn settled')
  assert.equal(pool.listenerCount(), 0)
})

test('#5 a retired running chat is bounded, and can be revived', async () => {
  const pool = pooledGateway()
  const chat = createChatController(BOT, pool.deps, { retireMaxMs: 1000 })
  await chat.open()
  await chat.send('long')
  assert.equal(chat.retire(), true)
  assert.equal(chat.revive(), true)
  pool.emit({ type: 'message.complete', session_id: 'rt-1', payload: { text: 'x' } })
  await settle()
  assert.equal(pool.releases, 0, 'a revived chat stays open')
  await chat.send('again')
  assert.equal(chat.retire(), true)
  for (let i = 0; i < 3; i += 1) await pool.runTimers()
  assert.equal(pool.releases, 1, 'the bound released it')
})

// ── #6 handoff never replaces a draft, never drops attachments ─────────────

function fakeComposer({ existing = '', mounted = true, insert = true, read = true } = {}) {
  const calls = []
  let draft = existing
  const composer = {
    setDraft: async (id, text) => (calls.push(['setDraft', id, text]), mounted ? ((draft = text), true) : false)
  }
  if (read) composer.getDraft = async id => (calls.push(['getDraft', id]), draft || null)
  if (insert) composer.insertText = async (id, text, opts) => (calls.push(['insertText', id, text, opts?.mode]), mounted ? ((draft = `${draft}\n\n${text}`), true) : false)
  return { composer, calls, draft: () => draft }
}
const wait = () => Promise.resolve()

test('#6 placeDraft reports an existing stock draft instead of replacing it', async () => {
  const fake = fakeComposer({ existing: 'my half-written note' })
  const result = await placeDraft({ composer: fake.composer, sessionId: 'tip', text: '@research hi', wait })
  assert.equal(result.status, 'conflict')
  assert.equal(result.existing, 'my half-written note')
  assert.ok(!fake.calls.some(c => c[0] !== 'getDraft'), 'nothing written')

  const appended = await placeDraft({ composer: fake.composer, sessionId: 'tip', text: '@research hi', mode: 'append', wait })
  assert.equal(appended.status, 'landed')
  assert.equal(fake.draft(), 'my half-written note\n\n@research hi')

  const fresh = fakeComposer({ existing: 'old' })
  assert.equal((await placeDraft({ composer: fresh.composer, sessionId: 'tip', text: 'new', mode: 'replace', wait })).status, 'landed')
  assert.equal(fresh.draft(), 'new')

  const empty = fakeComposer()
  assert.equal((await placeDraft({ composer: empty.composer, sessionId: 'tip', text: 'go', wait })).status, 'landed')
  assert.equal(empty.draft(), 'go')
})

test('#6 a host that cannot read drafts never gets a blind replace', async () => {
  const blind = fakeComposer({ existing: 'keep me', read: false, insert: false })
  const result = await placeDraft({ composer: blind.composer, sessionId: 'tip', text: 'x', wait })
  assert.equal(result.status, 'failed')
  assert.equal(blind.draft(), 'keep me')
  const appendOnly = fakeComposer({ existing: 'keep me', read: false })
  assert.equal((await placeDraft({ composer: appendOnly.composer, sessionId: 'tip', text: 'x', wait })).status, 'landed')
  assert.equal(appendOnly.draft(), 'keep me\n\nx', 'appended, never replaced')
})

test('#6 a draft with attachments cannot be handed off', () => {
  assert.equal(handoffBlocked([]), false)
  assert.equal(handoffBlocked([{ kind: 'image', name: 'a.png' }]), true)
})

// ── #7 failed sends keep their payload ─────────────────────────────────────

const IMG = { id: 'img-1', kind: 'image', name: 'paste.png', data: 'data:image/png;base64,AAAA', owner: draftOwnerKey(BOT) }
const PDF = { id: 'pdf-1', kind: 'pdf', name: 'a.pdf', data: 'data:application/pdf;base64,BBBB', owner: draftOwnerKey(BOT) }

test('#7 a definite attach failure is "not sent", keeps the payload, and Retry sends the original', async () => {
  let reject = true
  const gw = gateway({
    'image.attach_bytes': () => (reject ? { attached: false, message: 'too large' } : { attached: true })
  })
  const chat = createChatController(BOT, gw.deps)
  await chat.open()
  const result = await chat.sendDraft('see', [IMG])
  assert.deepEqual([result.ok, result.delivery], [false, 'not-sent'])
  const bubble = chat.get().chat.items.find(i => i.id === result.clientId)
  assert.equal(bubble.delivery, 'not-sent')
  assert.equal(count(gw, 'prompt.submit'), 0)
  reject = false
  const retried = await chat.retry(result.clientId)
  assert.equal(retried.ok, true)
  const image = gw.calls.filter(c => c.method === 'image.attach_bytes').at(-1)
  assert.equal(image.params.content_base64, 'AAAA', 'the original bytes')
  assert.equal(chat.get().chat.items.filter(i => i.kind === 'user' && i.text === 'see').length, 1, 'one bubble')
})

test('#7 a retry reuses attachments already staged on the same runtime', async () => {
  let fail = true
  const gw = gateway({
    'image.attach_bytes': () => ({ attached: true }),
    'file.attach': params => ({ ref_text: `@file:${params.name}` }),
    'prompt.submit': () => {
      if (fail) throw Object.assign(new Error('session busy'), { code: 4009 })
      return { status: 'streaming' }
    }
  })
  const chat = createChatController(BOT, gw.deps)
  await chat.open()
  const result = await chat.sendDraft('both', [IMG, PDF])
  assert.equal(result.delivery, 'not-sent', 'the gateway answered with a refusal')
  fail = false
  assert.equal((await chat.retry(result.clientId)).ok, true)
  assert.equal(count(gw, 'image.attach_bytes'), 1, 'the image is not staged twice')
  assert.equal(count(gw, 'file.attach'), 1)
  assert.match(gw.calls.filter(c => c.method === 'prompt.submit').at(-1).params.text, /a\.pdf → @file:a\.pdf/)
})

test('#7 a lost submit acknowledgement is "delivery unknown" and is checked against history before any resend', async () => {
  for (const landed of [true, false]) {
    let submitted = false
    const gw = gateway({
      'prompt.submit': legacy(() => {
        submitted = true // the gateway may have stored it before the socket dropped
        throw new Error('request timed out after 30s: prompt.submit')
      }),
      REST: () => ({ messages: landed && submitted ? [...ROWS, { id: 3, role: 'user', content: 'did it go?', timestamp: 1762560100 }] : ROWS })
    })
    const chat = createChatController(BOT, gw.deps)
    await chat.open()
    const result = await chat.sendDraft('did it go?')
    assert.equal(result.delivery, 'unknown')
    const early = await chat.retry(result.clientId)
    assert.equal(early.ok, false, 'no resend before the history check')
    assert.equal(count(gw, 'prompt.submit'), 2, 'the refused id attempt + one identityless send')
    for (let i = 0; i < 2; i += 1) await gw.runTimers()
    await settle()
    const bubble = chat.get().chat.items.find(i => i.kind === 'user' && i.text === 'did it go?' && (i.id === result.clientId || !i.failed))
    if (landed) {
      assert.ok(!chat.get().chat.items.some(i => i.failed), 'found in history: not failed')
      assert.equal(chat.get().chat.items.filter(i => i.kind === 'user' && i.text === 'did it go?').length, 1)
    } else {
      assert.equal(bubble.delivery, 'unknown')
      assert.equal(bubble.checked, true, 'checked, not found: still unknown (r3 #2: never offered for a resend)')
    }
    assert.equal(count(gw, 'prompt.submit'), 2, 'never re-sent automatically')
  }
})

test('#7 a failed send is restored to the composer only when nothing newer was typed', () => {
  const failed = { ok: false, delivery: 'not-sent' }
  const owner = 'bot:a'
  assert.equal(restoreAfterFailure({ result: failed, sentOwner: owner, currentOwner: owner, currentText: '', currentFiles: [] }), true)
  assert.equal(restoreAfterFailure({ result: failed, sentOwner: owner, currentOwner: owner, currentText: 'newer', currentFiles: [] }), false)
  assert.equal(restoreAfterFailure({ result: failed, sentOwner: owner, currentOwner: owner, currentText: '', currentFiles: [{}] }), false)
  assert.equal(restoreAfterFailure({ result: failed, sentOwner: owner, currentOwner: 'bot:b', currentText: '', currentFiles: [] }), false)
  assert.equal(restoreAfterFailure({ result: { ok: false, delivery: 'unknown' }, sentOwner: owner, currentOwner: owner, currentText: '', currentFiles: [] }), false, 'maybe delivered: never re-armed')
})

// ── #8 drawer focus ────────────────────────────────────────────────────────

function fakeDom() {
  const doc = { activeElement: null }
  const el = (name, focusable = true) => {
    const node = {
      name,
      attrs: {},
      isConnected: true,
      focusable,
      children: [],
      focus() {
        doc.activeElement = node
      },
      setAttribute(k, v) {
        node.attrs[k] = String(v)
      },
      removeAttribute(k) {
        delete node.attrs[k]
      },
      hasAttribute: k => k in node.attrs,
      contains: other => other === node || node.children.some(c => c.contains(other)),
      querySelectorAll: () => node.children.filter(c => c.focusable && !c.attrs.disabled)
    }
    return node
  }
  return { doc, el }
}

test('#8 the drawer takes focus, traps Tab, makes the chat inert and gives focus back', () => {
  const { doc, el } = fakeDom()
  const trigger = el('trigger')
  const chat = el('chat')
  const drawer = el('drawer', false)
  const close = el('close')
  const link = el('link')
  drawer.children.push(close, link)
  trigger.focus()

  const release = trapFocus(drawer, { background: chat, doc })
  assert.equal(doc.activeElement, close, 'initial focus inside the drawer')
  assert.equal(chat.attrs.inert, '', 'background is inert')
  assert.equal(chat.attrs['aria-hidden'], 'true')

  let prevented = 0
  const key = (k, shift = false) => ({ key: k, shiftKey: shift, preventDefault: () => (prevented += 1), stopPropagation: () => undefined })
  link.focus()
  drawerKeyDown(key('Tab'), drawer, () => undefined, doc)
  assert.equal(doc.activeElement, close, 'Tab wraps to the first control')
  drawerKeyDown(key('Tab', true), drawer, () => undefined, doc)
  assert.equal(doc.activeElement, link, 'Shift+Tab wraps to the last')
  assert.equal(prevented, 2)

  let closed = 0
  drawerKeyDown(key('Escape'), drawer, () => (closed += 1), doc)
  assert.equal(closed, 1, 'Escape closes the drawer it was pressed in')

  release()
  assert.ok(!('inert' in chat.attrs))
  assert.ok(!('aria-hidden' in chat.attrs))
  assert.equal(doc.activeElement, trigger, 'focus goes back to the trigger')
})
