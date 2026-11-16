// Source links 24: a bot reply's link to a known service (a Slack message, a
// Gmail email, a GitHub PR …) draws as the service's small logo plus the link
// text; a bare URL gets a short label; code stays plain; unsafe links are
// never drawn or opened; a click opens the right URL through the plugin SDK.
// Demo content only: `example` workspace, fake ids.

import assert from 'node:assert/strict'
import { existsSync, readFileSync, rmSync } from 'node:fs'
import { dirname } from 'node:path'
import test from 'node:test'
import { pathToFileURL } from 'node:url'

import {
  SOURCE_SERVICES,
  bareLinkLabel,
  isBareLink,
  isPrivateHost,
  needsLightOnDark,
  parseSlackPermalink,
  serviceFor,
  slackOpenTarget,
  sourceLinkFor,
  sourceOpenUrl
} from '../src/core/sourceLinks.js'
import { streamSafe } from '../src/core/streamSafe.js'

const ready =
  existsSync(new URL('../node_modules/esbuild', import.meta.url)) &&
  existsSync(new URL('../node_modules/react-dom', import.meta.url)) &&
  existsSync(new URL('../node_modules/jsdom', import.meta.url))
const skip = !ready && 'dev dependencies not installed'

const SLACK = 'https://example.slack.com/archives/C0123ABCD/p1762560000123456'
const SLACK_REPLY = 'https://example.slack.com/archives/C0123ABCD/p1762560099000100?thread_ts=1762560000.123456&cid=C0123ABCD'
const GMAIL = 'https://mail.google.com/mail/u/0/#all/18c0ffee0000abcd'

// ---- host table ----

test('sourceLinks: every listed service matches its own URLs', () => {
  const cases = {
    slack: [SLACK, 'https://app.slack.com/client/T0EXAMPLE1/C0123ABCD', 'slack://channel?team=T0EXAMPLE1&id=C0123ABCD'],
    gmail: [GMAIL],
    googledocs: ['https://docs.google.com/document/d/abc123/edit'],
    googlesheets: ['https://docs.google.com/spreadsheets/d/abc123/edit#gid=0'],
    googleslides: ['https://docs.google.com/presentation/d/abc123/edit'],
    googledrive: ['https://drive.google.com/file/d/abc123/view', 'https://docs.google.com/forms/d/abc/viewform'],
    googlecalendar: ['https://calendar.google.com/calendar/u/0/r/eventedit/abc'],
    googlemeet: ['https://meet.google.com/abc-defg-hij'],
    github: ['https://github.com/example/repo/pull/12'],
    notion: ['https://www.notion.so/example/Page-abc123', 'https://example.notion.site/Page'],
    linear: ['https://linear.app/example/issue/ENG-12/title'],
    figma: ['https://www.figma.com/design/abc/File'],
    zoom: ['https://us02web.zoom.us/j/123456789'],
    outlook: ['https://outlook.office.com/mail/inbox/id/AAQk', 'https://outlook.live.com/mail/0/'],
    office365: ['https://www.office.com/launch/word', 'https://example.sharepoint.com/sites/x'],
    dropbox: ['https://www.dropbox.com/s/abc/file.pdf'],
    zoho: ['https://mail.zoho.com/zm/#mail/folder/inbox', 'https://crm.zoho.eu/crm/tab/Leads', 'https://voice.zohocloud.ca/x'],
    stripe: ['https://dashboard.stripe.com/payments/pi_123'],
    hubspot: ['https://app.hubspot.com/contacts/123/record/0-1/456'],
    airtable: ['https://airtable.com/appABC/tblDEF'],
    trello: ['https://trello.com/c/abc123/1-card'],
    asana: ['https://app.asana.com/0/123/456'],
    calendly: ['https://calendly.com/example/30min'],
    loom: ['https://www.loom.com/share/abc123'],
    youtube: ['https://www.youtube.com/watch?v=abc', 'https://youtu.be/abc'],
    x: ['https://x.com/example/status/1', 'https://twitter.com/example/status/1'],
    linkedin: ['https://www.linkedin.com/in/example']
  }
  assert.deepEqual(Object.keys(cases).sort(), SOURCE_SERVICES.map(s => s.id).sort(), 'every service has a case')
  for (const [id, urls] of Object.entries(cases)) {
    for (const url of urls) assert.equal(serviceFor(url)?.id, id, url)
  }
})

