// Scheduled-job create / edit / remove / run and the job detail (P3).
//
// Create, remove and the detail rows are ports of Bot Mode's Scheduled jobs
// pane, apps/desktop/src/plugins/hermes-bots/cron.tsx (Hermes Agent, MIT,
// (c) Nous Research):
//   - composeSchedule, scheduleSummary, defaultScheduleState  ← cron.tsx:668,703,931
//   - routinePrompt, routineInputError                        ← cron.tsx:260,272
//   - the cron.manage {action:'add'} body                     ← cron.tsx:1013
//   - cron.manage {action:'remove'}                           ← cron.tsx:507 RoutineRow.act
//   - routineDetailRows, routineDetailIssue, routineLastResult ← cron.tsx:341,370,412
//
// Bot Mode's pane has no edit or run-now; the gateway's cron.manage has
// neither action (tui_gateway/methods_tools.py:1305: list/add/remove/pause/
// resume). Both come from the app's own Cron page, which uses the dashboard
// REST API through `window.hermesDesktop.api` (apps/desktop/src/api/cron.ts):
//   - edit: PUT  /api/cron/jobs/{id} {updates}   (cron.ts:93 updateCronJob,
//           fields from app/cron/cron-job-model.ts:137 cronEditorUpdates)
//   - run:  POST /api/cron/jobs/{id}/trigger     (cron.ts:121 triggerCronJob,
//           24 h timeout: the endpoint waits for the run)
// scoped to the bot's own connection and profile exactly like the transcript
// reads (routing.js botRestScope; api/client.ts hermesApiAs).

export const SAFE_ROUTINE_MARKER = '[bot-mode:routine:v2] ' // cron.tsx:76
export const CRON_TRIGGER_REQUEST_TIMEOUT_MS = 24 * 60 * 60 * 1000

export const FREQUENCIES = [
  ['once', 'Once'],
  ['hourly', 'Every hour'],
  ['daily', 'Every day'],
  ['weekdays', 'Weekdays'],
  ['weekly', 'Every week'],
  ['monthly', 'Every month'],
  ['interval', 'Every N…'],
  ['advanced', 'Advanced']
]

export const WEEKDAYS = [
  ['1', 'Monday'],
  ['2', 'Tuesday'],
  ['3', 'Wednesday'],
  ['4', 'Thursday'],
  ['5', 'Friday'],
  ['6', 'Saturday'],
  ['0', 'Sunday']
]

export function defaultScheduleState() {
  return { freq: 'daily', time: '9:0', weekday: '1', monthday: '1', intervalN: '2', intervalUnit: 'h', onceN: '30', onceUnit: 'm', repeatN: '', raw: '' }
}

export function timeOptions() {
  const out = []
  for (let h = 0; h < 24; h += 1) {
    for (const m of [0, 30]) out.push({ id: `${h}:${m}`, h, m })
  }
  return out
}

export function composeSchedule(state) {
  const [h, m] = String(state.time || '9:0').split(':').map(Number)
  switch (state.freq) {
    case 'once':
      return `${Math.max(1, parseInt(state.onceN, 10) || 1)}${state.onceUnit || 'h'}`
    case 'hourly':
      return 'every 1h'
    case 'daily':
      return `${m} ${h} * * *`
    case 'weekdays':
      return `${m} ${h} * * 1-5`
    case 'weekly':
      return `${m} ${h} * * ${state.weekday || '1'}`
    case 'monthly':
      return `${m} ${h} ${state.monthday || '1'} * *`
    case 'interval':
      return `every ${Math.max(1, parseInt(state.intervalN, 10) || 1)}${state.intervalUnit || 'h'}`
    default:
      return state.raw || ''
  }
}

const unitWord = u => (u === 'm' ? 'minutes' : u === 'd' ? 'days' : 'hours')

