// Names of bots whose roster row carries none (an SSH source that is not the
// live gateway): read from the bot's own gateway, cached per connection +
// profile, never borrowed from this desktop's bare-name record. The
// loader-faithful half is test/loader-ssh-bot-names*.test.mjs.

import assert from 'node:assert/strict'
import test from 'node:test'

import { effectiveMeta, localMetaFor, saveBotMetaPatch } from '../src/core/botMeta.js'
import {
  entriesFromProfiles,
  entryAfterSave,
  gatewayMetaEntry,
  gatewayMetaFor,
  gatewayMetaKey,
  GATEWAY_META_MAX,
  hasListingMeta,
  mergeEntries,
  pruneCache
} from '../src/core/gatewayMeta.js'
import { createRemoteAvatars } from '../src/core/remoteAvatars.js'
import { botMeta, displayName } from '../src/core/roster.js'

// An SSH bot as host.agents lists it: connect-on-demand, no name data.
const ssh = (name = 'default', connectionId = 'laptop', extra = {}) => ({
  name,
  remoteSource: true,
  sourceScoped: true,
  connectionId,
  connectionKind: 'ssh',
  connectionLabel: 'Laptop',
  route: { connectionId, mode: 'remote', profile: name, targetProfile: name },
  sourceReachable: false,
  sourceError: 'connect-on-demand',
  ...extra
})
const localDefault = (extra = {}) => ({
  name: 'default',
  sourceScoped: true,
  connectionId: 'local',
  connectionKind: 'local',
  route: { connectionId: 'local', mode: 'local', profile: 'default', targetProfile: 'default' },
  ...extra
})
const entry = (title, at = 1) => ({ meta: { title }, display_name: '', description: '', at })

/** What the roster shows for a row (app.ts metaFor + roster.js displayName). */
function shown(bot, { localMeta = {}, writes = {}, fresh = {}, cache = {}, now = 1_000 } = {}) {
  return displayName(bot, effectiveMeta(bot, localMeta, writes, now, gatewayMetaFor(bot, fresh, cache)))
}

test('resolution order: row name > gateway meta > scoped cache > fallback', () => {
  const key = 'laptop::default'
  const fresh = { [key]: entry('Fresh') }
  const cache = { [key]: entry('Cached') }

  // 1. A row that lists its own name (its source answered) wins over both.
  const listed = ssh('default', 'laptop', { sourceReachable: true, sourceError: null, ui_meta: { 'hermes-bots': { title: 'Listed' } } })
  assert.equal(shown(listed, { fresh, cache }), 'Listed')
  assert.equal(shown(ssh('default', 'laptop', { display_name: 'Listed Name' }), { fresh, cache }), 'Listed Name')
  // A listing that says "no title" is the gateway's word too: no borrowing.
  assert.equal(shown(ssh('default', 'laptop', { display_name: '' }), { fresh, cache }), 'Hermes')

  // 2. No listing data: this session's gateway read.
  assert.equal(shown(ssh(), { fresh, cache }), 'Fresh')
  // 3. Nothing read yet this session: the cache.
  assert.equal(shown(ssh(), { cache }), 'Cached')
  // A cached display_name stands in for a missing title (relay.ts order).
  assert.equal(shown(ssh(), { cache: { [key]: { meta: {}, display_name: 'Display', description: '', at: 1 } } }), 'Display')
  // 4. Nothing anywhere: the fallback name.
  assert.equal(shown(ssh()), 'Hermes')
  assert.equal(shown(ssh('scout-two')), 'Scout Two')

  // A save of this desktop still shows over all of them for its fence.
  const writes = { [key]: { patch: { title: 'Just Saved' }, at: 900, sticky: false } }
  assert.equal(shown(ssh(), { fresh, cache, writes }), 'Just Saved')
})

