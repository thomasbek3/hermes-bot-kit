// The roster-side dialogs: Edit profile (R12), Delete (R12), Groups (R12),
// New bot (R13), Skills/tools/model (P6, C21), the panel's Model picker, the
// scheduled-job dialogs (P3)
// and the expensive-model confirmation (C21). One dialog at a time
// (rosterStores.dialog); whichever override surface mounts first hosts them.

import * as React from 'react'

import { botGroups, groupMembershipPatch, knownGroups } from '../core/botMeta.js'
import { emptyAdvancedState } from '../core/profileConfig.js'
import { botProfileIdentity, editedLook, NAME_RE, slugTaken } from '../core/profileOps.js'
import { displayName, rowKey } from '../core/roster.js'
import { botSourceStatus } from '../core/rosterView.js'
import { activeConnection, app, metaFor } from './app'
import { BotAvatar, botColor } from './Avatar'
import { OverrideBoundary } from './Boundary'
import { JobDetailDialog, JobDialog, JobRemoveDialog } from './CronDialogs'
import { Check, Confirm, Dialog, Field, Select, Tabs } from './kit'
import { AdvancedConfig, ModelExtraFields, ModelPicker } from './ProfileConfig'
import {
  createBot,
  deleteBot,
  ensureBotProfile,
  generateAvatar,
  groupHasRoom,
  listConnections,
  loadBotModel,
  loadBotModelSettings,
  type ModelSheetValue,
  loadCreateCatalog,
  probeImageGeneration,
  saveAdvanced,
  saveBotModelSheet,
  saveMeta,
  saveProfileEdits,
  setConfirmAsker
} from './rosterActions'
import { closeDialogIf, roster2 } from './rosterStores'
import { blobatarMarkup } from './sdk'
import { SlackDialog, SlackStatusDialog } from './SlackSetup'
import { useStore } from './store'

// ── dialog host election ────────────────────────────────────────────────

let hostSeq = 0
const hosts: number[] = []
const hostChange = new Set<() => void>()

function useIsDialogHost() {
  const [id] = React.useState(() => ++hostSeq)
  const [, force] = React.useReducer((n: number) => n + 1, 0)
  React.useEffect(() => {
    hosts.push(id)
    hostChange.forEach(fn => fn())
    hostChange.add(force)
    return () => {
      hostChange.delete(force)
      const at = hosts.indexOf(id)
      if (at >= 0) hosts.splice(at, 1)
      hostChange.forEach(fn => fn())
    }
  }, [id])
  return hosts.length ? hosts[0] === id : true
}

