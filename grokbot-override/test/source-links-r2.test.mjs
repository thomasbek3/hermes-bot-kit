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

// ---- SL24-05: enhancement follows the host's deferred commits ----

test('SL24-05: a heading link that first appears in a deferred final commit is enhanced', { skip }, async t => {
  const { container, draw } = await mountProse(t, '## Read ', { defer: true })
  draw('## Read [The PR](https://github.com/example/repo/pull/12)')
  await settle()
  const a = container.querySelector('h2 a[href]')
  assert.ok(a, 'the link drew')
  assert.equal(a.getAttribute('data-service'), 'github')
  assert.equal(a.querySelectorAll('[data-gbo-src-icon]').length, 1)
  assert.equal(a.title, 'https://github.com/example/repo/pull/12')
})

test('SL24-05: a reused heading anchor that changes destination, then label, is re-decorated', { skip }, async t => {
  const { container, draw } = await mountProse(t, '## Read [The PR](https://github.com/example/repo/pull/12)', { defer: true })
  draw('## Read [The PR](https://docs.google.com/document/d/abc/edit)')
  await settle()
  let a = container.querySelector('h2 a[href]')
  assert.equal(a.getAttribute('data-service'), 'googledocs')
  assert.equal(a.title, 'https://docs.google.com/document/d/abc/edit')
  assert.deepEqual([...a.querySelectorAll('[data-gbo-src-icon]')].map(n => n.getAttribute('data-service')), ['googledocs'])
  draw('## Read [The doc](https://docs.google.com/document/d/abc/edit)')
  await settle()
  a = container.querySelector('h2 a[href]')
  assert.equal(a.textContent, 'The doc')
  assert.equal(a.querySelectorAll('[data-gbo-src-icon]').length, 1, 'the logo comes back after the text changes')
  // A destination that is no longer a source link (an intranet host the
  // renderer still draws as a link) loses the decoration.
  draw('## Read [The doc](https://wiki.corp/page)')
  await settle()
  a = container.querySelector('h2 a[href]')
  assert.equal(a.querySelectorAll('[data-gbo-src-icon]').length, 0)
  assert.equal(a.getAttribute('data-service'), null)
})

test('SL24-05: a table-header link added in a deferred commit is enhanced', { skip }, async t => {
  const { container, draw } = await mountProse(t, 'Table:', { defer: true })
  draw('Table:\n\n| [The doc](https://docs.google.com/document/d/abc/edit) | b |\n|---|---|\n| c | d |')
  await settle()
  const th = container.querySelector('th a[href]')
  assert.equal(th.getAttribute('data-service'), 'googledocs')
  assert.equal(th.querySelectorAll('[data-gbo-src-icon]').length, 1)
})

// ---- SL24-06: the Slack rewrite never touches code or escaped text ----

const SLACK_LINK = `[Her message](${SLACK_APP})`

test('SL24-06: escaped backticks, indented code and escaped brackets stay exactly as written', () => {
  for (const text of [
    `Escaped \\\` and code \`${SLACK_LINK}\``,
    `Example:\n\n    ${SLACK_LINK}\n`,
    `\\${SLACK_LINK}`,
    `\`\`a ${SLACK_LINK} b\`\``
  ]) {
    assert.equal(protectSlackAppLinks(text), text, JSON.stringify(text))
  }
  // A real link next to escaped text and code is still carried.
  const mixed = `\\\` then ${SLACK_LINK}`
  assert.notEqual(protectSlackAppLinks(mixed), mixed)
  // An indented line inside a list is a list continuation, not code.
  assert.notEqual(protectSlackAppLinks(`- item\n\n    ${SLACK_LINK}`), `- item\n\n    ${SLACK_LINK}`)
})

test('SL24-06: in the host pipeline the displayed code text is the original', { skip: skipHost }, async t => {
  const { m } = await setup(t)
  const text = `Escaped \\\` and code \`${SLACK_LINK}\``
  const html = host.render(protectSlackAppLinks(text), m.sourceLinkUi.decorateSourceLinks)
  const code = /<code[^>]*>([\s\S]*?)<\/code>/.exec(html)?.[1]
  assert.equal(code, SLACK_LINK.replace(/&/g, '&amp;'), html)
  assert.doesNotMatch(html, /gbo-slack-app/)
  const indented = host.render(protectSlackAppLinks(`Example:\n\n    ${SLACK_LINK}\n`), m.sourceLinkUi.decorateSourceLinks)
  assert.match(indented, /<pre/, 'an indented code block')
  assert.doesNotMatch(indented, /gbo-slack-app/)
})