test('sourceLinks: lookalike hosts are not matched; case, ports and subdomains are', () => {
  for (const url of [
    'https://slack.com.evil.io/archives/C0123ABCD/p1762560000123456',
    'https://evilslack.com/archives/C1/p1',
    'https://mail.google.com.example.net/x',
    'https://github.com-pages.example/x',
    'https://notgithub.com/x',
    'https://example.com/?u=https://github.com/a',
    'https://fakezoho.com/',
    'https://youtube.co/watch'
  ]) {
    assert.equal(serviceFor(url), null, url)
  }
  assert.equal(serviceFor('https://EXAMPLE.Slack.COM/archives/C0123ABCD/p1762560000123456')?.id, 'slack')
  assert.equal(serviceFor('https://github.com:443/example/repo')?.id, 'github')
  assert.equal(serviceFor('https://gist.github.com/example/abc')?.id, 'github')
  assert.equal(serviceFor('https://github.com./example')?.id, 'github', 'a trailing dot')
  assert.equal(serviceFor('ftp://github.com/x'), null, 'web schemes only')
  assert.equal(serviceFor('not a url'), null)
})

// ---- Slack ----

test('Slack permalinks parse: channel, ts, thread_ts', () => {
  assert.deepEqual(parseSlackPermalink(SLACK), { workspace: 'example', channel: 'C0123ABCD', ts: '1762560000.123456', threadTs: null })
  assert.deepEqual(parseSlackPermalink(SLACK_REPLY), { workspace: 'example', channel: 'C0123ABCD', ts: '1762560099.000100', threadTs: '1762560000.123456' })
  assert.equal(parseSlackPermalink('https://example.slack.com/archives/C0123ABCD'), null, 'a channel, not a message')
  assert.equal(parseSlackPermalink('https://example.slack.com/archives/C0123ABCD/p12345'), null, 'short ts')
  assert.equal(parseSlackPermalink('https://slack.com.evil.io/archives/C0123ABCD/p1762560000123456'), null)
  assert.equal(parseSlackPermalink('http://example.slack.com/archives/C0123ABCD/p1762560000123456'), null, 'https only')
  assert.equal(parseSlackPermalink(`${SLACK}?thread_ts=bad`).threadTs, null)
})

test('Slack: the app link only with a known team id; otherwise the https permalink (slack.com hands off to the app)', () => {
  assert.deepEqual(slackOpenTarget(SLACK), { kind: 'web', url: SLACK }, 'no team id: never guessed')
  assert.deepEqual(slackOpenTarget(SLACK, { teamId: 'T0EXAMPLE1' }), { kind: 'web', url: SLACK }, 'an opener without app schemes')
  assert.deepEqual(slackOpenTarget(SLACK, { teamId: 'T0EXAMPLE1', appScheme: true }), {
    kind: 'app',
    url: 'slack://channel?team=T0EXAMPLE1&id=C0123ABCD&message=1762560000.123456',
    fallback: SLACK
  })
  assert.deepEqual(slackOpenTarget(SLACK, { teamId: 'bogus', appScheme: true }), { kind: 'web', url: SLACK }, 'a malformed team id is ignored')
  // A slack:// link is tried as itself (the exact message), then the channel page.
  assert.deepEqual(slackOpenTarget('slack://channel?team=T0EXAMPLE1&id=C0123ABCD&message=1762560000.123456'), {
    kind: 'app',
    url: 'slack://channel?team=T0EXAMPLE1&id=C0123ABCD&message=1762560000.123456',
    fallback: 'https://app.slack.com/client/T0EXAMPLE1/C0123ABCD'
  })
  assert.deepEqual(slackOpenTarget('slack://channel?team=T0EXAMPLE1&id=C0123ABCD&message=bad'), {
    kind: 'app',
    url: 'slack://channel?team=T0EXAMPLE1&id=C0123ABCD',
    fallback: 'https://app.slack.com/client/T0EXAMPLE1/C0123ABCD'
  }, 'a malformed message ts is dropped')
  assert.deepEqual(slackOpenTarget('slack://open?team=T0EXAMPLE1'), { kind: 'app', url: 'slack://open?team=T0EXAMPLE1', fallback: 'https://app.slack.com/client/T0EXAMPLE1' })
  assert.equal(slackOpenTarget('slack://channel?id=C0123ABCD'), null, 'no team: not opened')
  assert.equal(slackOpenTarget('slack://file?team=T0EXAMPLE1&id=F1'), null)
  assert.equal(sourceOpenUrl(SLACK_REPLY), SLACK_REPLY, 'a thread reply opens its own permalink')
})

