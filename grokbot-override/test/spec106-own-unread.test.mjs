// Spec 106: plugin's own unread store for EVERY bot row (local and remote/SSH).
// Covers:
// - new message on remote bot -> dot (including SSH connect-on-demand poll)
// - open + visible + fresh history covering latest -> clears
// - hidden tab / hidden window / empty / failed / cached read -> does NOT clear
// - reload/restart keeps unread and keeps read
// - two machines with same profile name are independent
// - re-created connection for same host keeps stable key (old id doesn't linger)
// - first observation seeds no dot (no flood on install)
// - null / unreadable session fields -> no change (neither mark nor seed)
// - cron-delivered session counts
// - Problem 2: stuck dot (newest activity in a non-Bot-Chat session) clears on open

import assert from 'node:assert/strict'
import test from 'node:test'

import { createOwnership } from '../src/core/ownership.js'
import { createRemoteActivity, remoteActivityCarriers, withRemoteSessions } from '../src/core/remoteActivity.js'
import { extractBotActivity, isBotUnread, isEntryUnread, loadUnreadStore, markBotSeen, observeRoster, unreadBotKey } from '../src/core/unreadStore.js'
import { bootPlugin, LOCAL, READY, waitFor } from './loader-boot.mjs'

const mkBot = (conn, name, extra = {}) => ({
  name,
  display_name: name[0].toUpperCase() + name.slice(1),
  connectionId: conn,
  connectionKind: conn === 'local' ? 'local' : 'ssh',
  remoteSource: conn !== 'local',
  sourceScoped: true,
  route: { connectionId: conn, mode: conn === 'local' ? 'local' : 'remote', profile: name, targetProfile: name },
  ...extra
})

test('Spec 106 core: first observation seeds seen = latest (no dot); new message lights dot; visible fresh history clears', () => {
  const bot = mkBot('brain', 'paverturf', {
    canonical_session: { id: 'p-root', resolved_id: 'p-tip', message_count: 10, last_active: 1762560000, preview: 'old' }
  })
  let { store, changed } = observeRoster({}, [bot], [], { now: 1000 })
  assert.equal(changed, true)
  assert.equal(isBotUnread(store, bot), false, 'first observation seeds no dot')
  assert.equal(store['brain::paverturf'].seenCount, 10)
  assert.equal(store['brain::paverturf'].latestCount, 10)

  // New message arrives on remote bot.
  const moved = mkBot('brain', 'paverturf', {
    canonical_session: { id: 'p-root', resolved_id: 'p-tip', message_count: 11, last_active: 1762560060, preview: 'Cron report ready' }
  })
  ;({ store, changed } = observeRoster(store, [moved], [], { now: 2000 }))
  assert.equal(changed, true)
  assert.equal(isBotUnread(store, moved), true, 'new message on remote bot lights dot')

  // Hidden tab does not clear.
  let seenRes = markBotSeen(store, moved, [], { visible: false, fresh: true, nonEmpty: true, sessionId: 'p-tip', count: 11, lastAt: 1762560060000 })
  assert.equal(seenRes.changed, false)
  assert.equal(isBotUnread(seenRes.store, moved), true, 'hidden tab does not clear')

  // Cached (non-fresh) read does not clear.
  seenRes = markBotSeen(store, moved, [], { visible: true, fresh: false, nonEmpty: true, sessionId: 'p-tip', count: 11, lastAt: 1762560060000 })
  assert.equal(seenRes.changed, false)
  assert.equal(isBotUnread(seenRes.store, moved), true, 'cached read does not clear')

  // Empty read does not clear.
  seenRes = markBotSeen(store, moved, [], { visible: true, fresh: true, nonEmpty: false, sessionId: 'p-tip', count: 0, lastAt: 0 })
  assert.equal(seenRes.changed, false)
  assert.equal(isBotUnread(seenRes.store, moved), true, 'empty read does not clear')

  // A fresh visible page whose count is one short of the roster's (the two
  // count differently) still clears: opening the chat clears the dot, always.
  seenRes = markBotSeen(store, moved, [], { visible: true, fresh: true, nonEmpty: true, sessionId: 'p-tip', count: 10, lastAt: 1762560000000 })
  assert.equal(isBotUnread(seenRes.store, moved), false, 'a count mismatch never leaves the dot stuck')
  assert.equal(isBotUnread(observeRoster(seenRes.store, [moved], [], { now: 3000 }).store, moved), false, 'the same activity does not re-light it')

  // Visible + fresh + non-empty history covering 11 clears!
  seenRes = markBotSeen(store, moved, [], { visible: true, fresh: true, nonEmpty: true, sessionId: 'p-tip', count: 11, lastAt: 1762560060000 })
  assert.equal(seenRes.changed, true)
  assert.equal(isBotUnread(seenRes.store, moved), false, 'visible fresh history covering latest clears')
})

