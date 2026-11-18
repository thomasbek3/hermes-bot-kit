// The bot's computer opens by itself: the built plugin.js under Hermes's
// loader (one boot per file). Opening the viewer on a screen that is asleep
// sends display.start once (no click) and then dials it (display.observe);
// "Waking the computer…" shows meanwhile. The roster alone never starts a
// screen. The hidden-pane case is loader-screen-hidden.test.mjs.

import assert from 'node:assert/strict'
import test from 'node:test'

import { READY, waitFor } from './loader-boot.mjs'
import { bootFull, reactErrors } from './loader-surfaces.mjs'
import { fakeScreen, openScreen, tick } from './fixtures/screen-cold-open.mjs'

const skip = !READY && 'dev dependencies not installed'

test('cold open: an asleep screen is started once with no click, shows "Waking the computer…", then is dialled', { skip }, async t => {
  const fake = fakeScreen()
  const booted = await bootFull(t, { primitives: false, answers: fake.answers })
  const { calls, errors } = booted
  const sent = method => calls.filter(c => c.method === method).length

  // The roster and panel alone never start a screen.
  booted.mount(booted.panes.find(p => p.id === 'roster').render)
  await tick(80)
  assert.equal(sent('display.start'), 0, 'no start before the viewer is opened')

  const el = await openScreen(booted)
  await waitFor(() => sent('display.start') === 1, 'display.start sent by the open itself')
  await waitFor(() => el.textContent.includes('Waking the computer…') && el.textContent.includes('Starting…'), 'the waking state')
  assert.ok(!el.textContent.includes('Take control'), 'no Take control while waking')
  assert.ok(!el.textContent.includes('Start screen'), 'no Start button while waking')
  assert.ok(!el.textContent.includes('call display.start first'), 'no raw backend error in the view')

  fake.screen.release()
  await waitFor(() => sent('display.observe') >= 1, 'the woken screen is dialled')
  const startAt = calls.findIndex(c => c.method === 'display.start')
  const observeAt = calls.findIndex(c => c.method === 'display.observe')
  assert.ok(observeAt > startAt, 'dialled after the start answered')
  await tick(60)
  assert.equal(sent('display.start'), 1, 'started exactly once')
  assert.deepEqual(reactErrors(errors), [])
})
