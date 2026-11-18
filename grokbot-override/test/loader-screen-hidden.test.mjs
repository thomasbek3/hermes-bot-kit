// The bot's computer: a viewer whose workspace pane is hidden (a background
// tab) sends no display.start; showing the pane wakes the screen and dials
// it. The built plugin.js under Hermes's loader (one boot per file).

import assert from 'node:assert/strict'
import test from 'node:test'

import { READY, waitFor } from './loader-boot.mjs'
import { bootFull, reactErrors } from './loader-surfaces.mjs'
import { fakeScreen, openScreen, tick, visibilityAtom } from './fixtures/screen-cold-open.mjs'

const skip = !READY && 'dev dependencies not installed'

test('a hidden viewer pane sends no start; showing it wakes the screen', { skip }, async t => {
  const fake = fakeScreen()
  const atoms = new Map()
  const booted = await bootFull(t, {
    primitives: false,
    answers: fake.answers,
    tweak: sdk => {
      const base = sdk.host.paneVisibility
      sdk.host.paneVisibility = id => {
        if (!String(id).startsWith('plugin-workspace:grokbot-override-screen-')) return base(id)
        if (!atoms.has(id)) atoms.set(id, visibilityAtom(false))
        return atoms.get(id)
      }
    }
  })
  const { calls, errors } = booted
  const sent = method => calls.filter(c => c.method === method).length

  const el = await openScreen(booted)
  await waitFor(() => sent('display.status') >= 1 && el.textContent.includes('asleep'), 'a hidden viewer reads the status only')
  await tick(120)
  assert.equal(sent('display.start'), 0, 'no start while the pane is hidden')
  assert.ok(el.textContent.includes('Start screen'), 'the asleep card keeps its button')

  const [atom] = [...atoms.values()]
  atom.set(true)
  await waitFor(() => sent('display.start') === 1, 'shown: the viewer wakes the screen')
  fake.screen.release()
  await waitFor(() => sent('display.observe') >= 1, 'and dials it')
  assert.deepEqual(reactErrors(errors), [])
})
