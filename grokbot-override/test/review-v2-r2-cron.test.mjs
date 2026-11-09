// Review override-v2-r2 H1/M1 (src/ui/CronDialogs.tsx JobDialog,
// src/core/cronOps.js cronEditUpdates) and the cron sweep instances, on the
// built plugin.js under Hermes's loader (test/hermes-loader.mjs), real clicks.
// One boot per file (the SDK shim is a cached data: URL), so the dialog
// scenarios run in sequence on one boot:
//
//   H1  editing only the name never writes the 100-character list preview back
//       as the instruction: the editor reads the stored record first (stock's
//       Cron page edits job.prompt from GET /api/cron/jobs/{id}); Save waits for
//       it; an unreadable or foreign record leaves the instruction as stored
//   M1  the pinned model/provider are never sent by this editor (no control)
//   S1  an unchanged schedule is not re-sent (cron/jobs.py update_job
//       re-anchors next_run_at whenever `schedule` is in the update, and a
//       one-shot's display text "once in 30m" does not parse back)
//   S2  a script-only job saves with an empty instruction (stock parity)
//   S4  a save finishing after the dialog was replaced leaves the newer one open

import assert from 'node:assert/strict'
import test from 'node:test'

import { cronEditUpdates } from '../src/core/cronOps.js'
import { READY, waitFor } from './loader-boot.mjs'
import { bootFull, buttonWithText, dialogEl, reactErrors, SCOUT } from './loader-surfaces.mjs'

const skip = !READY && 'dev dependencies not installed'