export function RosterDialogs() {
  const isHost = useIsDialogHost()
  const dialog = useStore(roster2.dialog)
  const [confirm, setConfirm] = React.useState<null | { message: string; resolve: (v: boolean) => void }>(null)
  React.useEffect(() => {
    if (!isHost) return
    setConfirm(null)
    setConfirmAsker(message => new Promise<boolean>(resolve => setConfirm({ message, resolve })))
    return () => setConfirmAsker(null)
  }, [isHost])
  // Review override-v2-r2 sweep: a dialog's save can finish after the user
  // moved to another dialog; its close then leaves the newer one open.
  const close = React.useCallback(() => closeDialogIf(dialog), [dialog])
  if (!isHost) return null
  // Each dialog renders inside its own boundary: a dialog error closes into
  // an inline card (Try again closes the dialog) instead of taking the
  // roster or chat pane with it.
  return (
    <OverrideBoundary key={dialog?.kind || 'none'} area="dialog" onReset={close}>
      {dialog?.kind === 'edit' ? <EditProfileDialog bot={dialog.bot} onClose={close} /> : null}
      {dialog?.kind === 'config' ? <ConfigDialog bot={dialog.bot} initial={dialog.initial} onClose={close} /> : null}
      {dialog?.kind === 'model' ? <ModelDialog bot={dialog.bot} onClose={close} /> : null}
      {dialog?.kind === 'groups' ? <GroupsDialog bot={dialog.bot} onClose={close} /> : null}
      {dialog?.kind === 'create' ? <CreateBotDialog initialTab={dialog.tab} initialCaps={dialog.caps} onClose={close} /> : null}
      {dialog?.kind === 'delete' ? (
        <Confirm
          open
          title="Delete this bot?"
          description={
            <span>
              This permanently deletes <strong>{dialog.bot.name}</strong> and its Hermes profile{dialog.bot.path ? <> at <code>{dialog.bot.path}</code></> : null}
              {dialog.bot.connectionLabel ? ` on ${dialog.bot.connectionLabel}` : ''}. This cannot be undone.
            </span>
          }
          confirmLabel="Delete"
          destructive
          onConfirm={() => deleteBot(dialog.bot)}
          onClose={close}
        />
      ) : null}
      {dialog?.kind === 'cron-edit' ? <JobDialog bot={dialog.bot} job={dialog.job} onClose={close} /> : null}
      {dialog?.kind === 'cron-detail' ? <JobDetailDialog bot={dialog.bot} job={dialog.job} onClose={close} /> : null}
      {dialog?.kind === 'cron-remove' ? <JobRemoveDialog bot={dialog.bot} job={dialog.job} onClose={close} /> : null}
      {dialog?.kind === 'slack' ? <SlackDialog bot={dialog.bot} initial={dialog.initial} onClose={close} /> : null}
      {dialog?.kind === 'slack-status' ? <SlackStatusDialog bot={dialog.bot} onClose={close} /> : null}
      {confirm ? (
        <Confirm
          open
          title="Use this model?"
          description={confirm.message}
          confirmLabel="Switch anyway"
          onConfirm={() => confirm.resolve(true)}
          onClose={() => {
            confirm.resolve(false)
            setConfirm(null)
          }}
        />
      ) : null}
    </OverrideBoundary>
  )
}

// ── avatar picker (avatar-picker.tsx) ────────────────────────────────────

const BLOB_KINDS = ['round', 'organic', 'boxy', 'capsule', 'nub', 'cloud', 'droplet', 'hexagon', 'sun', 'triangle']
const SWATCHES = ['#8b5cf6', '#3b82f6', '#0ea5e9', '#14b8a6', '#22c55e', '#eab308', '#f97316', '#ef4444', '#ec4899', '#64748b']

function parseBlob(shape: string) {
  const parts = String(shape || '').split(':')
  return { seedPart: parts[1] || '', kind: BLOB_KINDS.includes(parts[2]) ? parts[2] : '' }
}

function blobShape(seedPart: string, kind: string) {
  return kind ? `blobatar:${seedPart}:${kind}` : seedPart ? `blobatar:${seedPart}` : 'blobatar'
}

/** Normalize an uploaded picture to a 256 px square (avatar-image.ts:18). */
function normalizeImage(dataUrl: string, edge = 256): Promise<string> {
  return new Promise(resolve => {
    try {
      const img = new Image()
      img.onload = () => {
        try {
          const canvas = document.createElement('canvas')
          canvas.width = edge
          canvas.height = edge
          const side = Math.min(img.width, img.height)
          canvas.getContext('2d')!.drawImage(img, (img.width - side) / 2, (img.height - side) / 2, side, side, 0, 0, edge, edge)
          resolve(canvas.toDataURL('image/png'))
        } catch {
          resolve(dataUrl)
        }
      }
      img.onerror = () => resolve(dataUrl)
      img.src = dataUrl
    } catch {
      resolve(dataUrl)
    }
  })
}

