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
// - spec 106b: unread = Bot Chat (canonical_session) only: a new cron session
//   (silent, or mid-run non-silent) does NOT light the dot; a delivered cron
//   report (new Bot Chat message) DOES; a stored cron-tip latest re-baselines
// - Problem 2: stuck dot (empty Bot Chat / count mismatch) clears on open

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

test('Spec 106b core: a new cron session (last_session newer, Bot Chat unchanged) does NOT light the dot', () => {
  const upwork = mkBot('brain', 'upwork-bot', {
    canonical_session: { id: 'u-botchat', message_count: 10, last_active: 1000, preview: 'hi' },
    last_session: { id: 'u-botchat', message_count: 10, last_active: 1000, preview: 'hi' }
  })
  let { store } = observeRoster({}, [upwork], [])
  assert.equal(isBotUnread(store, upwork), false)

  // "Upwork job scout · Nov 25 10:53": a brand-new cron session, ended [SILENT].
  const silentRun = mkBot('brain', 'upwork-bot', {
    canonical_session: { id: 'u-botchat', message_count: 10, last_active: 1000, preview: 'hi' },
    last_session: { id: 'cron-scout-1053', message_count: 3, last_active: 2000, preview: '[SILENT]' }
  })
  ;({ store } = observeRoster(store, [silentRun], []))
  assert.equal(isBotUnread(store, silentRun), false, 'a silent cron run does not light the dot')

  // The next run's session with a non-silent preview (a finished run that did
  // not deliver) still does not light it: only the Bot Chat counts.
  const loudRun = mkBot('brain', 'upwork-bot', {
    canonical_session: { id: 'u-botchat', message_count: 10, last_active: 1000, preview: 'hi' },
    last_session: { id: 'cron-scout-1055', message_count: 4, last_active: 3000, preview: 'Scanned 12 jobs, none matched' }
  })
  ;({ store } = observeRoster(store, [loudRun], []))
  assert.equal(isBotUnread(store, loudRun), false, 'a new cron session never lights the dot while the Bot Chat is unchanged')
  assert.equal(store['brain::upwork-bot'].latestTipId, 'u-botchat', 'latest stays the Bot Chat')
})

test('Spec 106b core: a mid-run last_session preview (not yet [SILENT]) does not light the dot', () => {
  const base = { canonical_session: { id: 'u-botchat', message_count: 10, last_active: 1000, preview: 'hi' } }
  let { store } = observeRoster({}, [mkBot('brain', 'upwork-bot', base)], [])
  // Poll catches the run mid-flight: tool output preview, not [SILENT] yet.
  const midRun = mkBot('brain', 'upwork-bot', { ...base, last_session: { id: 'cron-scout-1057', message_count: 2, last_active: 2000, preview: 'Searching Upwork for n8n jobs...' } })
  ;({ store } = observeRoster(store, [midRun], []))
  assert.equal(isBotUnread(store, midRun), false, 'mid-run preview does not light the dot')
  // Then the run finishes [SILENT].
  const done = mkBot('brain', 'upwork-bot', { ...base, last_session: { id: 'cron-scout-1057', message_count: 3, last_active: 2010, preview: '[SILENT]' } })
  ;({ store } = observeRoster(store, [done], []))
  assert.equal(isBotUnread(store, done), false, 'and stays unlit after the run ends')
})

test('Spec 106b core: a delivered cron report (new message in the Bot Chat) DOES light the dot; opening clears it; the next report re-lights it', () => {
  const meta = mkBot('brain', 'meta-ads', {
    canonical_session: { id: 'm-botchat', message_count: 10, last_active: 1000, preview: 'hi' },
    last_session: { id: 'm-botchat', message_count: 10, last_active: 1000, preview: 'hi' }
  })
  let { store } = observeRoster({}, [meta], [])
  // Cron session 12:01 runs, then its report is appended to the Bot Chat at 12:02.
  const delivered = mkBot('brain', 'meta-ads', {
    canonical_session: { id: 'm-botchat', message_count: 11, last_active: 2100, preview: 'Meta Ads report: CPL up 12%' },
    last_session: { id: 'cron-meta-1201', message_count: 3, last_active: 2000, preview: 'Meta Ads report: CPL up 12%' }
  })
  ;({ store } = observeRoster(store, [delivered], []))
  assert.equal(isBotUnread(store, delivered), true, 'a delivered cron report lights the dot')

  // Opening the bot clears it, even when the page count is one short of the roster's.
  ;({ store } = markBotSeen(store, delivered, [], { visible: true, fresh: true, nonEmpty: true, sessionId: 'm-botchat', count: 10, lastAt: 2100000 }))
  assert.equal(isBotUnread(store, delivered), false, 'opening clears the dot')
  ;({ store } = observeRoster(store, [delivered], []))
  assert.equal(isBotUnread(store, delivered), false, 'the same activity does not re-light it')

  const next = mkBot('brain', 'meta-ads', {
    canonical_session: { id: 'm-botchat', message_count: 12, last_active: 3100, preview: 'Next report' },
    last_session: { id: 'cron-meta-1301', message_count: 3, last_active: 3000, preview: 'Next report' }
  })
  ;({ store } = observeRoster(store, [next], []))
  assert.equal(isBotUnread(store, next), true, 'the next delivered report lights it again')
})

