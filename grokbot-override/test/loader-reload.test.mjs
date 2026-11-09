// Pass 6 C1: Hermes's stock chat view must never take the main pane beside
// the override's roster. Live repro: ⌘K "Reload desktop plugins" with a Bot
// Chat open left Hermes's own session view in the main pane. A reload runs
// every disposer of the running instance and registers a freshly evaluated
// plugin.js (contrib/runtime-loader.ts activate); the host keeps a plugin
// workspace registered past its plugin, so the old instance closes its chat
// tab (sdk/index.ts openWorkspace: the closer calls onClose) and the new one
// must take the main pane back.
//
// The fake host below models the main pane: a workspace docked center in
// 'workspace' fronts it; closing that tab or host.openSession in place shows
// Hermes's own chat view ('stock-chat').

import assert from 'node:assert/strict'
import test from 'node:test'

import { bootPlugin, READY, waitFor } from './loader-boot.mjs'

const MAIN = 'plugin-workspace:grokbot-override'

test('loader: normal clicks keep the override screen; a plugin reload takes the main pane back', { skip: !READY && 'dev dependencies not installed' }, async t => {
  const main = { pane: 'stock-chat', history: [] }
  const front = pane => {
    main.pane = pane
    main.history.push(pane)
  }
  const reveals = []
  const closeMainRef = { current: null }
  const closeMain = () => closeMainRef.current?.()
  const actions = []
  const booted = await bootPlugin(t, {
    storage: { pinnedBots: ['local::security'] },
    ctxExtras: { runAction: id => (actions.push(id), { ok: true }) },
    tweak: sdk => {
      const { host } = sdk
      const openWorkspace = host.openWorkspace
      host.openWorkspace = (id, options) => {
        const close = openWorkspace(id, options)
        const pane = `plugin-workspace:${id}`
        if (options?.dock?.pane === 'workspace' && options.dock.pos === 'center') front(pane)
        // sdk/index.ts: the closer removes the pane and calls onClose.
        return () => {
          if (main.pane === pane) front('stock-chat')
          close()
          options.onClose?.()
        }
      }
      const openSession = host.openSession
      host.openSession = async (...args) => {
        front('stock-chat')
        return openSession(...args)
      }
      host.revealPane = id => void reveals.push(id)
      const wrapped = host.openWorkspace
      host.openWorkspace = (id, options) => {
        const close = wrapped(id, options)
        if (id === 'grokbot-override') closeMainRef.current = close
        return close
      }
    }
  })
  const { panes, workspaces, mount, errors, calls, reload, store } = booted
  const stockCalls = () => calls.filter(c => c.method === 'openSession')

  let rosterEl = mount(panes.find(p => p.id === 'roster').render)
  const row = name => [...rosterEl.querySelectorAll('button.gbo-row')].find(b => b.textContent.includes(name))
  ;(await waitFor(() => row('Scholar'), 'rows')).click()
  let mainEl = mount((await waitFor(() => workspaces.get('grokbot-override'), 'the chat tab')).render)
  await waitFor(() => mainEl.textContent.includes('hello scholar'), 'Scholar’s transcript')
  assert.equal(main.pane, MAIN, 'the override holds the main pane')
  assert.equal(store.get('chatOpen'), true)

  const stays = label => {
    assert.equal(main.pane, MAIN, `${label}: the override keeps the main pane`)
    assert.ok(workspaces.has('grokbot-override'), `${label}: the chat tab stays registered`)
    assert.ok(mainEl.querySelector('.gbo-chat'), `${label}: our chat stays mounted`)
    assert.equal(stockCalls().length, 0, `${label}: nothing handed to Hermes's chat view`)
    assert.ok(!reveals.includes('hermes-bots:pane'), `${label}: the stock Bots surface is not revealed`)
  }

  // 1. A roster row (the first click opened the tab; this one switches in it).
  stays('row click')

  // 2. The pinned tile.
  const pin = await waitFor(() => [...rosterEl.querySelectorAll('.gbo-pins button.gbo-pin')].find(b => b.textContent.includes('Security')), 'the pinned tile')
  pin.click()
  await waitFor(() => mainEl.textContent.includes('hello security'), 'back on Security')
  stays('pinned tile')

  // 3. The header: the pill and the details toggle.
  mainEl.querySelector('.gbo-head-pill').click()
  await new Promise(r => setTimeout(r, 20))
  stays('header pill')
  const toggle = await waitFor(() => mainEl.querySelector('.gbo-panel-toggle') || mainEl.querySelector('.gbo-head-pill'), 'a profile toggle')
  toggle.click()
  await new Promise(r => setTimeout(r, 20))
  stays('show profile')

  // 4. The sidebar toggle (Hermes's own view.toggleSidebar action).
  rosterEl.querySelector('button[aria-label="Hide sidebar"]').click()
  assert.deepEqual(actions, ['view.toggleSidebar'])
  stays('sidebar toggle')

  // 5. Share → Open another chat beside this one: a SIDE pane, never ours replaced.
  mainEl.querySelector('button[aria-label="Share"]').click()
  ;(await waitFor(() => [...document.querySelectorAll('[role="menuitem"]')].find(el => el.textContent.includes('Open another chat beside this one')), 'the Share menu')).click()
  const [, side] = await waitFor(() => [...workspaces.entries()].find(([id]) => id.startsWith('grokbot-override-tab-')), 'the side tab')
  assert.deepEqual(side.dock, { pane: MAIN, pos: 'right' }, 'docked to the right of the main chat')
  stays('open beside')

  // 6. ⌘K → Reload desktop plugins, with Security's chat open.
  const resumesBefore = calls.filter(c => c.method === 'session.resume' && c.via === 'local::security').length
  await reload()
  assert.equal(main.pane, MAIN, 'the reloaded override took the main pane back')
  assert.ok(main.history.includes('stock-chat'), 'the old instance did close its tab')
  assert.equal(store.get('chatOpen'), true, 'the teardown did not forget the open chat')
  rosterEl = mount((await waitFor(() => panes.find(p => p.id === 'roster'), 'the new roster pane')).render)
  mainEl = mount(workspaces.get('grokbot-override').render)
  await waitFor(() => mainEl.textContent.includes('hello security'), 'the same bot’s chat, live again')
  await waitFor(() => calls.filter(c => c.method === 'session.resume' && c.via === 'local::security').length > resumesBefore, 'attached again')
  await waitFor(() => rosterEl.querySelector('.gbo-pins button.gbo-pin.is-selected')?.textContent.includes('Security'), 'still selected (its pinned tile)')
  assert.equal(stockCalls().length, 0, 'Hermes’s chat view was never opened')
  assert.equal(reveals.at(-1), 'grokbot-override:roster', 'the roster is the sidebar again')

  // 7. Closing the chat tab would leave Hermes's own view under it: while
  // the override is on, its tab comes straight back.
  closeMain()
  assert.equal(store.get('chatOpen'), false, 'the user’s close is recorded')
  await waitFor(() => workspaces.has('grokbot-override') && main.pane === MAIN, 'the tab claimed back')
  await reload()
  assert.equal(main.pane, MAIN, 'and after another reload')
  assert.equal(stockCalls().length, 0)

  assert.deepEqual(errors.filter(e => e.kind !== 'recoverable'), [])
})
