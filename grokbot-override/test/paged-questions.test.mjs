// Pass 15: a clarify card with several questions pages, one question at a
// time like Grok Bot. A click picks a row (the letter badge turns blue);
// Next moves on, Back goes back with the picks kept, Skip skips the
// question on screen, Done on the last page sends every answer once. Page
// dots on the left; the page lives on the controller. Demo content only.

import assert from 'node:assert/strict'
import test from 'node:test'

import { clarifyOpenPages, clarifyPage, keepCardProgress } from '../src/core/prompts.js'
import { createChatController } from '../src/core/session.js'
import { BOT, gateway } from './harness.mjs'
import { bootPlugin, READY, waitFor } from './loader-boot.mjs'

const skip = !READY && 'dev dependencies not installed'

const THREE = {
  request_id: 'p1',
  questions: [
    { qid: 'team', question: 'Which team is this for?', choices: ['Design (Recommended)', 'Sales', 'Support'] },
    { qid: 'where', question: 'Where should it go?', choices: ['Shared folder', 'Email'] },
    { qid: 'size', question: 'Which sizes?', choices: ['Small', 'Medium', 'Large'], multi_select: true }
  ]
}

const locks = calls => calls.filter(c => c.method === 'clarify.lock').map(c => c.params)
const card = el => el.querySelector('.gbo-transcript .gbo-ask:not(.is-settled)')
const page = el => card(el)?.querySelector('.gbo-ask-q:not(.is-ghost)')
const title = el => page(el)?.querySelector('.gbo-ask-title')?.textContent
const rows = el => [...page(el).querySelectorAll('button.gbo-ask-row')]
const button = (el, text) => [...card(el).querySelectorAll('.gbo-ask-actions button')].find(b => b.textContent === text)
const buttons = el => [...card(el).querySelectorAll('.gbo-ask-actions button')].map(b => b.textContent)
const dots = el => [...card(el).querySelectorAll('.gbo-ask-dot')].map(d => (d.classList.contains('is-current') ? 'o' : '.')).join('')

let shared = null
let seq = 0
/** One plugin boot for the file (the loader harness boots once per file);
 *  every scenario asks a new request on the same chat. */
async function openChat(t) {
  if (shared) return shared
  const booted = await bootPlugin(t, { answers: { 'clarify.lock': () => ({ status: 'ok', remaining: [] }) } })
  const rosterEl = booted.mount(booted.panes.find(p => p.id === 'roster').render)
  ;(await waitFor(() => [...rosterEl.querySelectorAll('button.gbo-row')].find(b => b.textContent.includes('Scholar')), 'row')).click()
  const workspace = await waitFor(() => booted.workspaces.get('grokbot-override'), 'workspace')
  const chatEl = booted.mount(workspace.render)
  await waitFor(() => chatEl.textContent.includes('hello scholar'), 'transcript')
  shared = { ...booted, workspace, chatEl }
  return shared
}

async function ask(t, payload = THREE) {
  const opened = await openChat(t)
  const id = `${payload.request_id}-${++seq}`
  const settledBefore = opened.chatEl.querySelectorAll('.gbo-ask.is-settled').length
  opened.emit({ type: 'clarify.request', session_id: 'rt-scholar', payload: { ...payload, request_id: id } })
  await waitFor(() => card(opened.chatEl)?.querySelector('.gbo-ask-q:not(.is-ghost)'), 'the card')
  const sent = () => locks(opened.calls).filter(c => c.request_id === id)
  const settledCard = () => waitFor(() => opened.chatEl.querySelectorAll('.gbo-ask.is-settled')[settledBefore], 'the settled card')
  return { ...opened, id, sent, settledCard }
}

/** Every disabled button in the card says why (never a dead button). */
function noDeadButtons(el) {
  for (const b of card(el)?.querySelectorAll('.gbo-ask-actions button') || []) {
    if (b.disabled) assert.ok(b.title, `disabled "${b.textContent}" has a title`)
  }
}

