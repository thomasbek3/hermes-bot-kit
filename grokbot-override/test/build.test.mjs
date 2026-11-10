// The committed bundle: reproducible from any working directory, and it
// carries every licence text it owes its recipients (it is distributed as a
// single file).

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const pluginDir = resolve(here, '..')
const repoRoot = resolve(pluginDir, '..')
const ready = existsSync(resolve(pluginDir, 'node_modules/esbuild'))
const BUNDLE = readFileSync(resolve(pluginDir, 'plugin.js'), 'utf8')

test('build --check gives the same answer from the plugin folder and from the repository root (review r1 #10)', { skip: !ready && 'dev dependencies not installed' }, () => {
  const fromPlugin = spawnSync(process.execPath, ['build.mjs', '--check'], { cwd: pluginDir, encoding: 'utf8' })
  assert.equal(fromPlugin.status, 0, fromPlugin.stderr)
  const fromRoot = spawnSync(process.execPath, ['grokbot-override/build.mjs', '--check'], { cwd: repoRoot, encoding: 'utf8' })
  assert.equal(fromRoot.status, 0, fromRoot.stderr)
})

test('plugin.js embeds the full Apache-2.0 text and every attribution it owes (review r1 #8)', () => {
  const head = BUNDLE.slice(0, BUNDLE.indexOf('*/') + 2)
  assert.ok(head.startsWith('/*!'), 'the licence block is a preserved (/*!) comment')
  for (const text of [
    'Apache License',
    'Version 2.0, January 2004',
    'TERMS AND CONDITIONS FOR USE, REPRODUCTION, AND DISTRIBUTION',
    '4. Redistribution.',
    'END OF TERMS AND CONDITIONS',
    'Copyright 2026 Rakazo contributors',
    'Modified 2026-11-08',
    'Copyright (c) 2025 Nous Research',
    'Copyright (c) 2026 Thomas Bekkers',
    'Copyright (c) 2026 Nick Vasilescu',
    'src/ui/styles-ref.ts',
    'Permission is hereby granted, free of charge',
    'THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND'
  ]) {
    assert.ok(head.includes(text), `licence block is missing: ${text}`)
  }
  // All three MIT permission notices are reproduced (kit, Hermes Agent, and
  // the third-party layout CSS in styles-ref.ts).
  assert.equal(head.split('Permission is hereby granted, free of charge').length - 1, 3)
})

test('plugin.js (what the root install.sh installs) starts on; there is no default-off copy any more', () => {
  assert.match(BUNDLE, /^var DEFAULT_ON = true;$/m)
  assert.equal(existsSync(resolve(pluginDir, 'plugin.default-off.js')), false)
  const listed = readFileSync(resolve(repoRoot, 'scripts/manifest-files.txt'), 'utf8')
  assert.match(listed, /^grokbot-override\/plugin\.js$/m)
  assert.doesNotMatch(listed, /default-off/)
})
