// Tighter T4: a live reply (`live:…`) or an optimistic bubble (`local:…`)
// that becomes its stored row keeps its React identity (`renderKey`), so the
// finished reply is not remounted when the history refresh lands: no Markdown
// re-parse, no card back to its loading box, no image back to its placeholder.
// The durable `id` is the stored row's (react / edit / rewind addressing).

import assert from 'node:assert/strict'
import test from 'node:test'

import { groupMessages } from '../src/core/groups.js'
import { carryKeys, confirmedSends, isPersistedItem, rebuildItems, rowsToItems } from '../src/core/history.js'
import { bootPlugin, LOCAL, READY, waitFor } from './loader-boot.mjs'

const t0 = 1762560000
const keepLocal = item => item.failed || item.kind === 'command'

test('rebuildItems: the stored copy of a live reply takes renderKey live:x; the id stays the stored one', () => {
  const current = [
    ...rowsToItems([{ id: 1, role: 'user', content: 'hi', timestamp: t0 }]),
    { kind: 'user', id: 'local:1:abc', text: 'plan my week', at: (t0 + 5) * 1000 },
    { kind: 'assistant', id: 'live:x', text: 'Here is **the plan**.', at: (t0 + 6) * 1000 }
  ]
  const rows = [
    { id: 1, role: 'user', content: 'hi', timestamp: t0 },
    { id: 2, role: 'user', content: 'plan my week', timestamp: t0 + 5 },
    { id: 3, role: 'assistant', content: 'Here is **the plan**.', timestamp: t0 + 6 }
  ]
  // The send is confirmed by row 2 (session.js keepingSends -> confirmedSends).
  const done = confirmedSends([{ id: 'local:1:abc', text: 'plan my week', submitted: 'plan my week', known: new Set(['id:1']), byOrder: true }], rows)
  assert.ok(done.has('local:1:abc'))
  const next = rebuildItems(current, rowsToItems(rows), keepLocal)
  assert.equal(next.length, 3)
  const [first, user, reply] = next
  assert.equal(first.renderKey, undefined, 'an item already stored gets no key')
  assert.equal(user.id, 'h:2')
  assert.equal(user.renderKey, 'local:1:abc', 'the sent bubble keeps its identity')
  assert.equal(reply.id, 'h:3', 'durable id is the stored row')
  assert.equal(reply.rowId, 3)
  assert.equal(reply.renderKey, 'live:x')
  assert.ok(isPersistedItem(reply))

  // The next idle refresh builds fresh items: the key carries over again.
  const again = rebuildItems(next, rowsToItems(rows), keepLocal)
  assert.equal(again[1].renderKey, 'local:1:abc')
  assert.equal(again[2].renderKey, 'live:x')

  // Groups key on their first item's identity.
  const groups = groupMessages(again)
  assert.deepEqual(groups.map(g => g.id), ['group:h:1', 'group:live:x'])
})

test('carryKeys: a sent bubble goes to the row that confirmed it; replies pair inside its turn (text first, then order); a reply without a confirmed turn keeps no key', () => {
  const current = [
    { kind: 'user', id: 'local:a', text: '/skill weekly' },
    { kind: 'assistant', id: 'live:1', text: 'one' },
    { kind: 'assistant', id: 'live:2', text: 'two' }
  ]
  const next = [
    { kind: 'user', id: 'h:5', text: 'expanded weekly skill text' },
    { kind: 'assistant', id: 'h:6', text: 'two' },
    { kind: 'assistant', id: 'h:7', text: 'one, edited by the gateway' }
  ]
  const confirmed = id => (id === 'local:a' ? 'h:5' : undefined)
  const out = carryKeys(current, next, confirmed)
  assert.equal(out[0].renderKey, 'local:a', 'the confirming row, whatever its stored text')
  assert.equal(out[1].renderKey, 'live:2', 'same text first')
  assert.equal(out[2].renderKey, 'live:1', 'the rest of the turn in order')
  const none = carryKeys(current, next, () => undefined)
  assert.deepEqual(none.map(item => item.renderKey), [undefined, undefined, undefined], 'nothing confirmed: no identity moves')
  const same = [{ kind: 'assistant', id: 'h:9', text: 'x' }]
  assert.equal(carryKeys([{ kind: 'assistant', id: 'h:9', text: 'x' }], same), same, 'nothing carried: the same array')
})