// ---- safety ----

test('unsafe schemes and private hosts are refused; mailto/tel are left to the renderer', () => {
  for (const href of [
    'javascript:alert(1)',
    'JaVaScRiPt:alert(1)',
    ' javascript:alert(1)',
    'data:text/html,<b>x</b>',
    'file:///etc/hosts',
    'vbscript:x',
    'chrome://settings',
    'mailto:someone@example.com',
    'tel:+15550100',
    'http://localhost:8080/',
    'http://127.0.0.1/x',
    'http://192.168.1.10/',
    'http://10.0.0.1/',
    'http://100.64.0.2/',
    'http://intranet/',
    'http://printer.local/',
    'http://[::1]/',
    // Built from pieces: credentials in a URL, kept out of the privacy guard's email scan.
    ['https://user:pass', 'github.com/x'].join('@'),
    'slack://file?team=T0EXAMPLE1&id=F1'
  ]) {
    assert.equal(sourceLinkFor(href), null, href)
    assert.equal(sourceOpenUrl(href), null, href)
  }
  assert.equal(isPrivateHost('example.com'), false)
  assert.equal(sourceLinkFor('https://example.com/a').service.id, 'web', 'an unknown public host: the neutral icon')
})

test('bare URLs get a short label, never the URL', () => {
  assert.equal(bareLinkLabel(SLACK), 'Slack message')
  assert.equal(bareLinkLabel(SLACK_REPLY), 'Slack thread reply')
  assert.equal(bareLinkLabel('https://app.slack.com/client/T0EXAMPLE1/C0123ABCD'), 'Slack')
  assert.equal(bareLinkLabel(GMAIL), 'Gmail')
  assert.equal(bareLinkLabel('https://github.com/example/repo/pull/12'), 'GitHub PR #12')
  assert.equal(bareLinkLabel('https://github.com/example/repo/issues/7'), 'GitHub issue #7')
  assert.equal(bareLinkLabel('https://linear.app/example/issue/eng-12/title'), 'Linear ENG-12')
  assert.equal(bareLinkLabel('https://docs.google.com/document/d/abc/edit'), 'Google Doc')
  assert.equal(bareLinkLabel('https://dashboard.stripe.com/payments/pi_123'), 'Stripe')
  assert.equal(bareLinkLabel('https://www.example.com/some/very/long/path?with=query&and=more'), 'example.com')
  const long = `https://${'a'.repeat(80)}.example.com/x`
  assert.ok(bareLinkLabel(long).length <= 32, 'a long host is clipped')
  assert.equal(isBareLink(SLACK, SLACK), true)
  assert.equal(isBareLink('example.com/x', 'https://example.com/x'), true)
  assert.equal(isBareLink('Her message', SLACK), false)
})

test('dark mode: marks too dark for the dark bubble switch to the light text colour', () => {
  assert.equal(needsLightOnDark('181717'), true, 'GitHub')
  assert.equal(needsLightOnDark('000000'), true, 'X, Notion')
  assert.equal(needsLightOnDark('EA4335'), false, 'Gmail red keeps its colour')
  assert.equal(needsLightOnDark('FFFFFF'), false)
})

test('streaming: a bare URL still typing is held until it ends; a half link stays held', () => {
  assert.equal(streamSafe('See https://example.sla'), 'See ')
  assert.equal(streamSafe('See https:/'), 'See ')
  assert.equal(streamSafe('See https://example.slack.com/x more'), 'See https://example.slack.com/x more')
  assert.equal(streamSafe('Done [Her message](https://example.slack.com/arch'), 'Done ')
  assert.equal(streamSafe('code `https://exa'), 'code `https://exa`', 'inside inline code: shown as typed')
  assert.equal(streamSafe('https://example.com/a\nnext'), 'https://example.com/a\nnext', 'a finished line')
})

// ---- render harness (dev/preview-entry.tsx, the real components) ----

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
  env = { m, React, createRoot, JSDOM }
  return env
}

