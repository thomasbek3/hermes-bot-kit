// The bot's computer: the control pill under the desk image
// (src/core/screenPill.js). Each state keeps the old header bar's actions and
// disabled rules; only the presentation moved. Take control (and Take back)
// show only while a stream is live; waking, connecting and reconnecting show
// progress with no button but Stop for a held control.

import assert from 'node:assert/strict'
import { existsSync, rmSync } from 'node:fs'
import { dirname } from 'node:path'
import test from 'node:test'
import { pathToFileURL } from 'node:url'

import { screenLink, screenPill, screenPillTitle, screenRatio } from '../src/core/screenPill.js'

const base = { phase: 'running', conn: 'live', iHold: false, humanOther: false, busy: false, hasViewer: true, blocker: null }
const ids = pill => pill.actions.map(action => action.id)

test('watching: eye, "Watching", one dark "Take control"', () => {
  const pill = screenPill(base)
  assert.equal(pill.tone, 'watch')
  assert.equal(pill.icon, 'eye')
  assert.equal(pill.label, 'Watching')
  assert.deepEqual(pill.actions, [{ id: 'take', label: 'Take control', kind: 'dark', disabled: false }])
})

test('Take control is disabled while busy or before a viewer id exists (as Take over was)', () => {
  assert.equal(screenPill({ ...base, busy: true }).actions[0].disabled, true)
  assert.equal(screenPill({ ...base, hasViewer: false }).actions[0].disabled, true)
})

test('in control: pointer, "You’re in control", one light "Stop" (hand back)', () => {
  const pill = screenPill({ ...base, iHold: true })
  assert.equal(pill.tone, 'you')
  assert.equal(pill.icon, 'pointer')
  assert.equal(pill.label, 'You’re in control')
  assert.deepEqual(ids(pill), ['stop'])
  assert.equal(pill.actions[0].kind, 'light')
  assert.equal(screenPill({ ...base, iHold: true, busy: true }).actions[0].disabled, true)
  assert.equal(screenPill({ ...base, iHold: true, conn: 'attaching' }).actions[0].disabled, false, 'Stop stays available while reconnecting')
})

test('stale human hold: "Someone else is in control", Take back (force) then Take control', () => {
  const pill = screenPill({ ...base, humanOther: true })
  assert.equal(pill.label, 'Someone else is in control')
  assert.equal(pill.icon, 'person')
  assert.deepEqual(ids(pill), ['take-back', 'take'])
  assert.equal(pill.actions[0].label, 'Take back')
  assert.equal(pill.actions[0].kind, 'light')
  assert.equal(pill.actions[1].kind, 'dark')
})

test('connecting, reconnecting and starting show progress and no Take control', () => {
  for (const [conn, label] of [['attaching', 'Connecting…'], ['idle', 'Connecting…'], ['reconnecting', 'Reconnecting…'], ['waking', 'Starting…']]) {
    const pill = screenPill({ ...base, conn })
    assert.equal(pill.label, label, conn)
    assert.equal(pill.icon, 'spinner', conn)
    assert.deepEqual(ids(pill), [], `${conn}: no button`)
    assert.deepEqual(ids(screenPill({ ...base, conn, humanOther: true })), [], `${conn}: no Take back either`)
    assert.deepEqual(ids(screenPill({ ...base, conn, iHold: true })), ['stop'], `${conn}: a held control can still be handed back`)
  }
})

test('given up: "Connection lost" + Retry only (Stop too while holding), never Take control', () => {
  const lost = screenPill({ ...base, conn: 'error' })
  assert.equal(lost.label, 'Connection lost')
  assert.equal(lost.icon, 'warn')
  assert.deepEqual(ids(lost), ['retry'])
  assert.equal(lost.actions[0].kind, 'dark')
  assert.deepEqual(ids(screenPill({ ...base, conn: 'error', humanOther: true })), ['retry'])
  assert.deepEqual(ids(screenPill({ ...base, conn: 'error', iHold: true })), ['retry', 'stop'])
  assert.deepEqual(ids(screenPill({ ...base, phase: 'stopped', conn: 'error' })), ['retry'], 'a screen that would not wake')
})