export function AvatarPicker({ name, title, description, look, setLook }: { name: string; title: string; description: string; look: any; setLook: (fn: (l: any) => any) => void }) {
  const [tab, setTab] = React.useState('face')
  const [gen, setGen] = React.useState<{ available: null | boolean; busy: boolean; error: null | string }>({ available: null, busy: false, error: null })
  const seedName = name || 'agent'
  const { seedPart, kind } = parseBlob(look.shape)
  React.useEffect(() => {
    if (tab === 'generate' && gen.available !== true) void probeImageGeneration().then(available => setGen(g => ({ ...g, available })))
  }, [tab])
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      <Tabs
        value={tab}
        onChange={setTab}
        tabs={[
          ['face', 'Face'],
          ['upload', 'Photo'],
          ['generate', 'Generate']
        ]}
      />
      {tab === 'face' ? (
        <>
          {blobatarMarkup('x', 8) !== null ? (
            <div className="gbo-face-grid">
              {BLOB_KINDS.map(k => (
                <button
                  key={k}
                  type="button"
                  className="gbo-face-btn"
                  aria-pressed={!look.image && String(look.shape || '').startsWith('blobatar') && kind === k}
                  title={k}
                  onClick={() => setLook(l => ({ ...l, image: null, shape: blobShape(seedPart, k) }))}
                >
                  <BotAvatar look="hermes" name={seedName} meta={{ shape: blobShape(seedPart, k), color: look.color, custom: true }} size={34} />
                </button>
              ))}
            </div>
          ) : null}
          <button type="button" className="gbo-link-btn" style={{ alignSelf: 'flex-start' }} onClick={() => setLook(l => ({ ...l, image: null, shape: blobShape(Math.random().toString(36).slice(2, 10), kind) }))}>
            Shuffle face
          </button>
          <div className="gbo-swatches" role="group" aria-label="Colour">
            <button type="button" className="gbo-swatch is-auto" aria-pressed={!look.color} title="From the name" onClick={() => setLook(l => ({ ...l, color: null }))} />
            {SWATCHES.map(c => (
              <button key={c} type="button" className="gbo-swatch" style={{ background: c }} aria-pressed={look.color === c} title={c} onClick={() => setLook(l => ({ ...l, color: c }))} />
            ))}
          </div>
        </>
      ) : null}
      {tab === 'upload' ? (
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <label className="gbo-btn is-small">
            Choose a picture…
            <input
              type="file"
              accept="image/png,image/jpeg,image/webp,image/gif"
              style={{ display: 'none' }}
              onChange={event => {
                const file = event.target.files?.[0]
                if (!file || file.size > 15_000_000) return
                const reader = new FileReader()
                reader.onload = async () => {
                  if (typeof reader.result === 'string') {
                    const image = await normalizeImage(reader.result)
                    setLook(l => ({ ...l, image }))
                  }
                }
                reader.readAsDataURL(file)
              }}
            />
          </label>
          {look.image ? (
            <button type="button" className="gbo-btn is-small is-ghost" onClick={() => setLook(l => ({ ...l, image: null }))}>
              Remove picture
            </button>
          ) : null}
        </div>
      ) : null}
      {tab === 'generate' ? (
        gen.available === false ? (
          <div className="gbo-form-note">No image generator is configured on this Hermes.</div>
        ) : (
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <button
              type="button"
              className="gbo-btn is-small"
              disabled={gen.busy || gen.available === null}
              onClick={async () => {
                setGen(g => ({ ...g, busy: true, error: null }))
                try {
                  const raw = await generateAvatar(seedName, title, description)
                  const image = raw.startsWith('data:') ? await normalizeImage(raw) : raw
                  setLook(l => ({ ...l, image }))
                  setGen(g => ({ ...g, busy: false }))
                } catch (err: any) {
                  setGen(g => ({ ...g, busy: false, error: String(err?.message || err) }))
                }
              }}
            >
              {gen.busy ? 'Generating…' : gen.available === null ? 'Checking…' : 'Generate a picture'}
            </button>
            {gen.error ? <span className="gbo-card-error">{gen.error}</span> : null}
          </div>
        )
      ) : null}
    </div>
  )
}

// ── Edit profile ─────────────────────────────────────────────────────────

function lookOf(bot: any, meta: any) {
  return { shape: meta?.shape || 'blobatar', color: meta?.color ?? null, image: meta?.image ?? null, title: meta?.title || bot?.title || '' }
}

