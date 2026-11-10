// Look 9: the sidebar footer (initials avatar, the person's name from the
// running app, a Hermes settings button only when the host offers it; the bot
// count only as the footer's tooltip) and the red NEW line above the first
// unread bot message (before that message's time line, never above the
// user's own messages, never for messages read on arrival).

import assert from 'node:assert/strict'
import { existsSync, rmSync } from 'node:fs'
import { dirname } from 'node:path'
import test from 'node:test'
import { pathToFileURL } from 'node:url'

import { firstUnreadId, newestAt, raiseSeen, resetMarker, seenFrom, stepMarker, withNewMarker, MAX_SEEN } from '../src/core/newMarker.js'
import { footerPerson, initialsOf } from '../src/core/person.js'
import { withDividers } from '../src/core/time.js'
import { bootPlugin, READY, waitFor } from './loader-boot.mjs'

const ready = existsSync(new URL('../node_modules/esbuild', import.meta.url)) && existsSync(new URL('../node_modules/react-dom', import.meta.url))

const T = new Date(2026, 10, 8, 21, 0).getTime()
const items = [
  { kind: 'assistant', id: 'a0', text: 'old', at: T - 86_400_000 },
  { kind: 'user', id: 'u1', text: 'check tonight?', at: T },
  { kind: 'assistant', id: 'a1', text: 'will do', at: T + 20_000 },
  { kind: 'assistant', id: 'a2', text: 'evening check', at: T + 7_200_000 },
  { kind: 'assistant', id: 'a3', text: 'one more thing', at: T + 7_230_000 }
]

test('initials and the "You" fallback', () => {
  assert.equal(initialsOf('Alex Rivera'), 'AR')
  assert.equal(initialsOf('alex'), 'A')
  assert.equal(initialsOf('alex.rivera'), 'AR')
  assert.equal(initialsOf('Ana María de la Cruz'), 'AC')
  assert.equal(initialsOf('user42'), 'U')
  assert.equal(initialsOf('42'), '')
  assert.deepEqual(footerPerson(''), { initials: 'You', name: '', known: false })
  assert.deepEqual(footerPerson('  '), { initials: 'You', name: '', known: false })
  assert.deepEqual(footerPerson('Alex Rivera'), { initials: 'AR', name: 'Alex Rivera', known: true })
})

test('first unread: bot messages after the seen time and after the user’s own last message', () => {
  assert.equal(firstUnreadId(items, undefined), null, 'never seen: no line')
  assert.equal(firstUnreadId(items, T + 20_000), 'a2')
  assert.equal(firstUnreadId(items, T - 2 * 86_400_000), 'a1', 'everything unread: still only after the user’s message')
  assert.equal(firstUnreadId(items, T + 7_230_000), null, 'all seen')
  assert.equal(firstUnreadId([...items, { kind: 'user', id: 'u2', text: 'ok', at: T + 7_300_000 }], T + 20_000), null, 'the user wrote after them: never above their own message')
  assert.equal(firstUnreadId([{ kind: 'assistant', id: 's', text: '…', at: T + 9e6, streaming: true }], T), null, 'a reply still streaming is not marked')
  assert.equal(newestAt(items), T + 7_230_000)
})

test('the NEW row goes above the time line of the first unread message', () => {
  const rows = withDividers(items, T + 8e6, 'en-US')
  const marked = withNewMarker(rows, 'a2')
  const at = marked.findIndex(row => row.kind === 'new')
  assert.equal(marked[at].id, 'new:a2')
  assert.equal(marked[at + 1].kind, 'divider', 'NEW first, then the time line')
  assert.equal(marked[at + 2].id, 'a2')
  // No divider right before it: directly above the message.
  const close = withNewMarker(rows, 'a3')
  const i = close.findIndex(row => row.kind === 'new')
  assert.equal(close[i + 1].id, 'a3')
  assert.equal(withNewMarker(rows, null), rows)
  assert.equal(withNewMarker(rows, 'missing'), rows)
})

test('stepMarker: decided at open, kept while open, never for messages read on arrival', () => {
  const key = 'local::scholar'
  let s = { markers: {}, seen: {} }
  // First sight seeds the watermark: no line on a chat never seen before.
  s = stepMarker(s, { key, items: items.slice(0, 3), ready: true, looking: false })
  assert.equal(s.markers[key], null)
  assert.equal(s.seen[key], T + 20_000)
  // Two bot messages arrive while the user is elsewhere (not looking).
  s = stepMarker(s, { key, items, ready: true, looking: false })
  assert.equal(s.markers[key], 'a2', 'arrived unseen: the line goes above the first')
  // Reopened: decided afresh from the watermark, before looking raises it.
  s = resetMarker(s, key)
  s = stepMarker(s, { key, items, ready: true, looking: true })
  assert.equal(s.markers[key], 'a2')
  assert.equal(s.seen[key], T + 7_230_000, 'looking raised the watermark')
  // It stays while the chat is open, though now read.
  s = stepMarker(s, { key, items, ready: true, looking: true })
  assert.equal(s.markers[key], 'a2')
  // Opened again with nothing unread: gone.
  s = resetMarker(s, key)
  s = stepMarker(s, { key, items, ready: true, looking: true })
  assert.equal(s.markers[key], null)
  // A message arriving while the user looks (focused, open, at the bottom)
  // moves the watermark in the same step: no line.
  const more = [...items, { kind: 'assistant', id: 'a4', text: 'live', at: T + 7_400_000 }]
  s = stepMarker(s, { key, items: more, ready: true, looking: true })
  assert.equal(s.markers[key], null)
  assert.equal(s.seen[key], T + 7_400_000)
  // Not loaded yet: nothing decided.
  const fresh = stepMarker({ markers: {}, seen: {} }, { key, items: [], ready: false, looking: true })
  assert.deepEqual(fresh, { markers: {}, seen: {} })
  // Unchanged state is the same object (no store write, no storage write).
  assert.equal(stepMarker(s, { key, items: more, ready: true, looking: true }), s)
})

