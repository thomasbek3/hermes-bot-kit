// Review tighter-b r3 #2 (T9): without the REST history bridge the chat's
// transcript comes from the session.resume history fallback (items, no
// rows). Going back to such a bot still shows its last transcript at once,
// read-only while it is checked.

import assert from 'node:assert/strict'
import test from 'node:test'

import { createChatController, seedFromState } from '../src/core/session.js'
import { BOT, gateway } from './harness.mjs'
import { bootPlugin, READY, waitFor } from './loader-boot.mjs'

test('seedFromState keeps a fallback chat’s stored items, never live or local ones; a seed paints them', () => {
  const state = {
    phase: 'ready',
    storedId: 'tip',
    canonical: { id: 'root', resolved_id: 'tip' },
    rows: [],
    hasMore: false,
    chat: { items: [{ kind: 'user', id: 'r:1', text: 'hi' }, { kind: 'assistant', id: 'r:2', text: 'hello' }, { kind: 'assistant', id: 'live:x', text: 'partial' }, { kind: 'user', id: 'local:y', text: 'unsent' }] }
  }
  const seed = seedFromState(state)
  assert.deepEqual(seed.items.map(i => i.id), ['r:1', 'r:2'])
  const chat = createChatController(BOT, gateway().deps, { seed })
  assert.deepEqual(chat.get().chat.items.map(i => i.text), ['hi', 'hello'])
  assert.equal(chat.get().checking, true)
  chat.dispose()
})

const deferred = () => {
  let resolve
  const promise = new Promise(res => (resolve = res))
  return { promise, resolve }
}

test('loader: A -> B -> A with the REST history bridge down shows A’s fallback transcript at once', { skip: !READY && 'dev dependencies not installed' }, async t => {
  let gate = null
  const answers = {
    'session.list': async (_params, profile) => {
      if (gate && profile === 'security') await gate.promise
      return { sessions: profile === 'security' ? [{ id: 's-root', title: 'Bot Chat', message_count: 2 }] : [{ id: 'k-root', resolved_id: 'k-tip', title: 'Bot Chat', message_count: 2 }] }
    },
    'session.resume': (params, profile) => ({
      session_id: `rt-${profile}`,
      running: false,
      message_count: 2,
      ...(params?.omit_messages ? {} : { messages: [{ role: 'user', content: `fallback hello ${profile}`, timestamp: 1762560000 }, { role: 'assistant', content: `fallback answer ${profile}`, timestamp: 1762560001 }] })
    })
  }
  const api = () => {
    throw new Error('no transcript reader')
  }
  const { workspaces, mount, errors, internals } = await bootPlugin(t, { smoke: true, answers, api, storage: { selected: 'local::security' } })
  const { app, selectBot } = internals
  const row = name => app.roster.get().rows.find(r => r.name === name)
  const mainEl = mount(workspaces.get('grokbot-override').render)
  await waitFor(() => mainEl.textContent.includes('fallback answer security'), 'Security’s fallback transcript')
  assert.equal(app.chat.get().rows.length, 0, 'no REST rows: the transcript is items only')
  selectBot(row('scholar'))
  await waitFor(() => mainEl.textContent.includes('fallback answer scholar'), 'Scholar')

  gate = deferred()
  selectBot(row('security'))
  await new Promise(resolve => setTimeout(resolve, 30))
  assert.equal(app.chat.get().checking, true, 'still being checked')
  assert.ok(mainEl.textContent.includes('fallback answer security'), 'the remembered fallback transcript shows at once')
  assert.ok(!mainEl.textContent.includes('Opening'))
  gate.resolve()
  gate = null
  await waitFor(() => app.chat.get().checking === false && app.chat.get().phase === 'ready', 'checked')
  await waitFor(() => mainEl.textContent.includes('fallback answer security'), 'still there after the check')
  assert.deepEqual(errors.filter(e => e.kind !== 'recoverable'), [])
})