export function EditProfileDialog({ bot: row, onClose }: { bot: any; onClose: () => void }) {
  const [bot, setBot] = React.useState(row)
  const meta = metaFor(row)
  const [opened] = React.useState(() => lookOf(row, meta))
  const [look, setLook] = React.useState(() => lookOf(row, meta))
  const [description, setDescriptionState] = React.useState(String(row.description || ''))
  // Review override-v2-r2 sweep: the server read below may land after the
  // user started typing; it then only updates the baseline, never the text.
  const descriptionTouched = React.useRef(false)
  const setDescription = (value: string) => {
    descriptionTouched.current = true
    setDescriptionState(value)
  }
  const [advancedOpen, setAdvancedOpen] = React.useState(false)
  const [adv, setAdv] = React.useState<any>(emptyAdvancedState())
  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState<null | string>(null)
  React.useEffect(() => {
    // canonical-chat.ts ensureBotProfile: the description its own backend holds.
    let live = true
    void ensureBotProfile(row).then(next => {
      if (!live) return
      setBot(next)
      if (next.description !== row.description && !descriptionTouched.current) setDescriptionState(String(next.description || ''))
    })
    return () => {
      live = false
    }
  }, [rowKey(row)])
  const submit = async () => {
    setBusy(true)
    setError(null)
    try {
      const failed = await saveProfileEdits(bot, { look: editedLook(opened, look), description, advanced: advancedOpen ? adv : null })
      if (failed.length) setError(`Saved, except: ${failed.join(', ')}`)
      else onClose()
    } catch (err: any) {
      setError(String(err?.message || err))
    } finally {
      setBusy(false)
    }
  }
  return (
    <Dialog
      open
      wide={advancedOpen}
      busy={busy}
      onClose={onClose}
      title="Edit profile"
      description={`${displayName(bot, null)} · profile ${bot.name}${bot.connectionLabel ? ` on ${bot.connectionLabel}` : ''}`}
      footer={
        <>
          <button type="button" className="gbo-btn is-ghost" disabled={busy} onClick={onClose}>
            Cancel
          </button>
          <button type="button" className="gbo-btn is-primary" disabled={busy} onClick={() => void submit()}>
            {busy ? 'Saving…' : 'Save'}
          </button>
        </>
      }
    >
      <div className="gbo-avatar-hero">
        <BotAvatar look="hermes" name={bot.name} meta={{ ...look, custom: true }} size={64} />
      </div>
      <AvatarPicker name={bot.name} title={look.title} description={description} look={look} setLook={setLook} />
      <Field label="Name shown">
        <input className="gbo-input" value={look.title} placeholder={displayName(bot, null)} onChange={e => setLook(l => ({ ...l, title: e.target.value }))} />
      </Field>
      <Field label="Description">
        <textarea className="gbo-textarea" value={description} placeholder="What this bot is for" onChange={e => setDescription(e.target.value)} />
      </Field>
      <button type="button" className="gbo-disclosure" aria-expanded={advancedOpen} onClick={() => setAdvancedOpen(v => !v)}>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <path d="m6 9 6 6 6-6" />
        </svg>
        Skills, tools, MCP, model and SOUL
      </button>
      {advancedOpen ? (
        <div className="gbo-section-card">
          <AdvancedConfig bot={bot} state={adv} setState={setAdv} />
        </div>
      ) : null}
      {error ? <div className="gbo-form-error">{error}</div> : null}
    </Dialog>
  )
}

/** P6 on its own: skills, tools, MCP, model and SOUL for one bot. */
/** `initial`: an already-read config (e.g. handed over from another view),
 *  else it is read on open. */
