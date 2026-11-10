// Cards 7, part 3: `::card{…}` and `::preview{…}` render live in the open
// Bot Chat, from the bot's own session on its own machine; everywhere else
// they stay inert text.

import assert from 'node:assert/strict'
import test from 'node:test'

import {
  cardFromRead,
  isFinalCard,
  parseDirectiveAttrs,
  previewDocument,
  previewHeightFrom,
  previewIntentFrom,
  previewIntentRoute,
  previewPrelude,
  PREVIEW_CSP,
  previewStartHeight,
  splitDirectives,
  validateCard,
  workspaceReadRequest,
  workspaceRelPath
} from '../src/core/directives.js'
import { createChatController } from '../src/core/session.js'
import { BOT, gateway } from './harness.mjs'
import { bootPlugin, READY, waitFor } from './loader-boot.mjs'

const CARD = {
  schema: 'card.v1',
  kind: 'approval',
  title: 'Send the weekly note?',
  status: { state: 'awaiting-approval' },
  body: [{ type: 'text', text: 'Three paragraphs, ready to go.' }, { type: 'kv', rows: [['To', 'team@example.com']] }],
  actions: [
    { label: 'Send it', style: 'primary', send: 'APPROVE c-1a2b send the note' },
    { label: 'Hold', send: 'HOLD c-1a2b' }
  ]
}

test('directive grammar: claimed names only, outside code, quoted or bare attributes', () => {
  assert.deepEqual(parseDirectiveAttrs('id="c-1" kind=\'task\' file=cards/c-1.json height=300'), { id: 'c-1', kind: 'task', file: 'cards/c-1.json', height: '300' })
  assert.equal(splitDirectives('no directives here'), null)
  assert.equal(splitDirectives('std::vector{int} and ::other{a="b"}'), null, 'unclaimed or not at a word start: prose')
  assert.equal(splitDirectives('```\n::card{file="cards/a.json"}\n```'), null, 'inside a fence: prose')
  assert.equal(splitDirectives('write `::preview{file="x.html"}` on its own line'), null, 'inline code: prose')
  const parts = splitDirectives('Here is the draft.\n\n::card{id="c-1" kind="approval" file="cards/c-1.json"}\n\nAnd a chart: ::preview{file=chart.html}')
  assert.deepEqual(parts.map(p => p.kind), ['prose', 'directive', 'prose', 'directive'])
  assert.equal(parts[0].text, 'Here is the draft.')
  assert.deepEqual(parts[1].attrs, { id: 'c-1', kind: 'approval', file: 'cards/c-1.json' })
  assert.equal(parts[2].text, 'And a chart:')
  assert.equal(parts[3].name, 'preview')
  assert.equal(parts[3].attrs.file, 'chart.html')
})

test('workspace paths stay inside the session workspace', () => {
  assert.equal(workspaceRelPath('cards/c-1.json'), 'cards/c-1.json')
  assert.equal(workspaceRelPath('./cards//c-1.json'), 'cards/c-1.json')
  for (const bad of ['/etc/passwd', '~/x', '../x', 'cards/../../x', 'file:///x', 'https://x', 'C:\\x', '', 7]) assert.equal(workspaceRelPath(bad), null, String(bad))
  assert.deepEqual(workspaceReadRequest('cards/c 1.json', 'k-tip', { connectionId: 'home-server', profile: 'scholar' }), {
    path: '/api/fs/read-text?path=cards%2Fc%201.json&session_id=k-tip',
    timeoutMs: 5000,
    connectionId: 'home-server',
    profile: 'scholar'
  })
})

test('card.v1: validated as the skill defines it; final when resolved, done or failed', () => {
  const card = validateCard(CARD)
  assert.equal(card.kind, 'approval')
  assert.equal(card.actions.length, 2)
  assert.equal(card.actions[1].style, 'default')
  assert.equal(isFinalCard(card), false)
  assert.equal(isFinalCard(validateCard({ ...CARD, resolved: { action: 'Send it', at: '2026-11-09T10:00:00Z' } })), true)
  assert.equal(isFinalCard(validateCard({ ...CARD, status: { state: 'done' } })), true)
  assert.equal(validateCard({ ...CARD, schema: 'card.v2' }), null)
  assert.equal(validateCard({ ...CARD, kind: 'poll' }), null)
  assert.equal(validateCard({ ...CARD, actions: Array(5).fill({ label: 'x', send: 'y' }) }).actions.length, 3)
  assert.equal(validateCard({ ...CARD, actions: [{ label: 'x', send: 'z'.repeat(900) }] }).actions[0].send.length, 500)
  assert.deepEqual(cardFromRead({ text: '{', binary: false }), { ok: false, reason: 'json' })
  assert.deepEqual(cardFromRead({ text: JSON.stringify(CARD), truncated: true }), { ok: false, reason: 'too-large' })
  assert.equal(cardFromRead({ text: JSON.stringify(CARD) }).ok, true)
})

