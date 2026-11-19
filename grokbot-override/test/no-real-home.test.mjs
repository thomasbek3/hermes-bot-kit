// Tests never read the real ~/.hermes: helpers find a Hermes checkout only
// through HERMES_TEST_CHECKOUT, and npm test runs under a throwaway HOME.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'

const here = fileURLToPath(new URL('.', import.meta.url))

test('no test file looks under the home folder', () => {
  const hits = []
  for (const f of readdirSync(here).filter(f => /\.(mjs|js)$/.test(f) && f !== 'no-real-home.test.mjs')) {
    const text = readFileSync(join(here, f), 'utf8')
    if (/homedir\s*\(|os\.homedir|process\.env\.HOME\b|['"`]~\/\.hermes/.test(text)) hits.push(f)
  }
  assert.deepEqual(hits, [])
})

test('helpers do not borrow from a Hermes install unless asked', async () => {
  if (process.env.HERMES_TEST_CHECKOUT) return
  const { reactRequire } = await import('./hermes-loader.mjs')
  assert.equal(reactRequire().from, 'local')
  const { hostMarkdown } = await import('./host-markdown.mjs')
  assert.equal(await hostMarkdown(), null)
})

test('npm test runs under a throwaway HOME', { skip: !process.env.KIT_TEST_TEMP_HOME && 'run through npm test' }, () => {
  assert.equal(process.env.HOME, process.env.KIT_TEST_TEMP_HOME)
  assert.ok(process.env.HOME.startsWith(tmpdir()) || process.env.HOME.includes('grokbot-test-home-'))
  assert.equal(process.env.HERMES_HOME, undefined)
})