test('Spec 106 core: two machines with same profile name are independent', () => {
  const localOwl = mkBot('local', 'owl', { canonical_session: { id: 'same-id', message_count: 5, last_active: 1000 } })
  const brainOwl = mkBot('brain', 'owl', { canonical_session: { id: 'same-id', message_count: 5, last_active: 1000 } })
  let { store } = observeRoster({}, [localOwl, brainOwl], [])
  assert.equal(isBotUnread(store, localOwl), false)
  assert.equal(isBotUnread(store, brainOwl), false)

  // Brain owl gets a message; local owl does not.
  const brainOwl2 = mkBot('brain', 'owl', { canonical_session: { id: 'same-id', message_count: 6, last_active: 2000 } })
  ;({ store } = observeRoster(store, [localOwl, brainOwl2], []))
  assert.equal(isBotUnread(store, brainOwl2), true, 'brain owl is unread')
  assert.equal(isBotUnread(store, localOwl), false, 'local owl stays read')

  // Clearing local owl does not clear brain owl.
  ;({ store } = markBotSeen(store, localOwl, [], { visible: true, fresh: true, nonEmpty: true, sessionId: 'same-id', count: 6, lastAt: 2000000 }))
  assert.equal(isBotUnread(store, brainOwl2), true, 'brain owl remains unread when local owl is read')

  // Clearing brain owl clears brain owl.
  ;({ store } = markBotSeen(store, brainOwl2, [], { visible: true, fresh: true, nonEmpty: true, sessionId: 'same-id', count: 6, lastAt: 2000000 }))
  assert.equal(isBotUnread(store, brainOwl2), false)
})

test('Spec 106 core: null / unreadable session fields make no change (neither mark nor seed)', () => {
  const unreadable = mkBot('brain', 'meta-ads', { canonical_session: null, last_session: null })
  assert.equal(extractBotActivity(unreadable), null)
  let { store, changed } = observeRoster({}, [unreadable], [])
  assert.equal(changed, false)
  assert.equal(store['brain::meta-ads'], undefined, 'null fields must not seed')

  const allNull = mkBot('brain', 'meta-ads', { canonical_session: { id: null, message_count: null, last_active: null }, last_session: null })
  assert.equal(extractBotActivity(allNull), null)
  ;({ store, changed } = observeRoster(store, [allNull], []))
  assert.equal(changed, false)

  // Once readable, seeds cleanly.
  const readable = mkBot('brain', 'meta-ads', { canonical_session: { id: 'm-1', message_count: 3, last_active: 1000 } })
  ;({ store, changed } = observeRoster(store, [readable], []))
  assert.equal(changed, true)
  assert.equal(isBotUnread(store, readable), false)

  // Subsequent unreadable poll does not clear or invent unread.
  const moved = mkBot('brain', 'meta-ads', { canonical_session: { id: 'm-1', message_count: 4, last_active: 2000 } })
  ;({ store } = observeRoster(store, [moved], []))
  assert.equal(isBotUnread(store, moved), true)
  ;({ store, changed } = observeRoster(store, [unreadable], []))
  assert.equal(changed, false)
  assert.equal(isBotUnread(store, unreadable), true, 'unread state survives a null/unreadable poll')
})

test('Spec 106 core: cron-delivered session counts and Problem 2 stuck dot (non-Bot-Chat session) clears on open', () => {
  const gandalf = mkBot('local', 'gandalf', {
    canonical_session: { id: 'g-botchat', message_count: 10, last_active: 1000, preview: 'hi' },
    last_session: { id: 'g-botchat', message_count: 10, last_active: 1000, preview: 'hi' }
  })
  let { store } = observeRoster({}, [gandalf], [])
  assert.equal(isBotUnread(store, gandalf), false)

  // Cron job delivers a report into a SEPARATE (non-Bot-Chat) session!
  const withCron = mkBot('local', 'gandalf', {
    canonical_session: { id: 'g-botchat', message_count: 10, last_active: 1000, preview: 'hi' },
    last_session: { id: 'cron-run-42', message_count: 2, last_active: 2000, preview: 'Daily cron report' }
  })
  ;({ store } = observeRoster(store, [withCron], []))
  assert.equal(isBotUnread(store, withCron), true, 'cron-delivered non-Bot-Chat session lights the dot')

  // User opens Gandalf's Bot Chat (visible, fresh non-empty history of g-botchat):
  // MUST clear the dot, even though newest activity was in cron-run-42!
  ;({ store } = markBotSeen(store, withCron, [], {
    visible: true,
    fresh: true,
    nonEmpty: true,
    sessionId: 'g-botchat',
    count: 10,
    lastAt: 1000000
  }))
  assert.equal(isBotUnread(store, withCron), false, 'Problem 2: opening bot clears dot caused by non-Bot-Chat session')

  // Next roster poll still reports cron-run-42 at last_active 2000: must NOT re-light!
  ;({ store } = observeRoster(store, [withCron], []))
  assert.equal(isBotUnread(store, withCron), false, 'stays cleared across subsequent roster polls')

  // A NEW cron delivery (cron-run-43) lights it up again!
  const nextCron = mkBot('local', 'gandalf', {
    canonical_session: { id: 'g-botchat', message_count: 10, last_active: 1000, preview: 'hi' },
    last_session: { id: 'cron-run-43', message_count: 2, last_active: 3000, preview: 'Next cron report' }
  })
  ;({ store } = observeRoster(store, [nextCron], []))
  assert.equal(isBotUnread(store, nextCron), true, 'next cron session lights dot again')
})

