// Source links, review round 2 (SL24-05 … SL24-08): regressions found by the
// second adversarial review, each reproduced first. Demo content only:
// `example` workspace, fake ids.

import assert from 'node:assert/strict'
import { existsSync, rmSync } from 'node:fs'
import { dirname } from 'node:path'
import test from 'node:test'
import { pathToFileURL } from 'node:url'

import { protectSlackAppLinks } from '../src/core/sourceLinks.js'
import { hostMarkdown } from './host-markdown.mjs'

const ready =
  existsSync(new URL('../node_modules/esbuild', import.meta.url)) &&
  existsSync(new URL('../node_modules/react-dom', import.meta.url)) &&
  existsSync(new URL('../node_modules/jsdom', import.meta.url))
const skip = !ready && 'dev dependencies not installed'
const host = await hostMarkdown()
const skipHost = (!ready && 'dev dependencies not installed') || (!host && 'no local Hermes Agent checkout (Streamdown)')

const SLACK_APP = 'slack://channel?team=T0EXAMPLE1&id=C0123ABCD&message=1762560000.123456'
const LONG_BARE = `https://github.com/example/repo/blob/main/${'long-path/'.repeat(24)}file.md`

let env = null
async function setup(t) {
  if (env) return env
  const { JSDOM } = await import('jsdom')
  const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/', pretendToBeVisual: true })
  const w = dom.window
  const set = (key, value) => Object.defineProperty(globalThis, key, { value, configurable: true, writable: true })
  for (const key of ['window', 'document', 'navigator', 'HTMLElement', 'Element', 'Node', 'Text', 'Event', 'MouseEvent', 'KeyboardEvent', 'MutationObserver', 'getComputedStyle']) {
    set(key, key === 'getComputedStyle' ? w.getComputedStyle.bind(w) : w[key])
  }
  set('IS_REACT_ACT_ENVIRONMENT', false)
  const { bundlePreview } = await import('../dev/bundle.mjs')
  const file = await bundlePreview()
  const m = await import(pathToFileURL(file).href)
  const React = (await import('react')).default
  const { createRoot } = await import('react-dom/client')
  t.after(() => {
    rmSync(dirname(file), { recursive: true, force: true })
    dom.window.close()
  })
  env = { m, React, createRoot }
  return env
}

const settle = async () => {
  for (let i = 0; i < 30; i += 1) await new Promise(resolve => setTimeout(resolve, 2))
}

/** Mount BotProse; `defer` models the host's deferred text commits. */
async function mountProse(t, text, { defer = false } = {}) {
  const { m, React, createRoot } = await setup(t)
  m.fakeSdk.FAKE_RENDER.defer = defer
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  const draw = (value, streaming = false) => root.render(React.createElement(m.BotProse, { bot: { name: 'scholar' }, text: value, pos: '', streaming }))
  draw(text, true)
  await settle()
  t.after(() => {
    root.unmount()
    container.remove()
    m.fakeSdk.FAKE_RENDER.defer = false
  })
  return { container, draw }
}

// ---- SL24-02 (accepted platform limit): documented, and bots told to use https permalinks ----

test('SL24-02: the slack:// limit is documented and the skill asks for https permalinks', async () => {
  const { readFileSync } = await import('node:fs')
  const parity = readFileSync(new URL('../PARITY.md', import.meta.url), 'utf8')
  const limits = parity.slice(parity.indexOf('## Known limits'))
  assert.match(limits, /`slack:\/\/` source links open the channel, not the message/)
  assert.match(limits, /admits\s+only `http:`, `https:` and `mailto:`/)
  const skill = readFileSync(new URL('../skills/agent-cards/SKILL.md', import.meta.url), 'utf8')
  assert.match(skill, /always the https permalink `https:\/\/<workspace>\.slack\.com\/archives\/<channel_id>\/p<ts without the dot>`/)
  assert.match(skill, /Never a `slack:\/\/` link/)
})