test('the gateway meta corrects the route-keyed local snapshot, keeps its local image, and fills the look', () => {
  const bot = ssh()
  const localMeta = { 'laptop::default': { title: 'Old', image: 'data:image/png;base64,AAAA', pinned: true } }
  const gateway = { meta: { title: 'Scout', color: '#ff0000', shape: 'pixel' }, display_name: '', description: '', at: 1 }
  const meta = effectiveMeta(bot, localMeta, {}, 1, gateway)
  assert.equal(meta.title, 'Scout')
  assert.equal(meta.color, '#ff0000')
  assert.equal(meta.shape, 'pixel')
  assert.equal(meta.image, 'data:image/png;base64,AAAA')
  assert.equal(meta.pinned, true)
})

test('only rows on a remote route without listing data are named by their gateway', () => {
  const cache = { 'local::default': entry('Wrong'), 'laptop::default': entry('Scout') }
  assert.equal(gatewayMetaKey(ssh()), 'laptop::default')
  assert.equal(gatewayMetaKey(localDefault()), '', 'a local bot keeps today’s behaviour')
  assert.equal(gatewayMetaKey({ name: 'default' }), '', 'an unscoped row of the active gateway')
  assert.equal(gatewayMetaFor(localDefault(), {}, cache), null)
  assert.equal(shown(localDefault(), { cache }), 'Hermes', 'local default without a title still renders Hermes')
  assert.equal(hasListingMeta(ssh()), false)
  assert.equal(hasListingMeta(ssh('default', 'laptop', { ui_meta_revisions: {} })), true)
})

test('a title on the bare `default` record never appears on another connection’s default', () => {
  const localMeta = { default: { title: 'Desk' } }
  const other = ssh('default', 'other')
  assert.equal(localMetaFor(other, localMeta), null)
  assert.equal(botMeta(other, localMeta).title, undefined)
  assert.notEqual(shown(other, { localMeta }), 'Desk')
  assert.equal(shown(other, { localMeta }), 'Hermes')
  // With a gateway name it shows that one, still not the bare record's.
  assert.equal(shown(other, { localMeta, cache: { 'other::default': entry('Scout') } }), 'Scout')
  // The local bot (and an unscoped row of the active gateway) keep the bare record.
  assert.equal(shown(localDefault(), { localMeta }), 'Desk')
  assert.equal(shown({ name: 'default' }, { localMeta }), 'Desk')
  assert.equal(botMeta(localDefault(), localMeta).title, 'Desk')
  // A route-keyed record of that connection is still read.
  assert.equal(shown(other, { localMeta: { ...localMeta, 'other::default': { title: 'Routed' } } }), 'Routed')
})

test('the scoped cache survives a simulated reload (storage round trip)', () => {
  const stored = new Map()
  // Session 1: a gateway read lands and is kept.
  const read = entriesFromProfiles([ssh()], 'laptop', [{ name: 'default', display_name: 'Hermes', ui_meta: { 'hermes-bots': { title: 'Scout' } } }], 5)
  const cache = mergeEntries({}, read)
  stored.set('botMetaCache', JSON.parse(JSON.stringify(pruneCache(cache))))
  assert.equal(shown(ssh(), { fresh: read, cache }), 'Scout')
  // Session 2: nothing read yet, the gateway is not up; the stored cache names it.
  const reloaded = pruneCache(stored.get('botMetaCache'))
  assert.equal(shown(ssh(), { fresh: {}, cache: reloaded }), 'Scout')
  // Without the cache it is the bug this fixes.
  assert.equal(shown(ssh(), { fresh: {}, cache: {} }), 'Hermes')
})

test('entries: one per roster row of that connection, by target profile, without chat/image/pet', () => {
  const rows = [
    ssh('default'),
    ssh('helper', 'laptop', { route: { connectionId: 'laptop', mode: 'remote', profile: 'helper', targetProfile: 'helper-2' } }),
    ssh('default', 'other'),
    localDefault()
  ]
  const profiles = [
    { name: 'default', description: 'Reads the news', ui_meta: { 'hermes-bots': { title: 'Scout', chat: { id: 'x' }, image: 'data:image/png;base64,AA', pet: 'cat', color: '#00ff00' } } },
    { name: 'helper-2', display_name: 'Helper Two' }
  ]
  const out = entriesFromProfiles(rows, 'laptop', profiles, 7)
  assert.deepEqual(Object.keys(out).sort(), ['laptop::default', 'laptop::helper'])
  assert.deepEqual(out['laptop::default'], { meta: { title: 'Scout', color: '#00ff00' }, display_name: '', description: 'Reads the news', at: 7 })
  assert.deepEqual(out['laptop::helper'], { meta: {}, display_name: 'Helper Two', description: '', at: 7 })
  assert.equal(gatewayMetaEntry(null), null)
  assert.equal(gatewayMetaEntry({ name: 'x', ui_meta: { 'hermes-bots': { title: 'x'.repeat(20_000) } } }), null, 'an oversized entry is not kept')
})

