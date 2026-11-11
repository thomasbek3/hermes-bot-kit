// Server avatars for bots on other connections (core/remoteAvatars.js):
// which rows are asked, on which route, how often, and what a failure or a
// face raster leaves behind. The loader-faithful half (the roster draws the
// picture) is test/loader-remote-avatars.test.mjs.

import assert from 'node:assert/strict'
import test from 'node:test'

import {
  AVATAR_LIST_TTL_MS,
  AVATAR_RETRY_MS,
  AVATAR_TTL_MS,
  createRemoteAvatars,
  isAvatarDataUrl,
  isBackfilledFacePng,
  remoteAvatarRoute
} from '../src/core/remoteAvatars.js'
import { annotateSources } from '../src/core/roster.js'
import { createBotRequester } from '../src/core/routing.js'
import { pngDataUrl } from './fixtures/avatar-png.mjs'

const PICTURE = pngDataUrl(512, 512)

const remote = (name, { connectionId = 'mini', has_avatar, targetProfile = name } = {}) => ({
  name,
  remoteSource: true,
  sourceScoped: true,
  connectionId,
  connectionKind: 'ssh',
  route: { connectionId, mode: 'remote', profile: name, targetProfile },
  ...(has_avatar === undefined ? {} : { has_avatar })
})
const local = (name, extra = {}) => ({
  name,
  sourceScoped: true,
  connectionId: 'local',
  connectionKind: 'local',
  route: { connectionId: 'local', mode: 'local', profile: name, targetProfile: name },
  ...extra
})

const flush = async (n = 6) => {
  for (let i = 0; i < n; i += 1) await new Promise(resolve => setImmediate(resolve))
}

/** A loader over a fake host (the kit's real requester), a movable clock,
 *  and per-method answers. */
function harness({ answers = {}, hasOwnImage } = {}) {
  const calls = []
  let clock = 1_762_560_000_000
  const host = {
    request: async (method, params) => {
      calls.push({ via: 'active', method, params })
      throw new Error('the active gateway is never asked')
    },
    requestProfile: async (route, method, params, timeoutMs) => {
      calls.push({ via: `${route.connectionId}::${route.profile}`, method, params, timeoutMs })
      const answer = answers[method]
      if (!answer) return {}
      return answer(params, route)
    }
  }
  const request = createBotRequester(host, { activeConnectionId: () => 'local' })
  const changes = []
  const loader = createRemoteAvatars({ request, hasOwnImage, onChange: images => changes.push(images), now: () => clock })
  return {
    loader,
    calls,
    changes,
    assets: () => calls.filter(c => c.method === 'profiles.get_asset'),
    lists: () => calls.filter(c => c.method === 'profiles.list'),
    advance: ms => (clock += ms)
  }
}

test('a remote row with has_avatar gets its picture from profiles.get_asset on its own route', async () => {
  const h = harness({ answers: { 'profiles.get_asset': () => ({ found: true, mime: 'image/png', data: PICTURE }) } })
  h.loader.sync([remote('artist', { has_avatar: true })])
  await flush()
  assert.deepEqual(h.assets().map(c => [c.via, c.params]), [['mini::artist', { name: 'artist', asset: 'avatar' }]])
  assert.deepEqual(h.loader.images(), { 'mini::artist': PICTURE })
  assert.deepEqual(h.changes.at(-1), { 'mini::artist': PICTURE })
  assert.equal(h.calls.filter(c => c.via === 'active').length, 0)
})

test('the asset is asked for by the backend profile name when the route maps one', async () => {
  const h = harness({ answers: { 'profiles.get_asset': () => ({ found: true, data: PICTURE }) } })
  h.loader.sync([remote('helper', { has_avatar: true, targetProfile: 'helper-2' })])
  await flush()
  assert.deepEqual(h.assets()[0].params, { name: 'helper-2', asset: 'avatar' })
})

test('the picture is cached: roster refreshes make no new request until the TTL', async () => {
  const h = harness({ answers: { 'profiles.get_asset': () => ({ found: true, data: PICTURE }) } })
  const rows = [remote('artist', { has_avatar: true }), remote('coder', { has_avatar: true })]
  for (let i = 0; i < 25; i += 1) {
    h.loader.sync(rows.map(r => ({ ...r })))
    await flush(1)
  }
  await flush()
  assert.equal(h.assets().length, 2, 'one request per bot, however often the roster refreshes')
  const changesBefore = h.changes.length
  h.advance(AVATAR_TTL_MS - 1000)
  h.loader.sync(rows)
  await flush()
  assert.equal(h.assets().length, 2, 'still cached just before the TTL')
  h.advance(2000)
  h.loader.sync(rows)
  await flush()
  assert.equal(h.assets().length, 4, 'refreshed after the TTL')
  assert.equal(h.changes.length, changesBefore, 'the same picture is not published again')
})