test('pages: the open question indexes, locked ones left out; the page kept across a repeated request', () => {
  const waiting = { kind: 'clarify', id: 'x', questions: [{ qid: 'a' }, { qid: 'b' }, { qid: 'c' }], locked: { a: 'done' } }
  assert.deepEqual(clarifyOpenPages(waiting), [1, 2])
  assert.equal(clarifyPage(waiting), 1, 'starts on the first open question')
  assert.equal(clarifyPage({ ...waiting, page: 2 }), 2)
  assert.equal(clarifyPage({ ...waiting, page: 0 }), 1, 'a locked page is never shown')
  assert.deepEqual(keepCardProgress({ ...waiting, page: 2, picks: { b: 'x' } }, waiting), { ...waiting, page: 2, picks: { b: 'x' } })
  assert.equal(keepCardProgress({ ...waiting, id: 'other', page: 2 }, waiting), waiting, 'a different request starts fresh')
})

test('controller: the page lives on the waiting card and survives a repeated frame and a snapshot repair', async () => {
  const gw = gateway({
    'session.resume': () => ({ session_id: 'rt-1', message_count: 0, messages: [], running: true, open_requests: [{ id: 'p1', method: 'clarify', params: THREE }] }),
    'clarify.lock': () => ({ status: 'ok' })
  })
  const chat = createChatController(BOT, gw.deps)
  await chat.open()
  assert.equal(chat.pickClarify('team', 'Sales', 1), true, 'a pick and the next page in one update')
  assert.equal(chat.get().chat.waiting.page, 1)
  gw.emit({ type: 'clarify.request', session_id: 'rt-1', payload: THREE })
  assert.equal(chat.get().chat.waiting.page, 1, 'a repeated request keeps the page')
  assert.deepEqual(chat.get().chat.waiting.picks, { team: 'Sales' }, 'and the picks')
  const resumes = gw.methods().filter(m => m === 'session.resume').length
  await chat.reconcile({ snapshot: true })
  assert.ok(gw.methods().filter(m => m === 'session.resume').length > resumes, 'the snapshot was re-read')
  assert.equal(chat.get().chat.waiting.page, 1, 'a snapshot repair keeps the page')
  chat.dispose()
})

function type(el, value) {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set
  setter.call(el, value)
  el.setSelectionRange(value.length, value.length)
  el.dispatchEvent(new window.Event('input', { bubbles: true }))
}

