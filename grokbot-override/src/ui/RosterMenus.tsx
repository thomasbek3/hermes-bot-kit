// Roster menus: a bot row's context menu (R11, R12), the filter menu (R6)
// and the New menu (R13). Entries mirror stock Bot Mode's
// bot-row.tsx:300-485 and roster-pane-toolbar.tsx:124-262.

import { botGroups } from '../core/botMeta.js'
import { isDefaultBot } from '../core/profileOps.js'
import { ACTIVITY_FILTERS, botSourceStatus, KIND_FILTERS } from '../core/rosterView.js'
import { app, botSectionId, botsInSection, canPinMore, deleteOwnSection, isPinnedTop, metaFor, moveBotToSection, moveOwnSection, selectBot, toggleTopPin } from './app'
import { IconChatPlus, IconDuplicate, IconEdit, IconEye, IconEyeOff, IconFolder, IconSettings, IconTab, IconTrash, IconUsers } from './iconsRoster'
import { IconPin, IconScreen } from './icons'
import type { MenuEntry } from './kit'
import { duplicateBot, newChatWith, openInNewTab, togglePinned, toggleHidden } from './rosterActions'
import { openDialog, roster2 } from './rosterStores'

let newGroupOpener: null | (() => void) = null
/** Group chats (R14) register their New group chat entry here. */
export function setNewGroupOpener(fn: null | (() => void)) {
  newGroupOpener = fn
}

let screenOpener: null | ((bot: any) => void) = null
export function setScreenOpener(fn: null | ((bot: any) => void)) {
  screenOpener = fn
}

export function botMenuEntries(bot: any): MenuEntry[] {
  const meta = metaFor(bot)
  const groups = botGroups(meta)
  // Pin to top: the override's own pins (core/pins.js), shown as big avatars
  // over the list. Bot Mode's pin (R11, ui_meta) orders a row first in its
  // section and keeps its own entry.
  const top = isPinnedTop(bot)
  const full = !top && !canPinMore()
  const entries: MenuEntry[] = [
    { label: 'Open Bot Chat', icon: <IconChatPlus />, onSelect: () => selectBot(bot) },
    { label: 'Open in new tab', icon: <IconTab />, onSelect: () => void openInNewTab(bot) },
    ...(screenOpener ? [{ label: 'Bot’s computer', icon: <IconScreen />, onSelect: () => screenOpener?.(bot) }] : []),
    'sep',
    { label: top ? 'Unpin' : 'Pin to top', icon: <IconPin />, disabled: full, meta: full ? '4 max' : undefined, onSelect: () => void toggleTopPin(bot) },
    { label: meta?.pinned ? 'Unpin from section' : 'Pin first in section', icon: <IconPin />, onSelect: () => void togglePinned(bot) },
    { label: meta?.hidden ? 'Unhide' : 'Hide', icon: meta?.hidden ? <IconEye /> : <IconEyeOff />, onSelect: () => void toggleHidden(bot) },
    { label: 'Move to section', icon: <IconFolder />, sub: moveToSectionEntries(bot) },
    'sep',
    { label: 'Edit profile…', icon: <IconEdit />, onSelect: () => openDialog({ kind: 'edit', bot }) },
    { label: 'Skills, tools and model…', icon: <IconSettings />, onSelect: () => openDialog({ kind: 'config', bot }) },
    { label: groups.length ? `Groups: ${groups.join(', ')}` : 'Manage groups…', icon: <IconUsers />, onSelect: () => openDialog({ kind: 'groups', bot }) },
    { label: 'Duplicate', icon: <IconDuplicate />, onSelect: () => void duplicateBot(bot) },
    'sep',
    { label: 'New chat with this agent', icon: <IconChatPlus />, onSelect: () => newChatWith(bot) }
  ]
  if (!isDefaultBot(bot)) entries.push('sep', { label: 'Delete…', icon: <IconTrash />, destructive: true, onSelect: () => openDialog({ kind: 'delete', bot }) })
  return entries
}

/** A bot's "Move to section" submenu: the own sections, then Default (the
 *  grouping it has without one), then a new section. */
