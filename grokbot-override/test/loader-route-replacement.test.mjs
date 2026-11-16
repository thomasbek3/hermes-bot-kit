// Review tighter-b r3 #1 (T3 + T9): the selected bot's Bot Chat was replaced
// (the roster already names the new one) and Hermes opens the replacement
// (a notification, search, a session tab). The override must show and send
// to the replacement, never reuse the ready controller still attached to the
// old chat.

import assert from 'node:assert/strict'
import test from 'node:test'

import { mainPaneModel } from './claim-host.mjs'
import { bootPlugin, LOCAL, READY, REMOTE, waitFor } from './loader-boot.mjs'

const MAIN = 'plugin-workspace:grokbot-override'

function type(el, value) {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set
  setter.call(el, value)
  el.setSelectionRange(value.length, value.length)
  el.dispatchEvent(new window.Event('input', { bubbles: true }))
}

test('loader: opening the replacement of the selected bot’s Bot Chat shows it and sends to it, not to the old runtime', { skip: !READY && 'dev dependencies not installed' }, async t => {
  const model = mainPaneModel('workspace')
  let rows = [LOCAL, REMOTE]
  let registryId = 's-root'
  const ticks = []
  const tweak = sdk => {
    model.tweak(sdk)
    sdk.queryClient.getQueryCache = () => ({
      findAll: () => [{ queryKey: ['hermes-bots', 'roster', null], state: { data: { profiles: rows, sources: [] }, dataUpdatedAt: Date.now() } }]
    })
  }
  const answers = {
    'session.list': (_params, profile) =>
      profile === 'security' ? { sessions: [{ id: registryId, title: 'Bot Chat', message_count: 2 }] } : { sessions: [{ id: 'k-root', resolved_id: 'k-tip', title: 'Bot Chat', message_count: 4 }] },
    'session.resume': params => ({ session_id: `rt-${params.session_id}`, running: false, message_count: 2 }),
    'prompt.submit': () => ({ status: 'streaming' })
  }
  const api = request => {
    if (String(request.path || '').includes('/s-new/')) {
      return { session_id: 's-new', messages: [{ id: 21, role: 'user', content: 'hello replacement', timestamp: 1762570000 }], pagination: { limit: 120, offset: 0, order: 'latest', returned: 1 } }
    }
    return undefined
  }
  const realTimeout = (fn, ms) => {
    const id = setTimeout(fn, ms)
    return () => clearTimeout(id)
  }
  const { workspaces, mount, errors, internals, calls } = await bootPlugin(t, {
    tweak,
    answers,
    api,
    smoke: true,
    storage: { selected: 'local::security', chatOpen: false },
    // The roster loop's 3 s tick is driven by hand.
    ctxExtras: { setTimeout: (fn, ms) => (ms === 3000 ? (ticks.push(fn), () => undefined) : realTimeout(fn, ms)) }
  })
  const { app } = internals
  const mainEl = mount(workspaces.get('grokbot-override').render)
  await waitFor(() => mainEl.textContent.includes('hello security'), 'Security’s chat')
  await waitFor(() => app.chat.get()?.runtimeId === 'rt-s-root', 'attached to the old Bot Chat')
  document.dispatchEvent(new window.MouseEvent('pointerdown', { bubbles: true }))

  // The Bot Chat is replaced: registry and roster now name s-new.
  registryId = 's-new'
  rows = [{ ...LOCAL, canonical_session: { id: 's-new', preview: 'replacement', last_active: 1762570000 } }, REMOTE]
  ticks.shift()()
  await waitFor(() => app.roster.get().rows.find(r => r.name === 'security')?.canonical_session?.id === 's-new', 'the roster names the replacement')

  // Hermes opens the replacement (a notification, search, a session tab).
  model.restoreSession('s-new')
  await waitFor(() => model.state.pane === MAIN, 'routed into the override')
  // Give whatever opens time to open, then send from the composer as a user.
  await new Promise(resolve => setTimeout(resolve, 800))
  const input = () => mainEl.querySelector('textarea')
  await waitFor(() => input() && !input().disabled, 'the composer')
  type(input(), 'message meant for the replacement')
  await waitFor(() => !mainEl.querySelector('button.is-send').disabled, 'Send enabled')
  mainEl.querySelector('button.is-send').click()
  await waitFor(() => calls.some(c => c.method === 'prompt.submit'), 'the send')
  const submits = calls.filter(c => c.method === 'prompt.submit')
  assert.equal(submits.length, 1)
  assert.equal(submits[0].params.text, 'message meant for the replacement')
  assert.equal(submits[0].params.session_id, 'rt-s-new', 'sent to the replacement’s runtime, never the old one')
  assert.equal(app.chat.get().storedId, 's-new', 'the replacement is the open chat')
  assert.equal(app.selectedKey.get(), 'local::security')
  await waitFor(() => mainEl.textContent.includes('hello replacement'), 'the replacement’s transcript')
  assert.ok(!mainEl.textContent.includes('hello security'), 'the old transcript is gone')
  assert.deepEqual(errors.filter(e => e.kind !== 'recoverable'), [])
})
