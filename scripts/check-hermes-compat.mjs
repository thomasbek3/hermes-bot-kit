import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const kit = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const root = process.argv[2]
if (!root) throw new Error('Usage: node scripts/check-hermes-compat.mjs /path/to/hermes-agent')
const require = createRequire(path.resolve(root, 'package.json'))
const { build } = require('esbuild')
const sdkPath = path.resolve(root, 'apps/desktop/src/sdk/index.ts')
const exports = new Set()
const visited = new Set()
async function collectExports(file) {
  if (visited.has(file)) return
  visited.add(file)
  const result = await build({ entryPoints: [file], bundle: false, write: false,
    metafile: true, format: 'esm', logLevel: 'silent' })
  for (const name of Object.values(result.metafile.outputs)[0].exports) exports.add(name)
  const source = fs.readFileSync(file, 'utf8')
  for (const match of source.matchAll(/export \* from ['"]([^'"]+)['"]/g)) {
    assert.ok(match[1].startsWith('.'), `Unsupported SDK wildcard: ${match[1]}`)
    const base = path.resolve(path.dirname(file), match[1])
    const next = [base + '.ts', base + '.tsx', path.join(base, 'index.ts')].find(fs.existsSync)
    assert.ok(next, `Cannot resolve SDK re-export ${match[1]}`)
    await collectExports(next)
  }
}
await collectExports(sdkPath)
for (const plugin of ['bubble-mode', 'bot-sections', 'task-dock', 'computer-viewer']) {
  const source = fs.readFileSync(path.join(kit, plugin, 'plugin.js'), 'utf8')
  for (const match of source.matchAll(/import\s*\{([^}]+)\}\s*from '@hermes\/plugin-sdk'/g)) {
    for (const name of match[1].split(',').map(x => x.trim()).filter(Boolean)) {
      assert.ok(exports.has(name), `${plugin}: missing SDK export ${name}`)
    }
  }
  await build({ entryPoints: [path.join(kit, plugin, 'plugin.js')], bundle: false,
    write: false, format: 'esm', logLevel: 'silent' })
  console.log(`${plugin}: SDK imports and ESM syntax OK`)
}
const sdk = fs.readFileSync(sdkPath, 'utf8')
assert.match(sdk, /focusedSessionOwner: readonlyAtom<PluginFocusedSessionOwner \| null>/)
assert.match(sdk, /connectionId: string/)
assert.match(sdk, /profile: string/)
console.log('Focused owner contract OK (connectionId + profile)')
