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

test('carryKeys: different text does not match an assistant; a user bubble falls back to order; each old key is used once', () => {
  const current = [
    { kind: 'user', id: 'local:a', text: '/skill weekly' },
    { kind: 'assistant', id: 'live:1', text: 'one' },
    { kind: 'assistant', id: 'live:2', text: 'two' }
  ]
  const next = [
    { kind: 'user', id: 'h:5', text: 'expanded weekly skill text' },
    { kind: 'assistant', id: 'h:6', text: 'two' },
    { kind: 'assistant', id: 'h:7', text: 'something else' }
  ]
  const out = carryKeys(current, next)
  assert.equal(out[0].renderKey, 'local:a', 'the expanded skill row takes the sent bubble by order')
  assert.equal(out[1].renderKey, 'live:2', 'matched by text')
  assert.equal(out[2].renderKey, undefined, 'no match, no key')
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

test('r1-01: an exact match is reserved before the order fallback', () => {
  const current = [
    { kind: 'user', id: 'local:skill', text: '/weekly' },
    { kind: 'user', id: 'local:plain', text: 'thanks' }
  ]
  const next = [
    { kind: 'user', id: 'h:7', text: 'Run the weekly skill: ...' },
    { kind: 'user', id: 'h:8', text: 'thanks' }
  ]
  const out = carryKeys(current, next)
  assert.equal(out[1].renderKey, 'local:plain', 'exact text first')
  assert.equal(out[0].renderKey, 'local:skill', 'the expanded skill row by order')
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