export function ConfigDialog({ bot, initial, onClose }: { bot: any; initial?: any; onClose: () => void }) {
  const [adv, setAdv] = React.useState<any>(() => (initial?.loaded ? initial : emptyAdvancedState()))
  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState<null | string>(null)
  const dirty = adv.dirtyModel || adv.dirtySoul || adv.dirtySkills || adv.dirtyToolsets || adv.dirtyMcp
  return (
    <Dialog
      open
      wide
      busy={busy}
      onClose={onClose}
      title={`${displayName(bot, metaFor(bot))}: skills, tools and model`}
      description="Changes are written to the bot’s own Hermes profile on save."
      footer={
        <>
          <button type="button" className="gbo-btn is-ghost" disabled={busy} onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="gbo-btn is-primary"
            disabled={busy || !dirty}
            onClick={async () => {
              setBusy(true)
              setError(null)
              try {
                const res = await saveAdvanced(bot, adv)
                const failed = Object.entries(res?.applied || {})
                  .filter(([, ok]) => !ok)
                  .map(([k]) => k)
                if (failed.length) setError(`Not saved: ${failed.join(', ')}`)
                else onClose()
              } catch (err: any) {
                setError(String(err?.message || err))
              } finally {
                setBusy(false)
              }
            }}
          >
            {busy ? 'Saving…' : 'Save'}
          </button>
        </>
      }
    >
      <AdvancedConfig bot={bot} state={adv} setState={setAdv} />
      {error ? <div className="gbo-form-error">{error}</div> : null}
    </Dialog>
  )
}

/** The panel's Model row: provider, model, reasoning effort and speed for one
 *  bot, written to its own profile in one Save (rosterActions
 *  saveBotModelSheet). It opens at once: the values come from the stores the
 *  panel row already filled (profiles.describe, config.get), the catalogue
 *  from the shared cache, and anything still on its way fills in place. */
export function ModelDialog({ bot, onClose }: { bot: any; onClose: () => void }) {
  const key = rowKey(bot)
  const current = useStore(roster2.models)[key]
  const settings = useStore(roster2.modelSettings)[key]
  // The values the sheet opened on (what Save compares against), and the edits.
  const [edits, setEdits] = React.useState<Partial<ModelSheetValue>>({})
  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState<null | string>(null)
  React.useEffect(() => {
    void loadBotModel(bot, { foreground: true })
    void loadBotModelSettings(bot, { foreground: true })
  }, [key])
  const before: ModelSheetValue = {
    provider: current?.provider || '',
    model: current?.model || '',
    effort: settings?.effort || '',
    speed: settings?.speed || ''
  }
  const value: ModelSheetValue = { ...before, ...edits }
  const modelReady = Boolean(current?.loaded)
  const settingsReady = Boolean(settings?.loaded)
  const dirty = Object.keys(edits).some(k => (edits as any)[k] !== (before as any)[k])
  const save = async () => {
    setBusy(true)
    setError(null)
    try {
      const res: any = await saveBotModelSheet(bot, before, value)
      if (res?.ok) onClose()
      else if (res?.applied?.model === false && res?.confirmation?.accepted === false) setError('Not saved: the model was not confirmed.')
      else {
        const failed = Object.entries(res?.applied || {})
          .filter(([, ok]) => !ok)
          .map(([k]) => (res?.errors?.[k] ? `${k} (${res.errors[k]})` : k))
        setError(`Not saved: ${failed.join(', ') || 'model'}`)
        // What did save is now the bot's value; keep only the edits that failed.
        setEdits(e => Object.fromEntries(Object.entries(e).filter(([k]) => res?.applied?.[k === 'provider' ? 'model' : k] !== true)))
      }
    } catch (err: any) {
      setError(String(err?.message || err))
    } finally {
      setBusy(false)
    }
  }
  return (
    <Dialog
      open
      busy={busy}
      onClose={onClose}
      title={`${displayName(bot, metaFor(bot))}: model`}
      description="Written to the bot’s own Hermes profile on save."
      footer={
        <>
          <button type="button" className="gbo-btn is-ghost" disabled={busy} onClick={onClose}>
            Cancel
          </button>
          <button type="button" className="gbo-btn is-primary" disabled={busy || !dirty || !modelReady} onClick={() => void save()}>
            {busy ? 'Saving…' : 'Save'}
          </button>
        </>
      }
    >
      <ModelPicker
        bot={bot}
        foreground
        disabled={!modelReady}
        value={{ provider: value.provider, model: value.model }}
        onChange={patch => setEdits(e => ({ ...e, ...patch }))}
      >
        <ModelExtraFields
          bot={bot}
          provider={value.provider}
          model={value.model}
          effort={value.effort}
          speed={value.speed}
          disabled={!settingsReady}
          onChange={patch => setEdits(e => ({ ...e, ...patch }))}
        />
      </ModelPicker>
      {current?.error && !modelReady ? <div className="gbo-form-error">Could not read the bot’s model: {current.error}</div> : null}
      {settings?.error && !settingsReady ? <div className="gbo-form-error">Could not read the bot’s effort and speed: {settings.error}</div> : null}
      {error ? <div className="gbo-form-error">{error}</div> : null}
    </Dialog>
  )
}