test('a request in flight is never doubled', async () => {
  let release
  const h = harness({ answers: { 'profiles.get_asset': () => new Promise(resolve => (release = () => resolve({ found: true, data: PICTURE }))) } })
  const rows = [remote('writer', { has_avatar: true })]
  h.loader.sync(rows)
  await flush()
  h.loader.sync(rows)
  h.loader.sync(rows)
  await flush()
  assert.equal(h.assets().length, 1)
  release()
  await flush()
  assert.deepEqual(Object.keys(h.loader.images()), ['mini::writer'])
})

test('on an error the row keeps its shape (no picture) and is retried only after the back-off', async () => {
  let fail = true
  const h = harness({
    answers: {
      'profiles.get_asset': () => {
        if (fail) throw Object.assign(new Error('socket closed'), { code: 'EPIPE' })
        return { found: true, data: PICTURE }
      }
    }
  })
  const rows = [remote('coder', { has_avatar: true })]
  h.loader.sync(rows)
  await flush()
  assert.deepEqual(h.loader.images(), {}, 'no picture: the generated shape stays')
  h.loader.sync(rows)
  await flush()
  assert.equal(h.assets().length, 1, 'no retry storm')
  fail = false
  h.advance(AVATAR_RETRY_MS + 1)
  h.loader.sync(rows)
  await flush()
  assert.equal(h.assets().length, 2)
  assert.deepEqual(h.loader.images(), { 'mini::coder': PICTURE })
})

test('a failed refresh keeps the picture already shown', async () => {
  let fail = false
  const h = harness({ answers: { 'profiles.get_asset': () => (fail ? Promise.reject(new Error('offline')) : { found: true, data: PICTURE }) } })
  const rows = [remote('artist', { has_avatar: true })]
  h.loader.sync(rows)
  await flush()
  fail = true
  h.advance(AVATAR_TTL_MS + 1)
  h.loader.sync(rows)
  await flush()
  assert.equal(h.assets().length, 2)
  assert.deepEqual(h.loader.images(), { 'mini::artist': PICTURE })
})

test('found:false, a non-image data URL and Bot Mode\'s 160 px face raster are not shown', async () => {
  const replies = {
    a: { found: false },
    b: { found: true, data: 'data:text/html;base64,PHNjcmlwdD4=' },
    c: { found: true, data: 'javascript:alert(1)' },
    d: { found: true, data: pngDataUrl(160, 160) },
    e: { found: true, data: pngDataUrl(256, 256) }
  }
  const h = harness({ answers: { 'profiles.get_asset': params => replies[params.name] } })
  h.loader.sync(Object.keys(replies).map(name => remote(name, { has_avatar: true })))
  await flush()
  assert.deepEqual(h.loader.images(), { 'mini::e': replies.e.data })
  assert.equal(isBackfilledFacePng(pngDataUrl(160, 160)), true)
  assert.equal(isBackfilledFacePng(PICTURE), false)
  assert.equal(isAvatarDataUrl('data:image/webp;base64,UklGRg=='), true)
  assert.equal(isAvatarDataUrl('data:image/svg+xml;base64,PHN2Zz4='), false, 'no SVG')
})

test('local bots, active-source rows and rows a source does not serve are never asked', async () => {
  const h = harness({ answers: { 'profiles.get_asset': () => ({ found: true, data: PICTURE }) } })
  h.loader.sync([
    local('security', { has_avatar: true }),
    { name: 'plain', has_avatar: true },
    { ...remote('gone', { has_avatar: true }), unserved: true },
    { ...remote('down', { has_avatar: true }), sourceReachable: false },
    { ...remote('old', { has_avatar: true }), retained: true },
    { ...remote('half', { has_avatar: true }), route: { connectionId: 'local', mode: 'local', profile: 'half', targetProfile: 'half' } }
  ])
  await flush()
  assert.deepEqual(h.calls, [])
  assert.deepEqual(h.loader.images(), {})
  assert.equal(remoteAvatarRoute(local('x')), null)
  assert.equal(remoteAvatarRoute(remote('x')).connectionId, 'mini')
})