// ---- SL24-07: every valid Markdown link form with a Slack app destination ----

const FORMS = {
  title: `[Her message](${SLACK_APP} "Message title")`,
  angle: `[Her message](<${SLACK_APP}>)`,
  upper: `[Her message](${SLACK_APP.replace('slack:', 'SLACK:')})`,
  reference: `[Her message][msg]\n\n[msg]: ${SLACK_APP}`
}

test('SL24-07: titled, angle, upper-case and reference Slack links are carried; titles kept', () => {
  for (const [name, text] of Object.entries(FORMS)) {
    const out = protectSlackAppLinks(text)
    assert.notEqual(out, text, name)
    assert.match(out, /https:\/\/app\.slack\.com\/client\/T0EXAMPLE1\/C0123ABCD#gbo-slack-app=/, name)
  }
  assert.match(protectSlackAppLinks(FORMS.title), /"Message title"\)$/)
  assert.match(protectSlackAppLinks(FORMS.angle), /^\[Her message\]\(<https:[^>]+>\)$/)
})

test('SL24-07: in the host pipeline every form draws a Slack chip, never [blocked]', { skip: skipHost }, async t => {
  const { m } = await setup(t)
  for (const [name, text] of Object.entries(FORMS)) {
    const html = host.render(protectSlackAppLinks(text), m.sourceLinkUi.decorateSourceLinks)
    assert.doesNotMatch(html, /\[blocked\]/, name)
    assert.match(html, /<a class="gbo-src"[^>]*data-service="slack"/, name)
    assert.match(html, /<span class="gbo-src-text">Her message<\/span>/, name)
  }
})

// ---- SL24-08: bare URLs in headings and table headers get the short label ----

test('SL24-08: a long bare URL in a heading shows the short label, the full URL only as the title', { skip }, async t => {
  const { container } = await mountProse(t, `## See ${LONG_BARE}`)
  const a = container.querySelector('h2 a[href]')
  assert.ok(LONG_BARE.length > 200)
  assert.equal(a.querySelector('.gbo-src-label').textContent, 'GitHub example/repo')
  assert.equal(a.getAttribute('aria-label'), 'GitHub example/repo')
  assert.equal(a.title, LONG_BARE)
  // React's URL text stays where React put it (never moved), hidden by CSS.
  assert.ok(a.classList.contains('is-bare'))
  assert.ok([...a.childNodes].some(n => n.nodeType === 3 && n.textContent === LONG_BARE), 'the host text node is untouched')
  assert.equal(a.querySelector('.gbo-src-label').getAttribute('aria-hidden'), 'true')
  const { m } = await setup(t)
  assert.match(m.CSS, /a\.gbo-src-host\.is-bare[^{]*\{ font-size: 0; \}/, 'the URL text is not shown')
  assert.match(m.CSS, /a\.gbo-src-host\.is-bare[^{]*\.gbo-src-label[^{]*\{ font-size: var\(--gbo-src-label-size/)
})

test('SL24-08: a bare URL in a table header gets the short label; an explicit label is kept', { skip }, async t => {
  const { container } = await mountProse(t, `| ${LONG_BARE} | [The PR](https://github.com/example/repo/pull/12) |\n|---|---|\n| a | b |`)
  const [bare, named] = container.querySelectorAll('th a[href]')
  assert.equal(bare.querySelector('.gbo-src-label').textContent, 'GitHub example/repo')
  assert.equal(named.querySelector('.gbo-src-label'), null)
  assert.equal(named.textContent, 'The PR')
})

test('SL24-08: the short label survives a deferred update of the same bare heading URL', { skip }, async t => {
  const { container, draw } = await mountProse(t, `## See ${LONG_BARE}`, { defer: true })
  draw(`## See ${LONG_BARE.replace('file.md', 'other.md')}`)
  await settle()
  const a = container.querySelector('h2 a[href]')
  assert.equal(a.querySelector('.gbo-src-label').textContent, 'GitHub example/repo')
  assert.equal(a.title, LONG_BARE.replace('file.md', 'other.md'))
  assert.equal(a.querySelectorAll('.gbo-src-label').length, 1)
})

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