test('r1-01: rows another surface stored in between never take the keys; the real copies do', () => {
  const t1 = 1762560000
  const loaded = [{ id: 1, role: 'user', content: 'old question', timestamp: t1 }]
  const current = [
    ...rowsToItems(loaded),
    { kind: 'user', id: 'local:mine', text: 'my question', at: (t1 + 30) * 1000 },
    { kind: 'assistant', id: 'live:mine', text: 'Done.', at: (t1 + 31) * 1000 }
  ]
  const rows = [
    ...loaded,
    { id: 2, role: 'user', content: 'other surface question', timestamp: t1 + 10 },
    { id: 3, role: 'assistant', content: 'Done.', timestamp: t1 + 11 },
    { id: 4, role: 'user', content: 'my question', timestamp: t1 + 30 },
    { id: 5, role: 'assistant', content: 'Done.', timestamp: t1 + 31 }
  ]
  const done = confirmedSends([{ id: 'local:mine', text: 'my question', submitted: 'my question', known: new Set(['id:1']), byOrder: true }], rows)
  assert.ok(done.has('local:mine'))
  const keep = item => item.kind === 'user' && !item.id.startsWith('h:') && !done.has(item.id)
  const next = rebuildItems(current, rowsToItems(rows), keep)
  const key = id => next.find(item => item.id === id)?.renderKey
  assert.deepEqual(next.map(item => item.id), ['h:1', 'h:2', 'h:3', 'h:4', 'h:5'])
  assert.equal(key('h:2'), undefined, 'the other surface question keeps its own identity')
  assert.equal(key('h:3'), undefined, 'an older identical reply does not take the live key')
  assert.equal(key('h:4'), 'local:mine', 'my stored question takes my bubble')
  assert.equal(key('h:5'), 'live:mine', 'my stored reply takes the live reply')
  // Rendered identity: the groups of my turn keep their keys.
  const groups = groupMessages(next)
  assert.ok(groups.some(g => g.id === 'group:local:mine' && g.items[0].id === 'h:4'))
  assert.ok(groups.some(g => g.id === 'group:live:mine' && g.items[0].id === 'h:5'))
  assert.equal(new Set(groups.map(g => g.id)).size, groups.length, 'no duplicate React keys')
})

// The reviewer's round-2 case: this view sent `/weekly` (stored expanded)
// and got `Done.`; another surface then added a whole turn ending in the same
// `Done.` before the refresh landed.
const R2_ROWS = [
  { id: 1, role: 'user', content: 'old question', timestamp: t0 },
  { id: 2, role: 'user', content: 'Run the weekly skill: expanded instructions', timestamp: t0 + 30 },
  { id: 3, role: 'assistant', content: 'Done.', timestamp: t0 + 31 },
  { id: 4, role: 'user', content: 'Other surface question', timestamp: t0 + 40 },
  { id: 5, role: 'assistant', content: 'Done.', timestamp: t0 + 41 }
]
const r2Current = () => [
  ...rowsToItems(R2_ROWS.slice(0, 1)),
  { kind: 'user', id: 'local:r2', text: '/weekly', at: (t0 + 30) * 1000 },
  { kind: 'assistant', id: 'live:r2', text: 'Done.', at: (t0 + 31) * 1000 }
]

test('r2-01: a later external turn never takes the keys; the confirmed turn does (expanded submission, repeated reply text)', () => {
  const done = confirmedSends([{ id: 'local:r2', text: '/weekly', submitted: 'Run the weekly skill: expanded instructions', known: new Set(['id:1']), byOrder: true }], R2_ROWS)
  assert.ok(done.has('local:r2'))
  const keep = item => item.kind === 'user' && !item.id.startsWith('h:') && !done.has(item.id)
  const next = rebuildItems(r2Current(), rowsToItems(R2_ROWS), keep)
  const key = id => next.find(item => item.id === id)?.renderKey
  assert.equal(key('h:2'), 'local:r2', 'the expanded row that confirmed the send')
  assert.equal(key('h:3'), 'live:r2', 'the reply of that turn')
  assert.equal(key('h:4'), undefined, 'the other surface question')
  assert.equal(key('h:5'), undefined, 'the other surface reply with the same text')
})

