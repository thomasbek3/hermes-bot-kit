// T9 (audit 20): a bot switch without the "Opening…" flash. Going back to a
// bot shows its last transcript, jobs and screen status at once while the
// registry, history, jobs and status are re-read in the background
// (stale-while-revalidate). A Bot Chat that changed meanwhile drops the
// remembered transcript and opens the normal way.

import assert from 'node:assert/strict'
import test from 'node:test'

import { chatSeed, seedFromState } from '../src/core/session.js'
import { bootPlugin, READY, waitFor } from './loader-boot.mjs'

const deferred = () => {
  let resolve
  const promise = new Promise(res => (resolve = res))
  return { promise, resolve }
}
const frame = () => new Promise(resolve => setTimeout(resolve, 30))

test('seedFromState / chatSeed: only a loaded chat leaves a seed', () => {
  assert.equal(seedFromState({ phase: 'loading', storedId: 's', canonical: { id: 's' }, rows: [] }), null)
  assert.equal(seedFromState({ phase: 'ready', storedId: '', canonical: { id: 's' }, rows: [] }), null)
  const seed = seedFromState({ phase: 'ready', storedId: 's', canonical: { id: 's' }, rows: [{ id: 1 }], hasMore: true })
  assert.deepEqual(seed, { storedId: 's', canonical: { id: 's' }, rows: [{ id: 1 }], hasMore: true })
  assert.deepEqual(chatSeed(seed), seed)
  assert.equal(chatSeed(null), null)
  assert.equal(chatSeed({ storedId: 's', rows: [] }), null, 'no canonical row')
})

test('loader: switching back to a bot shows its transcript, jobs and screen at once', { skip: !READY && 'dev dependencies not installed' }, async t => {
  let gate = null
  let registryId = 's-root'
  const held = async value => {
    if (gate) await gate.promise
    return value
  }
  const answers = {
    'session.list': (_params, profile) =>
      held({ sessions: profile === 'security' ? [{ id: registryId, title: 'Bot Chat', message_count: 4 }] : [{ id: 'k-root', resolved_id: 'k-tip', title: 'Bot Chat', message_count: 4 }] }),
    'cron.manage': (_params, profile) => held({ jobs: profile === 'security' ? [{ job_id: 'j1', name: 'Nightly scan', enabled: true }] : [] }),
    'display.status': (_params, profile) => held({ running: profile === 'security' })
  }
  const { workspaces, mount, errors, internals } = await bootPlugin(t, { smoke: true, answers, storage: { selected: 'local::security' } })
  const { app, selectBot } = internals
  const row = name => app.roster.get().rows.find(r => r.name === name)
  const mainEl = mount(workspaces.get('grokbot-override').render)
  await waitFor(() => mainEl.textContent.includes('hello security'), 'Security’s chat')
  await waitFor(() => app.cron.get().jobs.length === 1 && app.screen.get().status?.running === true, 'Security’s jobs and screen')

  selectBot(row('scholar'))
  await waitFor(() => mainEl.textContent.includes('hello scholar'), 'Scholar’s chat')
  await waitFor(() => app.cron.get().key === 'home-server::scholar' && !app.cron.get().loading, 'Scholar’s jobs')

  // Back to Security with every read held: what shows comes from memory.
  gate = deferred()
  let sawOpening = false
  const observer = new window.MutationObserver(() => {
    if (mainEl.textContent.includes('Opening')) sawOpening = true
  })
  observer.observe(mainEl, { subtree: true, childList: true, characterData: true })
  selectBot(row('security'))
  assert.equal(app.chat.get().phase, 'ready', 'the chat state is ready on the click')
  await frame()
  assert.ok(mainEl.textContent.includes('hello security'), 'the transcript is on screen straight away')
  assert.ok(!mainEl.textContent.includes('hello scholar'))
  assert.deepEqual(app.cron.get().jobs.map(j => j.job_id), ['j1'], 'last known jobs while they reload')
  assert.equal(app.cron.get().loading, true)
  assert.equal(app.screen.get().status?.running, true, 'last known screen status while it reloads')

  // The reads land: same chat, no flash.
  gate.resolve()
  gate = null
  await waitFor(() => !app.cron.get().loading, 'jobs re-read')
  await frame()
  assert.ok(mainEl.textContent.includes('hello security'))
  assert.equal(sawOpening, false, 'never "Opening…"')
  assert.equal(app.chat.get().storedId, 's-root')

  // The Bot Chat was replaced meanwhile: the seed is dropped, the new one opens.
  selectBot(row('scholar'))
  await waitFor(() => mainEl.textContent.includes('hello scholar'), 'Scholar again')
  registryId = 's-new'
  selectBot(row('security'))
  await waitFor(() => app.chat.get()?.storedId === 's-new' && app.chat.get().phase === 'ready', 'the new Bot Chat opened')
  observer.disconnect()
  assert.deepEqual(errors.filter(e => e.kind !== 'recoverable'), [])
})
