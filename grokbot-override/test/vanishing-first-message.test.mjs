// The user's first message in a new Bot Chat must not vanish while the reply
// is pending. Live: the bubble disappeared on Send (empty state + "Thinking…")
// and came back ~10 s later with the reply. Cause: every transcript re-read
// (idle refresh, roster activity refresh, reconcile, lineage follow) rebuilt
// the items from the stored rows and kept only failed / waiting local items,
// so a sent bubble whose turn the gateway had not stored yet was dropped.

import assert from 'node:assert/strict'
import { existsSync, rmSync } from 'node:fs'
import { dirname } from 'node:path'
import test from 'node:test'
import { pathToFileURL } from 'node:url'

import { confirmedSends } from '../src/core/history.js'
import { createChatController } from '../src/core/session.js'
import { BOT, flush, gateway } from './harness.mjs'

const NO_CHAT_BOT = { ...BOT, canonical_session: undefined }
const TEXT = 'how goes it sir'
const settle = async (n = 10) => {
  for (let i = 0; i < n; i += 1) await flush()
}
const users = chat => chat.get().chat.items.filter(item => item.kind === 'user')
const deferred = () => {
  let resolve
  const promise = new Promise(r => (resolve = r))
  return { promise, resolve }
}

/** A new chat whose transcript the test controls; prompt.submit waits for `submitGate`. */
function newChat({ submitGate = null, submit = () => ({ status: 'streaming' }), extra = {} } = {}) {
  const store = { rows: [] }
  let created = false
  const gw = gateway({
    'session.list': () => ({ sessions: created ? [{ id: 'st-new', title: 'Bot Chat' }] : [] }),
    'session.create': () => ((created = true), { session_id: 'rt-new', stored_session_id: 'st-new' }),
    'session.title': () => ({}),
    'session.resume': () => ({ session_id: 'rt-new', running: false }),
    'prompt.submit': async params => {
      if (submitGate) await submitGate
      return submit(params)
    },
    REST: () => ({ messages: store.rows }),
    ...extra
  })
  const chat = createChatController(NO_CHAT_BOT, gw.deps, { createIfMissing: true })
  return { gw, chat, store }
}

test('first send in a new chat: a refresh during the submit (empty transcript) keeps the bubble', async () => {
  const gate = deferred()
  const { gw, chat, store } = newChat({ submitGate: gate.promise })
  await chat.open()
  await settle()
  assert.equal(chat.get().phase, 'ready')
  assert.equal(chat.get().storedId, 'st-new', 'the new chat got its stored id')
  assert.equal(chat.get().chat.items.length, 0)

  const sent = chat.sendDraft(TEXT)
  await settle()
  assert.equal(users(chat).length, 1)
  assert.equal(users(chat)[0].pending, true)

  // The idle refresh (and the roster's activity refresh) run while prompt.submit
  // is still out; the gateway has not stored the turn: [].
  await chat.refresh()
  await gw.runTimers()
  assert.deepEqual(users(chat).map(u => u.text), [TEXT], 'the bubble survives a transcript without it')
  assert.ok(chat.get().chat.items.length > 0, 'never the empty state while a send is out')

  gate.resolve()
  assert.equal((await sent).ok, true)
  assert.equal(chat.get().chat.busy, true)
  assert.deepEqual(users(chat).map(u => [u.text, u.pending]), [[TEXT, false]])

  // The reply arrives; the transcript read right after still lacks the turn.
  gw.emit({ type: 'message.start', session_id: 'rt-new', payload: { turn_id: 't1' } })
  gw.emit({ type: 'message.complete', session_id: 'rt-new', payload: { text: 'Doing well, sir.' } })
  assert.equal(chat.get().chat.busy, false)
  await chat.refresh()
  assert.deepEqual(users(chat).map(u => u.text), [TEXT], 'still shown, still once')

  // The stored copy arrives: it replaces the bubble, no duplicate.
  store.rows = [
    { id: 11, role: 'user', content: TEXT, timestamp: 1762560100 },
    { id: 12, role: 'assistant', content: 'Doing well, sir.', timestamp: 1762560101 }
  ]
  await chat.refresh()
  const items = chat.get().chat.items
  assert.deepEqual(items.filter(i => i.kind === 'user').map(u => [u.id, u.text]), [['h:11', TEXT]])
  assert.deepEqual(items.map(i => i.kind), ['user', 'assistant'])
  // And a later read does not bring the local bubble back.
  await chat.refresh()
  assert.equal(users(chat).length, 1)
  chat.dispose()
})

test('a reconcile that finds the turn over re-reads an empty transcript: the bubble stays', async () => {
  const { gw, chat, store } = newChat({
    submit: params => ({ status: 'queued', submission_id: params.submission_id }),
    extra: { 'session.active_list': () => ({ sessions: [{ id: 'rt-new', status: 'idle' }] }) }
  })
  await chat.open()
  await settle()
  assert.equal((await chat.sendDraft(TEXT)).ok, true)
  assert.equal(chat.get().chat.busy, true)
  // The watchdog fires with no events: active_list says idle, the turn is
  // settled and the transcript re-read, still without the user row.
  await gw.runTimers()
  await settle()
  assert.deepEqual(users(chat).map(u => u.text), [TEXT])
  store.rows = [{ id: 21, role: 'user', content: TEXT }, { id: 22, role: 'assistant', content: 'ok' }]
  await chat.refresh()
  assert.deepEqual(users(chat).map(u => u.id), ['h:21'])
  chat.dispose()
})