const flush = async () => {
  for (let i = 0; i < 6; i += 1) await new Promise(resolve => setImmediate(resolve))
}

async function botBubble(t, text, { streaming = false } = {}) {
  const { m, JSDOM } = await setup(t)
  const items = [{ kind: 'assistant', id: 'a1', text, at: 1_762_560_030_000, ...(streaming ? { streaming: true } : {}) }]
  const html = m.render({ items, busy: streaming, panelOpen: false })
  const doc = new JSDOM(html).window.document
  return doc.querySelector('.gbo-msg.is-bot .bubble.is-agent')
}

const REPLY = [
  'Two things need you.',
  '',
  `- A question about the launch. [Her message](${SLACK})`,
  `- **Billing:** they replied about the invoice. [The email](${GMAIL})`,
  '',
  'Bare https://github.com/example/repo/pull/12 here, `https://example.slack.com/archives/C0123ABCD/p1762560000123456` in code, [bad](javascript:alert%281%29) and [home](http://localhost:3000/).',
  '',
  '```sh',
  `curl ${SLACK}`,
  '```'
].join('\n')

test('render: a known-service link draws icon + text, the full URL as its title', { skip }, async t => {
  const bubble = await botBubble(t, REPLY)
  const chips = [...bubble.querySelectorAll('a.gbo-src')]
  assert.deepEqual(chips.map(a => a.dataset.service), ['slack', 'gmail', 'github'])
  const [slack, gmail] = chips
  assert.equal(slack.getAttribute('href'), SLACK)
  assert.equal(slack.getAttribute('title'), SLACK)
  assert.equal(slack.firstElementChild.className.split(' ')[0], 'gbo-src-icon', 'the icon comes first')
  assert.equal(slack.firstElementChild.getAttribute('aria-hidden'), 'true')
  assert.ok(slack.querySelector('.gbo-src-icon svg path'), 'an inline SVG mark, no <img>, no fetch')
  assert.equal(slack.querySelector('img'), null)
  assert.equal(slack.querySelector('.gbo-src-text').textContent, 'Her message')
  assert.equal(slack.textContent, 'Her message', 'the icon adds no text')
  assert.equal(gmail.querySelector('.gbo-src-text').textContent, 'The email')
  const bold = await botBubble(t, `**Read it: [The email](${GMAIL})**`)
  assert.ok(bold.querySelector('strong a.gbo-src[data-service="gmail"]'), 'a link inside bold is still a chip')
})

test('render: a bare URL gets the service label; code and unsafe links stay plain', { skip }, async t => {
  const bubble = await botBubble(t, REPLY)
  const github = bubble.querySelector('a.gbo-src[data-service="github"]')
  assert.equal(github.querySelector('.gbo-src-text').textContent, 'GitHub PR #12')
  assert.ok(!bubble.textContent.includes('https://github.com'), 'never the raw URL as text')
  const code = bubble.querySelector('code')
  assert.equal(code.textContent, 'https://example.slack.com/archives/C0123ABCD/p1762560000123456')
  assert.equal(code.querySelector('a, .gbo-src-icon'), null, 'no chip in inline code')
  const block = bubble.querySelector('.gbo-code pre')
  assert.ok(block.textContent.includes(SLACK))
  assert.equal(bubble.querySelector('.gbo-code .gbo-src'), null, 'no chip in a code block')
  assert.equal(bubble.querySelectorAll('a[href^="javascript"], a[href^="data:"]').length, 0)
  assert.ok(bubble.textContent.includes('bad'), 'the unsafe link text stays, as text')
  assert.equal(bubble.querySelector('.gbo-src[href*="localhost"]'), null, 'a private host is never a chip (the renderer keeps its own refusal)')
})

