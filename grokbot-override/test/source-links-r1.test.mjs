// Source links, review round 1 (SL24-02 … SL24-05): regressions found by the
// adversarial review, each reproduced first. Demo content only: `example`
// workspace, fake ids.

import assert from 'node:assert/strict'
import { existsSync, rmSync } from 'node:fs'
import { dirname } from 'node:path'
import test from 'node:test'
import { pathToFileURL } from 'node:url'

import { hostMarkdown } from './host-markdown.mjs'

const ready =
  existsSync(new URL('../node_modules/esbuild', import.meta.url)) &&
  existsSync(new URL('../node_modules/react-dom', import.meta.url)) &&
  existsSync(new URL('../node_modules/jsdom', import.meta.url))
const skip = !ready && 'dev dependencies not installed'
const host = await hostMarkdown()
const skipHost = (!ready && 'dev dependencies not installed') || (!host && 'no local Hermes Agent checkout (Streamdown)')

const SLACK_APP = 'slack://channel?team=T0EXAMPLE1&id=C0123ABCD&message=1762560000.123456'
const SLACK_APP_MD = `[Her message](${SLACK_APP})`

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

const flush = async () => {
  for (let i = 0; i < 8; i += 1) await new Promise(resolve => setImmediate(resolve))
}

/** Mount BotText (the real component on the fake SDK) and return its container. */
async function mount(t, text) {
  const { m, React, createRoot } = await setup(t)
  const container = document.createElement('div')
  container.className = 'md'
  document.body.appendChild(container)
  const root = createRoot(container)
  root.render(React.createElement(m.BotText, { bot: { name: 'scholar' }, text }))
  await flush()
  t.after(() => {
    root.unmount()
    container.remove()
  })
  return container
}

/** Stub ctx.os.openExternal: `refuse` lists URL prefixes the host refuses. */
async function stubOpener(t, refuse = []) {
  const { m } = await setup(t)
  const calls = []
  const prev = m.appApi.app.ctx
  m.appApi.app.ctx = { ...(prev || {}), os: { openExternal: async url => (calls.push(url), !refuse.some(p => url.startsWith(p))) } }
  t.after(() => (m.appApi.app.ctx = prev))
  return calls
}

const click = el => el.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }))

// ---- SL24-02: Slack app links survive the sanitizer and keep the message ----

test('SL24-02: a slack:// message link draws as a Slack chip, not "[blocked]" (fake SDK models the sanitizer)', { skip }, async t => {
  const box = await mount(t, `Done. ${SLACK_APP_MD}`)
  assert.ok(!box.textContent.includes('[blocked]'), box.textContent)
  const chip = box.querySelector('a.gbo-src[data-service="slack"]')
  assert.ok(chip, 'a Slack chip')
  assert.equal(chip.querySelector('.gbo-src-text').textContent, 'Her message')
  assert.equal(chip.getAttribute('title'), SLACK_APP, 'the hover shows the app link itself')
})

test('SL24-02: in the host Streamdown pipeline the same input is a Slack chip', { skip: skipHost }, async t => {
  const { m } = await setup(t)
  const { protectSlackAppLinks } = await import('../src/core/sourceLinks.js')
  const raw = host.render(SLACK_APP_MD, m.sourceLinkUi.decorateSourceLinks)
  assert.match(raw, /\[blocked\]/, 'reproduced: the sanitizer drops a raw slack:// link')
  const html = host.render(protectSlackAppLinks(SLACK_APP_MD), m.sourceLinkUi.decorateSourceLinks)
  assert.doesNotMatch(html, /\[blocked\]/)
  assert.match(html, /<a class="gbo-src"[^>]*data-service="slack"/)
  assert.match(html, /<span class="gbo-src-text">Her message<\/span>/)
})

test('SL24-02: a click tries the exact message deep link first; refused, it opens the channel page', { skip }, async t => {
  const calls = await stubOpener(t, ['slack:'])
  const box = await mount(t, SLACK_APP_MD)
  click(box.querySelector('a.gbo-src'))
  await flush()
  assert.deepEqual(calls, [SLACK_APP, 'https://app.slack.com/client/T0EXAMPLE1/C0123ABCD'])
})

