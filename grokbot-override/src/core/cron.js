// Scheduled jobs for one bot, through the same cron.manage calls Bot Mode's
// Scheduled jobs pane makes (apps/desktop/src/plugins/hermes-bots/cron.tsx).
// The list is a pure read: Bot Mode's own list also pauses legacy delegated
// routines as a side effect; the override does not repeat that.

export function jobActive(job) {
  return job?.enabled !== false && job?.state !== 'paused'
}

export function cronListParams(bot) {
  return { action: 'list', include_disabled: true, profile: String(bot?.name || 'default') }
}

/** Pause an active job, resume a paused one (a user click). */
export function cronToggleParams(bot, job) {
  return { action: jobActive(job) ? 'pause' : 'resume', name: String(job?.job_id || ''), profile: String(bot?.name || 'default') }
}

/** Jobs sorted for the panel: active first, then by next run, then name. */
export function sortJobs(jobs) {
  const next = job => {
    const t = Date.parse(job?.next_run_at || '')
    return Number.isFinite(t) ? t : Infinity
  }
  return [...(Array.isArray(jobs) ? jobs : [])].sort(
    (a, b) => Number(jobActive(b)) - Number(jobActive(a)) || next(a) - next(b) || String(a?.name || '').localeCompare(String(b?.name || ''))
  )
}
