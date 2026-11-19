// The profile panel's "Bot's computer" card (src/core/screenThumb.js,
// src/ui/Profile.tsx): the status word, the thumbnail in each state, and the
// still cache behind it (scoped per connection and profile, size-capped,
// never shown for a screen that is asleep). The card's stills come only from
// the viewer's own canvas; nothing here sends a request.

import assert from 'node:assert/strict'
import { existsSync, rmSync } from 'node:fs'
import { dirname } from 'node:path'
import test from 'node:test'
import { pathToFileURL } from 'node:url'

import {
  acceptableFrame,
  computerCard,
  computerStatus,
  createThumbCache,
  snapshotCanvas,
  THUMB_MAX_BYTES,
  THUMB_MAX_ENTRIES,
  THUMB_STORAGE_KEY,
  thumbKey
} from '../src/core/screenThumb.js'

const STILL = 'data:image/jpeg;base64,' + 'A'.repeat(400)
const OTHER = 'data:image/jpeg;base64,' + 'B'.repeat(400)

function memoryStorage(seed = {}) {
  const map = new Map(Object.entries(seed))
  return { map, get: (k, f) => (map.has(k) ? map.get(k) : f), set: (k, v) => map.set(k, JSON.parse(JSON.stringify(v))) }
}

test('status word: Awake / Asleep / Unavailable / … (the old row’s conditions, Running reads Awake)', () => {
  assert.deepEqual(computerStatus({ supported: true, running: true }), { state: 'awake', label: 'Awake' })
  assert.deepEqual(computerStatus({ supported: true, running: false }), { state: 'asleep', label: 'Asleep' })
  assert.deepEqual(computerStatus({ error: true }), { state: 'unavailable', label: 'Unavailable' })
  assert.deepEqual(computerStatus({ supported: false, running: true }), { state: 'unavailable', label: 'Unavailable' })
  assert.deepEqual(computerStatus(null), { state: 'loading', label: '…' })
})

test('card states: awake with a still, awake without one, asleep, unavailable, loading', () => {
  assert.deepEqual(computerCard({ running: true }, STILL), { state: 'awake', label: 'Awake', thumb: 'shot', src: STILL })
  assert.deepEqual(computerCard({ running: true }, null), { state: 'awake', label: 'Awake', thumb: 'glyph', src: null })
  assert.deepEqual(computerCard({ running: false }, null), { state: 'asleep', label: 'Asleep', thumb: 'sleep', src: null })
  assert.deepEqual(computerCard({ error: true }, null), { state: 'unavailable', label: 'Unavailable', thumb: 'sleep', src: null })
  assert.deepEqual(computerCard(null, STILL), { state: 'loading', label: '…', thumb: 'blank', src: null })
})

test('a cached still is never shown for a screen that is asleep or unavailable', () => {
  for (const status of [{ running: false }, { error: true }, { supported: false }, null]) {
    const card = computerCard(status, STILL)
    assert.equal(card.src, null, JSON.stringify(status))
    assert.notEqual(card.thumb, 'shot', JSON.stringify(status))
  }
})

test('the cache key is <connectionId>::<profile>', () => {
  const routed = { name: 'scout', sourceScoped: true, connectionId: 'box', route: { connectionId: 'box', mode: 'remote', profile: 'scout', targetProfile: 'scout' } }
  assert.equal(thumbKey(routed, 'local'), 'box::scout')
  assert.equal(thumbKey({ name: 'helper' }, 'conn-a'), 'conn-a::helper', 'a row on the active gateway uses that connection')
  assert.equal(thumbKey({ name: 'helper' }, null), 'local::helper')
})

test('cache scoping: one bot’s still never answers for another (same profile name on another connection too)', () => {
  const cache = createThumbCache({ storage: memoryStorage() })
  assert.equal(cache.put('box::scout', STILL), true)
  assert.equal(cache.get('box::scout'), STILL)
  assert.equal(cache.get('local::scout'), null)
  assert.equal(cache.get('box::helper'), null)
  cache.put('local::scout', OTHER)
  assert.equal(cache.get('box::scout'), STILL)
  assert.equal(cache.get('local::scout'), OTHER)
})

