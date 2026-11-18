// The bot's computer: the control pill under the desk image
// (src/core/screenPill.js). Each state keeps the old header bar's actions and
// disabled rules; only the presentation moved.

import assert from 'node:assert/strict'
import { existsSync, rmSync } from 'node:fs'
import { dirname } from 'node:path'
import test from 'node:test'
import { pathToFileURL } from 'node:url'

import { screenPill, screenPillTitle, screenRatio } from '../src/core/screenPill.js'

const base = { phase: 'running', conn: 'live', iHold: false, humanOther: false, busy: false, hasViewer: true, blocker: null }
const ids = pill => pill.actions.map(action => action.id)

test('watching: eye, "Watching", one dark "Take control"', () => {
  const pill = screenPill(base)
  assert.equal(pill.tone, 'watch')
  assert.equal(pill.icon, 'eye')
  assert.equal(pill.label, 'Watching')
  assert.deepEqual(pill.actions, [{ id: 'take', label: 'Take control', kind: 'dark', disabled: false }])
})

test('Take control is disabled while busy, attaching or before a viewer id exists (as Take over was)', () => {
  assert.equal(screenPill({ ...base, busy: true }).actions[0].disabled, true)
  assert.equal(screenPill({ ...base, conn: 'attaching' }).actions[0].disabled, true)
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

test('connecting and lost connections change the label; a lost one adds Retry first', () => {
  const connecting = screenPill({ ...base, conn: 'attaching' })
  assert.equal(connecting.label, 'Connecting…')
  assert.equal(connecting.icon, 'spinner')
  assert.deepEqual(ids(connecting), ['take'])
  const lost = screenPill({ ...base, conn: 'error' })
  assert.equal(lost.label, 'Connection lost')
  assert.equal(lost.icon, 'warn')
  assert.deepEqual(ids(lost), ['retry', 'take'])
  assert.deepEqual(ids(screenPill({ ...base, conn: 'error', iHold: true })), ['retry', 'stop'])
})

test('not running: "Not running" + Start screen, disabled by a blocker or while starting', () => {
  const pill = screenPill({ ...base, phase: 'stopped' })
  assert.equal(pill.tone, 'idle')
  assert.equal(pill.label, 'Not running')
  assert.deepEqual(pill.actions, [{ id: 'start', label: 'Start screen', kind: 'dark', disabled: false }])
  assert.equal(screenPill({ ...base, phase: 'stopped', blocker: 'No display server' }).actions[0].disabled, true)
  const starting = screenPill({ ...base, phase: 'stopped', busy: true })
  assert.equal(starting.actions[0].label, 'Starting…')
  assert.equal(starting.actions[0].disabled, true)
})

test('the other phases keep their own centred cards (no pill)', () => {
  for (const phase of ['unavailable', 'loading', 'unsupported', 'not-installed', 'image-switch']) assert.equal(screenPill({ ...base, phase }), null, phase)
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
    'not-running': ['Not running', 'Start screen', 'asleep']
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
    assert.equal(body.includes('aria-label="Reconnect"'), state !== 'not-running', `${state}: Reconnect in the corner while running`)
    assert.equal(body.includes('gbo-screen-stage is-held'), state === 'in-control', `${state}: the accent outline only while you hold control`)
  }
})
