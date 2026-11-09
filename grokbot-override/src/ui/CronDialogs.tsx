// Scheduled job create / edit and the job detail (P3). Form and payloads are
// stock cron.tsx (CreateRoutineDialog, SchedulePicker, RoutineDetailDialog);
// edit and run use the app's own Cron page REST calls (core/cronOps.js).

import * as React from 'react'

import { composeSchedule, defaultScheduleState, FREQUENCIES, routineDetailIssue, routineDetailRows, routineInputError, routineTitle, scheduleStateFrom, scheduleSummary, timeOptions, WEEKDAYS } from '../core/cronOps.js'
import { displayName } from '../core/roster.js'
import { metaFor } from './app'
import { Check, Confirm, Dialog, Field, Select } from './kit'
import { createJob, editJob, loadJob, removeJob, runJob } from './rosterActions'
import { closeDialog, openDialog } from './rosterStores'

const digits = (v: string, n: number) => v.replace(/[^0-9]/g, '').slice(0, n)

function timeLabel(id: string) {
  const [h, m] = id.split(':').map(Number)
  return new Date(2000, 0, 1, h, m).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
}

export function SchedulePicker({ state, setState }: { state: any; setState: (fn: (s: any) => any) => void }) {
  const upd = (patch: any) => setState(s => ({ ...s, ...patch }))
  const needsTime = ['daily', 'weekdays', 'weekly', 'monthly'].includes(state.freq)
  const times = timeOptions().map(t => [t.id, timeLabel(t.id)] as [string, string])
  const unitOptions = (suffix: string): Array<[string, string]> => [
    ['m', `minutes${suffix}`],
    ['h', `hours${suffix}`],
    ['d', `days${suffix}`]
  ]
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <div className={needsTime ? 'gbo-row2' : ''}>
        <Select label="How often" value={state.freq} onChange={v => upd({ freq: v })} options={FREQUENCIES as any} />
        {needsTime ? <Select label="Time" value={state.time} onChange={v => upd({ time: v })} options={times} /> : null}
      </div>
      {state.freq === 'once' ? (
        <div className="gbo-row2">
          <input className="gbo-input" aria-label="In" value={state.onceN} placeholder="30" onChange={e => upd({ onceN: digits(e.target.value, 4) })} />
          <Select label="Unit" value={state.onceUnit} onChange={v => upd({ onceUnit: v })} options={unitOptions(' from now')} />
        </div>
      ) : null}
      {state.freq === 'weekly' ? <Select label="Day" value={state.weekday} onChange={v => upd({ weekday: v })} options={WEEKDAYS as any} /> : null}
      {state.freq === 'monthly' ? (
        <Field label="Day of month">
          <input className="gbo-input" value={state.monthday} placeholder="1" onChange={e => upd({ monthday: digits(e.target.value, 2) })} />
        </Field>
      ) : null}
      {state.freq === 'interval' ? (
        <div className="gbo-row2">
          <input className="gbo-input" aria-label="Every" value={state.intervalN} placeholder="2" onChange={e => upd({ intervalN: digits(e.target.value, 4) })} />
          <Select label="Unit" value={state.intervalUnit} onChange={v => upd({ intervalUnit: v })} options={unitOptions('')} />
        </div>
      ) : null}
      {state.freq === 'advanced' ? (
        <input className="gbo-input" style={{ fontFamily: 'var(--gbo-mono)' }} value={state.raw} placeholder="every 1d · every 2h · 0 9 * * * (cron)" onChange={e => upd({ raw: e.target.value })} />
      ) : null}
      {state.freq !== 'once' && state.freq !== 'advanced' && state.repeatN !== undefined ? (
        <label className="gbo-check">
          <span>Stop after</span>
          <input className="gbo-input" style={{ width: 64 }} value={state.repeatN} placeholder="∞" onChange={e => upd({ repeatN: digits(e.target.value, 4) })} />
          <span>runs</span>
        </label>
      ) : null}
      <span className="gbo-field-hint">
        {scheduleSummary(state, timeLabel(state.time || '9:0'))} · {composeSchedule(state) || '—'}
      </span>
    </div>
  )
}