test('Spec 106 core: re-created connection for the same host keeps host+profile key so old connectionId does not linger', () => {
  const sources1 = [{ connectionId: 'ssh-conn-old', kind: 'ssh', host: 'brain.tailnet', reachable: true }]
  const botOld = mkBot('ssh-conn-old', 'reviewsy', { canonical_session: { id: 'r-1', message_count: 2, last_active: 1000 } })
  assert.equal(unreadBotKey(botOld, sources1), 'brain.tailnet::reviewsy')

  let { store } = observeRoster({}, [botOld], sources1)
  const botOldMoved = mkBot('ssh-conn-old', 'reviewsy', { canonical_session: { id: 'r-1', message_count: 3, last_active: 2000 } })
  ;({ store } = observeRoster(store, [botOldMoved], sources1))
  assert.equal(isBotUnread(store, botOldMoved, sources1), true)

  // Connection is re-created with a brand-new connectionId for the same host.
  const sources2 = [{ connectionId: 'ssh-conn-new', kind: 'ssh', host: 'brain.tailnet', reachable: true }]
  const botNew = mkBot('ssh-conn-new', 'reviewsy', { canonical_session: { id: 'r-1', message_count: 3, last_active: 2000 } })
  assert.equal(unreadBotKey(botNew, sources2), 'brain.tailnet::reviewsy')
  assert.equal(isBotUnread(store, botNew, sources2), true, 'unread state follows host+profile across recreated connection')
  assert.equal(store['ssh-conn-old::reviewsy'], undefined, 'old connectionId does not linger')
})

test('Spec 106 core: persisted store round-trip keeps unread and read states', () => {
  const botA = mkBot('brain', 'paverturf', { canonical_session: { id: 'p-1', message_count: 5, last_active: 1000 } })
  const botB = mkBot('brain', 'reviewsy', { canonical_session: { id: 'r-1', message_count: 5, last_active: 1000 } })
  let { store } = observeRoster({}, [botA, botB], [])
  const botA2 = mkBot('brain', 'paverturf', { canonical_session: { id: 'p-1', message_count: 6, last_active: 2000 } })
  ;({ store } = observeRoster(store, [botA2, botB], []))

  const rehydrated = loadUnreadStore(JSON.parse(JSON.stringify(store)))
  assert.equal(isEntryUnread(rehydrated['brain::paverturf']), true, 'reload keeps unread')
  assert.equal(isEntryUnread(rehydrated['brain::reviewsy']), false, 'reload keeps read')
})

test('Spec 106 core: remoteActivity polls SSH connect-on-demand rows and overlays session fields', async () => {
  const sshRow = mkBot('brain', 'paverturf', { sourceError: 'connect-on-demand', sourceReachable: false })
  const carriers = remoteActivityCarriers([sshRow])
  assert.equal(carriers.get('brain')?.name, 'paverturf', 'SSH connect-on-demand row is eligible for remote activity poll')

  let changes = 0
  const ownership = createOwnership()
  const ra = createRemoteActivity({
    ownership,
    onChange: () => (changes += 1),
    request: async () => ({
      install_id: 'brain-install-1',
      profiles: [
        { name: 'paverturf', canonical_session: { id: 'pt-1', message_count: 7, last_active: 5000, preview: 'Cron done' } }
      ]
    })
  })
  ra.sync(['brain'])
  const ok = await ra.read('brain', sshRow)
  assert.equal(ok, true)
  assert.equal(changes, 1)
  const overlaid = withRemoteSessions([sshRow], ra.lists())
  assert.equal(overlaid[0].canonical_session?.id, 'pt-1')
  assert.equal(overlaid[0].canonical_session?.message_count, 7)
})

