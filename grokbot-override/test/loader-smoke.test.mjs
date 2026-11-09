// Loader-faithful smoke test, one harness for both parity branches: the BUILT
// plugin.js loaded exactly as Hermes Desktop loads a runtime plugin
// (hermes-loader.mjs: the runtime loader's unsupported-import check and
// specifier rewrite from contrib/runtime-loader.ts, sdk/runtime.ts namespace
// shims over production React built like the app's rolldown __toESM, a jsdom
// DOM, createRoot), with the SDK's Radix dialog / menu parts present. Every
// roster-side and chat-side surface renders (test/loader-surfaces.mjs); the
// older-SDK fallbacks run in loader-smoke-legacy.test.mjs (one plugin per
// file: react-dom binds to the first window it sees, as in the app).

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

import { PLUGIN, READY } from './loader-boot.mjs'
import { exerciseSurfaces } from './loader-surfaces.mjs'

test('loader-faithful smoke: every surface of both parity branches renders (SDK dialog / menu parts present)', { skip: !READY && 'dev dependencies not installed' }, async t => {
  await exerciseSurfaces(t, { primitives: true })
})

test('plugin.js names the bundled noVNC (MPL-2.0) and the Rakazo dialog/menu look in its licence block', () => {
  const bundle = readFileSync(PLUGIN, 'utf8')
  const head = bundle.slice(0, bundle.indexOf('*/') + 2)
  for (const text of ['noVNC 1.7.0', 'Mozilla Public License 2.0', 'https://www.mozilla.org/MPL/2.0/', 'pako (MIT', 'src/ui/stylesRoster.ts']) assert.ok(head.includes(text), text)
  assert.ok(bundle.includes('novnc_rfb_exports'), 'the noVNC source form is in the bundle')
})