function deferred() {
  let resolve
  let reject
  const promise = new Promise((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}
const tick = (ms = 30) => new Promise(resolve => setTimeout(resolve, ms))

function typeInto(input, value) {
  Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set.call(input, value)
  input.dispatchEvent(new window.Event('input', { bubbles: true }))
}

const FULL_PROMPT = `Check the release dashboard every morning. ${'Only report regressions above two percent, never the noise. '.repeat(2)}Always end with the rollback command.`
const LIST_JOB = {
  job_id: 'j7',
  name: '[bot:scout] Release watch',
  prompt_preview: FULL_PROMPT.slice(0, 100) + '...',
  model: 'chosen-model',
  provider: 'chosen-provider',
  pinned: true,
  schedule: 'every 1440m',
  deliver: 'local',
  enabled: true
}
// GET /api/cron/jobs/{id}: the stored record (cron/jobs.py get_job).
const STORED_JOB = {
  id: 'j7',
  name: '[bot:scout] Release watch',
  prompt: FULL_PROMPT,
  model: 'chosen-model',
  provider: 'chosen-provider',
  schedule: { kind: 'interval', minutes: 1440, display: 'every 1440m' },
  schedule_display: 'every 1440m',
  deliver: 'local',
  enabled: true
}

function cronApi({ get = () => STORED_JOB, put = () => ({ ok: true }) } = {}) {
  const rest = []
  const api = async request => {
    if (!String(request.path).startsWith('/api/cron/jobs/')) return undefined
    rest.push(request)
    if (request.method === 'PUT') return put(request)
    return get(request)
  }
  return { rest, api }
}

async function openJobDialog(internals, job) {
  internals.openDialog({ kind: 'cron-edit', bot: SCOUT, job })
  return waitFor(() => dialogEl(false), 'the job dialog')
}

test('v2-r2 M1+S1 payload: model/provider only when the caller passes them (explicit reset clears), schedule only when changed', () => {
  const job = { job_id: 'j1', name: '[bot:scout] Digest', prompt: 'old', deliver: 'local' }
  const base = { profile: 'scout', job, title: 'Digest', prompt: 'old', sched: { freq: 'hourly' } }
  const plain = cronEditUpdates(base)
  assert.ok(!('model' in plain) && !('provider' in plain), 'no model fields unless the editor has them')
  assert.equal(plain.schedule, 'every 1h', 'no baseline: schedule is sent')
  const reset = cronEditUpdates({ ...base, model: '', provider: '' })
  assert.equal(reset.model, null, 'an explicit default selection clears the pin')
  assert.equal(reset.provider, null)
  const kept = cronEditUpdates({ ...base, model: 'm', provider: 'p' })
  assert.deepEqual([kept.model, kept.provider], ['m', 'p'])
  assert.ok(!('schedule' in cronEditUpdates({ ...base, initialSchedule: 'every 1h' })), 'unchanged schedule omitted')
  assert.equal(cronEditUpdates({ ...base, initialSchedule: 'every 2h' }).schedule, 'every 1h', 'changed schedule sent')
  assert.ok(!('prompt' in cronEditUpdates({ ...base, prompt: undefined })), 'no prompt unless a full one was edited')
})

test('v2-r2 H1+M1+S1+S2+S4 job editor: full instruction, model pin and schedule survive; Save waits for the stored record; no stale close', { skip }, async t => {
  assert.ok(FULL_PROMPT.length > 150, 'the instruction is longer than the list preview')
  const rest = []
  let get = () => STORED_JOB
  let put = () => ({ ok: true })
  const api = async request => {
    if (!String(request.path).startsWith('/api/cron/jobs/')) return undefined
    rest.push(request)
    return request.method === 'PUT' ? put(request) : get(request)
  }
  const { panes, mount, internals, errors } = await bootFull(t, { primitives: false, api })
  mount(panes.find(p => p.id === 'roster').render)
  const open = async job => {
    internals.openDialog(null)
    await waitFor(() => !dialogEl(false), 'the previous dialog to close')
    rest.length = 0
    internals.openDialog({ kind: 'cron-edit', bot: SCOUT, job })
    return waitFor(() => dialogEl(false), 'the job dialog')
  }
  const nameField = dialog => dialog.querySelector('input.gbo-input')
  const lastPut = () => waitFor(() => rest.find(r => r.method === 'PUT'), 'the update')

  // H1 + M1 + S1: rename only.
  let dialog = await open(LIST_JOB)
  const area = await waitFor(() => {
    const el = dialog.querySelector('textarea')
    return el && el.value === FULL_PROMPT ? el : null
  }, 'the full instruction in the editor')
  assert.equal(area.disabled, false)
  const read = rest.find(r => r.method !== 'PUT')
  assert.equal(read.path, '/api/cron/jobs/j7')
  assert.equal(read.connectionId, 'mini', 'read on the bot’s own connection')
  assert.equal(read.profile, 'scout')
  typeInto(nameField(dialog), 'Release watch v2')
  buttonWithText(dialog, 'Save').click()
  let { updates } = (await lastPut()).body
  assert.equal(updates.name, '[bot:scout] Release watch v2')
  assert.equal(updates.prompt, FULL_PROMPT, 'the complete instruction survives')
  assert.ok(!('model' in updates) && !('provider' in updates), 'the pinned model and provider are left untouched')
  assert.ok(!('schedule' in updates), 'S1: an unchanged schedule is not re-sent')
  await waitFor(() => !dialogEl(false), 'the dialog closes after saving')

  // H1: Save waits; an unreadable record leaves the instruction as stored.
  const gate = deferred()
  get = () => gate.promise
  dialog = await open(LIST_JOB)
  await waitFor(() => rest.length, 'the stored-record read')
  assert.equal(buttonWithText(dialog, 'Save').disabled, true, 'no save before the stored record is known')
  assert.equal(dialog.querySelector('textarea').disabled, true)
  gate.reject(new Error('backend unreachable'))
  await waitFor(() => dialog.textContent.includes('left unchanged'), 'the read-failure note')
  const preview = dialog.querySelector('textarea')
  assert.ok(preview.readOnly || preview.disabled, 'the preview cannot be edited')
  typeInto(nameField(dialog), 'Renamed anyway')
  assert.equal(buttonWithText(dialog, 'Save').disabled, false, 'the other fields can still be saved')
  buttonWithText(dialog, 'Save').click()
  updates = (await lastPut()).body.updates
  assert.ok(!('prompt' in updates), 'the preview is never written as the instruction')
  assert.ok(!('model' in updates))
  assert.equal(updates.name, '[bot:scout] Renamed anyway')

  // H1: a record for another job is not used as the source.
  get = () => ({ ...STORED_JOB, id: 'other', prompt: 'someone else' })
  dialog = await open(LIST_JOB)
  await waitFor(() => dialog.textContent.includes('left unchanged'), 'the mismatch treated as unreadable')
  buttonWithText(dialog, 'Save').click()
  assert.ok(!('prompt' in (await lastPut()).body.updates))

  // S1: a changed schedule is sent.
  get = () => STORED_JOB
  dialog = await open(LIST_JOB)
  await waitFor(() => dialog.querySelector('textarea')?.value === FULL_PROMPT, 'the full job')
  const every = dialog.querySelector('input[aria-label="Every"]')
  assert.ok(every, 'the interval editor')
  typeInto(every, '2')
  buttonWithText(dialog, 'Save').click()
  updates = (await lastPut()).body.updates
  assert.equal(updates.schedule, 'every 2m', 'every 1440m edited to every 2m')
  assert.equal(updates.prompt, FULL_PROMPT)

  // S2: a script-only job saves with an empty instruction.
  get = () => ({ ...STORED_JOB, prompt: '', script: 'check.sh' })
  dialog = await open({ ...LIST_JOB, prompt_preview: '', script: 'check.sh' })
  await waitFor(() => rest.length && dialog.querySelector('textarea') && !dialog.querySelector('textarea').disabled, 'the stored script job')
  assert.equal(buttonWithText(dialog, 'Save').disabled, false, 'an empty instruction is fine for a script job')
  buttonWithText(dialog, 'Save').click()
  assert.ok(!('prompt' in (await lastPut()).body.updates))

  // S4: a save that finishes after the dialog was replaced.
  const slow = deferred()
  get = () => STORED_JOB
  put = () => slow.promise
  dialog = await open(LIST_JOB)
  await waitFor(() => dialog.querySelector('textarea')?.value === FULL_PROMPT, 'the full job')
  buttonWithText(dialog, 'Save').click()
  await lastPut()
  const next = { kind: 'cron-detail', bot: SCOUT, job: LIST_JOB }
  internals.openDialog(next)
  await waitFor(() => dialogEl(false)?.textContent.includes('What Hermes knows'), 'the detail dialog')
  slow.resolve({ ok: true })
  await tick(60)
  assert.equal(internals.roster2.dialog.get(), next, 'the newer dialog stays open')
  assert.ok(dialogEl(false)?.textContent.includes('What Hermes knows'))
  assert.deepEqual(reactErrors(errors), [])
})
