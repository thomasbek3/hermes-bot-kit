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
  unread: 'size-1.5 rounded-full bg-(--ui-success)',
  'needs-input': 'size-1.5 rounded-full bg-amber-500'
}
const bot = (name, title, id) => ({ ...LOCAL, name, display_name: title, route: { ...LOCAL.route, profile: name, targetProfile: name }, canonical_session: { id, preview: name, last_active: 1 } })
const OWL = bot('owl', 'Owl', 'o-root')
const FINCH = bot('finch', 'Finch', 'f-root')
const GULL = bot('gull', 'Gull', 'g-root')
const HAWK = bot('hawk', 'Hawk', 'h-root')

test('loader-faithful unread look: a running bot keeps Hermes\'s running cue on its avatar, apart from the unread dot', { skip: !READY && 'dev dependencies not installed' }, async t => {
  const states = { 's-root': 'working', 'o-root': 'unread', 'f-root': 'stalled', 'g-root': 'background', 'h-root': 'needs-input' }
  const { panes, mount, errors, React } = await bootPlugin(t, {
    rows: [LOCAL, OWL, FINCH, GULL, HAWK],
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

  // Every native variant: the dot that should show is visible down to its
  // inner element (no hidden wrapper or inner span, a real size), and the
  // other one is hidden. The cue sits on the avatar; the unread dot is the
  // row's last item in normal flex order.
  const visibleChain = el => {
    for (let node = el; node && node.tagName !== 'BUTTON'; node = node.parentElement) {
      const cs = getComputedStyle(node)
      if (cs.display === 'none' || cs.visibility === 'hidden' || cs.opacity === '0') return false
    }
    return true
  }
  const sized = el => {
    const cs = getComputedStyle(el)
    return cs.width !== '0px' && cs.height !== '0px' && cs.width !== '' && cs.height !== ''
  }
  for (const [name, state] of [['Security', 'working'], ['Finch', 'stalled'], ['Gull', 'background']]) {
    const inner = rowOf(name).querySelector('.gbo-row-face .gbo-run-dot [role="status"]')
    assert.ok(inner && visibleChain(inner) && sized(inner), `${state}: the running cue's dot is visible and sized`)
    assert.ok(!shown(rowOf(name).querySelector('.gbo-unread-dot')), `${state}: no unread dot`)
  }
  for (const [name, state] of [['Owl', 'unread'], ['Hawk', 'needs-input']]) {
    const inner = rowOf(name).querySelector('.gbo-unread-dot [role="status"]')
    assert.ok(inner && visibleChain(inner) && sized(inner), `${state}: the unread dot's inner dot is visible and sized`)
    assert.ok(!shown(rowOf(name).querySelector('.gbo-run-dot')), `${state}: no running cue`)
  }

  // The CSS draws the cue for the running states only, and the unread dot
  // for unread / needs-input only.
  const css = readFileSync(new URL('../src/ui/styles-adapt.ts', import.meta.url), 'utf8')
  assert.match(css, /\.gbo-run-dot:has\(\[role="status"\]\[class\*="ui-accent"\]\)/)
  assert.match(css, /\.gbo-run-dot:has\(\[role="status"\]\[class\*="ui-text-tertiary"\]\)/)
  assert.ok(!/\.gbo-run-dot:has\(\[role="status"\]\[class\*="ui-success"\]\)/.test(css), 'unread is not a running cue')
  assert.deepEqual(errors.map(e => `${e.kind}: ${e.error?.message}`), [])
})