/** New job (job === null) or edit an existing one.
 *
 *  Review override-v2-r2 H1/M1: an edit starts from the stored record (full
 *  instruction), read on the bot's scope like stock's Cron page; the list
 *  row's prompt_preview is display text and is never written back. Until the
 *  record is read nothing can be saved; if it cannot be read the preview is
 *  shown read-only and the instruction is left as stored. The model pin is
 *  never sent (this editor has no model control), and an unchanged schedule
 *  is not re-sent (it would re-anchor the next run). */
export function JobDialog({ bot, job, onClose }: { bot: any; job: any | null; onClose: () => void }) {
  const editing = Boolean(job)
  const [title, setTitle] = React.useState(() => (job ? routineTitle(job) : ''))
  const [stored, setStored] = React.useState<{ status: 'loading' | 'ready' | 'failed'; job?: any; error?: string }>(() => ({ status: editing ? 'loading' : 'ready' }))
  const [instruction, setInstruction] = React.useState('')
  const [sched, setSched] = React.useState<any>(() => (job ? { ...scheduleStateFrom(job.schedule), repeatN: undefined } : defaultScheduleState()))
  const [initialSchedule] = React.useState(() => (job ? composeSchedule({ ...scheduleStateFrom(job.schedule), repeatN: undefined }).trim() : undefined))
  const [continuity, setContinuity] = React.useState(false)
  const [target, setTarget] = React.useState(() => (job?.deliver === 'bot-chat' ? 'bot-chat' : 'history'))
  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState<null | string>(null)
  const who = displayName(bot, metaFor(bot))
  const schedule = composeSchedule(sched).trim()
  React.useEffect(() => {
    if (!editing) return
    let live = true
    loadJob(bot, job).then(
      full => {
        if (!live) return
        setStored({ status: 'ready', job: full })
        setInstruction(String(full.prompt || ''))
      },
      (err: any) => live && setStored({ status: 'failed', error: String(err?.message || err) })
    )
    return () => {
      live = false
    }
  }, [])
  const base = stored.job || job
  const scriptOnly = editing && stored.status === 'ready' && !String(stored.job?.prompt || '').trim() && Boolean(stored.job?.script)
  const instructionEditable = !editing || stored.status === 'ready'
  const instructionMissing = instructionEditable && !instruction.trim() && !scriptOnly
  const submit = async () => {
    const t = title.trim()
    const task = instruction.trim()
    const bad = routineInputError(t, instructionEditable ? task : '')
    if (bad) return setError(bad)
    if (!t || instructionMissing || !schedule || busy || stored.status === 'loading') return
    setBusy(true)
    setError(null)
    try {
      if (editing) {
        await editJob(bot, job, {
          ...(stored.job ? { stored: stored.job } : {}),
          title: t,
          ...(instructionEditable ? { prompt: task } : {}),
          sched,
          initialSchedule,
          deliver: target === 'bot-chat' ? 'bot-chat' : base.deliver === 'bot-chat' ? 'local' : base.deliver
        })
      } else {
        await createJob(bot, { title: t, instruction: task, sched, continuity, target })
      }
      onClose()
    } catch (err: any) {
      setBusy(false)
      setError(String(err?.message || err))
    }
  }
  return (
    <Dialog
      open
      busy={busy}
      onClose={onClose}
      title={editing ? 'Edit scheduled job' : 'New scheduled job'}
      description={editing ? `A job of ${who}. Saved through Hermes’s Cron API on ${who}’s machine.` : `${who} runs this on a schedule, in its own profile.`}
      footer={
        <>
          <button type="button" className="gbo-btn is-ghost" disabled={busy} onClick={onClose}>
            Cancel
          </button>
          <button type="button" className="gbo-btn is-primary" disabled={busy || stored.status === 'loading' || !title.trim() || instructionMissing || !schedule} onClick={() => void submit()}>
            {busy ? 'Saving…' : editing ? 'Save' : 'Create job'}
          </button>
        </>
      }
    >
      <Field label="Name">
        <input className="gbo-input" autoFocus value={title} placeholder="Morning digest" onChange={e => setTitle(e.target.value)} />
      </Field>
      <Field label="What should it do?">
        {instructionEditable ? (
          <textarea className="gbo-textarea" value={instruction} placeholder={scriptOnly ? 'Optional: this job runs a script' : 'Summarise yesterday’s alerts and send me the top three.'} onChange={e => setInstruction(e.target.value)} />
        ) : (
          <textarea className="gbo-textarea" value={stored.status === 'loading' ? '' : String(job?.prompt_preview || '')} placeholder={stored.status === 'loading' ? 'Loading the full instruction…' : ''} readOnly disabled={stored.status === 'loading'} />
        )}
      </Field>
      {stored.status === 'failed' ? (
        <div className="gbo-form-note">The full instruction could not be read ({stored.error}). It is left unchanged; the other fields can still be saved.</div>
      ) : null}
      <Field label="When to run">
        <SchedulePicker state={sched} setState={setSched} />
      </Field>
      <Field label="Send results to">
        <Select
          label="Send results to"
          value={target}
          onChange={setTarget}
          options={[
            ['history', 'Run history only'],
            ['bot-chat', `${who}’s Bot Chat`]
          ]}
        />
      </Field>
      {editing ? null : (
        <Check checked={continuity} onChange={setContinuity}>
          Continue from the previous run (same session each time)
        </Check>
      )}
      {error ? <div className="gbo-form-error">{error}</div> : null}
    </Dialog>
  )
}