// ── Groups (create-dialog.tsx GroupDialog) ───────────────────────────────

export function GroupsDialog({ bot, onClose }: { bot: any; onClose: () => void }) {
  useStore(roster2.metaWrites)
  useStore(app.roster)
  const [name, setName] = React.useState('')
  const [error, setError] = React.useState<null | string>(null)
  const [busy, setBusy] = React.useState(false)
  const meta = metaFor(bot)
  const current = botGroups(meta)
  const groups = knownGroups(app.roster.get().rows.map((r: any) => metaFor(r)))
  const who = displayName(bot, meta)
  // memberMachineOffline: its groups[] lives on its own machine.
  const locked = Boolean(bot.remoteSource && !botSourceStatus(bot).available)
  const setMembership = async (group: string, enabled: boolean) => {
    if (groupHasRoom(group)) {
      setError(`“${group}” has a group chat room. Change its members from the room’s member list so the room’s seats stay in step.`)
      return false
    }
    setBusy(true)
    setError(null)
    try {
      const res = await saveMeta(bot, groupMembershipPatch(metaFor(bot), group, enabled), {
        rebase: server => groupMembershipPatch(server, group, enabled),
        label: 'The group change'
      })
      if (bot.remoteSource && (res.serverOutcome === 'failed' || res.serverOutcome === 'unreachable')) {
        setError(`${who}’s machine did not take the change.`)
        return false
      }
      return true
    } catch (err: any) {
      setError(String(err?.message || err))
      return false
    } finally {
      setBusy(false)
    }
  }
  return (
    <Dialog
      open
      busy={busy}
      onClose={onClose}
      title="Groups"
      description={`Groups ${who} belongs to. A bot can be in several.`}
      footer={
        <>
          {current.length ? (
            <button
              type="button"
              className="gbo-btn is-ghost"
              disabled={locked || busy}
              onClick={async () => {
                for (const group of current) if (!(await setMembership(group, false))) return
              }}
            >
              Remove from all groups
            </button>
          ) : null}
          <span className="gbo-spacer" />
          <button type="button" className="gbo-btn is-primary" onClick={onClose}>
            Done
          </button>
        </>
      }
    >
      {groups.length ? (
        <div className="gbo-check-list is-one">
          {groups.map(group => (
            <Check key={group} checked={current.includes(group)} disabled={locked || busy} onChange={v => void setMembership(group, v)}>
              {group}
            </Check>
          ))}
        </div>
      ) : null}
      {locked ? <div className="gbo-form-note">{who}’s machine is offline; its groups can change once it is back.</div> : null}
      <form
        style={{ display: 'flex', gap: 8 }}
        onSubmit={event => {
          event.preventDefault()
          const trimmed = name.trim()
          if (trimmed && !locked) {
            void setMembership(trimmed, true)
            setName('')
          }
        }}
      >
        <input className="gbo-input" autoFocus disabled={locked} value={name} placeholder={groups.length ? 'New group…' : 'Group name (e.g. Research)'} onChange={e => setName(e.target.value)} />
        <button type="submit" className="gbo-btn is-small" disabled={locked || !name.trim() || busy}>
          Create & join
        </button>
      </form>
      {error ? <div className="gbo-form-error">{error}</div> : null}
    </Dialog>
  )
}

