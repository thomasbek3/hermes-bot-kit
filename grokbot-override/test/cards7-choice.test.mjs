// Cards 7, part 2: a clarify question is a choice card at the end of the
// transcript (bold question, lettered rows), answered by a click or by what
// the user types in the composer; once answered it stays, settled, with the
// choice marked.

import assert from 'node:assert/strict'
import test from 'node:test'

import { bareChoice, choiceLetter, clarifySettledItem, clarifyTextAnswer } from '../src/core/prompts.js'
import { createChatController } from '../src/core/session.js'
import { BOT, gateway } from './harness.mjs'
import { bootPlugin, READY, waitFor } from './loader-boot.mjs'

const running = extra => () => ({ session_id: 'rt-1', message_count: 0, messages: [], running: true, ...extra })
const lockCalls = gw => gw.calls.filter(c => c.method === 'clarify.lock').map(c => c.params)

test('letters, bare choices, typed answers and the settled item', () => {
  assert.deepEqual([0, 1, 25, 26].map(choiceLetter), ['A', 'B', 'Z', '27'])
  assert.equal(bareChoice('main (Recommended)'), 'main')
  const one = { id: 'c1', questions: [{ qid: 'q', question: 'Yes or no?', choices: ['Yes', 'No'], multiSelect: false }] }
  assert.deepEqual(clarifyTextAnswer(one, '  maybe  '), { picks: { q: 'maybe' }, complete: true })
  assert.deepEqual(clarifyTextAnswer(one, '   '), { picks: {}, complete: false })
  const two = { id: 'c2', questions: [{ qid: 'a', question: 'A?', choices: ['x', 'y'], multiSelect: true }, { qid: 'b', question: 'B?', choices: null, multiSelect: false }], picks: { a: ['x'] } }
  assert.deepEqual(clarifyTextAnswer(two, 'because'), { picks: { a: ['x'], b: 'because' }, complete: true })
  assert.deepEqual(clarifyTextAnswer({ ...two, picks: {} }, 'z'), { picks: { a: ['z'] }, complete: false }, 'a multi-select question adds the text to its picks')
  assert.deepEqual(clarifyTextAnswer({ ...two, picks: { a: ['x'], b: 'old' } }, 'new').picks.b, 'new', 'all answered: the last question takes it')
  const settled = clarifySettledItem(one, { q: 'Yes' }, 'ok', 5)
  assert.deepEqual(settled, { kind: 'clarify', id: 'clarify:c1', requestId: 'c1', questions: one.questions, answers: { q: 'Yes' }, status: 'answered', at: 5 })
  assert.equal(clarifySettledItem(one, { q: null }, 'ok').status, 'skipped')
  assert.equal(clarifySettledItem(one, { q: 'Yes' }, 'expired').status, 'expired')
})

test('a clicked answer leaves the card in the transcript, settled; a refresh keeps it', async () => {
  const gw = gateway({
    'session.resume': running({ open_requests: [{ id: 'c1', method: 'clarify', params: { question: 'Yes or no?', choices: ['Yes', 'No'] } }] }),
    'clarify.lock': () => ({ status: 'ok', remaining: [] })
  })
  const chat = createChatController(BOT, gw.deps)
  await chat.open()
  const waiting = chat.get().chat.waiting
  assert.equal(waiting.kind, 'clarify')
  const qid = waiting.questions[0].qid
  assert.equal((await chat.answerPrompt({ [qid]: 'Yes' })).ok, true)
  assert.equal(chat.get().chat.waiting, null)
  const card = chat.get().chat.items.at(-1)
  assert.equal(card.kind, 'clarify')
  assert.equal(card.status, 'answered')
  assert.deepEqual(card.answers, { [qid]: 'Yes' })
  assert.deepEqual(lockCalls(gw), [{ request_id: 'c1', question_id: qid, answer: 'Yes' }])
  // The turn ends; an idle refresh rebuilds the transcript from history.
  gw.emit({ type: 'message.complete', session_id: 'rt-1', payload: { text: 'Great.' } })
  assert.equal(chat.get().chat.busy, false)
  const reads = gw.methods().filter(m => m === 'REST').length
  await chat.refresh()
  assert.equal(gw.methods().filter(m => m === 'REST').length, reads + 1, 'the history was re-read')
  assert.ok(chat.get().chat.items.some(item => item.id === 'clarify:c1'), 'the settled card survives a history rebuild')
  chat.dispose()
})

