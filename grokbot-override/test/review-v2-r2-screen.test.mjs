// Review override-v2-r2 M2 (src/ui/Screen.tsx): closing Bot Screen while an
// install's socket retention is pending never starts the install and the late
// retention is released; done releases it while mounted (stock
// screen-install.tsx:55-133, screen-install-retention.test.tsx:115-136).
// The built plugin.js under Hermes's loader, one boot per file (the SDK shim
// is a cached data: URL).

import assert from 'node:assert/strict'
import test from 'node:test'

import { READY, waitFor } from './loader-boot.mjs'
import { bootFull, buttonWithText, reactErrors, SCOUT } from './loader-surfaces.mjs'

const skip = !READY && 'dev dependencies not installed'

function deferred() {
  let resolve
  let reject
  const promise = new Promise((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}
const tick = (ms = 30) => new Promise(resolve => setTimeout(resolve, ms))

test('v2-r2 M2: closing Bot Screen while install retention is pending never installs and releases the late retention; done releases while mounted', { skip }, async t => {
  const retentions = []
  let released = 0
  const notInstalled = { supported: true, installed: false, running: false, missing: ['xvfb'], install_command: 'apt install xvfb', profile_key: 'pk-scout', lease: { holder: 'agent', epoch: 1, since: 0 } }
  const booted = await bootFull(t, {
    primitives: false,
    tweak: sdk => {
      const on = sdk.host.onEvent
      sdk.host.onEvent = (type, fn) => on(type, event => event?.type === type && fn(event))
      sdk.host.retainProfile = () => {
        const d = deferred()
        retentions.push(d)
        return d.promise
      }
    },
    answers: { 'display.status': () => notInstalled, 'display.install': () => ({ ok: true }) }
  })
  const { React, workspaces, mount, calls, internals, emit, errors } = booted
  const installs = () => calls.filter(c => c.method === 'display.install').length
  const release = () => {
    released += 1
  }

  mount(booted.panes.find(p => p.id === 'roster').render)
  internals.openBotScreen(SCOUT)
  const [, tab] = await waitFor(() => [...workspaces.entries()].find(([id]) => String(id).startsWith('grokbot-override-screen-')), 'the screen tab')
  let setShown = null
  const Inner = () => tab.render()
  const Toggle = () => {
    const [on, set] = React.useState(true)
    setShown = set
    return on ? React.createElement(Inner) : null
  }
  const el = mount(() => React.createElement(Toggle))
  await waitFor(() => buttonWithText(el, 'Install'), 'the install card')

  // Mounted: install, then done releases the retention.
  buttonWithText(el, 'Install').click()
  await waitFor(() => retentions.length === 1, 'the first retention request')
  retentions[0].resolve(release)
  await waitFor(() => installs() === 1, 'the install request')
  assert.equal(released, 0, 'held while the install runs')
  emit({ type: 'display.install.done', connectionId: 'mini', payload: { profile_key: 'pk-scout', code: 1 } })
  await waitFor(() => released === 1, 'done releases the install retention')

  // Unmounted while the retention is pending: no install, late release.
  await waitFor(() => !buttonWithText(el, 'Installing…') && buttonWithText(el, 'Install'), 'the card is idle again')
  buttonWithText(el, 'Install').click()
  await waitFor(() => retentions.length === 2, 'the second retention request')
  setShown(false)
  await waitFor(() => !el.querySelector('.gbo-screen'), 'the screen unmounted')
  retentions[1].resolve(release)
  await tick(60)
  assert.equal(installs(), 1, 'no display.install after the screen closed')
  assert.equal(released, 2, 'the late retention is released at once')
  assert.deepEqual(reactErrors(errors), [])
})