export function scheduleSummary(state, timeLabel) {
  const cap = state.freq !== 'once' && String(state.repeatN || '').trim() ? `, ${Math.max(1, parseInt(state.repeatN, 10) || 1)} times total` : ''
  switch (state.freq) {
    case 'once':
      return `Runs once, ${Math.max(1, parseInt(state.onceN, 10) || 1)} ${unitWord(state.onceUnit)} from now`
    case 'hourly':
      return `Runs every hour${cap}`
    case 'daily':
      return `Runs every day at ${timeLabel}${cap}`
    case 'weekdays':
      return `Runs on weekdays at ${timeLabel}${cap}`
    case 'weekly':
      return `Runs every ${(WEEKDAYS.find(w => w[0] === state.weekday) || WEEKDAYS[0])[1]} at ${timeLabel}${cap}`
    case 'monthly':
      return `Runs on day ${state.monthday || '1'} of every month at ${timeLabel}${cap}`
    case 'interval':
      return `Runs every ${Math.max(1, parseInt(state.intervalN, 10) || 1)} ${unitWord(state.intervalUnit)}${cap}`
    default:
      return 'Runs on the schedule you typed'
  }
}

/** Best-effort picker state for an existing schedule string (edit); anything
 *  the structured picker cannot express opens as Advanced with the raw text. */
export function scheduleStateFrom(schedule) {
  const s = String(schedule || '').trim()
  const base = defaultScheduleState()
  let m
  if (s === 'every 1h') return { ...base, freq: 'hourly' }
  if ((m = /^every (\d+)([mhd])$/.exec(s))) return { ...base, freq: 'interval', intervalN: m[1], intervalUnit: m[2] }
  if ((m = /^(\d+) (\d+) \* \* \*$/.exec(s)) && ['0', '30'].includes(m[1])) return { ...base, freq: 'daily', time: `${Number(m[2])}:${Number(m[1])}` }
  if ((m = /^(\d+) (\d+) \* \* 1-5$/.exec(s)) && ['0', '30'].includes(m[1])) return { ...base, freq: 'weekdays', time: `${Number(m[2])}:${Number(m[1])}` }
  if ((m = /^(\d+) (\d+) \* \* ([0-6])$/.exec(s)) && ['0', '30'].includes(m[1])) {
    return { ...base, freq: 'weekly', time: `${Number(m[2])}:${Number(m[1])}`, weekday: m[3] }
  }
  if ((m = /^(\d+) (\d+) (\d{1,2}) \* \*$/.exec(s)) && ['0', '30'].includes(m[1])) {
    return { ...base, freq: 'monthly', time: `${Number(m[2])}:${Number(m[1])}`, monthday: m[3] }
  }
  return { ...base, freq: 'advanced', raw: s === '?' ? '' : s }
}

export function normalizedProfileName(profile) {
  return typeof profile === 'string' ? profile.trim().toLowerCase() : ''
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", "'\"'\"'")}'`
}

export function routineInputError(title, instruction) {
  if (String(title).includes('\0')) return 'The name cannot contain a NUL character.'
  if (String(instruction).includes('\0')) return 'The instruction cannot contain a NUL character.'
  return null
}

/** cron.tsx:272: a job created in the bot's own (profile-scoped) cron store
 *  runs the instruction as-is; one created elsewhere wraps it. */
export function routinePrompt(bot, title, instruction, activeProfile) {
  if (normalizedProfileName(bot) && normalizedProfileName(bot) === normalizedProfileName(activeProfile)) return instruction
  return (
    `${SAFE_ROUTINE_MARKER}You are running the scheduled routine "${title}" for agent '${bot}'. ` +
    `Execute it AS that agent so the run lands in its own history: run this in the terminal and relay the output:\n\n` +
    `hermes -p ${shellQuote(bot)} chat -c ${shellQuote(`Routine: ${title}`)} -q ${shellQuote(`[Scheduled routine] ${instruction}`)}\n\n` +
    `If the command fails, report the error instead.`
  )
}