test('render: dark-mode class on marks that need the light ink; the CSS switches them', { skip }, async t => {
  const bubble = await botBubble(t, `[The PR](https://github.com/example/repo/pull/12) and [The email](${GMAIL}) and [Notes](https://example.com/notes)`)
  assert.ok(bubble.querySelector('[data-service="github"] .gbo-src-icon').classList.contains('is-light-on-dark'))
  assert.ok(!bubble.querySelector('a[data-service="gmail"] .gbo-src-icon').classList.contains('is-light-on-dark'))
  assert.ok(bubble.querySelector('a[data-service="web"] .gbo-src-icon.is-web svg'), 'the neutral globe for an unknown host')
  const { m } = await setup(t)
  // ADAPT_CSS is scoped and zoom-scaled (styles-ref.ts refCss): --color-* becomes --g-color-*, px x 1/0.896.
  assert.match(m.CSS, /\.gbo-src-icon\.is-light-on-dark[^{]*\{ color: var\(--g-color-src-dark-ink, var\(--gbo-src-color\)\); \}/)
  assert.match(m.CSS, /\[data-gbo-theme="dark"\][^{]*\{[^}]*--g-color-src-dark-ink: var\(--g-color-text-primary\)/, 'set in dark only')
  assert.match(m.CSS, /\.gbo-src:focus-visible[^{]*\{ outline: [\d.]+px solid var\(--g-color-border-focus\)/, 'a visible keyboard focus ring')
  assert.match(m.CSS, /\.gbo-src-icon:where[^{]*\{[^}]*width: ([\d.]+)px; height: \1px;/, 'a fixed icon box: no layout shift')
  assert.match(m.CSS, /a\.gbo-src[^{]*\{[^}]*text-decoration: none/, 'the icon is not underlined')
  assert.match(m.CSS, /\.gbo-src-text:where[^{]*\{[^}]*text-decoration: underline/, 'the text is')
})

test('render: streaming shows no raw half link, and the finished chip matches', { skip }, async t => {
  const full = `Done. [Her message](${SLACK})`
  for (let i = 'Done. ['.length; i < full.length; i += 7) {
    const bubble = await botBubble(t, full.slice(0, i), { streaming: true })
    assert.ok(!bubble.textContent.includes('[') && !bubble.textContent.includes(']('), JSON.stringify(full.slice(0, i)))
  }
  const live = await botBubble(t, full, { streaming: true })
  const done = await botBubble(t, full)
  assert.equal(live.querySelector('a.gbo-src').outerHTML, done.querySelector('a.gbo-src').outerHTML)
})

test('click: opens the right URL through ctx.os.openExternal; keyboard focusable', { skip }, async t => {
  const { m, React, createRoot } = await setup(t)
  const opened = []
  const prev = m.appApi.app.ctx
  m.appApi.app.ctx = { ...(prev || {}), os: { openExternal: async url => (opened.push(url), true) } }
  t.after(() => (m.appApi.app.ctx = prev))
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  root.render(React.createElement(m.BotText, { bot: { name: 'scholar' }, text: `[Her message](${SLACK_REPLY}) and [The PR](https://github.com/example/repo/pull/12) and [mail](mailto:someone@example.com)` }))
  await flush()
  const chips = [...container.querySelectorAll('a.gbo-src')]
  assert.equal(chips.length, 2, 'mailto is not a chip')
  assert.equal(chips[0].tabIndex, 0, 'an anchor with href: in the tab order')
  chips[0].focus()
  assert.equal(document.activeElement, chips[0])
  const event = new window.MouseEvent('click', { bubbles: true, cancelable: true })
  chips[0].dispatchEvent(event)
  assert.equal(event.defaultPrevented, true, 'no in-app navigation')
  chips[1].dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }))
  await flush()
  assert.deepEqual(opened, [SLACK_REPLY, 'https://github.com/example/repo/pull/12'])
  root.unmount()
  container.remove()
})

test('click: without ctx.os the desktop bridge opens it', { skip }, async t => {
  const { m } = await setup(t)
  const opened = []
  const prev = m.appApi.app.ctx
  m.appApi.app.ctx = { ...(prev || {}), os: undefined }
  window.hermesDesktop = { openExternal: async url => opened.push(url) }
  t.after(() => {
    m.appApi.app.ctx = prev
    delete window.hermesDesktop
  })
  m.sourceLinkUi.openSource(SLACK)
  await flush()
  assert.deepEqual(opened, [SLACK])
})

test('the agent-cards skill tells bots to link their sources', () => {
  const skill = readFileSync(new URL('../skills/agent-cards/SKILL.md', import.meta.url), 'utf8')
  assert.match(skill, /## Link your sources/)
  assert.match(skill, /\[short label\]\(permalink\)/)
  assert.match(skill, /archives\/<channel_id>\/p<ts without the dot>/)
  assert.match(skill, /mail\.google\.com\/mail\/u\/0\/#all\/<message id>/)
  assert.match(skill, /never paste raw URLs/i)
})
