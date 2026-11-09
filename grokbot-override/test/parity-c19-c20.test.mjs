// PARITY C19 (slash commands) and C20 (@mentions), against fakes shaped from
// the stock sources named in src/core/slash.js and src/core/mentions.js.

import assert from 'node:assert/strict'
import test from 'node:test'

import { mentionCompletions, mentionedBots, mentionNote } from '../src/core/mentions.js'
import { createChatController } from '../src/core/session.js'
import { parseCommandDispatch, parseSlash, slashSurface } from '../src/core/slash.js'
import { BOT, flush, gateway } from './harness.mjs'

const settle = async (n = 8) => {
  for (let i = 0; i < n; i += 1) await flush()
}
const commands = chat => chat.get().chat.items.filter(i => i.kind === 'command')
const open = async handlers => {
  const gw = gateway(handlers)
  const chat = createChatController(BOT, gw.deps)
  await chat.open()
  return { gw, chat }
}

test('C19 parsing: aliases, the /new guard, desktop-only commands', () => {
  assert.deepEqual(parseSlash('/compact  focus on auth'), { name: 'compress', raw: 'compact', arg: 'focus on auth', command: 'compact focus on auth' })
  assert.equal(slashSurface(parseSlash('/new')), 'new-guard')
  assert.equal(slashSurface(parseSlash('/reset')), 'new-guard')
  assert.equal(slashSurface(parseSlash('/skin dark')), 'desktop')
  assert.equal(slashSurface(parseSlash('/my-skill go')), 'exec')
  assert.equal(parseSlash('not a command'), null)
  assert.deepEqual(parseCommandDispatch({ type: 'skill', name: 'x', message: 'body', display: '/x' }), { type: 'skill', name: 'x', message: 'body', display: '/x' })
  assert.equal(parseCommandDispatch({ type: 'nope' }), null)
})

test('C19 /compress runs session.compress on the runtime with the long budget, then follows the lineage tip', async () => {
  let listed = 0
  const { gw, chat } = await open({
    'session.list': () => ({ sessions: [{ id: 'root', resolved_id: listed++ === 0 ? 'tip' : 'tip-2', title: 'Bot Chat' }] }),
    'session.compress': () => ({ status: 'compressed', summary: { headline: 'Compressed 40 → 6 messages', token_line: '12k → 2k tokens' } })
  })
  await chat.runSlash('/compress the auth work')
  const call = gw.calls.find(c => c.method === 'session.compress')
  assert.deepEqual(call.params, { session_id: 'rt-1', focus_topic: 'the auth work' })
  assert.equal(call.options.timeoutMs, 660_000)
  assert.equal(chat.get().storedId, 'tip-2', 'the new tip is followed')
  assert.match(commands(chat)[0].output, /Compressed 40 → 6 messages/)
  assert.ok(!gw.methods().includes('prompt.submit'))
  chat.dispose()
})

test('C19 /new in a Bot Chat compacts instead and says so (stock new-compact guard)', async () => {
  const { gw, chat } = await open({ 'session.compress': () => ({ status: 'compressed' }) })
  await chat.runSlash('/new')
  assert.ok(gw.methods().includes('session.compress'))
  assert.ok(!gw.methods().includes('session.create'), 'never forks the forever-chat')
  assert.match(commands(chat)[0].output, /never resets/)
  chat.dispose()
})

test('C19 a gateway command runs through slash.exec and its output shows; /status uses session.status', async () => {
  const { gw, chat } = await open({
    'slash.exec': params => ({ output: `ran ${params.command}` }),
    'session.status': () => ({ output: 'Model: x\nTokens: 10' })
  })
  await chat.runSlash('/usage today')
  assert.deepEqual(gw.calls.find(c => c.method === 'slash.exec').params, { session_id: 'rt-1', command: 'usage today' })
  assert.equal(commands(chat)[0].output, 'ran usage today')
  await chat.runSlash('/status')
  assert.equal(commands(chat)[1].output, 'Model: x\nTokens: 10')
  chat.dispose()
})

test('C19 a skill: slash.exec fails, command.dispatch answers a skill; the expanded body is submitted, the bubble shows the invocation', async () => {
  const { gw, chat } = await open({
    // The gateway's routing refusal (tui_gateway slash.exec: 4018 "skill
    // command: use command.dispatch"); a refusal is what permits the fallback.
    'slash.exec': () => {
      throw Object.assign(new Error('skill command: use command.dispatch for /research'), { code: 4018 })
    },
    'command.dispatch': () => ({ type: 'skill', name: 'research', message: 'SKILL BODY: research deeply', display: '/research cats' })
  })
  await chat.runSlash('/research cats')
  assert.deepEqual(gw.calls.find(c => c.method === 'command.dispatch').params, { session_id: 'rt-1', name: 'research', arg: 'cats' })
  const submit = gw.calls.find(c => c.method === 'prompt.submit')
  assert.equal(submit.params.text, 'SKILL BODY: research deeply')
  assert.ok(submit.params.submission_id)
  const bubble = chat.get().chat.items.findLast(i => i.kind === 'user')
  assert.equal(bubble.text, '/research cats')
  chat.dispose()
})

