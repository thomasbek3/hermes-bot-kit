// Right panel: big avatar and name, scheduled jobs (create / edit / run /
// remove / detail, on/off switches), the bot's computer, its profile and
// model, and the open chat's context meter. Slack (SlackSetup.tsx), under the
// jobs: a Suggested "Add to Slack" card while the profile has no Slack, or a
// "Slack · <status>" card once it has; never both. Markup uses the reference
// layout's details-panel class names (details__top, details__identity,
// section-label, panel-card, panel-row, toggle; see styles-ref.ts); the
// gbo-* classes are hooks.

import { isLegacyDelegatedRoutine, routineTitle } from '../core/cronOps.js'
import { displayName, handleOf, rowKey } from '../core/roster.js'
import { app, backToOverride, loadCron, metaFor, openComputerViewer, openRoom, toggleCron } from './app'
import { BotAvatar } from './Avatar'
import { RosterDialogs } from './BotDialogs'
import { IconClock, IconPlus, IconScreen, IconX } from './icons'
import { IconEdit, IconPlay, IconRefresh, IconSettings, IconTrash, IconUsers } from './iconsRoster'
import { botFor, openNewGroupForm } from './Rooms'
import { openDialog, roster2 } from './rosterStores'
import { runJob } from './rosterActions'
import { openBotScreen } from './Screen'
import { SlackStatusCard, SuggestedSlack } from './SlackSetup'
import { useStore } from './store'
import { UsageBlock } from './UsageMeter'
import { OverlayScroll } from './OverlayScroll'

function jobWhen(job: any): string {
  const schedule = String(job?.schedule || '').trim()
  const paused = job?.enabled === false || job?.state === 'paused'
  if (paused) return schedule && schedule !== '?' ? `Paused · ${schedule}` : 'Paused'
  if (job?.next_run_at) {
    const next = new Date(job.next_run_at)
    if (!Number.isNaN(next.getTime())) {
      const when = next.toLocaleString(undefined, { weekday: 'short', hour: 'numeric', minute: '2-digit' })
      return schedule && schedule !== '?' ? `${schedule} · next ${when}` : `Next ${when}`
    }
  }
  return schedule && schedule !== '?' ? schedule : ''
}

/** `onClose` draws the panel's own round close button (top right); the
 *  narrow drawer brings its own instead. */