test('SL24-02: an opener that admits slack: opens the message itself and nothing else', { skip }, async t => {
  const calls = await stubOpener(t, [])
  const box = await mount(t, SLACK_APP_MD)
  click(box.querySelector('a.gbo-src'))
  await flush()
  assert.deepEqual(calls, [SLACK_APP])
})

test('SL24-02: invalid or unsupported slack:// links stay inert; inline code is untouched', async () => {
  const { protectSlackAppLinks, sourceLinkFor } = await import('../src/core/sourceLinks.js')
  for (const md of ['[x](slack://channel?id=C0123ABCD)', '[x](slack://file?team=T0EXAMPLE1&id=F1)', '[x](slack://channel?team=bad&id=C0123ABCD)']) {
    assert.equal(protectSlackAppLinks(md), md, md)
  }
  const code = `\`${SLACK_APP_MD}\` and \`\`a ${SLACK_APP_MD} b\`\``
  assert.equal(protectSlackAppLinks(code), code)
  // A forged stand-in only ever yields the validated Slack link.
  const forged = 'https://app.slack.com/client/T0EXAMPLE1/C0123ABCD#gbo-slack-app=javascript%3Aalert(1)'
  assert.deepEqual(sourceLinkFor(forged).opens, [forged], 'a forged stand-in opens only its own https page')
  assert.equal(sourceLinkFor('https://app.slack.com.evil.io/client/T0EXAMPLE1/C0123ABCD#gbo-slack-app=' + encodeURIComponent(SLACK_APP))?.service.id, 'web')
})

// ---- SL24-03: the bare-URL hold never hides text inside inline code ----

test('SL24-03: a URL inside a double-backtick or multi-line code span shows as it types', async () => {
  const { streamSafe, streamSafeParts } = await import('../src/core/streamSafe.js')
  assert.equal(streamSafe('See ``code https://example.com/path'), 'See ``code https://example.com/path``')
  assert.equal(streamSafe('See `one\nhttps://example.com/path'), 'See `one\nhttps://example.com/path`')
  assert.equal(streamSafe('See `code https://example.com/pa'), 'See `code https://example.com/pa`')
  assert.equal(streamSafeParts('See ``code https://example.com/path').held, '')
  // Outside code it is still held, also after a closed span.
  assert.equal(streamSafe('See ``a`` https://example.com/pa'), 'See ``a`` ')
  assert.equal(streamSafe('See `one`\nhttps://example.com/pa'), 'See `one`\n')
})

// ---- SL24-04: a complete angle autolink is complete ----

test('SL24-04: <https://…> shows once its > arrives; while typing, the whole construct waits, never a raw <', async () => {
  const { streamSafe, streamSafeParts } = await import('../src/core/streamSafe.js')
  const done = 'See <https://github.com/example/repo/pull/12>'
  assert.deepEqual(streamSafeParts(done), { text: done, held: '', directive: false })
  for (let i = 'See '.length + 1; i < done.length; i += 1) {
    assert.equal(streamSafe(done.slice(0, i)), 'See ', JSON.stringify(done.slice(0, i)))
  }
})

test('SL24-04: in the host pipeline the last streaming tick of a closed angle autolink draws the finished chip', { skip: skipHost }, async t => {
  const { m } = await setup(t)
  const { streamSafe } = await import('../src/core/streamSafe.js')
  const done = 'See <https://github.com/example/repo/pull/12>'
  const finished = host.render(done, m.sourceLinkUi.decorateSourceLinks)
  assert.match(finished, /data-service="github"/)
  assert.equal(host.render(streamSafe(done), m.sourceLinkUi.decorateSourceLinks), finished)
  assert.doesNotMatch(host.render(streamSafe(done.slice(0, -5)), m.sourceLinkUi.decorateSourceLinks), /&lt;/, 'no raw < while it types')
})
