// Loader-faithful smoke test on an older Desktop: the same surfaces as
// loader-smoke.test.mjs through the same loader, but the SDK has no Radix
// dialog / menu parts, so the override's own fallbacks (inline menus opened
// by a click, the in-place modal) render instead.

import test from 'node:test'

import { READY } from './loader-boot.mjs'
import { exerciseSurfaces } from './loader-surfaces.mjs'

test('loader-faithful smoke: every surface of both parity branches renders on an older SDK (fallbacks)', { skip: !READY && 'dev dependencies not installed' }, async t => {
  await exerciseSurfaces(t, { primitives: false })
})
