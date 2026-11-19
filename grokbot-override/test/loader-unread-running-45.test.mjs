// Loader-faithful (unread look): Hermes's own running-state cue (its status
// dot in the working / stalled / background states) still shows on a row,
// independent of the unread dot, which shows only unread and needs-input.

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

import { bootPlugin, LOCAL, READY, waitFor } from './loader-boot.mjs'

const CLASSES = {
  working: 'size-1.5 rounded-full bg-(--ui-accent)',
  stalled: 'size-1.5 rounded-full border border-(--ui-accent)',
  background: 'size-1.5 rounded-full border border-(--ui-text-tertiary)',
  unread: 'size-1.5 rounded-full bg-(--ui-success)'
}
const OWL = { ...LOCAL, name: 'owl', display_name: 'Owl', route: { ...LOCAL.route, profile: 'owl', targetProfile: 'owl' }, canonical_session: { id: 'o-root', preview: 'owl', last_active: 1 } }

test('loader-faithful unread look: a running bot keeps Hermes\'s running cue on its avatar, apart from the unread dot', { skip: !READY && 'dev dependencies not installed' }, async t => {
  const states = { 's-root': 'working', 'o-root': 'unread' }
  const { panes, mount, errors, React } = await bootPlugin(t, {
    rows: [LOCAL, OWL],
    tweak: sdk => {
      sdk.SessionStatusDot = props => globalThis.__fakeDot(props)
      sdk.markSessionUnreadFinished = () => undefined
      sdk.ackStoredSessionId = () => undefined
    }
  })
  globalThis.__fakeDot = ({ storedSessionId }) => React.createElement('span', { className: 'flex' }, React.createElement('span', { role: 'status', className: CLASSES[states[storedSessionId]] || 'size-1 rounded-full' }))
  t.after(() => delete globalThis.__fakeDot)
  const rosterEl = mount(panes.find(p => p.id === 'roster').render)
  const rowOf = name => [...rosterEl.querySelectorAll('button.gbo-row')].find(b => b.textContent.includes(name))
  await waitFor(() => rowOf('Security') && rowOf('Owl'), 'the rows')
  const cue = rowOf('Security').querySelector('.gbo-row-face .gbo-run-dot [role="status"]')
  assert.ok(cue, 'the running cue sits on the avatar')
  assert.match(cue.className, /ui-accent/)
  assert.ok(rowOf('Owl').querySelector('.gbo-unread-dot [role="status"][class*="ui-success"]'), 'the unread dot stays at the right edge')

  // Computed, with the plugin's own injected stylesheet: the running cue
  // shows for a working bot and not for an unread one; the unread dot the
  // other way round.
  const shown = el => (el ? getComputedStyle(el).display !== 'none' : false)
  assert.ok(document.getElementById('grokbot-override-style') || document.querySelector('style'), 'the plugin stylesheet is in the page')
  assert.equal(shown(rowOf('Security').querySelector('.gbo-run-dot')), true, 'running: the cue is visible')
  assert.equal(shown(rowOf('Owl').querySelector('.gbo-run-dot')), false, 'unread: no running cue')
  assert.equal(shown(rowOf('Owl').querySelector('.gbo-unread-dot')), true, 'unread: the dot is visible')
  assert.equal(shown(rowOf('Security').querySelector('.gbo-unread-dot')), false, 'running: no unread dot')

  // The CSS draws the cue for the running states only, and the unread dot
  // for unread / needs-input only.
  const css = readFileSync(new URL('../src/ui/styles-adapt.ts', import.meta.url), 'utf8')
  assert.match(css, /\.gbo-run-dot:has\(\[role="status"\]\[class\*="ui-accent"\]\)/)
  assert.match(css, /\.gbo-run-dot:has\(\[role="status"\]\[class\*="ui-text-tertiary"\]\)/)
  assert.ok(!/\.gbo-run-dot:has\(\[role="status"\]\[class\*="ui-success"\]\)/.test(css), 'unread is not a running cue')
  assert.deepEqual(errors.map(e => `${e.kind}: ${e.error?.message}`), [])
})