/** Read-only detail (cron.tsx RoutineDetailDialog) with the row's actions. */
export function JobDetailDialog({ bot, job, onClose }: { bot: any; job: any; onClose: () => void }) {
  const rows = routineDetailRows(job)
  const issue = routineDetailIssue(job)
  const instruction = String(job?.prompt_preview || '').trim()
  return (
    <Dialog
      open
      onClose={onClose}
      title={routineTitle(job)}
      description="What Hermes knows about this job."
      footer={
        <>
          <button type="button" className="gbo-btn is-ghost" onClick={() => openDialog({ kind: 'cron-remove', bot, job })}>
            Delete
          </button>
          <span className="gbo-spacer" />
          <button type="button" className="gbo-btn" onClick={() => openDialog({ kind: 'cron-edit', bot, job })}>
            Edit
          </button>
          <button
            type="button"
            className="gbo-btn"
            onClick={() => {
              void runJob(bot, job)
              onClose()
            }}
          >
            Run now
          </button>
          <button type="button" className="gbo-btn is-primary" onClick={onClose}>
            Close
          </button>
        </>
      }
    >
      {issue ? <div className="gbo-form-error">{issue}</div> : null}
      <div className="gbo-detail-rows">
        {rows.map(row => (
          <div key={row.label} className="gbo-detail-row">
            <span>{row.label}</span>
            <span title={row.value}>{row.value}</span>
          </div>
        ))}
      </div>
      {instruction ? (
        <Field label="Instruction">
          <div className="gbo-pre">{instruction}</div>
        </Field>
      ) : null}
    </Dialog>
  )
}

export function JobRemoveDialog({ bot, job, onClose }: { bot: any; job: any; onClose: () => void }) {
  return (
    <Confirm
      open
      title="Delete this job?"
      description={`“${routineTitle(job)}” stops running and is removed from ${displayName(bot, metaFor(bot))}’s schedule.`}
      confirmLabel="Delete job"
      destructive
      onConfirm={() => removeJob(bot, job)}
      onClose={onClose}
    />
  )
}

export const closeCronDialog = closeDialog