test('connect-on-demand SSH rows (every SSH machine that is not the live gateway) are asked', async () => {
  // Live shape: host.agents reports an undialed SSH source as reachable with
  // error 'connect-on-demand', annotateSources turns that into
  // sourceReachable:false + sourceError, and SSH sources carry no
  // has_avatar. These rows were skipped, so no SSH bot ever got its picture.
  const sources = [{ connectionId: 'mini', reachable: true, error: 'connect-on-demand' }]
  const rows = annotateSources([remote('default'), remote('artist'), remote('scout'), remote('helper')], sources)
  assert.equal(rows[1].sourceReachable, false)
  assert.equal(rows[1].sourceError, 'connect-on-demand')
  assert.equal(remoteAvatarRoute(rows[1])?.connectionId, 'mini')
  const h = harness({
    answers: {
      'profiles.list': () => ({
        profiles: [{ name: 'default', has_avatar: false }, { name: 'artist', has_avatar: true }, { name: 'scout', has_avatar: true }, { name: 'helper', has_avatar: false }]
      }),
      'profiles.get_asset': () => ({ found: true, mime: 'image/png', data: PICTURE })
    }
  })
  h.loader.sync(rows)
  await flush(12)
  assert.deepEqual(h.lists().map(c => c.via), ['mini::default'])
  assert.deepEqual(h.assets().map(c => c.via).sort(), ['mini::artist', 'mini::scout'])
  assert.deepEqual(h.loader.images(), { 'mini::artist': PICTURE, 'mini::scout': PICTURE })
  // A source that is really down still is not asked.
  const down = annotateSources([remote('planner', { has_avatar: true })], [{ connectionId: 'mini', reachable: false, error: 'ssh: connect timed out' }])
  assert.equal(remoteAvatarRoute(down[0]), null)
})

test('has_avatar:false and a row that already shows its own picture are not fetched', async () => {
  const h = harness({
    answers: { 'profiles.get_asset': () => ({ found: true, data: PICTURE }) },
    hasOwnImage: bot => bot.name === 'mine'
  })
  h.loader.sync([remote('plain', { has_avatar: false }), remote('mine', { has_avatar: true })])
  await flush()
  assert.deepEqual(h.calls, [])
})

test('rows that cannot say has_avatar: one profiles.list per connection answers for every bot on it', async () => {
  const h = harness({
    answers: {
      'profiles.list': (params, route) =>
        route.connectionId === 'mini'
          ? { profiles: [{ name: 'default' }, { name: 'artist', has_avatar: true }, { name: 'helper', has_avatar: false }] }
          : { profiles: [{ name: 'scout', has_avatar: true }] },
      'profiles.get_asset': () => ({ found: true, data: PICTURE })
    }
  })
  const rows = [remote('helper'), remote('artist'), remote('default'), remote('scout', { connectionId: 'vps' })]
  h.loader.sync(rows)
  await flush(12)
  assert.deepEqual(h.lists().map(c => [c.via, c.params]).sort(), [
    ['mini::default', { include_sessions: false }],
    ['vps::scout', { include_sessions: false }]
  ], 'one list per connection, on its default profile when it has one')
  assert.deepEqual(h.assets().map(c => c.via).sort(), ['mini::artist', 'vps::scout'], 'then only the bots with a picture')
  for (let i = 0; i < 10; i += 1) h.loader.sync(rows)
  await flush()
  assert.equal(h.lists().length, 2, 'the list is cached too')
  h.advance(AVATAR_LIST_TTL_MS + 1)
  h.loader.sync(rows)
  await flush()
  assert.equal(h.lists().length, 4, 're-listed after its TTL (a picture added later shows up)')
})

test('a row that leaves the roster, or turns has_avatar off, loses its picture; stop() clears everything', async () => {
  const h = harness({ answers: { 'profiles.get_asset': () => ({ found: true, data: PICTURE }) } })
  h.loader.sync([remote('a', { has_avatar: true }), remote('b', { has_avatar: true })])
  await flush()
  assert.deepEqual(Object.keys(h.loader.images()).sort(), ['mini::a', 'mini::b'])
  h.loader.sync([remote('a', { has_avatar: false }), remote('b', { has_avatar: true })])
  await flush()
  assert.deepEqual(Object.keys(h.loader.images()), ['mini::b'])
  h.loader.sync([])
  await flush()
  assert.deepEqual(h.loader.images(), {})
  h.loader.stop()
  h.loader.sync([remote('c', { has_avatar: true })])
  await flush()
  assert.equal(h.assets().length, 2, 'a stopped loader asks nothing')
})