test('preview frame: prelude first, script before </body>, token-gated size and intents', () => {
  const prelude = previewPrelude({ '--foreground': '#fff', '--bad': 'x}</style><script>' }, 'Inter', 'dark')
  assert.ok(prelude.includes('color-scheme:dark') && prelude.includes('--foreground:#fff') && !prelude.includes('<script>'))
  const doc = previewDocument('<html><body><p>hi</p></body></html>', 'tok', prelude)
  assert.ok(doc.startsWith('<meta http-equiv="Content-Security-Policy"'), 'the CSP comes before anything the page says')
  assert.ok(doc.indexOf('<style>') < doc.indexOf('<p>hi</p>'))
  assert.ok(doc.indexOf('<script>') < doc.indexOf('</body>'))
  assert.ok(doc.includes('"tok"') && doc.includes('window.hermes'))
  assert.equal(previewHeightFrom({ type: 'hermes-inline-preview-size', token: 'tok', height: 50 }, 'tok'), 120)
  assert.equal(previewHeightFrom({ type: 'hermes-inline-preview-size', token: 'other', height: 300 }, 'tok'), null)
  assert.equal(previewStartHeight('5000'), 1200)
  assert.equal(previewStartHeight(undefined), 280)
  const intent = (prompt, at, last) => previewIntentFrom({ type: 'hermes-inline-preview-intent', token: 'tok', id: 1, prompt }, 'tok', at, last)
  assert.deepEqual(intent(' buy eth ', 5000, 0), { kind: 'accept', id: 1, prompt: 'buy eth' })
  assert.equal(intent('x'.repeat(501), 5000, 0).ack.error, 'too_long')
  assert.equal(intent('again', 5000, 4500).ack.error, 'throttled')
  assert.equal(previewIntentFrom({ type: 'hermes-inline-preview-intent', token: 'nope', id: 1, prompt: 'x' }, 'tok', 1, 0), null)
})

test('a card button or widget intent is a hidden turn: display_kind hidden, no bubble', async () => {
  const gw = gateway()
  const chat = createChatController(BOT, gw.deps)
  await chat.open()
  const before = chat.get().chat.items.length
  const result = await chat.sendIntent('APPROVE c-1a2b send the note')
  assert.equal(result.ok, true)
  const submit = gw.calls.find(c => c.method === 'prompt.submit')
  assert.equal(submit.params.text, 'APPROVE c-1a2b send the note')
  assert.equal(submit.params.display_kind, 'hidden')
  assert.equal(submit.params.session_id, 'rt-1')
  assert.ok(submit.params.submission_id)
  assert.equal(chat.get().chat.items.length, before, 'no user bubble')
  assert.equal((await chat.sendIntent('x'.repeat(501))).ok, false)
  assert.equal((await chat.sendIntent('  ')).ok, false)
  chat.dispose()
})

const cardMessage = profile => ({
  session_id: profile,
  messages: [
    { id: 11, role: 'user', content: 'draft the weekly note and ask me first', timestamp: 1762560000 },
    {
      id: 12,
      role: 'assistant',
      content: 'Drafted it.\n\n::card{id="c-1a2b" kind="approval" file="cards/c-1a2b.json"}\n\nAnd the numbers:\n\n::preview{file="charts/week.html"}\n\n::preview{file="notes.pdf"}',
      timestamp: 1762560005
    }
  ],
  pagination: { limit: 120, offset: 0, order: 'latest', returned: 2 }
})