test('a runtime swapped on the first send (4001, re-attach with a new id) keeps the bubble', async () => {
  let minted = 0
  let refused = false
  const { gw, chat, store } = newChat({
    extra: {
      'session.resume': () => ({ session_id: `rt-${(minted += 1)}`, running: false }),
      'prompt.submit': params => {
        if (!refused) {
          refused = true
          throw Object.assign(new Error(`session ${params.session_id} not in memory`), { code: 4001 })
        }
        return { status: 'streaming' }
      }
    }
  })
  await chat.open()
  await settle()
  assert.equal(chat.get().runtimeId, 'rt-1')
  assert.equal((await chat.sendDraft(TEXT)).ok, true)
  assert.equal(chat.get().runtimeId, 'rt-2', 'the send moved to the new runtime')
  assert.deepEqual(users(chat).map(u => u.text), [TEXT])
  // The turn on the new runtime ends; the first read is still empty.
  gw.emit({ type: 'message.complete', session_id: 'rt-2', payload: { text: 'fine' } })
  assert.equal(chat.get().chat.busy, false)
  await chat.refresh()
  assert.deepEqual(users(chat).map(u => u.text), [TEXT])
  store.rows = [{ id: 31, role: 'user', content: TEXT }]
  await chat.refresh()
  assert.deepEqual(users(chat).map(u => u.id), ['h:31'])
  chat.dispose()
})

test('a failed send keeps its failed bubble across refreshes', async () => {
  const { chat } = newChat({
    submit: () => {
      throw Object.assign(new Error('refused'), { code: 4002 })
    }
  })
  await chat.open()
  await settle()
  const result = await chat.sendDraft(TEXT)
  assert.equal(result.ok, false)
  await chat.refresh()
  const [bubble] = users(chat)
  assert.equal(bubble.text, TEXT)
  assert.ok(bubble.failed, 'the failed / retry treatment stays')
})

test('confirmedSends: content + role + order, each stored row claimed once', () => {
  const known = new Set(['id:1'])
  const rows = [
    { id: 1, role: 'user', content: 'ok' },
    { id: 2, role: 'assistant', content: 'yes' },
    { id: 3, role: 'user', content: 'ok' }
  ]
  const sends = [
    { id: 'a', text: 'ok', known },
    { id: 'b', text: 'ok', known }
  ]
  // The row known before the send never confirms it; one new row, one send.
  assert.deepEqual([...confirmedSends(sends, rows)], ['a'])
  assert.deepEqual([...confirmedSends(sends, [...rows, { id: 4, role: 'user', content: 'ok' }])], ['a', 'b'])
  // An assistant row with the same text is not the user's copy.
  assert.deepEqual([...confirmedSends([{ id: 'c', text: 'yes', known }], rows)], [])
  // The gateway stored the submitted text (an @mention note appended).
  assert.deepEqual([...confirmedSends([{ id: 'd', text: 'hi', submitted: 'hi\n\n(note)', known }], [{ id: 5, role: 'user', content: 'hi\n\n(note)' }])], ['d'])
  // Stored text differs entirely (an expanded skill): only an accepted send claims by order.
  const expanded = [{ id: 6, role: 'user', content: 'Long expanded skill prompt' }]
  assert.deepEqual([...confirmedSends([{ id: 'e', text: '/skill go', known }], expanded)], [])
  assert.deepEqual([...confirmedSends([{ id: 'e', text: '/skill go', known, byOrder: true }], expanded)], ['e'])
  // A hidden (card intent) row never confirms a bubble.
  assert.deepEqual([...confirmedSends([{ id: 'f', text: 'ok', known, byOrder: true }], [{ id: 7, role: 'user', content: 'ok', display_kind: 'hidden' }])], [])
})

const ready = existsSync(new URL('../node_modules/esbuild', import.meta.url)) && existsSync(new URL('../node_modules/react-dom', import.meta.url))

test('render: the pending first bubble shows instead of the empty state', { skip: !ready && 'dev dependencies not installed' }, async t => {
  const gate = deferred()
  const { chat } = newChat({ submitGate: gate.promise })
  await chat.open()
  await settle()
  void chat.sendDraft(TEXT)
  await settle()
  await chat.refresh()

  const { bundlePreview } = await import('../dev/bundle.mjs')
  const file = await bundlePreview()
  t.after(() => rmSync(dirname(file), { recursive: true, force: true }))
  const { render } = await import(pathToFileURL(file).href)
  const html = render({ items: chat.get().chat.items, busy: true })
  assert.ok(html.includes(TEXT), 'the bubble is drawn')
  assert.ok(!html.includes('Send a message to start the conversation'), 'no empty state')
  assert.ok(render({ items: [], busy: true }).includes('Send a message to start the conversation'))
  gate.resolve()
  chat.dispose()
})