test('typed text answers the open question through clarify.lock, never prompt.submit', async () => {
  const gw = gateway({
    'session.resume': running({ open_requests: [{ id: 'c2', method: 'clarify', params: { question: 'Yes or no?', choices: ['Yes', 'No'] } }] }),
    'clarify.lock': () => ({ status: 'ok', remaining: [] })
  })
  const chat = createChatController(BOT, gw.deps)
  await chat.open()
  const qid = chat.get().chat.waiting.questions[0].qid
  const result = await chat.answerClarifyText('Only on weekdays')
  assert.equal(result.ok, true)
  assert.deepEqual(lockCalls(gw), [{ request_id: 'c2', question_id: qid, answer: 'Only on weekdays' }])
  assert.ok(!gw.methods().includes('prompt.submit'))
  assert.deepEqual(chat.get().chat.items.at(-1).answers, { [qid]: 'Only on weekdays' })
  assert.equal((await chat.answerClarifyText('again')).ok, false, 'nothing is waiting any more')
  chat.dispose()
})

test('several questions: picks wait on the card, typed text fills the next one, Answer sends all', async () => {
  const gw = gateway({
    'session.resume': running({
      open_requests: [{ id: 'c3', method: 'clarify', params: { questions: [{ qid: 'a', question: 'Which days?', choices: ['Mon', 'Tue', 'Wed'], multi_select: true }, { qid: 'b', question: 'Why?' }, { qid: 'c', question: 'Where?', choices: ['Home', 'Office'] }] } }]
    }),
    'clarify.lock': () => ({ status: 'ok' })
  })
  const chat = createChatController(BOT, gw.deps)
  await chat.open()
  assert.equal(chat.pickClarify('a', ['Mon', 'Wed']), true)
  assert.equal(chat.pickClarify('nope', 'x'), false, 'an unknown question is ignored')
  assert.deepEqual(await chat.answerClarifyText('team sync'), { ok: true, status: 'picked' })
  assert.deepEqual(chat.get().chat.waiting.picks, { a: ['Mon', 'Wed'], b: 'team sync' })
  assert.equal(lockCalls(gw).length, 0, 'nothing sent while a question is open')
  chat.pickClarify('c', 'Office')
  const res = await chat.answerPrompt(chat.get().chat.waiting.picks)
  assert.equal(res.ok, true)
  assert.deepEqual(lockCalls(gw), [
    { request_id: 'c3', question_id: 'a', answer: ['Mon', 'Wed'] },
    { request_id: 'c3', question_id: 'b', answer: 'team sync' },
    { request_id: 'c3', question_id: 'c', answer: 'Office' }
  ])
  assert.equal(chat.get().chat.items.at(-1).status, 'answered')
  chat.dispose()
})

test('a failed answer keeps the card open with the error, and no settled card', async () => {
  const gw = gateway({
    'session.resume': running({ open_requests: [{ id: 'c4', method: 'clarify', params: { question: 'Go?', choices: ['Yes', 'No'] } }] }),
    'clarify.lock': () => {
      throw Object.assign(new Error('socket closed'), {})
    }
  })
  const chat = createChatController(BOT, gw.deps)
  await chat.open()
  const result = await chat.answerClarifyText('later')
  assert.equal(result.ok, false)
  assert.match(result.error, /socket closed/)
  assert.equal(chat.get().chat.waiting.kind, 'clarify')
  assert.ok(!chat.get().chat.items.some(item => item.kind === 'clarify'))
  chat.dispose()
})