test('seen watermarks: sanitised, only raised, bounded', () => {
  assert.deepEqual(seenFrom({ a: 5, b: -1, c: 'x', d: Infinity, '': 3 }), { a: 5 })
  assert.deepEqual(seenFrom(null), {})
  const s = { a: 10 }
  assert.equal(raiseSeen(s, 'a', 5), s, 'never lowered')
  assert.deepEqual(raiseSeen(s, 'a', 20), { a: 20 })
  let many = {}
  for (let i = 0; i < MAX_SEEN + 5; i += 1) many = raiseSeen(many, `k${i}`, i + 1)
  assert.equal(Object.keys(many).length, MAX_SEEN)
  assert.ok(!('k0' in many) && `k${MAX_SEEN + 4}` in many, 'the oldest go first')
})

test('render: footer person and settings button, bot count as tooltip; NEW line in light and dark', { skip: !ready && 'dev dependencies not installed' }, async t => {
  const { bundlePreview } = await import('../dev/bundle.mjs')
  const file = await bundlePreview()
  t.after(() => rmSync(dirname(file), { recursive: true, force: true }))
  const m = await import(pathToFileURL(file).href)
  const footer = html => html.slice(html.indexOf('class="sidebar__footer'), html.indexOf('class="preview-main"'))

  for (const theme of ['light', 'dark']) {
    const html = m.render({ theme, botIndex: 1, items: m.NEW_ITEMS, busy: false, hasMore: false, userName: 'Alex Rivera', newLine: m.NEW_ITEMS_FIRST_UNREAD })
    const foot = footer(html)
    assert.match(foot, /class="account__initials gbo-user-dot"[^>]*>AR</)
    assert.match(foot, /class="account__name gbo-user-name">Alex Rivera</)
    assert.match(html, /class="sidebar__footer gbo-roster-foot" title="\d+ bots"/, 'the bot count is the footer tooltip')
    assert.ok(!/gbo-user-name">\d+ bots</.test(html), 'the count is no longer the name')
    const buttons = foot.match(/<button[^>]*>/g) || []
    assert.equal(buttons.length, 1, 'one button: settings')
    assert.match(buttons[0], /aria-label="Open Hermes settings"/)
    assert.match(buttons[0], /class="icon-btn gbo-foot-btn"/)

    const lines = html.match(/class="gbo-new-line"/g) || []
    assert.equal(lines.length, 1, `${theme}: one NEW line`)
    const at = html.indexOf('class="gbo-new-line"')
    const after = html.slice(at)
    assert.match(after, /^class="gbo-new-line" role="separator" aria-label="New messages"><span>NEW<\/span><\/div><div class="divider gbo-divider">/, 'NEW, then the time line')
    assert.ok(after.indexOf('Evening check') > 0 && after.indexOf('Evening check') < after.indexOf('library card renewal'))
    assert.ok(html.slice(0, at).includes('Will do.'), 'read messages stay above it')
    assert.ok(!html.slice(at).includes('can you check my reading list'), 'never above the user’s own message')
  }

  const none = m.render({ theme: 'light', botIndex: 1, items: m.NEW_ITEMS, busy: false, hasMore: false })
  assert.ok(!none.includes('class="gbo-new-line"'), 'nothing unread: no line')
  const fallback = footer(m.render({ theme: 'light', botIndex: 1, items: m.NEW_ITEMS, busy: false, settings: false }))
  assert.match(fallback, /gbo-user-dot"[^>]*>You</, 'no name known: "You" as before')
  assert.ok(!fallback.includes('gbo-user-name'))
  assert.ok(!fallback.includes('<button'), 'no settings door: no button, no dead one')

  const css = m.CSS
  assert.match(css, /\.account__name[^{]*\{[^}]*text-overflow: ellipsis/, 'long names truncate')
  assert.match(css, /\.gbo-new-line:where\([^)]*\) \{[^}]*color: var\(--(g-)?color-danger\)/, 'red in both themes (the danger token)')
  assert.match(css, /\.gbo-new-line[^{]*::after \{[^}]*height: 1(\.\d+)?px/)
})

test('plugin.js: the footer shows the OS account name and opens Hermes Settings through ctx.runAction', { skip: !READY && 'dev dependencies not installed' }, async t => {
  const actions = []
  const { panes, mount } = await bootPlugin(t, {
    ctxExtras: {
      runAction: id => (actions.push(id), { ok: true }),
      listActions: () => [{ id: 'view.toggleSidebar' }, { id: 'nav.settings' }]
    }
  })
  window.hermesDesktop.getMachineProfile = async () => ({ username: 'alex.rivera', locale: 'en-US' })
  const el = mount(panes.find(p => p.id === 'roster').render)
  await waitFor(() => el.querySelector('.gbo-user-name')?.textContent === 'alex.rivera', 'the name')
  assert.equal(el.querySelector('.gbo-user-dot').textContent, 'AR')
  const button = el.querySelector('.gbo-foot-btn')
  assert.ok(button, 'settings button')
  button.click()
  assert.deepEqual(actions, ['nav.settings'])
})