test('r2-01: a send confirmed only by order still pairs with its own row, not a later one', () => {
  const rows = [...R2_ROWS.slice(0, 2), R2_ROWS[2], R2_ROWS[3], R2_ROWS[4]].map(r => (r.id === 2 ? { ...r, content: 'The weekly skill ran with a note' } : r))
  const done = confirmedSends([{ id: 'local:r2b', text: '/weekly', submitted: '/weekly', known: new Set(['id:1']), byOrder: true }], rows)
  assert.ok(done.has('local:r2b'))
  const current = r2Current().map(item => (item.id === 'local:r2' ? { ...item, id: 'local:r2b' } : item.id === 'live:r2' ? { ...item, id: 'live:r2b' } : item))
  const next = rebuildItems(current, rowsToItems(rows), item => item.kind === 'user' && !item.id.startsWith('h:') && !done.has(item.id))
  const key = id => next.find(item => item.id === id)?.renderKey
  assert.equal(key('h:2'), 'local:r2b')
  assert.equal(key('h:3'), 'live:r2b')
  assert.equal(key('h:4'), undefined)
  assert.equal(key('h:5'), undefined)
})

test('r2-01: the DOM nodes of the confirmed turn survive the refresh at the right rows', async t => {
  const { JSDOM } = await import('jsdom')
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>')
  const keys = ['window', 'document', 'HTMLElement', 'Node']
  const saved = keys.map(k => [k, Object.getOwnPropertyDescriptor(globalThis, k)])
  for (const k of keys) Object.defineProperty(globalThis, k, { value: dom.window[k === 'window' ? 'window' : k], configurable: true, writable: true })
  globalThis.IS_REACT_ACT_ENVIRONMENT = false
  t.after(() => {
    for (const [k, d] of saved) d ? Object.defineProperty(globalThis, k, d) : delete globalThis[k]
    dom.window.close()
  })
  const React = (await import('react')).default
  const { flushSync } = await import('react-dom')
  const { createRoot } = await import('react-dom/client')
  // Keyed like Chat.tsx Transcript: groups by their key, items by renderKey ?? id.
  const View = ({ items }) =>
    React.createElement(
      'div',
      null,
      groupMessages(items).map(entry =>
        entry.kind === 'group'
          ? React.createElement('div', { key: entry.id, className: 'group' }, entry.items.map(item => React.createElement('p', { key: item.renderKey ?? item.id, 'data-text': item.text }, item.text)))
          : null
      )
    )
  const root = createRoot(dom.window.document.getElementById('root'))
  const current = r2Current().map(item => ({ ...item, id: item.id.replace('r2', 'r2c') }))
  flushSync(() => root.render(React.createElement(View, { items: current })))
  const mine = dom.window.document.querySelector('p[data-text="/weekly"]')
  const reply = dom.window.document.querySelector('p[data-text="Done."]')
  const done = confirmedSends([{ id: 'local:r2c', text: '/weekly', submitted: 'Run the weekly skill: expanded instructions', known: new Set(['id:1']), byOrder: true }], R2_ROWS)
  const next = rebuildItems(current, rowsToItems(R2_ROWS), item => item.kind === 'user' && !item.id.startsWith('h:') && !done.has(item.id))
  flushSync(() => root.render(React.createElement(View, { items: next })))
  const ps = [...dom.window.document.querySelectorAll('p')]
  assert.equal(ps.length, 5)
  assert.equal(ps[1], mine, 'row 2 is the node that showed /weekly')
  assert.equal(ps[2], reply, 'row 3 is the node that showed the live reply')
  assert.notEqual(ps[4], reply, 'the other surface reply is a node of its own')
  root.unmount()
})

const CARD = {
  schema: 'card.v1',
  kind: 'task',
  title: 'Weekly plan ready',
  status: { state: 'done' },
  body: [{ type: 'text', text: 'All seven days are planned.' }]
}
const REPLY = 'Done.\n\n::card{id="c-9" kind="task" file="cards/c-9.json"}'

function type(el, value) {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set
  setter.call(el, value)
  el.setSelectionRange(value.length, value.length)
  el.dispatchEvent(new window.Event('input', { bubbles: true }))
}