test('loader-faithful: the paged card in the real chat', { skip }, async t => {
  await t.test('a row click on a multi-question card shows the pick and stays on the page', async () => {
    const { chatEl, errors } = await ask(t)
    assert.equal(title(chatEl), 'Which team is this for?')
    assert.equal(card(chatEl).querySelectorAll('.gbo-ask-q:not(.is-ghost)').length, 1, 'one question on screen')
    assert.equal(dots(chatEl), 'o..')
    assert.deepEqual(buttons(chatEl), ['Skip', 'Next'], 'no Back on page 1')
    rows(chatEl)[1].click()
    await waitFor(() => page(chatEl).querySelector('.gbo-ask-row.is-on'), 'the picked row')
    const on = page(chatEl).querySelector('.gbo-ask-row.is-on')
    assert.equal(on.getAttribute('aria-checked'), 'true')
    assert.ok(on.textContent.includes('Sales'))
    assert.ok(!on.querySelector('.gbo-ask-check'), 'the badge marks the pick, no check mark')
    assert.equal(title(chatEl), 'Which team is this for?', 'a click does not move on')
    assert.equal(rows(chatEl)[0].querySelector('.gbo-ask-tag').textContent, 'Recommended')
    noDeadButtons(chatEl)
    })

  await t.test('Next pages forward, Back keeps picks, Done sends the full payload once', async () => {
    const { chatEl, errors, sent, settledCard } = await ask(t)
    rows(chatEl)[0].click()
    await waitFor(() => page(chatEl).querySelector('.gbo-ask-row.is-on'), 'pick 1')
    button(chatEl, 'Next').click()
    await waitFor(() => title(chatEl) === 'Where should it go?', 'page 2')
    assert.equal(dots(chatEl), '.o.')
    assert.deepEqual(buttons(chatEl), ['Back', 'Skip', 'Next'])
    rows(chatEl)[1].click()
    await waitFor(() => page(chatEl).querySelector('.gbo-ask-row.is-on'), 'pick 2')
    button(chatEl, 'Back').click()
    await waitFor(() => title(chatEl) === 'Which team is this for?', 'back on page 1')
    assert.ok(rows(chatEl)[0].classList.contains('is-on'), 'the earlier pick is shown')
    rows(chatEl)[2].click()
    await waitFor(() => rows(chatEl)[2].classList.contains('is-on'), 'changed pick')
    button(chatEl, 'Next').click()
    await waitFor(() => title(chatEl) === 'Where should it go?', 'page 2 again')
    assert.ok(rows(chatEl)[1].classList.contains('is-on'), 'the later pick is kept')
    button(chatEl, 'Next').click()
    await waitFor(() => title(chatEl) === 'Which sizes?', 'page 3')
    assert.deepEqual(buttons(chatEl), ['Back', 'Skip', 'Done'], 'the last page says Done')
    // Multi-select: rows toggle.
    rows(chatEl)[0].click()
    await waitFor(() => rows(chatEl)[0].classList.contains('is-on'), 'Small')
    rows(chatEl)[2].click()
    await waitFor(() => rows(chatEl)[2].classList.contains('is-on'), 'Large')
    rows(chatEl)[0].click()
    await waitFor(() => !rows(chatEl)[0].classList.contains('is-on'), 'Small off again')
    assert.equal(rows(chatEl)[2].getAttribute('role'), 'checkbox')
    assert.equal(sent().length, 0, 'nothing sent before Done')
    button(chatEl, 'Done').click()
    const settled = await settledCard()
    assert.deepEqual(sent(), [
      { request_id: sent()[0].request_id, question_id: 'team', answer: 'Support' },
      { request_id: sent()[0].request_id, question_id: 'where', answer: 'Email' },
      { request_id: sent()[0].request_id, question_id: 'size', answer: ['Large'] }
    ])
    // The settled card shows every question with its answer.
    assert.equal(settled.querySelectorAll('.gbo-ask-q').length, 3)
    assert.ok(!settled.querySelector('.is-ghost, .gbo-ask-dots'))
    assert.deepEqual([...settled.querySelectorAll('.gbo-ask-row.is-on .gbo-ask-label')].map(e => e.textContent), ['Support', 'Email', 'Large'])
    assert.ok(settled.querySelector('.gbo-ask-row.is-on .gbo-ask-check'), 'settled rows keep the check')
    await new Promise(resolve => setTimeout(resolve, 50))
    assert.equal(sent().length, 3, 'sent once')
    })

  await t.test('Skip and Next with no pick skip the question (sent as null); never a dead button', async () => {
    const { chatEl, calls, sent, settledCard } = await ask(t)
    button(chatEl, 'Skip').click()
    await waitFor(() => title(chatEl) === 'Where should it go?', 'page 2')
    noDeadButtons(chatEl)
    assert.ok(!button(chatEl, 'Next').disabled, 'Next works with no pick')
    button(chatEl, 'Next').click()
    await waitFor(() => title(chatEl) === 'Which sizes?', 'page 3')
    assert.ok(!button(chatEl, 'Done').disabled)
    button(chatEl, 'Done').click()
    await settledCard()
    assert.deepEqual(sent().map(c => c.answer), [null, null, null])
    assert.ok((await settledCard()).textContent.includes('Skipped'))
  })

  await t.test('Skip on a picked question clears it; Skip on the last page sends', async () => {
    const { chatEl, calls, sent, settledCard } = await ask(t)
    rows(chatEl)[0].click()
    await waitFor(() => rows(chatEl)[0].classList.contains('is-on'), 'pick')
    button(chatEl, 'Skip').click()
    await waitFor(() => title(chatEl) === 'Where should it go?', 'page 2')
    rows(chatEl)[0].click()
    await waitFor(() => rows(chatEl)[0].classList.contains('is-on'), 'pick 2')
    button(chatEl, 'Next').click()
    await waitFor(() => title(chatEl) === 'Which sizes?', 'page 3')
    button(chatEl, 'Skip').click()
    await settledCard()
    assert.deepEqual(sent().map(c => c.answer), [null, 'Shared folder', null])
  })

  await t.test('questions the gateway already locked are not pages', async () => {
    const { chatEl, sent, settledCard } = await ask(t, { ...THREE, answers: { team: 'Design' } })
    assert.equal(title(chatEl), 'Where should it go?', 'starts on the first open question')
    assert.equal(dots(chatEl), 'o.')
    assert.deepEqual(buttons(chatEl), ['Skip', 'Next'], 'no Back to a locked question')
    button(chatEl, 'Next').click()
    await waitFor(() => title(chatEl) === 'Which sizes?', 'page 2')
    button(chatEl, 'Back').click()
    await waitFor(() => title(chatEl) === 'Where should it go?', 'back')
    button(chatEl, 'Next').click()
    await waitFor(() => title(chatEl) === 'Which sizes?', 'page 2 again')
    button(chatEl, 'Done').click()
    await settledCard()
    assert.deepEqual(sent().map(c => c.answer), ['Design', null, null], 'the same payload shape as before')
  })

  await t.test('composer text answers the page on screen and moves to the next one', async () => {
    const { chatEl, calls, sent, settledCard } = await ask(t)
    const box = await waitFor(() => {
      const el = chatEl.querySelector('textarea')
      return el && !el.disabled ? el : null
    }, 'an enabled composer')
    type(box, 'Marketing')
    box.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    await waitFor(() => title(chatEl) === 'Where should it go?', 'the typed answer moved the card on')
    assert.equal(sent().length, 0, 'not sent yet')
    button(chatEl, 'Back').click()
    await waitFor(() => title(chatEl) === 'Which team is this for?', 'back')
    assert.ok(page(chatEl).querySelector('.gbo-ask-row.is-typed').textContent.includes('Marketing'), 'the typed answer shows on its page')
    button(chatEl, 'Next').click()
    await waitFor(() => title(chatEl) === 'Where should it go?', 'page 2')
    button(chatEl, 'Next').click()
    await waitFor(() => title(chatEl) === 'Which sizes?', 'page 3')
    type(box, 'Extra large')
    box.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    await settledCard()
    assert.deepEqual(sent().map(c => c.answer), ['Marketing', null, ['Extra large']])
    assert.equal(calls.filter(c => c.method === 'prompt.submit').length, 0, 'never sent as a message')
  })

  await t.test('the page survives a re-render (the chat drawn again)', async () => {
    const { chatEl, mount, workspace } = await ask(t)
    rows(chatEl)[1].click()
    await waitFor(() => rows(chatEl)[1].classList.contains('is-on'), 'pick')
    button(chatEl, 'Next').click()
    await waitFor(() => title(chatEl) === 'Where should it go?', 'page 2')
    const again = mount(workspace.render)
    await waitFor(() => page(again), 'the card drawn again')
    assert.equal(title(again), 'Where should it go?', 'still page 2')
    assert.equal(dots(again), '.o.')
  })

  await t.test('a single question is unchanged: a click answers at once', async () => {
    const { chatEl, id, sent, settledCard } = await ask(t, { request_id: 's1', question: 'Ready to start?', choices: ['Yes', 'Not yet'] })
    assert.ok(!card(chatEl).querySelector('.gbo-ask-dots, .gbo-ask-pages'))
    assert.deepEqual(buttons(chatEl), ['Skip'])
    card(chatEl).querySelector('button.gbo-ask-row').click()
    await settledCard()
    assert.deepEqual(sent(), [{ request_id: id, question_id: id, answer: 'Yes' }])
  })

  await t.test('a single multi-select question keeps Answer, and a disabled Answer says why', async () => {
    const { chatEl } = await ask(t, { request_id: 'm1', question: 'Which sizes?', choices: ['Small', 'Large'], multi_select: true })
    const answer = button(chatEl, 'Answer')
    assert.ok(answer.disabled)
    assert.equal(answer.title, 'Pick at least one choice first')
    noDeadButtons(chatEl)
  })
  assert.deepEqual(shared.errors, [])
})