test('loader-faithful: the open chat draws the card and the preview from the bot’s own session; a click is a hidden turn', { skip: !READY && 'dev dependencies not installed' }, async t => {
  const reads = []
  const rendered = []
  let card = CARD
  const { panes, workspaces, mount, errors, calls } = await bootPlugin(t, {
    tweak: sdk => {
      const inner = sdk.MessageTextContent
      sdk.MessageTextContent = props => (rendered.push({ media: props.media, previewOnly: props.previewOnly, text: props.text }), inner(props))
    },
    historyFor: cardMessage,
    answers: { 'prompt.submit': () => ({ status: 'streaming' }) },
    api: request => {
      if (!String(request.path).startsWith('/api/fs/read-text')) return undefined
      reads.push(request)
      if (request.path.includes('cards%2Fc-1a2b.json')) return { text: JSON.stringify(card), binary: false, truncated: false }
      if (request.path.includes('charts%2Fweek.html')) return { text: '<html><body><button data-hermes-send="more">More</button></body></html>', binary: false, truncated: false }
      return { text: '', binary: true }
    }
  })
  const rosterEl = mount(panes.find(p => p.id === 'roster').render)
  ;(await waitFor(() => [...rosterEl.querySelectorAll('button.gbo-row')].find(b => b.textContent.includes('Scholar')), 'row')).click()
  const chatEl = mount((await waitFor(() => workspaces.get('grokbot-override'), 'workspace')).render)
  const cardEl = await waitFor(() => chatEl.querySelector('.gbo-directive .gbo-dcard[data-gbo-card="approval"]'), 'the card')
  assert.ok(!chatEl.textContent.includes('::card{'), 'no raw directive text')
  assert.ok(chatEl.textContent.includes('Drafted it.'))
  assert.equal(cardEl.querySelector('.gbo-dcard-title').textContent, 'Send the weekly note?')
  assert.equal(cardEl.querySelector('.gbo-dcard-status'), null, 'a waiting approval card has no chip (Cards 8)')
  assert.equal(cardEl.querySelectorAll('.gbo-ask-row').length, 2, 'actions are lettered rows')
  const cardRead = reads.find(r => r.path.includes('cards%2Fc-1a2b.json'))
  assert.equal(cardRead.connectionId, 'home-server', 'read on the bot’s own machine')
  assert.equal(cardRead.profile, 'scholar')
  assert.match(cardRead.path, /&session_id=k-(tip|root)$/, 'relative to the bot’s own session')

  const frame = await waitFor(() => chatEl.querySelector('iframe.gbo-preview-frame'), 'the preview frame')
  assert.equal(frame.getAttribute('sandbox'), 'allow-scripts', 'scripts only: no same-origin, popups or forms')
  assert.ok(frame.getAttribute('srcdoc').includes('data-hermes-send="more"'))
  assert.ok(frame.getAttribute('srcdoc').includes('window.hermes'))
  assert.ok(chatEl.querySelector('.gbo-preview-row')?.textContent.includes('notes.pdf'), 'a non-HTML preview is a tidy row')
  assert.ok(chatEl.querySelector('.gbo-preview-row')?.textContent.includes('Only HTML previews show here'))
  // A message from anything but the frame is ignored.
  window.dispatchEvent(new window.MessageEvent('message', { data: { type: 'hermes-inline-preview-intent', token: 'x', id: 1, prompt: 'evil' }, source: window }))

  const send = [...cardEl.querySelectorAll('button')].find(b => b.textContent.includes('Send it'))
  send.click()
  await waitFor(() => calls.some(c => c.method === 'prompt.submit'), 'the hidden turn')
  const submits = calls.filter(c => c.method === 'prompt.submit')
  assert.equal(submits.length, 1)
  assert.equal(submits[0].params.text, 'APPROVE c-1a2b send the note')
  assert.equal(submits[0].params.display_kind, 'hidden')
  assert.equal(submits[0].via, 'home-server::scholar')
  assert.ok(!chatEl.querySelector('.bubble.is-user')?.textContent.includes('APPROVE'), 'no bubble for the click')

  // The bot rewrites the file: the next poll shows it settled.
  card = { ...CARD, status: { state: 'done' }, resolved: { action: 'Send it', at: '2026-11-09T10:00:00Z' } }
  assert.ok([...cardEl.querySelectorAll('.gbo-ask-row')].every(b => b.disabled), 'clicked: rows frozen at once')
  assert.ok(send.classList.contains('is-on'), 'clicked: the chosen row is marked')
  await waitFor(() => chatEl.querySelector('.gbo-dcard.is-settled'), 'the polled update', 6000)
  assert.ok([...chatEl.querySelectorAll('.gbo-dcard button')].every(b => b.disabled), 'resolved: buttons frozen')
  assert.ok(chatEl.querySelector('.gbo-dcard .gbo-ask-row.is-on')?.textContent.includes('Send it'), 'resolved: the chosen row stays marked')
  const settledReads = reads.filter(r => r.path.includes('cards%2Fc-1a2b.json')).length
  await new Promise(resolve => setTimeout(resolve, 3300))
  assert.equal(reads.filter(r => r.path.includes('cards%2Fc-1a2b.json')).length, settledReads, 'polling stops once final')
  // Markdown stays in the SDK renderer's owner-safe mode; the directives
  // never reach it (they are drawn by the override, for this chat only).
  assert.ok(rendered.length > 0)
  for (const props of rendered) {
    assert.equal(props.previewOnly, true)
    assert.equal(props.media, false)
    assert.ok(!props.text.includes('::card{') && !props.text.includes('::preview{'))
  }
  assert.deepEqual(errors, [])
})

test('preview CSP: no network at all; inline script and style, data/blob media only', () => {
  assert.equal(PREVIEW_CSP, "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; media-src data: blob:")
  const prelude = previewPrelude({}, 'Inter', 'light')
  assert.ok(prelude.startsWith(`<meta http-equiv="Content-Security-Policy" content="${PREVIEW_CSP}">`))
  assert.ok(!/https?:|connect-src|\*/.test(PREVIEW_CSP), 'no host, no wildcard, no connect-src grant')
})

test('preview intent route: sent at once only within 3 s of the user stepping into the frame', () => {
  assert.equal(previewIntentRoute(10_000, 0), 'ask', 'never seen: ask')
  assert.equal(previewIntentRoute(10_000, 9_000), 'send')
  assert.equal(previewIntentRoute(10_000, 7_000), 'send', 'exactly 3 s')
  assert.equal(previewIntentRoute(10_001, 7_000), 'ask', 'older than 3 s: ask')
  assert.equal(previewIntentRoute(10_000, 11_000), 'ask', 'a time in the future does not count')
})