test('Spec 106 loader-faithful: remote SSH bot gets dot on cron report, hidden tab does not clear, visible fresh history clears, survives reload', { skip: !READY && 'dev dependencies not installed' }, async t => {
  const brainSource = { connectionId: 'brain', kind: 'ssh', label: 'brain', host: 'brain.local', reachable: false, error: 'connect-on-demand' }
  const sshBot = {
    name: 'paverturf',
    display_name: 'PaverTurf',
    remoteSource: true,
    sourceScoped: true,
    connectionId: 'brain',
    connectionKind: 'ssh',
    connectionLabel: 'brain',
    sourceReachable: false,
    sourceError: 'connect-on-demand',
    route: { connectionId: 'brain', mode: 'remote', profile: 'paverturf', targetProfile: 'paverturf' }
  }

  let brainProfiles = [
    { name: 'paverturf', canonical_session: { id: 'pt-root', message_count: 4, last_active: 1762560000, preview: 'initial' } }
  ]
  let paneShown = false
  const visListeners = new Set()
  const setPaneShown = v => {
    paneShown = v
    for (const fn of visListeners) fn(v)
  }

  const { panes, mount, errors, reload } = await bootPlugin(t, {
    rows: [LOCAL, sshBot],
    sources: [brainSource],
    answers: {
      'profiles.list': (params, profile) => {
        if (profile === 'paverturf') return { install_id: 'brain-host-1', profiles: brainProfiles }
        return { profiles: [LOCAL] }
      },
      'session.list': (params, profile) => {
        if (profile === 'paverturf') return { sessions: [{ id: 'pt-root', title: 'Bot Chat', message_count: 4 }] }
        return { sessions: [{ ...LOCAL.canonical_session, title: 'Bot Chat', message_count: 4 }] }
      }
    },
    tweak: sdk => {
      sdk.host.paneVisibility = () => ({
        get: () => paneShown,
        subscribe: fn => (visListeners.add(fn), fn(paneShown), () => visListeners.delete(fn))
      })
    }
  })

  let rosterEl = mount(panes.find(p => p.id === 'roster').render)
  const rowOf = name => [...rosterEl.querySelectorAll('button.gbo-row')].find(b => b.textContent.includes(name))
  const dotOf = el => el?.querySelector('.gbo-unread-dot [role="status"][data-gbo-unread="true"]')

  await waitFor(() => rowOf('PaverTurf'), 'remote SSH row')
  // Wait for first remote activity poll to seed PaverTurf (no dot on first observation).
  await waitFor(() => rowOf('PaverTurf').textContent.includes('initial'), 'initial remote preview overlaid', 6000)
  assert.ok(!dotOf(rowOf('PaverTurf')), 'first observation seeds no dot')

  // Simulate cron report on PaverTurf in a non-Bot-Chat session (Problem 2 + cron).
  brainProfiles = [
    {
      name: 'paverturf',
      canonical_session: { id: 'pt-root', message_count: 4, last_active: 1762560000, preview: 'initial' },
      last_session: { id: 'pt-cron-1', message_count: 2, last_active: 1762560120, preview: 'Morning cron report' }
    }
  ]
  // Trigger a fresh reload with the new profile state? Wait: remote poll has 60s cadence,
  // so reloading resets the poll cadence and immediately runs the remote poll against persisted unreadStore!
  await reload()
  rosterEl = mount(panes.find(p => p.id === 'roster').render)
  await waitFor(() => dotOf(rowOf('PaverTurf')), 'PaverTurf lights up with blue dot on cron report', 6000)

  // Click PaverTurf while its pane is HIDDEN (paneShown === false): must NOT clear!
  rowOf('PaverTurf').click()
  await new Promise(resolve => setTimeout(resolve, 250))
  assert.ok(dotOf(rowOf('PaverTurf')), 'hidden tab must NOT clear the unread dot')

  // Make the pane VISIBLE: now the fresh history clears the dot!
  setPaneShown(true)
  await waitFor(() => !dotOf(rowOf('PaverTurf')), 'becoming visible with fresh history clears the dot')

  // Reload again: PaverTurf must STAY read!
  await reload()
  rosterEl = mount(panes.find(p => p.id === 'roster').render)
  await waitFor(() => rowOf('PaverTurf'), 'PaverTurf after reload')
  await new Promise(resolve => setTimeout(resolve, 250))
  assert.ok(!dotOf(rowOf('PaverTurf')), 'stays read after reload')
  assert.deepEqual(errors.map(e => `${e.kind}: ${e.error?.message}`), [])
})