// ── New bot (create-dialog.tsx CreateAgentDialog) ────────────────────────

export function CreateBotDialog({ onClose, initialTab = 'general', initialCaps = null }: { onClose: () => void; initialTab?: string; initialCaps?: any }) {
  useStore(app.roster)
  const [name, setName] = React.useState('')
  const [title, setTitle] = React.useState('')
  const [description, setDescription] = React.useState('')
  const [look, setLook] = React.useState<any>({ shape: blobatarMarkup('x', 8) !== null ? 'blobatar' : 'circle', color: null, image: null })
  const [tab, setTab] = React.useState(initialTab)
  const [target, setTarget] = React.useState('')
  const [connections, setConnections] = React.useState<any[]>([])
  const [cloneFrom, setCloneFrom] = React.useState('default')
  const [model, setModel] = React.useState({ provider: '', model: '' })
  const [soul, setSoul] = React.useState('')
  const [noSkills, setNoSkills] = React.useState(false)
  const [shareAuth, setShareAuth] = React.useState(true)
  const [caps, setCaps] = React.useState<any>(initialCaps ? { target: '', ...initialCaps } : null)
  const [capsError, setCapsError] = React.useState<null | string>(null)
  const [dirtyCaps, setDirtyCaps] = React.useState({ skills: false, toolsets: false, mcp: false })
  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState<null | string>(null)
  React.useEffect(() => {
    void listConnections().then(setConnections)
  }, [])
  const active = String(activeConnection() || '')
  const rows = app.roster.get().rows
  const { slug, title: botTitle } = botProfileIdentity(name, title)
  const valid = slug.length > 0 && NAME_RE.test(slug)
  const remote = Boolean(target)
  const taken = slugTaken(rows, slug, target)
  const capSource = cloneFrom === '__none__' || remote ? 'default' : cloneFrom
  React.useEffect(() => {
    if (tab !== 'capabilities' || (caps && caps.source === capSource && caps.target === target)) return
    let live = true
    setCapsError(null)
    loadCreateCatalog(target, capSource)
      .then(next => live && setCaps({ ...next, target }))
      .catch(err => live && setCapsError(String(err?.message || err)))
    return () => {
      live = false
    }
  }, [tab, capSource, target])
  const localBots = rows.filter((b: any) => !b.remoteSource)
  const toggleCap = (kind: 'skills' | 'toolsets' | 'mcp', capName: string, enabled: boolean) => {
    setDirtyCaps(d => ({ ...d, [kind]: true }))
    setCaps((c: any) => (c ? { ...c, [kind]: c[kind].map((x: any) => (x.name === capName ? { ...x, enabled } : x)) } : c))
  }
  const submit = async () => {
    if (!valid || taken || busy) return
    setBusy(true)
    setError(null)
    try {
      await createBot({
        name,
        slug,
        title: botTitle,
        description,
        target,
        targetLabel: connections.find(c => c.id === target)?.label,
        cloneFrom,
        noSkills,
        shareAuth,
        customSoul: soul,
        model: model.model,
        provider: model.provider,
        look,
        caps,
        dirtyCaps
      })
      onClose()
    } catch (err: any) {
      setBusy(false)
      setError(String(err?.message || err))
    }
  }
  const otherConnections = connections.filter(c => c?.id && c.id !== 'local' && c.id !== active)
  return (
    <Dialog
      open
      wide={tab !== 'general'}
      busy={busy}
      onClose={onClose}
      title="New bot"
      description="A named agent with its own memory, skills and Bot Chat."
      footer={
        <>
          <button type="button" className="gbo-btn is-ghost" disabled={busy} onClick={onClose}>
            Cancel
          </button>
          <button type="button" className="gbo-btn is-primary" disabled={busy || !valid || taken} onClick={() => void submit()}>
            {busy ? 'Creating…' : 'Create bot'}
          </button>
        </>
      }
    >
      <div className="gbo-avatar-hero">
        <BotAvatar look="hermes" name={slug || 'agent'} meta={{ ...look, custom: true, color: look.color || botColor(slug || 'agent', null) }} size={56} />
      </div>
      <Tabs
        value={tab}
        onChange={setTab}
        tabs={[
          ['general', 'General'],
          ['model', 'Model & SOUL'],
          ['capabilities', 'Skills & tools']
        ]}
      />
      {tab === 'general' ? (
        <>
          <AvatarPicker name={slug} title={botTitle} description={description} look={look} setLook={setLook} />
          <div className="gbo-row2">
            <Field label="Name" hint={name && !valid ? 'Letters, digits, - and _ only' : taken ? 'A bot with this name already exists there' : slug && slug !== name.trim() ? `Profile id: ${slug}` : undefined}>
              <input className="gbo-input" autoFocus value={name} placeholder="scout" onChange={e => setName(e.target.value)} />
            </Field>
            <Field label="Title (optional)">
              <input className="gbo-input" value={title} placeholder="Research scout" onChange={e => setTitle(e.target.value)} />
            </Field>
          </div>
          <Field label="What is it for?">
            <textarea className="gbo-textarea" value={description} placeholder="Finds and summarises what matters." onChange={e => setDescription(e.target.value)} />
          </Field>
          {otherConnections.length ? (
            <Field label="Create on">
              <Select
                label="Create on"
                value={target}
                onChange={setTarget}
                options={[['', 'This Hermes (active connection)'], ...otherConnections.map(c => [c.id, c.label || c.id] as [string, string])]}
              />
            </Field>
          ) : null}
        </>
      ) : null}
      {tab === 'model' ? (
        <>
          {remote ? null : (
            <Field label="Start from" hint="Copies config, skills and SOUL from that profile.">
              <Select label="Start from" value={cloneFrom} onChange={setCloneFrom} options={[['default', 'Hermes (default profile)'], ...localBots.filter((b: any) => b.name !== 'default').map((b: any) => [b.name, displayName(b, metaFor(b))] as [string, string]), ['__none__', 'A fresh profile']]} />
            </Field>
          )}
          <ModelPicker bot={remote ? { name: 'default', connectionId: target, remoteSource: true, sourceScoped: true, route: { connectionId: target, mode: 'remote', profile: 'default', targetProfile: 'default' } } : null} value={model} onChange={patch => setModel(m => ({ ...m, ...patch }))} />
          <Field label="SOUL (optional)" hint="Leave empty for an identity built from the name and description.">
            <textarea className="gbo-textarea is-mono" value={soul} onChange={e => setSoul(e.target.value)} />
          </Field>
          <Check checked={shareAuth} onChange={setShareAuth}>
            Share sign-ins with the main profile
          </Check>
          <Check checked={noSkills} onChange={setNoSkills}>
            Start with no skills
          </Check>
        </>
      ) : null}
      {tab === 'capabilities' ? (
        capsError ? (
          <div className="gbo-form-note">Could not read the starting profile’s capabilities ({capsError}). You can change them after creating the bot.</div>
        ) : !caps ? (
          <div className="gbo-form-note">Loading…</div>
        ) : (
          <>
            {(['skills', 'toolsets', 'mcp'] as const).map(kind => (
              <Field key={kind} label={kind === 'mcp' ? 'MCP servers' : kind === 'skills' ? 'Skills' : 'Toolsets'}>
                <div className={`gbo-check-list${kind === 'mcp' ? ' is-one' : ''}`}>
                  {(caps[kind] || []).map((x: any) => (
                    <Check key={x.name} title={x.description || x.name} checked={Boolean(x.enabled)} onChange={v => toggleCap(kind, x.name, v)}>
                      {x.name}
                    </Check>
                  ))}
                </div>
              </Field>
            ))}
          </>
        )
      ) : null}
      {error ? <div className="gbo-form-error">{error}</div> : null}
    </Dialog>
  )
}
