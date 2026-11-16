// T2 (audit 20): the 3 s roster tick is a no-op when nothing changed. The
// stock roster cache hands back equal rows as new objects (a react-query
// refetch), sources are re-annotated and Bot Mode's local meta is re-read on
// every tick; none of that may hand the store a new value, or the open chat
// re-renders its whole transcript every 3 s.

import assert from 'node:assert/strict'
import test from 'node:test'

import { annotateSources, keepRows, sameData, sameRows } from '../src/core/roster.js'
import { bootPlugin, LOCAL, READY, REMOTE, waitFor } from './loader-boot.mjs'

const row = (name, extra = {}) => ({ name, connectionId: 'c1', route: { connectionId: 'c1', mode: 'remote', profile: name }, canonical_session: { id: `${name}-root` }, ...extra })

test('annotateSources keeps a row whose reachability did not change', () => {
  const sources = [{ connectionId: 'c1', reachable: true }]
  const once = annotateSources([row('a')], sources)
  const twice = annotateSources(once, sources)
  assert.equal(twice[0], once[0], 'same row object')
  const down = annotateSources(once, [{ connectionId: 'c1', reachable: false, error: 'offline' }])
  assert.notEqual(down[0], once[0])
  assert.equal(down[0].sourceError, 'offline')
})

test('keepRows: equal data keeps the old array; one changed row keeps the others', () => {
  const prev = [row('a'), row('b')]
  const same = structuredClone(prev)
  assert.ok(sameRows(prev, same))
  assert.equal(keepRows(prev, same), prev)
  const changed = structuredClone(prev)
  changed[1].canonical_session.preview = 'new'
  const kept = keepRows(prev, changed)
  assert.notEqual(kept, prev)
  assert.equal(kept[0], prev[0], 'the unchanged row keeps its object')
  assert.equal(kept[1], changed[1])
  assert.equal(keepRows(prev, [prev[1], prev[0]]).length, 2, 'a reorder is a change')
  assert.ok(!sameRows(prev, [prev[1], prev[0]]))
  assert.ok(sameData({ a: [1, { b: 2 }] }, { a: [1, { b: 2 }] }))
  assert.ok(!sameData({ a: 1 }, { a: 1, b: undefined }))
})

test('loader: three roster ticks over unchanged data leave the store and the transcript alone', { skip: !READY && 'dev dependencies not installed' }, async t => {
  const sources = [{ connectionId: 'home-server', reachable: true }]
  const ticks = []
  let markdownRenders = 0
  const tweak = sdk => {
    const inner = sdk.MessageTextContent
    sdk.MessageTextContent = props => (markdownRenders++, inner(props))
    // Every read returns equal data as fresh objects, as a react-query refetch does.
    sdk.queryClient.getQueryCache = () => ({
      findAll: () => [{ queryKey: ['hermes-bots', 'roster', null], state: { data: structuredClone({ profiles: [LOCAL, REMOTE], sources }), dataUpdatedAt: Date.now() - 1000 } }]
    })
  }
  globalThis.localStorage?.clear?.()
  const realTimeout = (fn, ms) => {
    const id = setTimeout(fn, ms)
    return () => clearTimeout(id)
  }
  const { workspaces, mount, errors, internals } = await bootPlugin(t, {
    tweak,
    smoke: true,
    sources,
    storage: { selected: 'local::security' },
    ctxExtras: {
      // The roster loop's 3 s timer is driven by hand; everything else runs.
      setTimeout: (fn, ms) => (ms === 3000 ? (ticks.push(fn), () => undefined) : realTimeout(fn, ms))
    }
  })
  localStorage.setItem('hermes.plugin.hermes-bots.bot-meta-v2', JSON.stringify({ security: { title: 'Security' } }))
  const mainEl = mount(workspaces.get('grokbot-override').render)
  await waitFor(() => mainEl.textContent.includes('hello security'), 'the chat')
  // One tick to take in the meta written above, then let the chat settle.
  ticks.shift()()
  await new Promise(resolve => setTimeout(resolve, 100))

  const before = internals.app.roster.get()
  markdownRenders = 0
  for (let i = 0; i < 3; i++) {
    assert.ok(ticks.length, 'the roster loop scheduled its next tick')
    ticks.shift()()
    await new Promise(resolve => setTimeout(resolve, 30))
  }
  assert.equal(internals.app.roster.get(), before, 'the roster state is the same object')
  assert.equal(markdownRenders, 0, 'no transcript re-render')

  // A real change still lands.
  localStorage.setItem('hermes.plugin.hermes-bots.bot-meta-v2', JSON.stringify({ security: { title: 'Sec' } }))
  ticks.shift()()
  assert.notEqual(internals.app.roster.get(), before)
  assert.equal(internals.app.roster.get().rows, before.rows, 'rows untouched when only the meta changed')
  assert.deepEqual(errors.filter(e => e.kind !== 'recoverable'), [])
})