/** cron.tsx:1013 — the cron.manage add body. `activeProfile` is the
 *  window's active profile (host.state.profile), as in stock. */
export function cronAddParams({ profile, title, instruction, sched, continuity = false, target = 'history', activeProfile }) {
  const schedule = composeSchedule(sched).trim()
  const repeatN = sched.freq !== 'once' && sched.freq !== 'advanced' && String(sched.repeatN || '').trim() ? Math.max(1, parseInt(sched.repeatN, 10) || 1) : null
  return {
    action: 'add',
    name: `[bot:${profile}] ${title}`,
    schedule,
    prompt: routinePrompt(profile, title, instruction, activeProfile),
    ...(profile ? { profile } : {}),
    ...(repeatN ? { repeat: repeatN } : {}),
    ...(continuity ? { continuity: true } : {}),
    ...(target === 'bot-chat' ? { deliver: 'bot-chat' } : {})
  }
}

export function cronRemoveParams(bot, job) {
  return { action: 'remove', name: String(job?.job_id || ''), profile: String(bot?.name || 'default') }
}

/** The title a job shows: its name without Bot Mode's `[bot:<name>] ` tag. */
export const BOT_TAG_RE = /^\[bot:([a-z0-9][a-z0-9_-]*)\]\s*/i // cron.tsx:75
export const LEGACY_DELEGATED_ROUTINE_PREFIX = 'You are running the scheduled routine "' // cron.tsx:77

/** cron.tsx:95: the name without Bot Mode's `[bot:<name>] ` tag. */
export function routineTitle(job) {
  return String(job?.name || '').replace(BOT_TAG_RE, '') || 'Untitled job'
}

/** cron.tsx:99: a legacy delegated routine (its switch is disabled in stock). */
export function isLegacyDelegatedRoutine(job) {
  const preview = typeof job?.prompt_preview === 'string' ? job.prompt_preview : job?.prompt
  return Boolean(BOT_TAG_RE.exec(job?.name || '') && typeof preview === 'string' && preview.startsWith(LEGACY_DELEGATED_ROUTINE_PREFIX))
}

/** The edit form's REST body (cron-job-model.ts:137 cronEditorUpdates). Names
 *  keep the `[bot:<profile>]` tag Bot Mode filters by.
 *
 *  Review override-v2-r2 H1/M1/S1: nothing the editor did not hold in full is
 *  written back. `job` is the stored record (GET /api/cron/jobs/{id}), not the
 *  cron.manage list row whose prompt_preview is cut at 100 characters.
 *   - `prompt` is sent only when given (undefined = the full instruction could
 *     not be read, so it is left as stored).
 *   - `model`/`provider` are sent only when the caller has a model control and
 *     passes them; then '' clears the pin as stock does. This editor has none.
 *   - `schedule` is sent unless it equals `initialSchedule`: cron/jobs.py
 *     update_job re-anchors next_run_at whenever a schedule is in the update,
 *     and a one-shot's display text does not parse back. */
export function cronEditUpdates({ profile, job, title, prompt, sched, deliver, model, provider, initialSchedule }) {
  const stored = typeof job?.prompt === 'string' ? job.prompt : String(job?.prompt_preview || '')
  const scriptOnly = !stored.trim() && Boolean(job?.script)
  const tagged = BOT_TAG_RE.test(String(job?.name || ''))
  const schedule = composeSchedule(sched).trim()
  const updates = {
    deliver: deliver ?? job?.deliver ?? 'local',
    name: tagged || profile ? `[bot:${profile}] ${String(title).trim()}` : String(title).trim()
  }
  if (initialSchedule === undefined || schedule !== String(initialSchedule).trim()) updates.schedule = schedule
  if (prompt !== undefined) {
    const trimmed = String(prompt || '').trim()
    if (!scriptOnly || trimmed) updates.prompt = trimmed
  }
  if (!scriptOnly && (model !== undefined || provider !== undefined)) {
    updates.model = String(model ?? '').trim() || null
    updates.provider = String(provider ?? '').trim() || null
  }
  return updates
}