test('merge and prune: unchanged reads leave the cache object alone; the cache is bounded', () => {
  const base = { 'laptop::default': entry('Scout', 1) }
  assert.equal(mergeEntries(base, { 'laptop::default': entry('Scout', 99) }), base, 'a newer read time alone is no change')
  assert.notEqual(mergeEntries(base, { 'laptop::default': entry('Scout', 99) }, { touch: true }), base)
  assert.equal(mergeEntries(base, { 'laptop::default': entry('Renamed', 2) })['laptop::default'].meta.title, 'Renamed')
  const many = Object.fromEntries(Array.from({ length: GATEWAY_META_MAX + 5 }, (_, i) => [`c${i}::default`, entry(`B${i}`, i)]))
  const pruned = pruneCache({ ...many, junk: 1, 'x::y': { meta: 'no' } })
  assert.equal(Object.keys(pruned).length, GATEWAY_META_MAX)
  assert.ok(!pruned['c0::default'] && pruned[`c${GATEWAY_META_MAX + 4}::default`], 'oldest dropped first')
  assert.deepEqual(pruneCache('nope'), {})
})

test('a save the gateway took returns the namespace it wrote, which becomes the cache entry at once', async () => {
  const bot = ssh()
  const calls = []
  const request = async (_bot, method, params) => {
    calls.push(method)
    if (method === 'profiles.list') return { profiles: [{ name: 'default', display_name: 'Hermes', ui_meta: { 'hermes-bots': { color: '#123456' } }, ui_meta_revisions: { 'hermes-bots': 3 } }] }
    if (method === 'profiles.configure') return { applied: { ui_meta: true }, params }
    return {}
  }
  const result = await saveBotMetaPatch(request, bot, { title: 'Scout' })
  assert.equal(result.serverOutcome, 'persisted')
  assert.deepEqual(result.written, { color: '#123456', title: 'Scout' })
  const saved = entryAfterSave(gatewayMetaEntry(result.row), result.written, 50)
  assert.deepEqual(saved, { meta: { color: '#123456', title: 'Scout' }, display_name: 'Hermes', description: '', at: 50 })
  // Long after the 60 s fence, with no fresh read: the cache keeps the name.
  assert.equal(shown(bot, { cache: { 'laptop::default': saved }, now: 10 * 60_000 }), 'Scout')

  const refused = await saveBotMetaPatch(async (_b, method) => (method === 'profiles.list' ? { profiles: [{ name: 'default' }] } : { applied: { ui_meta: false } }), bot, { title: 'X' })
  assert.equal(refused.serverOutcome, 'failed')
  assert.equal(refused.written, null, 'nothing is cached from a save the gateway did not take')
})

test('the remote-avatar list hands its rows to onProfiles (the names cost no request of their own)', async () => {
  const lists = []
  const calls = []
  const loader = createRemoteAvatars({
    request: async (_bot, method) => {
      calls.push(method)
      return method === 'profiles.list' ? { profiles: [{ name: 'default', has_avatar: false, ui_meta: { 'hermes-bots': { title: 'Scout' } } }] } : {}
    },
    onProfiles: (connectionId, profiles) => lists.push([connectionId, profiles.map(p => p.name)])
  })
  loader.sync([ssh()])
  for (let i = 0; i < 20 && !lists.length; i++) await new Promise(resolve => setTimeout(resolve, 5))
  assert.deepEqual(lists, [['laptop', ['default']]])
  assert.deepEqual(calls, ['profiles.list'], 'one list, no extra read')
  loader.stop()
})
