// Review override-v2-r3 M1: a successfully loaded stored record must not lose
// the job id from the save URL.
//
// The cron.manage list row names a job `job_id`; GET /api/cron/jobs/{id}
// (hermes_cli/web_routers/cron.py:159-160,739-742, web_server_cron.py:127-139)
// returns the stored `cron/jobs.py get_job` record, keyed `id`. The write route
// is PUT /api/cron/jobs/{job_id} (web_routers/cron.py:780). The identity of the
// write is the validated list id; the stored record only supplies content, and
// a missing or mismatched id is refused before any write.
//
// The loader scenario runs the built plugin.js under Hermes's loader replica
// with a strict REST fake: any request that is not exactly the expected
// method + path + profile + connection fails the test.

import assert from 'node:assert/strict'
import test from 'node:test'

import { cronEditUpdates, cronJobId, cronJobRestPath, isStoredJobFor } from '../src/core/cronOps.js'
import { READY, waitFor } from './loader-boot.mjs'
import { bootFull, buttonWithText, dialogEl, reactErrors, SCOUT } from './loader-surfaces.mjs'

const skip = !READY && 'dev dependencies not installed'

test('v2-r3 M1 helpers: one normalized id for list rows (job_id) and stored records (id); none → no path', () => {
  assert.equal(cronJobId({ job_id: 'j7' }), 'j7')
  assert.equal(cronJobId({ id: 'j7', prompt: 'full' }), 'j7')
  assert.equal(cronJobId({ job_id: 'j7', id: 'j7' }), 'j7')
  assert.equal(cronJobId({ job_id: 'a', id: 'b' }), '', 'a record naming two different ids has no trustworthy id')
  assert.equal(cronJobId({}), '')
  assert.equal(cronJobRestPath({ id: 'j7', prompt: 'full' }), '/api/cron/jobs/j7')
  assert.equal(cronJobRestPath({ job_id: 'j 7' }, '/trigger'), '/api/cron/jobs/j%207/trigger')
  assert.throws(() => cronJobRestPath({ prompt: 'no id' }), /no id/i, 'never the collection URL')
  assert.throws(() => cronJobRestPath(null), /no id/i)
  assert.equal(isStoredJobFor({ job_id: 'j7' }, { id: 'j7', prompt: 'full' }), true)
  assert.equal(isStoredJobFor({ job_id: 'j7' }, { id: 'j8', prompt: 'full' }), false)
  assert.equal(isStoredJobFor({}, { prompt: 'full' }), false, 'two missing ids are not a match')
  // The record supplies content; nothing in the update body names the id.
  const updates = cronEditUpdates({ profile: 'scout', job: { id: 'j7', name: '[bot:scout] A', prompt: 'full', deliver: 'local' }, title: 'B', prompt: 'full', sched: { freq: 'hourly' }, initialSchedule: 'every 1h' })
  assert.deepEqual(updates, { deliver: 'local', name: '[bot:scout] B', prompt: 'full' })
})

const FULL_PROMPT = `Check the release dashboard every morning. ${'Only report regressions above two percent, never the noise. '.repeat(2)}Always end with the rollback command.`
const LIST_JOB = {
  job_id: 'j7',
  name: '[bot:scout] Release watch',
  prompt_preview: FULL_PROMPT.slice(0, 100) + '...',
  schedule: 'every 1440m',
  deliver: 'local',
  enabled: true
}
const STORED_JOB = {
  id: 'j7',
  name: '[bot:scout] Release watch',
  prompt: FULL_PROMPT,
  schedule: { kind: 'interval', minutes: 1440, display: 'every 1440m' },
  schedule_display: 'every 1440m',
  deliver: 'local',
  enabled: true
}
const ONE_SHOT_LIST = { job_id: 'j9', name: '[bot:scout] Remind me', prompt_preview: 'Stretch', schedule: 'once in 30m', deliver: 'local', enabled: true }
const ONE_SHOT_STORED = { id: 'j9', name: '[bot:scout] Remind me', prompt: 'Stretch', schedule: { kind: 'once', display: 'once in 30m' }, deliver: 'local', enabled: true }

function typeInto(input, value) {
  Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set.call(input, value)
  input.dispatchEvent(new window.Event('input', { bubbles: true }))
}

test('v2-r3 M1 job editor: after the stored record loads, Save PUTs exactly /api/cron/jobs/<id> on the bot’s profile and connection', { skip }, async t => {
  const rest = []
  const stray = []
  let records = { j7: STORED_JOB, j9: ONE_SHOT_STORED }
  // Strict: exact method, path, profile and connection, or the request is stray.
  const api = async request => {
    if (!String(request.path).startsWith('/api/cron/')) return undefined
    const m = /^\/api\/cron\/jobs\/([^/]+)$/.exec(String(request.path))
    if (!m || request.profile !== 'scout' || request.connectionId !== 'mini' || !['GET', 'PUT'].includes(request.method)) {
      stray.push(request)
      throw new Error(`unexpected ${request.method} ${request.path}`)
    }
    rest.push(request)
    const id = decodeURIComponent(m[1])
    if (request.method === 'GET') return records[id]
    return { ok: true }
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

  // Rename of an interval job with its full record loaded.
  let dialog = await open(LIST_JOB)
  await waitFor(() => dialog.querySelector('textarea')?.value === FULL_PROMPT, 'the full instruction')
  typeInto(nameField(dialog), 'Release watch v2')
  buttonWithText(dialog, 'Save').click()
  let put = await lastPut()
  assert.equal(put.path, '/api/cron/jobs/j7', 'the per-job route, not the collection')
  assert.equal(put.updates, undefined)
  assert.equal(put.body.updates.name, '[bot:scout] Release watch v2')
  assert.equal(put.body.updates.prompt, FULL_PROMPT)
  assert.ok(!('schedule' in put.body.updates))
  await waitFor(() => !dialogEl(false), 'the dialog closes after saving')

  // Script-only job.
  records = { ...records, j7: { ...STORED_JOB, prompt: '', script: 'check.sh' } }
  dialog = await open({ ...LIST_JOB, prompt_preview: '', script: 'check.sh' })
  await waitFor(() => rest.length && dialog.querySelector('textarea') && !dialog.querySelector('textarea').disabled, 'the stored script job')
  buttonWithText(dialog, 'Save').click()
  put = await lastPut()
  assert.equal(put.path, '/api/cron/jobs/j7')
  assert.ok(!('prompt' in put.body.updates))

  // One-shot job: rename keeps the schedule out of the update.
  dialog = await open(ONE_SHOT_LIST)
  await waitFor(() => dialog.querySelector('textarea')?.value === 'Stretch', 'the one-shot record')
  typeInto(nameField(dialog), 'Remind me later')
  buttonWithText(dialog, 'Save').click()
  put = await lastPut()
  assert.equal(put.path, '/api/cron/jobs/j9')
  assert.equal(put.body.updates.name, '[bot:scout] Remind me later')
  assert.ok(!('schedule' in put.body.updates), 'a one-shot display text is never written back')

  assert.deepEqual(stray, [], 'no request outside the exact per-job routes')
  assert.deepEqual(reactErrors(errors), [])
})