/** A job's id in either shape (review override-v2-r3 M1): the cron.manage
 *  list row says `job_id`, the stored REST record (cron/jobs.py get_job,
 *  GET /api/cron/jobs/{id}) says `id`. '' when absent, or when one object
 *  names two different ids (no trustworthy identity). */
export function cronJobId(job) {
  const listId = job?.job_id == null ? '' : String(job.job_id).trim()
  const storedId = job?.id == null ? '' : String(job.id).trim()
  if (listId && storedId && listId !== storedId) return ''
  return listId || storedId
}

/** Whether a GET /api/cron/jobs/{id} answer is the full record of `job`. */
export function isStoredJobFor(job, stored) {
  const id = cronJobId(job)
  return Boolean(id && stored && typeof stored === 'object' && typeof stored.prompt === 'string' && cronJobId(stored) === id)
}

/** The per-job REST route. Throws without an id: a write must never reach
 *  the collection URL `/api/cron/jobs/`. */
export function cronJobRestPath(job, suffix = '') {
  const id = cronJobId(job)
  if (!id) throw new Error('This job has no id, so it cannot be changed from here')
  return `/api/cron/jobs/${encodeURIComponent(id)}${suffix}`
}

function scheduleLabel(schedule) {
  const once = /^once in (.+)$/.exec(schedule || '')
  if (once) return `Once in ${once[1]}`
  const bare = /^(\d+)([mhd])$/.exec(schedule || '')
  if (bare) return `Once in ${bare[1]}${bare[2]}`
  const match = /^every (\d+)m$/.exec(schedule || '')
  if (match) {
    const minutes = Number(match[1])
    if (minutes % 1440 === 0) return minutes === 1440 ? 'Daily' : `Every ${minutes / 1440} days`
    if (minutes % 60 === 0) return minutes === 60 ? 'Hourly' : `Every ${minutes / 60} hours`
    return `Every ${minutes} minutes`
  }
  return schedule || ''
}

export function routineLastResult(status) {
  const raw = String(status || '').trim()
  if (!raw) return null
  switch (raw) {
    case 'ok':
      return 'Succeeded'
    case 'error':
      return 'Failed'
    case 'delivery_failed':
      return 'Ran, but delivery failed'
    case 'blocked_config':
      return 'Blocked by configuration'
    default:
      return raw
  }
}

function stamp(value) {
  const ms = value ? new Date(value).getTime() : Number.NaN
  return Number.isFinite(ms) ? new Date(ms).toLocaleString() : null
}

/** cron.tsx:370: only facts the list payload carries; absent values drop. */
export function routineDetailRows(job) {
  const paused = job?.enabled === false || job?.state === 'paused'
  const label = scheduleLabel(job?.schedule)
  const raw = String(job?.schedule || '').trim()
  return [
    ['Status', paused ? 'Paused' : 'Active'],
    ['Schedule', label],
    ['Raw schedule', raw && raw !== label ? raw : null],
    ['Repeat', job?.repeat == null ? null : String(job.repeat)],
    ['Next run', paused ? null : stamp(job?.next_run_at)],
    ['Last run', stamp(job?.last_run_at)],
    ['Last result', routineLastResult(job?.last_status)],
    ['Deliver to', job?.deliver],
    ['Model', job?.model],
    ['Working folder', job?.workdir]
  ]
    .filter(([, value]) => typeof value === 'string' && value.trim())
    .map(([label2, value]) => ({ label: label2, value: value.trim() }))
}

export function routineDetailIssue(job) {
  const first = [job?.last_fire_error, job?.last_delivery_error, job?.paused_reason].find(v => typeof v === 'string' && v.trim())
  return first ? first.trim() : null
}