test('Spec 106b core: last_session is used only when the bot has no readable Bot Chat', () => {
  const noChat = mkBot('local', 'gandalf', {
    canonical_session: null,
    last_session: { id: 'g-other', message_count: 6, last_active: 1000, preview: 'older talk' }
  })
  assert.equal(extractBotActivity(noChat).tipId, 'g-other')
  assert.equal(extractBotActivity(noChat).isCanonical, false)
  let { store } = observeRoster({}, [noChat], [])
  const moved = mkBot('local', 'gandalf', { canonical_session: null, last_session: { id: 'g-other', message_count: 8, last_active: 2000, preview: 'new talk' } })
  ;({ store } = observeRoster(store, [moved], []))
  assert.equal(isBotUnread(store, moved), true, 'without a Bot Chat, last_session activity lights the dot')
  ;({ store } = markBotSeen(store, moved, [], { visible: true, fresh: true, nonEmpty: false, emptyChat: true, sessionId: '', count: 0, lastAt: 0 }))
  assert.equal(isBotUnread(store, moved), false, 'opening clears it (Problem 2: empty Bot Chat, activity elsewhere)')

  // With a readable Bot Chat, last_session is ignored even if newer.
  const both = mkBot('local', 'gandalf', {
    canonical_session: { id: 'g-botchat', message_count: 0, last_active: 500 },
    last_session: { id: 'g-other', message_count: 9, last_active: 9000, preview: 'x' }
  })
  assert.equal(extractBotActivity(both).tipId, 'g-botchat')
  assert.equal(extractBotActivity(both).isCanonical, true)
})

test('Spec 106b core: a stored entry whose latest is a cron tip (old rule) re-baselines to the Bot Chat on next observation, clearing the false dot', () => {
  // What the 106 build left in storage for Upwork Bot: latest = a cron run's
  // session, seen = the Bot Chat -> permanently unread.
  const legacy = loadUnreadStore({
    'brain::upwork-bot': { seenCount: 10, seenTipId: 'u-botchat', latestCount: 2, latestTipId: 'cron-scout-1053', updatedAt: 5, seenAt: 1000000, latestAt: 2000000 }
  })
  const bot = mkBot('brain', 'upwork-bot', {
    canonical_session: { id: 'u-botchat', message_count: 10, last_active: 1000, preview: 'hi' },
    last_session: { id: 'cron-scout-1055', message_count: 2, last_active: 2100, preview: 'Searching...' }
  })
  assert.equal(isBotUnread(legacy, bot), true, 'precondition: the false dot is lit')
  let { store, changed } = observeRoster(legacy, [bot], [], { now: 10 })
  assert.equal(changed, true)
  assert.equal(isBotUnread(store, bot), false, 'false cron dot clears without opening the bot')
  const e = store['brain::upwork-bot']
  assert.equal(e.latestTipId, 'u-botchat')
  assert.equal(e.seenTipId, 'u-botchat')
  assert.equal(e.latestCount, 10)
  assert.equal(e.seenCount, 10)
  assert.equal(e.latestSource, 'canonical')

  // Survives a reload, and a later delivered report still lights it.
  store = loadUnreadStore(JSON.parse(JSON.stringify(store)))
  assert.equal(observeRoster(store, [bot], []).changed, false, 'stable on the next poll')
  const delivered = mkBot('brain', 'upwork-bot', { canonical_session: { id: 'u-botchat', message_count: 11, last_active: 3000, preview: 'New match: n8n job' } })
  ;({ store } = observeRoster(store, [delivered], []))
  assert.equal(isBotUnread(store, delivered), true, 'a real Bot Chat message after re-baseline lights the dot')

  // A legacy entry with a REAL Bot Chat unread (seen tip = Bot Chat, it grew)
  // keeps that unread through re-baseline.
  const realUnread = loadUnreadStore({
    'brain::upwork-bot': { seenCount: 10, seenTipId: 'u-botchat', latestCount: 2, latestTipId: 'cron-scout-1053', updatedAt: 5, seenAt: 1000000, latestAt: 2000000 }
  })
  ;({ store } = observeRoster(realUnread, [delivered], []))
  assert.equal(isBotUnread(store, delivered), true, 'a Bot Chat that grew since it was seen stays unread')
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

  // A cron run (own session) delivers its report into the Bot Chat (spec 106b).
  brainProfiles = [
    {
      name: 'paverturf',
      canonical_session: { id: 'pt-root', message_count: 5, last_active: 1762560125, preview: 'Morning cron report' },
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
