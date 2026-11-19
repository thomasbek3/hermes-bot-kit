// Hermes Desktop v0.23.2 has no Cmd/Ctrl+Shift+P palette (it is Cmd/Ctrl+K or
// +P, command "Reload desktop plugins"), and the plugin on/off switches live
// in Capabilities -> Plugins (Settings -> Plugins only holds plugin settings
// pages, e.g. "Settings -> Plugins -> Email drafts"). Tracked text must not send
// people to either old place, except where it says that one does nothing.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'

const root = new URL('..', import.meta.url)
const files = execFileSync('git', ['ls-files', '-co', '--exclude-standard', '-z'], { cwd: root })
  .toString('utf8').split('\0').filter(Boolean)
  .filter(f => /\.(md|sh|ps1|py|js|mjs|ts|tsx|yml|yaml|txt)$/.test(f))
  .filter(f => !/(^|\/)CHANGELOG\.md$/.test(f) && f !== 'tests/stale-instructions.test.mjs')
  .filter(f => !f.startsWith('grokbot-override/plugin.js'))

const SHORTCUT = /(⌘\s*⇧\s*P|cmd\s*\+\s*shift\s*\+\s*p|ctrl\s*\+\s*shift\s*\+\s*p)/i
const NEGATION = /not a Hermes shortcut|no ⌘⇧P|does nothing|isn't a Hermes shortcut/i
const OLD_SWITCH = /Settings\s*(→|->)\s*Plugins(?!\s*(→|->))/

test('no tracked text points at the old palette shortcut or switch location', () => {
  const hits = []
  for (const rel of files) {
    let text
    try { text = fs.readFileSync(new URL(rel, root), 'utf8') } catch { continue }
    text.split('\n').forEach((line, i) => {
      if (SHORTCUT.test(line) && !NEGATION.test(line)) hits.push(`${rel}:${i + 1}: shortcut`)
      if (OLD_SWITCH.test(line)) hits.push(`${rel}:${i + 1}: Settings -> Plugins`)
    })
  }
  assert.deepEqual(hits, [])
})