test('size cap: a still over 20 KB, or not an image data URL, is refused', () => {
  const cache = createThumbCache({ storage: memoryStorage() })
  const big = 'data:image/jpeg;base64,' + 'A'.repeat(THUMB_MAX_BYTES)
  assert.ok(big.length > THUMB_MAX_BYTES)
  assert.equal(cache.put('a::b', big), false)
  assert.equal(cache.put('a::b', 'https://example.com/x.png'), false)
  assert.equal(cache.put('a::b', 'data:text/html;base64,PGI+'), false)
  assert.equal(cache.get('a::b'), null)
  assert.equal(acceptableFrame(STILL), true)
})

test('entry cap: at most 50 stills, the oldest dropped first', () => {
  let clock = 0
  const storage = memoryStorage()
  const cache = createThumbCache({ storage, now: () => (clock += 1) })
  for (let i = 0; i < THUMB_MAX_ENTRIES + 5; i += 1) cache.put(`c::bot${i}`, STILL)
  assert.equal(cache.size(), THUMB_MAX_ENTRIES)
  for (let i = 0; i < 5; i += 1) assert.equal(cache.get(`c::bot${i}`), null, `bot${i} dropped`)
  assert.equal(cache.get(`c::bot${THUMB_MAX_ENTRIES + 4}`), STILL)
  assert.equal(Object.keys(storage.map.get(THUMB_STORAGE_KEY)).length, THUMB_MAX_ENTRIES, 'storage holds the same 50')
})

test('stills survive a reload through plugin storage; a corrupt record is ignored', () => {
  const storage = memoryStorage()
  createThumbCache({ storage }).put('box::scout', STILL)
  const again = createThumbCache({ storage })
  assert.equal(again.get('box::scout'), STILL)
  const corrupt = memoryStorage({ [THUMB_STORAGE_KEY]: { 'x::y': { url: 'javascript:alert(1)', at: 1 }, 'x::z': 'nope', 'x::w': { url: STILL, at: 2 } } })
  const cache = createThumbCache({ storage: corrupt })
  assert.equal(cache.get('x::y'), null)
  assert.equal(cache.get('x::z'), null)
  assert.equal(cache.get('x::w'), STILL)
  assert.equal(createThumbCache({ storage: memoryStorage({ [THUMB_STORAGE_KEY]: ['bad'] }) }).size(), 0)
  // No storage at all (an older desktop): memory only.
  const mem = createThumbCache()
  mem.put('a::b', STILL)
  assert.equal(mem.get('a::b'), STILL)
})

test('a put notifies subscribers; an identical still does not rewrite storage', () => {
  let writes = 0
  const storage = memoryStorage()
  const set = storage.set
  storage.set = (k, v) => {
    writes += 1
    set(k, v)
  }
  const cache = createThumbCache({ storage })
  let seen = 0
  const off = cache.subscribe(() => (seen += 1))
  cache.put('a::b', STILL)
  cache.put('a::b', STILL)
  assert.equal(seen, 1)
  assert.equal(writes, 1)
  off()
  cache.put('a::b', OTHER)
  assert.equal(seen, 1)
})

function fakeDoc({ url = STILL, urls = null } = {}) {
  const draws = []
  const qualities = []
  const doc = {
    createElement: () => ({
      width: 0,
      height: 0,
      getContext: () => ({ drawImage: (...args) => draws.push(args.slice(1)) }),
      toDataURL: (type, quality) => {
        qualities.push([type, quality])
        return urls ? urls.shift() : url
      }
    })
  }
  return { doc, draws, qualities }
}

test('snapshot: a small JPEG, cover-cropped to 16:10 at 128x80', () => {
  const { doc, draws, qualities } = fakeDoc()
  assert.equal(snapshotCanvas({ width: 1920, height: 1080 }, { doc }), STILL)
  // 16:9 source: the sides are cropped to 1728 wide, centred.
  assert.deepEqual(draws[0], [96, 0, 1728, 1080, 0, 0, 128, 80])
  assert.deepEqual(qualities[0], ['image/jpeg', 0.72])
  const tall = fakeDoc()
  snapshotCanvas({ width: 1000, height: 1000 }, { doc: tall.doc })
  assert.deepEqual(tall.draws[0], [0, 187.5, 1000, 625, 0, 0, 128, 80])
})