test('Take control (and Take back) only while the stream is live', () => {
  for (const conn of ['idle', 'attaching', 'reconnecting', 'waking', 'error']) {
    assert.ok(!ids(screenPill({ ...base, conn })).includes('take'), conn)
    assert.ok(!ids(screenPill({ ...base, conn, humanOther: true })).includes('take-back'), conn)
  }
  assert.deepEqual(ids(screenPill({ ...base, conn: 'live' })), ['take'])
  assert.deepEqual(ids(screenPill({ ...base, conn: 'live', humanOther: true })), ['take-back', 'take'])
})

test('not running and not waking: "Not running" + Start screen, disabled by a blocker', () => {
  const pill = screenPill({ ...base, phase: 'stopped', conn: 'idle' })
  assert.equal(pill.tone, 'idle')
  assert.equal(pill.label, 'Not running')
  assert.deepEqual(pill.actions, [{ id: 'start', label: 'Start screen', kind: 'dark', disabled: false }])
  const blocked = screenPill({ ...base, phase: 'stopped', conn: 'waking', blocker: 'Not enough memory' })
  assert.equal(blocked.label, 'Not running', 'a start blocker keeps its card even mid-sequence')
  assert.equal(blocked.actions[0].disabled, true)
})

test('waking a screen that is asleep: "Starting…" with no button', () => {
  for (const conn of ['waking', 'attaching', 'reconnecting']) {
    const pill = screenPill({ ...base, phase: 'stopped', conn })
    assert.equal(pill.label, 'Starting…', conn)
    assert.equal(pill.icon, 'spinner', conn)
    assert.deepEqual(pill.actions, [], conn)
  }
})

test('the first status read of a cold open: "Connecting…", no button', () => {
  const pill = screenPill({ ...base, phase: 'loading', conn: 'attaching' })
  assert.equal(pill.label, 'Connecting…')
  assert.deepEqual(pill.actions, [])
  assert.deepEqual(ids(screenPill({ ...base, phase: 'loading', conn: 'error' })), ['retry'])
})

test('the other phases keep their own centred cards (no pill)', () => {
  for (const phase of ['unavailable', 'unsupported', 'not-installed', 'image-switch']) assert.equal(screenPill({ ...base, phase }), null, phase)
})

test('screenLink: the wake machine mode as the pill sees it', () => {
  assert.equal(screenLink({ mode: 'live' }, 'running'), 'live')
  assert.equal(screenLink({ mode: 'gave-up' }, 'running'), 'error')
  assert.equal(screenLink({ mode: 'waking' }, 'stopped'), 'waking')
  assert.equal(screenLink({ mode: 'retrying', recovering: true }, 'running'), 'reconnecting')
  assert.equal(screenLink({ mode: 'checking', recovering: false }, 'loading'), 'attaching')
  assert.equal(screenLink({ mode: 'connecting', recovering: false }, 'running'), 'attaching')
  assert.equal(screenLink({ mode: 'checking', recovering: true }, 'running'), 'reconnecting', 'no flicker back to Connecting mid-recovery')
  assert.equal(screenLink({ mode: 'connecting', recovering: true }, 'running'), 'reconnecting')
  for (const mode of ['idle', 'paused', 'blocked']) {
    assert.equal(screenLink({ mode }, 'stopped'), 'idle', mode)
    assert.equal(screenLink({ mode }, 'running'), 'attaching', `${mode}: a running screen is dialled when shown`)
  }
  assert.equal(screenLink(null, 'stopped'), 'idle')
})

test('the desk image ratio comes from the geometry, 16:10 when unknown', () => {
  assert.equal(screenRatio('1920x1200'), 1.6)
  assert.equal(screenRatio('1280x720'), 1280 / 720)
  assert.equal(screenRatio(undefined), 1.6)
  assert.equal(screenRatio('0x0'), 1.6)
  assert.equal(screenRatio('wide'), 1.6)
})

