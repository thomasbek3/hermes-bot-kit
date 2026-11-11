// State for the roster-side parity surfaces. Kept apart from app.ts so the
// app module and the action module can both read it without a cycle.

import { DEFAULT_FILTERS } from '../core/rosterView.js'
import { createStore } from './store'

export type DialogState =
  | null
  | { kind: 'edit'; bot: any }
  | { kind: 'delete'; bot: any }
  | { kind: 'groups'; bot: any }
  | { kind: 'create'; tab?: string; caps?: any }
  | { kind: 'config'; bot: any; initial?: any }
  | { kind: 'model'; bot: any }
  | { kind: 'cron-edit'; bot: any; job: any | null }
  | { kind: 'cron-detail'; bot: any; job: any }
  | { kind: 'cron-remove'; bot: any; job: any }
  | { kind: 'slack'; bot: any; initial?: any }
  | { kind: 'slack-status'; bot: any }

/** A bot's configured model as profiles.describe reports it ('' = the
 *  profile has none of its own). */
export interface BotModel {
  loading: boolean
  loaded: boolean
  provider: string
  model: string
  error: null | string
}

/** A bot's reasoning effort and speed as its profile config holds them
 *  ('' = not set, core/modelSheet.js). */
export interface BotModelSettings {
  loading: boolean
  loaded: boolean
  effort: string
  speed: string
  error: null | string
}

export const roster2 = {
  /** R6: session-only, like stock's pane state. */
  filters: createStore<{ kind: string; activity: string; gateway: string }>({ ...DEFAULT_FILTERS }),
  /** R11: stock's $showHiddenBots (session only). */
  hiddenExpanded: createStore(false),
  /** R11: the override's own metadata writes (botMeta.js overlay). */
  metaWrites: createStore<Record<string, any>>({}),
  /** R15: roster key -> {reason, at, message}. */
  attention: createStore<Record<string, any>>({}),
  /** R9: a roster re-read in flight. */
  retrying: createStore(false),
  /** Which dialog is open (one at a time). */
  dialog: createStore<DialogState>(null),
  /** C25: the open chat's usage, keyed by its runtime id. */
  usage: createStore<{ key: string; runtimeId: string; usage: any | null; error: null | string }>({ key: '', runtimeId: '', usage: null, error: null }),
  /** P3: job ids with a run (trigger) in flight. */
  running: createStore<Record<string, boolean>>({}),
  /** The panel's Model row: roster key -> the bot's configured model. */
  models: createStore<Record<string, BotModel>>({}),
  /** The model sheet's Effort and Speed: roster key -> the profile's values. */
  modelSettings: createStore<Record<string, BotModelSettings>>({}),
  /** The open chats' NEW line (core/newMarker.js): roster key -> the id of
   *  the first unread bot message (null: none; absent: not decided), and the
   *  per-bot seen watermark (ms; plugin storage `seenAt`). */
  newLine: createStore<{ markers: Record<string, null | string>; seen: Record<string, number> }>({ markers: {}, seen: {} }),
  /** The roster's own sections: the inline name field that is open (a new
   *  section, or renaming one), and the delete waiting for a confirm. */
  sectionEdit: createStore<null | { kind: 'new' } | { kind: 'rename'; id: string }>(null),
  sectionDelete: createStore<null | { id: string; name: string; count: number }>(null),
  /** Server avatars of bots on other connections (core/remoteAvatars.js):
   *  route key -> data URL, for the app session. */
  remoteAvatars: createStore<Record<string, string>>({})
}

export function openDialog(state: DialogState) {
  roster2.dialog.set(state)
}

export function closeDialog() {
  roster2.dialog.set(null)
}

/** Close `state` only if it is still the open dialog (a late save never
 *  closes the dialog the user moved on to). */
export function closeDialogIf(state: DialogState) {
  if (roster2.dialog.get() === state) roster2.dialog.set(null)
}