test('snapshot: nothing for an empty framebuffer, a missing canvas, or a still that stays over the cap', () => {
  assert.equal(snapshotCanvas({ width: 0, height: 0 }, { doc: fakeDoc().doc }), null)
  assert.equal(snapshotCanvas(null, { doc: fakeDoc().doc }), null)
  const big = 'data:image/jpeg;base64,' + 'A'.repeat(THUMB_MAX_BYTES)
  const tooBig = fakeDoc({ urls: [big, big] })
  assert.equal(snapshotCanvas({ width: 640, height: 400 }, { doc: tooBig.doc }), null)
  assert.deepEqual(tooBig.qualities.map(q => q[1]), [0.72, 0.5], 'tried a lower quality first')
  const second = fakeDoc({ urls: [big, OTHER] })
  assert.equal(snapshotCanvas({ width: 640, height: 400 }, { doc: second.doc }), OTHER)
  const throwing = { createElement: () => ({ getContext: () => { throw new Error('tainted') } }) }
  assert.equal(snapshotCanvas({ width: 640, height: 400 }, { doc: throwing }), null)
})

const ready = existsSync(new URL('../node_modules/esbuild', import.meta.url)) && existsSync(new URL('../node_modules/react-dom', import.meta.url))

test('the rendered card in each state: one card, title over status, the thumbnail on the right', { skip: !ready && 'dev dependencies not installed' }, async t => {
  const { bundlePreview } = await import('../dev/bundle.mjs')
  const file = await bundlePreview()
  t.after(() => rmSync(dirname(file), { recursive: true, force: true }))
  const { renderComputerCard } = await import(pathToFileURL(file).href)
  const card = page => {
    const html = page.slice(page.indexOf('<body>'))
    const at = html.indexOf('gbo-computer-card')
    assert.ok(at > 0, 'the card is drawn')
    const start = html.lastIndexOf('<button', at)
    return html.slice(start, html.indexOf('</button>', at) + 9)
  }
  const expect = {
    awake: { state: 'awake', label: 'Awake', thumb: 'shot' },
    'awake-no-still': { state: 'awake', label: 'Awake', thumb: 'glyph' },
    asleep: { state: 'asleep', label: 'Asleep', thumb: 'sleep' },
    unavailable: { state: 'unavailable', label: 'Unavailable', thumb: 'sleep' }
  }
  for (const [state, want] of Object.entries(expect)) {
    const html = renderComputerCard(state)
    const light = card(html)
    assert.ok(light.includes(`data-state="${want.state}"`), `${state}: data-state`)
    assert.ok(light.includes('panel-row--computer'), `${state}: the reference's computer row`)
    assert.match(light, new RegExp(`<span class="panel-row__title">Bot’s computer</span><span class="panel-row__sub">${want.label}</span>`), `${state}: title over status`)
    assert.ok(light.includes(`data-thumb="${want.thumb}"`), `${state}: thumbnail ${want.thumb}`)
    assert.equal(light.includes('<img'), want.thumb === 'shot', `${state}: a still only while awake`)
    assert.equal(/computer-thumb__z1/.test(light), want.thumb === 'sleep', `${state}: the z only on the sleeping face`)
    assert.equal(light.indexOf('computer-thumb') > light.indexOf('panel-row__sub'), true, `${state}: the thumbnail sits right of the text`)
    const body = html.slice(html.indexOf('<body>'))
    assert.ok(!body.includes('gbo-status-dot'), `${state}: no old status dot row`)
    assert.ok(!body.includes('Running'), `${state}: no "Running" wording`)
    // The asleep and unavailable renders put a still in the cache first.
    if (state === 'asleep' || state === 'unavailable') assert.ok(!body.includes('data:image/png'), `${state}: the cached still is not shown`)
    else if (state === 'awake') assert.ok(body.includes('src="data:image/png;base64,'), 'awake: the cached still is the thumbnail')
  }
})
