// npm test: every test file runs under a throwaway HOME (and no HERMES_HOME),
// so nothing can read or write the real ~/.hermes. A Hermes checkout is used
// only when HERMES_TEST_CHECKOUT names one.
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = fileURLToPath(new URL('.', import.meta.url))
const files = readdirSync(here).filter(f => f.endsWith('.test.mjs')).sort().map(f => join(here, f))
const home = mkdtempSync(join(tmpdir(), 'grokbot-test-home-'))
const env = { ...process.env, HOME: home, USERPROFILE: home, KIT_TEST_TEMP_HOME: home }
delete env.HERMES_HOME
let status = 1
try {
  status = spawnSync(process.execPath, ['--test', ...process.argv.slice(2), ...files], { stdio: 'inherit', env }).status ?? 1
} finally {
  rmSync(home, { recursive: true, force: true })
}
process.exit(status)