function type(el, value) {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set
  setter.call(el, value)
  el.setSelectionRange(value.length, value.length)
  el.dispatchEvent(new window.Event('input', { bubbles: true }))
}

test('loader-faithful: the card renders inline with lettered rows; a click answers; typing answers the next one', { skip: !READY && 'dev dependencies not installed' }, async t => {
  const { panes, workspaces, mount, errors, calls, emit } = await bootPlugin(t, {
    answers: { 'clarify.lock': () => ({ status: 'ok', remaining: [] }) }
  })
  const rosterEl = mount(panes.find(p => p.id === 'roster').render)
  ;(await waitFor(() => [...rosterEl.querySelectorAll('button.gbo-row')].find(b => b.textContent.includes('Scholar')), 'row')).click()
  const chatEl = mount((await waitFor(() => workspaces.get('grokbot-override'), 'workspace')).render)
  await waitFor(() => chatEl.textContent.includes('hello scholar'), 'transcript')
  const box = await waitFor(() => {
    const el = chatEl.querySelector('textarea')
    return el && !el.disabled ? el : null
  }, 'an enabled composer')

  emit({ type: 'clarify.request', session_id: 'rt-scholar', payload: { request_id: 'q1', question: 'Does this yes/no card work for you?', choices: ['Yes', 'No'] } })
  const card = await waitFor(() => chatEl.querySelector('.gbo-transcript .gbo-ask'), 'the inline choice card')
  assert.equal(card.querySelector('.gbo-ask-title').textContent, 'Does this yes/no card work for you?')
  const rows = [...card.querySelectorAll('button.gbo-ask-row')]
  assert.deepEqual(rows.map(r => r.querySelector('.gbo-ask-key').textContent + ' ' + r.querySelector('.gbo-ask-label').textContent), ['A Yes', 'B No'])
  assert.ok(!chatEl.textContent.includes('Waiting for your answer'))
  assert.ok(!card.querySelector('input'), 'no input in the card: the composer types the answer')
  await waitFor(() => box.placeholder === 'Type your answer, or talk about something…', 'the answer placeholder')
  rows[0].click()
  await waitFor(() => chatEl.querySelector('.gbo-ask.is-settled'), 'the settled card')
  const settled = chatEl.querySelector('.gbo-ask.is-settled')
  assert.ok(settled.querySelector('.gbo-ask-row.is-on').textContent.includes('Yes'))
  assert.ok([...settled.querySelectorAll('button.gbo-ask-row')].every(b => b.disabled), 'not clickable')
  assert.deepEqual(calls.filter(c => c.method === 'clarify.lock').map(c => c.params), [{ request_id: 'q1', question_id: 'q1', answer: 'Yes' }])
  await waitFor(() => box.placeholder.startsWith('Message'), 'the normal placeholder again')

  emit({ type: 'clarify.request', session_id: 'rt-scholar', payload: { request_id: 'q2', question: 'When?', choices: ['Today', 'Tomorrow'] } })
  await waitFor(() => box.placeholder === 'Type your answer, or talk about something…', 'the answer placeholder again')
  type(box, 'Next week')
  box.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
  await waitFor(() => calls.filter(c => c.method === 'clarify.lock').length === 2, 'the typed answer was sent')
  assert.deepEqual(calls.filter(c => c.method === 'clarify.lock')[1].params, { request_id: 'q2', question_id: 'q2', answer: 'Next week' })
  assert.equal(calls.filter(c => c.method === 'prompt.submit').length, 0, 'never sent as a message')
  await waitFor(() => chatEl.querySelectorAll('.gbo-ask.is-settled').length === 2, 'both cards settled in place')
  assert.ok(chatEl.querySelectorAll('.gbo-ask.is-settled')[1].querySelector('.gbo-ask-row.is-typed').textContent.includes('Next week'))
  assert.equal(box.value, '')
  assert.deepEqual(errors, [])
})
