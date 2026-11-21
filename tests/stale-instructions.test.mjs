// Hermes Desktop v0.23.2 and v0.23.3 have no Cmd/Ctrl+Shift+P palette (it is Cmd/Ctrl+K or
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

/** Matches of `re` that exist only when line breaks are joined (a match on a
 *  single line is reported per line above). `except` skips negated mentions. */
export function wrappedOnly(text, re, except) {
  const g = new RegExp(re.source, re.flags.replace('g', '') + 'g')
  const count = s => [...s.matchAll(g)].filter(m => !except || !except.test(s.slice(Math.max(0, m.index - 80), m.index + 120))).length
  const perLine = text.split('\n').reduce((n, line) => n + count(line), 0)
  return count(text.replace(/[ \t]*\n[ \t]*/g, ' ')) - perLine
}

test('a wrapped old instruction is caught', () => {
  assert.equal(wrappedOnly('appears under Settings →\nPlugins.', OLD_SWITCH), 1)
  assert.equal(wrappedOnly('press ⌘⇧P\nor not', SHORTCUT, NEGATION), 0)
  assert.equal(wrappedOnly('press Cmd+Shift+\nP to reload', SHORTCUT, NEGATION), 1)
  assert.equal(wrappedOnly('Settings → Plugins → Email\ndrafts', OLD_SWITCH), 0)
})

test('no tracked text points at the old palette shortcut or switch location', () => {
  const hits = []
  for (const rel of files) {
    let text
    try { text = fs.readFileSync(new URL(rel, root), 'utf8') } catch { continue }
    text.split('\n').forEach((line, i) => {
      if (SHORTCUT.test(line) && !NEGATION.test(line)) hits.push(`${rel}:${i + 1}: shortcut`)
      if (OLD_SWITCH.test(line)) hits.push(`${rel}:${i + 1}: Settings -> Plugins`)
    })
    // Also across a line break ("Settings →\nPlugins"), as wrapped prose has it.
    if (wrappedOnly(text, OLD_SWITCH) > 0) hits.push(`${rel}: Settings -> Plugins (split across lines)`)
    if (wrappedOnly(text, SHORTCUT, NEGATION) > 0) hits.push(`${rel}: shortcut (split across lines)`)
  }
  assert.deepEqual(hits, [])
})