export function ProfilePanel({ bot, onClose }: { bot: any; onClose?: () => void }) {
  const cron = useStore(app.cron)
  const screen = useStore(app.screen)
  const cv = useStore(app.computerViewer)
  const running = useStore(roster2.running)
  useStore(app.roster)
  useStore(roster2.metaWrites)
  const rooms = useStore(app.rooms)
  const botRooms = rooms.loaded && rooms.route ? rooms.rooms.filter((room: any) =>
          (room.members || []).some((m: any) => {
            const member = botFor(String(m.profile || m.member_id), rooms.route)
            return Boolean(member) && rowKey(member) === rowKey(bot)
          })
        )
      : []
  const meta = metaFor(bot)
  const name = displayName(bot, meta)
  const subtitle = [handleOf(bot), meta?.title && meta.title !== name ? meta.title : bot?.title].filter(Boolean).join(' · ')
  const description = String(meta?.description || bot?.description || '').trim()
  // The store holds one bot's jobs: drawn only under that bot (review r2 #1).
  const mine = cron.key === rowKey(bot)
  const jobs = mine && Array.isArray(cron.jobs) ? cron.jobs : []
  const loading = !mine || cron.loading
  const cronError = mine ? cron.error : null
  const status = screen.key === rowKey(bot) ? screen.status : null
  const computerText = `Bot’s computer · ${status == null ? '…' : status.error || status.supported === false ? 'Unavailable' : status.running ? 'Running' : 'Asleep'}`

  return (
    <OverlayScroll as="aside" wrapClassName="details__scroll gbo-panel-scroll" className="details__body gbo-panel" aria-label={`${name} profile`}>
      <div className="details__top">
        {onClose ? (
          <button type="button" className="icon-btn icon-btn--bordered gbo-panel-close" title="Close profile" aria-label="Close profile" onClick={onClose}>
            <IconX />
          </button>
        ) : null}
      </div>
      <div className="details__identity gbo-panel-hero">
        <BotAvatar shapeKey={rowKey(bot)} name={bot.name} meta={meta} size={71} />
        <div className="details__name gbo-panel-name" title={name}>
          {name}
        </div>
        {subtitle ? <div className="gbo-panel-sub">{subtitle}</div> : null}
        {description ? <div className="gbo-panel-sub">{description}</div> : null}
      </div>
      <div className="details__sections">

      <section className="gbo-panel-section">
        <div className="section-label section-label--row gbo-panel-label">
          <span>Scheduled</span>
          <span className="gbo-label-actions">
            <button type="button" className="icon-btn icon-btn--plain" title="New scheduled job" aria-label="New scheduled job" onClick={() => openDialog({ kind: 'cron-edit', bot, job: null })}>
              <IconPlus />
            </button>
            <button type="button" className="icon-btn icon-btn--plain" title="Reload" aria-label="Reload scheduled jobs" onClick={() => void loadCron(bot)}>
              <IconRefresh />
            </button>
          </span>
        </div>
        <div className="panel-card gbo-panel-box">
          {loading && !jobs.length ? <div className="panel-empty gbo-panel-empty">Loading…</div> : null}
          {cronError ? <div className="panel-empty gbo-panel-empty">Could not load jobs: {cronError}</div> : null}
          {!loading && !cronError && !jobs.length ? <div className="panel-empty gbo-panel-empty">No scheduled jobs yet.</div> : null}
          {jobs.map((job: any) => {
            const id = String(job.job_id)
            const legacy = isLegacyDelegatedRoutine(job)
            const on = !legacy && job.enabled !== false && job.state !== 'paused'
            const error = job.last_error || job.last_fire_error || job.last_delivery_error
            const title = routineTitle(job)
            return (
              <div key={id} className="panel-row panel-row--routine gbo-job">
                <span className="panel-row__icon">
                  <IconClock />
                </span>
                <button type="button" className="panel-row__text gbo-job-open gbo-job-main" title={job.prompt_preview || title} onClick={() => openDialog({ kind: 'cron-detail', bot, job })}>
                  <span className="panel-row__title gbo-job-name">{title}</span>
                  <span className="panel-row__sub gbo-job-when">{running[id] ? 'Running now…' : jobWhen(job)}</span>
                  {legacy ? <span className="panel-row__sub gbo-job-error">Old delegated job: recreate it to switch it on</span> : error ? <span className="panel-row__sub gbo-job-error" title={String(error)}>Last run failed</span> : null}
                </button>
                <span className="gbo-job-actions">
                  <button type="button" className="icon-btn icon-btn--plain" title="Run now" aria-label={`Run ${title} now`} disabled={Boolean(running[id])} onClick={() => void runJob(bot, job)}>
                    <IconPlay />
                  </button>
                  <button type="button" className="icon-btn icon-btn--plain" title="Edit" aria-label={`Edit ${title}`} onClick={() => openDialog({ kind: 'cron-edit', bot, job })}>
                    <IconEdit />
                  </button>
                  <button type="button" className="icon-btn icon-btn--plain" title="Delete" aria-label={`Delete ${title}`} onClick={() => openDialog({ kind: 'cron-remove', bot, job })}>
                    <IconTrash />
                  </button>
                </span>
                <button
                  type="button"
                  role="switch"
                  className={`toggle gbo-switch${on ? ' is-on' : ''}`}
                  aria-checked={on}
                  aria-label={`${on ? 'Pause' : 'Resume'} ${title}`}
                  disabled={Boolean(cron.busy?.[id]) || legacy}
                  onClick={() => void toggleCron(bot, job)}
                >
                  <span className="toggle__knob" />
                </button>
              </div>
            )
          })}
        </div>
      </section>

      {/* Slack: one of the two, under the jobs and above Computer. */}
      <SuggestedSlack bot={bot} />
      <SlackStatusCard bot={bot} />

      <section className="gbo-panel-section">
        <div className="section-label gbo-panel-label">
          <span>Computer</span>
        </div>
        <div className="panel-card gbo-panel-box">
          <button type="button" className="panel-row panel-row--link gbo-panel-link" title={computerText} onClick={() => openBotScreen(bot)}>
            <span className="panel-row__glyph">
              <IconScreen />
            </span>
            <span className="panel-row__title">{computerText}</span>
            <span className={`gbo-status-dot${status?.running ? ' is-on' : ''}`} />
          </button>
          {cv.present ? (
            <button type="button" className="panel-row panel-row--link gbo-panel-link" title={`Computer viewer · ${cv.visible ? 'Showing' : 'Hidden'}`} onClick={openComputerViewer}>
              <span className="panel-row__glyph">
                <IconScreen />
              </span>
              <span className="panel-row__title">Computer viewer · {cv.visible ? 'Showing' : 'Hidden'}</span>
              <span className={`gbo-status-dot${cv.visible ? ' is-on' : ''}`} />
            </button>
          ) : null}
        </div>
      </section>

      <section className="gbo-panel-section">
        <div className="section-label gbo-panel-label">
          <span>Context</span>
        </div>
        <div className="panel-card gbo-panel-box">
          <UsageBlock bot={bot} />
        </div>
      </section>

      <section className="gbo-panel-section">
        <div className="section-label gbo-panel-label">
          <span>Profile</span>
        </div>
        <div className="panel-card gbo-panel-box">
          <button type="button" className="panel-row panel-row--link gbo-panel-link" title="Edit profile and avatar" onClick={() => openDialog({ kind: 'edit', bot })}>
            <span className="panel-row__glyph"><IconEdit /></span>
            <span className="panel-row__title">Edit profile and avatar</span>
          </button>
          <button type="button" className="panel-row panel-row--link gbo-panel-link" title="Skills, tools, MCP and model" onClick={() => openDialog({ kind: 'config', bot })}>
            <span className="panel-row__glyph"><IconSettings /></span>
            <span className="panel-row__title">Skills, tools, MCP and model</span>
          </button>
          <button type="button" className="panel-row panel-row--link gbo-panel-link" title="Groups" onClick={() => openDialog({ kind: 'groups', bot })}>
            <span className="panel-row__glyph"><IconUsers /></span>
            <span className="panel-row__title">Groups</span>
          </button>
          {/* R14: this bot's gateway group chats, native (no hand-off). */}
          {botRooms.map((room: any) => (
            <button key={room.room_id} type="button" className="panel-row panel-row--link gbo-panel-link" title={`Open the group chat ${room.name}`} onClick={() => openRoom(rooms.route, room)}>
              <span className="panel-row__glyph"><IconUsers /></span>
              <span className="panel-row__title">{room.name}</span>
            </button>
          ))}
          {rooms.loaded && rooms.route ? (
            <button
              type="button"
              className="panel-row panel-row--link gbo-panel-link"
              title="New group chat…"
              onClick={() => {
                openNewGroupForm()
                backToOverride()
              }}
            >
              <span className="panel-row__glyph"><IconPlus /></span>
              <span className="panel-row__title">New group chat…</span>
            </button>
          ) : null}
        </div>
      </section>
      </div>
      <RosterDialogs />
    </OverlayScroll>
  )
}
