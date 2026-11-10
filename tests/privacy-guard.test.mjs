// Privacy guard: no tracked text file may carry one person's private details
// (host and tailnet names, private addresses, home folders, workspace ids,
// business, product or bot names, real email addresses).
//
//   node --test tests/privacy-guard.test.mjs
//
// The forbidden words are stored as hashes so this file does not spell them
// out: every file is cut into lowercase words (runs of a-z and 0-9) and each
// run of one to three words is hashed (sha256, first 20 hex chars) and looked
// up. To add a word or phrase, hash it the same way:
//
//   node tests/privacy-guard.test.mjs --hash "some phrase"
//
// Common English words are left out on purpose (they would block ordinary
// prose); review catches those. Addresses, home folders and emails are
// checked by pattern below, with the documented examples allowed.

import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

const FORBIDDEN = new Set([
  'dd5a575848579835c0b3', '04c9098fee5b6f1f4bb5', '1bd7ce4dc46a110a5985', 'be6be30f47195a70589e',
  '50fd52cd1cb46f2fc7f0', '1552f59d213e755fce02', '8d3aa1a6f227d714692a', '813be9a82fb27a1a59f6',
  '2e2c479ff8bc1bd69f2f', '120adefee3d066afd5a7', '1be9f57a6ddda7567990', '6e80789b87c709a77499',
  '31ee941cab657d9e7846', 'c341e0bc4e5eb5642f0b', '3f5305e4027504a3588f', '3d9814136e1a19dee2bf',
  '3c84095a486f8d3c4f46', 'b3c5ba93f77bffcffc7b', 'ec534e27e6d4d58bce03', 'ea1fc024705933d98404',
  '837dbfe793d67b893ca2', '475f9fd3d326cd0903ef', '739e72f2db16302b3d58', '4f7cc4847130c6e7896e',
  'a3587249db361ec4b575', 'a82d92c43ec805af130d', '739de437a01cb18fdfa2', '003d3ef1d10a3a582268',
  '6711529767e00efa85a3', '335a5e95e9a849cbd08b', '97d56ced0b40767d75cc', 'bec25236577b724f2ebe'
])
const MAX_WORDS = 3

const hash = text => createHash('sha256').update(text).digest('hex').slice(0, 20)
const words = text => text.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean)

// Tailscale's 100.64.0.0/10 range: only the 100.64.0.x documentation examples.
const TAILNET_IP = /(?<![\d.])100\.(?:6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.\d{1,3}\.\d{1,3}(?![\d])/g
const TAILNET_OK = /^100\.64\.0\.\d{1,3}$/
// Home folders: only placeholder names.
const HOME_DIR = /\/(?:Users|home)\/([A-Za-z0-9._-]+)/g
const HOME_OK = new Set(['you', 'me', 'user', 'username', 'example', 'runner', 'name', 'cache'])
// Email addresses: only reserved example domains and GitHub's no-reply.
const EMAIL = /[A-Za-z0-9._%+-]+@([A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,})/g
const EMAIL_OK = /(?:^|\.)(?:example\.(?:com|org|net)|example|test|invalid|localhost|users\.noreply\.github\.com|anthropic\.com)$/i
// Third-party code shipped verbatim (its own authors' notices stay as they are).
const VENDORED = new Set(['computer-viewer/vendor/novnc-rfb.mjs', 'grokbot-override/package-lock.json'])
// The Slack pieces' own guard spells its values in split pieces.
const GUARDS = new Set(['slack-connect/tests/test_no_hardcoded_values.py'])

function trackedTextFiles() {
  const out = execFileSync('git', ['ls-files', '-z'], { cwd: ROOT, maxBuffer: 64 * 1024 * 1024 }).toString('utf8')
  const files = []
  for (const rel of out.split('\0')) {
    if (!rel || /\.(png|jpe?g|gif|webp|ico|pdf|woff2?)$/i.test(rel)) continue
    let buf
    try {
      buf = readFileSync(join(ROOT, rel))
    } catch {
      continue // deleted in the working tree
    }
    if (buf.subarray(0, 8192).includes(0)) continue
    files.push({ rel, text: buf.toString('utf8') })
  }
  return files
}

/** Every forbidden word run in `text`, as `{ line, kind }` (never the text). */
export function scan(text, rel = '', seen = new Map()) {
  const hits = []
  const lines = text.split('\n')
  lines.forEach((line, index) => {
    const w = GUARDS.has(rel) ? [] : words(line)
    for (let i = 0; i < w.length; i += 1) {
      let gram = ''
      for (let n = 1; n <= MAX_WORDS && i + n <= w.length; n += 1) {
        gram = n === 1 ? w[i] : `${gram} ${w[i + n - 1]}`
        let bad = seen.get(gram)
        if (bad === undefined) {
          bad = FORBIDDEN.has(hash(gram))
          seen.set(gram, bad)
        }
        if (bad) hits.push({ line: index + 1, kind: `private word (${hash(gram)})` })
      }
    }
    if (line.includes('100.')) {
      for (const m of line.matchAll(TAILNET_IP)) if (!TAILNET_OK.test(m[0])) hits.push({ line: index + 1, kind: `tailnet address ${m[0]}` })
    }
    if (line.includes('/Users/') || line.includes('/home/')) {
      for (const m of line.matchAll(HOME_DIR)) if (!HOME_OK.has(m[1].toLowerCase())) hits.push({ line: index + 1, kind: `home folder of "${m[1]}"` })
    }
    if (line.includes('@') && !VENDORED.has(rel)) {
      for (const m of line.matchAll(EMAIL)) if (!EMAIL_OK.test(m[1])) hits.push({ line: index + 1, kind: `email at ${m[1]}` })
    }
  })
  return hits
}

if (process.argv.includes('--hash')) {
  const phrase = process.argv.slice(process.argv.indexOf('--hash') + 1).join(' ')
  console.log(hash(words(phrase).join(' ')))
} else {
  const { test } = await import('node:test')
  const assert = (await import('node:assert/strict')).default

  test('no tracked text file carries private details', () => {
    const files = trackedTextFiles()
    assert.ok(files.length > 200, `expected the whole repo, got ${files.length} files`)
    const seen = new Map()
    const hits = files.flatMap(({ rel, text }) => scan(text, rel, seen).map(hit => `${rel}:${hit.line}: ${hit.kind}`))
    assert.deepEqual(hits, [])
  })

  test('the guard catches each kind it checks', () => {
    // Assembled at run time so the planted values are not literal here.
    const planted = [
      `see ${['paver', 'turf'].join('')} docs`,
      `host ${['100', '86', '1', '2'].join('.')}`,
      `path ${'/Us' + 'ers/'}somebody/x`,
      `mail ${'a' + '@'}company.io`
    ].join('\n')
    assert.deepEqual(scan(planted).map(hit => hit.line), [1, 2, 3, 4])
    assert.deepEqual(scan('/Users/you/x 100.64.0.9 a@example.com u@users.noreply.github.com'), [])
  })
}