test('the pill tooltip carries the name, display, size, sandbox and a holder’s reason', () => {
  assert.equal(screenPillTitle('Scout', { display: ':20', geometry: '1920x1200' }, { holder: 'agent' }), 'Scout’s computer — :20 · 1920x1200')
  assert.equal(
    screenPillTitle('Scout', { display: ':20', geometry: '1920x1200', placement: 'terminal:box-1' }, { holder: 'human', reason: 'fixing a login' }),
    'Scout’s computer — :20 · 1920x1200 — in sandbox box-1 — fixing a login'
  )
  assert.equal(screenPillTitle('Scout', null, null), 'Scout’s computer')
  assert.equal(
    screenPillTitle('Scout', { display: ':20' }, null, 'this profile’s Bot Desktop is not running; call display.start first'),
    'Scout’s computer — :20 — this profile’s Bot Desktop is not running; call display.start first',
    'the backend’s words live in the tooltip, not the view'
  )
})

const ready = existsSync(new URL('../node_modules/esbuild', import.meta.url)) && existsSync(new URL('../node_modules/react-dom', import.meta.url))

test('the viewer renders the pill under the stage in every state, with no header bar', { skip: !ready && 'dev dependencies not installed' }, async t => {
  const { bundlePreview } = await import('../dev/bundle.mjs')
  const file = await bundlePreview()
  t.after(() => rmSync(dirname(file), { recursive: true, force: true }))
  const { renderScreenState } = await import(pathToFileURL(file).href)
  const expect = {
    watching: ['Watching', 'Take control'],
    'in-control': ['You’re in control', 'Stop'],
    'stale-hold': ['Someone else is in control', 'Take back', 'Take control'],
    'not-running': ['Not running', 'Start screen', 'asleep'],
    waking: ['Starting…', 'Waking the computer…'],
    reconnecting: ['Reconnecting…'],
    'gave-up': ['Connection lost', 'Retry', 'Can’t reach the computer']
  }
  for (const [state, texts] of Object.entries(expect)) {
    const html = renderScreenState(state, 'light')
    const body = html.slice(html.indexOf('<body>'))
    assert.ok(!body.includes('gbo-screen-bar'), `${state}: no header bar`)
    assert.ok(body.includes('data-gbo-theme="dark"'), `${state}: the surround is dark in the light theme too`)
    const pillAt = body.indexOf('gbo-screen-pill"') >= 0 ? body.indexOf('gbo-screen-pill"') : body.indexOf('gbo-screen-pill ')
    assert.ok(pillAt > body.indexOf('gbo-screen-stage'), `${state}: the pill comes after the stage`)
    for (const text of texts) assert.ok(body.includes(text), `${state}: ${text}`)
    assert.ok(!body.includes('Scout') && !body.includes('Travel’s computer<'), `${state}: no bot name in the view`)
    assert.equal(body.includes('aria-label="Reconnect"'), state !== 'not-running' && state !== 'waking', `${state}: Reconnect in the corner while running`)
    assert.equal(body.includes('gbo-screen-stage is-held'), state === 'in-control', `${state}: the accent outline only while you hold control`)
    assert.equal(body.includes('>Take control<'), ['watching', 'stale-hold'].includes(state), `${state}: Take control only on a live stream`)
    assert.ok(!body.replace(/title="[^"]*"/g, '').includes('call display.start first'), `${state}: no raw backend error in the view (only in a tooltip)`)
    assert.ok(body.includes('gbo-screen-canvas'), `${state}: the canvas host is always in the stage`)
  }
  // The raw error rides the pill tooltip.
  const lost = renderScreenState('gave-up', 'light')
  assert.match(lost, /title="[^"]*call display\.start first"/)
  assert.ok(!renderScreenState('reconnecting', 'light').includes('<strong>Reconnecting'), 'reconnecting: the pill says it, the stage only spins')
})