test('C19 prefill returns text for the composer; /title and window commands make no gateway call', async () => {
  const { gw, chat } = await open({ 'slash.exec': () => ({ type: 'prefill', message: 'the undone message' }) })
  assert.deepEqual(await chat.runSlash('/undo'), { ok: true, prefill: 'the undone message' })
  const before = gw.calls.length
  await chat.runSlash('/title New name')
  await chat.runSlash('/skin dark')
  assert.equal(gw.calls.length, before)
  assert.match(commands(chat).at(-2).output, /keeps its name/)
  assert.match(commands(chat).at(-1).output, /Hermes window/)
  chat.dispose()
})

test('C19 /steer while idle queues the words as the next turn; /queue submits with queued:true', async () => {
  const { gw, chat } = await open()
  await chat.runSlash('/steer focus on tests')
  await chat.runSlash('/queue then deploy')
  const submits = gw.calls.filter(c => c.method === 'prompt.submit').map(c => [c.params.text, c.params.queued])
  assert.deepEqual(submits, [
    ['focus on tests', true],
    ['then deploy', true]
  ])
  chat.dispose()
})

test('C19 /steer during a turn uses session.steer', async () => {
  const { gw, chat } = await open({ 'session.steer': () => ({ status: 'queued' }) })
  gw.emit({ type: 'message.start', session_id: 'rt-1', payload: {} })
  await chat.runSlash('/steer shorter please')
  assert.deepEqual(gw.calls.find(c => c.method === 'session.steer').params, { session_id: 'rt-1', text: 'shorter please' })
  assert.ok(!gw.methods().includes('prompt.submit'))
  chat.dispose()
})

test('C19 completions come from complete.slash on the live runtime', async () => {
  const { gw, chat } = await open({ 'complete.slash': () => ({ items: [{ text: '/compress', display: '/compress', meta: 'Compress' }], replace_from: 0 }) })
  const res = await chat.completeSlash('/comp')
  assert.deepEqual(gw.calls.find(c => c.method === 'complete.slash').params, { text: '/comp', session_id: 'rt-1' })
  assert.equal(res.items[0].text, '/compress')
  chat.dispose()
})

const ROSTER = [
  BOT,
  { name: 'research', ui_meta: { 'hermes-bots': { title: 'Research Buddy' } }, connectionId: 'local' },
  { name: 'default', connectionId: 'local' },
  { name: 'cos', remoteSource: true, connectionId: 'mini', connectionLabel: 'Mini' }
]

test('C20 the identification note is stock\'s, word for word; the bubble keeps the user\'s text', async () => {
  const tagged = mentionedBots('ask @research-buddy and @cos@mini, mail me@x.com', ROSTER, BOT)
  assert.deepEqual(tagged.map(b => b.name), ['research', 'cos'])
  const note = mentionNote(tagged)
  assert.equal(
    note,
    '\n\n[@mentions resolved from the Bot Mode roster — the user is referring to: @research = agent profile "research" ("Research Buddy"); @cos = agent profile "cos" — on Mini (message_agent target: "cos@mini"). If they want one of these agents contacted, compose your own message and send it with your message_agent tool (agents on other connected machines are reachable too — the Desktop relays it); never forward the user’s text verbatim. If this session has no message_agent tool, agent messaging is unavailable here — say so.]'
  )
  const { gw, chat } = await open()
  await chat.sendDraft('ask @research-buddy', [], { apiText: mentionNote(mentionedBots('ask @research-buddy', ROSTER, BOT)) })
  const submit = gw.calls.find(c => c.method === 'prompt.submit')
  assert.ok(submit.params.text.startsWith('ask @research-buddy\n\n[@mentions resolved'))
  assert.equal(chat.get().chat.items.findLast(i => i.kind === 'user').text, 'ask @research-buddy')
  chat.dispose()
})

test('C20 completions: the open bot is not offered, friendly tags first, default answers @hermes', () => {
  const items = mentionCompletions(ROSTER, BOT, '')
  assert.ok(!items.some(i => i.bot.name === 'scholar'))
  assert.ok(items.some(i => i.insert === '@research-buddy'))
  assert.ok(items.some(i => i.insert === '@hermes'))
  assert.deepEqual(mentionCompletions(ROSTER, BOT, 'res').map(i => i.insert), ['@research-buddy'])
})