test('loader: a card under a just-finished reply keeps its DOM node and is not re-read when the stored row replaces the live one', { skip: !READY && 'dev dependencies not installed' }, async t => {
  let stored = false
  const base = [
    { id: 11, role: 'user', content: 'hello', timestamp: t0 },
    { id: 12, role: 'assistant', content: 'Hi there.', timestamp: t0 + 1 }
  ]
  const rowsNow = () => (stored ? [...base, { id: 13, role: 'user', content: 'plan my week', timestamp: t0 + 10 }, { id: 14, role: 'assistant', content: REPLY, timestamp: t0 + 12 }] : base)
  const bot = { ...LOCAL, canonical_session: { ...LOCAL.canonical_session } }
  const cardReads = []
  const historyReads = () => calls.filter(c => c.method === 'REST' && String(c.params.path || '').includes('/messages')).length
  const { panes, workspaces, mount, errors, calls, emit } = await bootPlugin(t, {
    rows: [bot],
    historyFor: profile => ({ session_id: profile, messages: rowsNow(), pagination: { limit: 120, offset: 0, order: 'latest', returned: rowsNow().length } }),
    answers: {
      'prompt.submit': () => ({ status: 'streaming' }),
      'session.active_list': () => ({ sessions: [] })
    },
    api: request => {
      if (!String(request.path).startsWith('/api/fs/read-text')) return undefined
      cardReads.push(request.path)
      return { text: JSON.stringify(CARD), binary: false, truncated: false }
    }
  })
  const rosterEl = mount(panes.find(p => p.id === 'roster').render)
  ;(await waitFor(() => [...rosterEl.querySelectorAll('button.gbo-row')].find(b => b.textContent.includes('Security')), 'row')).click()
  const chatEl = mount((await waitFor(() => workspaces.get('grokbot-override'), 'workspace')).render)
  await waitFor(() => chatEl.textContent.includes('Hi there.'), 'history')
  // The chat attaches (session.resume) and reads the bot's model before it sends.
  await waitFor(() => calls.some(c => c.method === 'config.get'), 'the chat attached', 8000)
  await new Promise(resolve => setTimeout(resolve, 200))
  const box = await waitFor(() => {
    const el = chatEl.querySelector('textarea')
    return el && !el.disabled ? el : null
  }, 'an enabled composer')
  type(box, 'plan my week')
  box.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
  await waitFor(() => calls.some(c => c.method === 'prompt.submit'), 'the send', 8000)
  const sent = await waitFor(() => [...chatEl.querySelectorAll('.bubble.is-user')].find(b => b.textContent.includes('plan my week')), 'the sent bubble')

  emit({ type: 'message.start', session_id: 'rt-security', payload: {} })
  emit({ type: 'message.delta', session_id: 'rt-security', payload: { text: REPLY } })
  emit({ type: 'message.complete', session_id: 'rt-security', payload: { text: REPLY } })
  stored = true
  const card = await waitFor(() => chatEl.querySelector('.gbo-directive .gbo-dcard-title'), 'the card under the finished reply')
  await waitFor(() => !chatEl.querySelector('.bubble.is-streaming'), 'the reply finished')
  const bubble = [...chatEl.querySelectorAll('.bubble.is-agent')].find(b => b.textContent.includes('Done.'))
  const group = bubble.closest('.group')
  const readsBefore = cardReads.length
  assert.ok(readsBefore >= 1)

  // The bot's activity moves on the roster: the open chat re-reads its tail
  // and the stored rows replace the live reply and the sent bubble.
  const before = historyReads()
  bot.canonical_session.last_active = t0 + 20
  await waitFor(() => historyReads() > before, 'the history refresh', 6000)
  await waitFor(() => !chatEl.textContent.includes('Sending…'), 'the stored copy replaced the bubble')
  await new Promise(resolve => setTimeout(resolve, 100))

  assert.equal(chatEl.querySelectorAll('.bubble.is-agent').length, 2, 'one reply, no duplicate')
  assert.ok(card.isConnected, 'the card element survived the refresh (not remounted)')
  assert.equal(chatEl.querySelector('.gbo-directive .gbo-dcard-title'), card)
  assert.ok(bubble.isConnected, 'the reply bubble survived')
  assert.ok(group.isConnected, 'its group survived')
  assert.ok(sent.isConnected, 'the sent bubble survived its stored copy')
  assert.equal(cardReads.length, readsBefore, 'the card was not read again')
  assert.deepEqual(errors, [])
})