export function moveToSectionEntries(bot: any): MenuEntry[] {
  const current = botSectionId(bot)
  const entries: MenuEntry[] = app.sections.get().sections.map(section => ({
    label: section.name,
    checked: section.id === current,
    onSelect: () => moveBotToSection(bot, section.id)
  }))
  if (entries.length) entries.push('sep')
  entries.push({ label: 'Default', checked: current === '', onSelect: () => moveBotToSection(bot, '') })
  entries.push('sep', { label: 'New section…', onSelect: () => startNewSection() })
  return entries
}

export function startNewSection() {
  roster2.sectionEdit.set({ kind: 'new' })
}

/** Delete an own section: at once when it is empty, else after a confirm. */
export function requestDeleteSection(id: string) {
  const section = app.sections.get().sections.find(entry => entry.id === id)
  if (!section) return
  const count = botsInSection(id)
  if (count === 0) deleteOwnSection(id)
  else roster2.sectionDelete.set({ id, name: section.name, count })
}

/** A section header's right-click menu. Own sections: rename, move, delete;
 *  the default groupings only offer a new section. */
export function sectionMenuEntries(section: { id?: string; own?: boolean }): MenuEntry[] {
  const list = app.sections.get().sections
  const index = section.own ? list.findIndex(entry => entry.id === section.id) : -1
  if (index < 0) return [{ label: 'New section…', icon: <IconFolder />, onSelect: () => startNewSection() }]
  const id = list[index].id
  return [
    { label: 'Rename…', icon: <IconEdit />, onSelect: () => roster2.sectionEdit.set({ kind: 'rename', id }) },
    { label: 'Move up', disabled: index === 0, onSelect: () => moveOwnSection(id, -1) },
    { label: 'Move down', disabled: index === list.length - 1, onSelect: () => moveOwnSection(id, 1) },
    'sep',
    { label: 'New section…', icon: <IconFolder />, onSelect: () => startNewSection() },
    'sep',
    { label: 'Delete section…', icon: <IconTrash />, destructive: true, onSelect: () => requestDeleteSection(id) }
  ]
}

export function filterMenuEntries(view: { gatewayOptions: any[]; activeFilterCount: number; gateway: string }, groupCount = 0): MenuEntry[] {
  const filters = roster2.filters.get()
  const set = (patch: Record<string, string>) => roster2.filters.set(f => ({ ...f, ...patch }))
  const entries: MenuEntry[] = KIND_FILTERS.map(([value, label]) => ({
    label,
    checked: filters.kind === value,
    disabled: value === 'groups' && groupCount === 0,
    meta: value === 'groups' && groupCount === 0 ? 'none yet' : undefined,
    onSelect: () => set({ kind: value })
  }))
  entries.push('sep')
  for (const [value, label] of ACTIVITY_FILTERS) entries.push({ label, checked: filters.activity === value, onSelect: () => set({ activity: value }) })
  if (view.gatewayOptions.length > 1) {
    entries.push('sep', { label: 'All gateways', checked: view.gateway === 'all', onSelect: () => set({ gateway: 'all' }) })
    for (const option of view.gatewayOptions) {
      const status = botSourceStatus({ sourceError: option.error, sourceReachable: option.reachable })
      entries.push({
        label: `${option.label || option.connectionId}${status.available ? '' : ` · ${status.label}`}`,
        meta: String(option.count),
        checked: view.gateway === option.connectionId,
        onSelect: () => set({ gateway: option.connectionId })
      })
    }
  }
  if (view.activeFilterCount) entries.push('sep', { label: 'Clear filters', onSelect: () => roster2.filters.set({ kind: 'all', activity: 'all', gateway: 'all' }) })
  return entries
}

export function newMenuEntries(): MenuEntry[] {
  return [
    { label: 'New bot…', onSelect: () => openDialog({ kind: 'create' }) },
    ...(newGroupOpener ? [{ label: 'New group chat…', onSelect: () => newGroupOpener?.() }] : []),
    { label: 'New section…', onSelect: () => startNewSection() }
  ]
}

/** Not a component: used by tests to see what a row's menu offers. */
export function _menuLabels(entries: MenuEntry[]): string[] {
  const out: string[] = []
  for (const e of entries) if (e !== 'sep' && !('heading' in e)) out.push(e.label)
  return out
}
