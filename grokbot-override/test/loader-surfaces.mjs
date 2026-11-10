// Shared fixtures and drivers for the loader-faithful smoke and click-through
// tests (loader-smoke*.test.mjs, loader-clickthrough.test.mjs,
// loader-wiring.test.mjs). Everything runs on the ONE loader replica
// (hermes-loader.mjs via loader-boot.mjs): the built plugin.js, shim modules
// over production React, the runtime loader's specifier rewrite, a jsdom DOM
// and createRoot, driven with clicks.

import assert from 'node:assert/strict'

import { reactRequire } from './hermes-loader.mjs'
import { bootPlugin, history, LOCAL, REMOTE, waitFor } from './loader-boot.mjs'

export const NOW_S = Math.floor(Date.now() / 1000)

export const SCOUT = {
  name: 'scout',
  connectionId: 'mini',
  connectionLabel: 'Mini',
  connectionKind: 'ssh',
  remoteSource: true,
  sourceScoped: true,
  route: { connectionId: 'mini', mode: 'remote', profile: 'scout', targetProfile: 'scout' },
  canonical_session: { id: 'sc-root', preview: 'On it', last_active: NOW_S - 20 },
  ui_meta: { 'hermes-bots': { pinned: true, title: 'Scout', groups: ['Research'] } }
}
export const QUIET = { name: 'quiet', connectionId: 'local', ui_meta: { 'hermes-bots': { hidden: true } }, last_session: { last_active: NOW_S - 40 * 86400 } }
export const FAR = {
  name: 'far',
  connectionId: 'cloud',
  connectionLabel: 'Cloud',
  connectionKind: 'cloud',
  remoteSource: true,
  sourceScoped: true,
  sourceReachable: false,
  route: { connectionId: 'cloud', mode: 'remote', profile: 'far', targetProfile: 'far' }
}
export const DEFAULT = { name: 'default', connectionId: 'local' }
export const ROWS = [LOCAL, REMOTE, SCOUT, QUIET, FAR, DEFAULT]
export const SOURCES = [
  { connectionId: 'local', label: 'This Mac', reachable: true },
  { connectionId: 'home-server', label: 'HOME-SERVER', reachable: true },
  { connectionId: 'mini', label: 'Mini', reachable: true },
  { connectionId: 'cloud', label: 'Cloud', reachable: false }
]

export const JOB = { job_id: 'j1', name: 'Digest', schedule: '0 9 * * *', enabled: true, prompt_preview: 'Summarise', last_status: 'error', last_fire_error: 'boom' }
export const CONFIG = {
  loaded: true,
  provider: 'nous',
  model: 'hermes-4',
  soul: '# Scout',
  skills: [{ name: 'web', enabled: true }],
  toolsets: [{ name: 'terminal', enabled: true, tool_count: 3 }],
  mcp: [{ name: 'github', enabled: false, fromCatalog: true, requires: ['GITHUB_TOKEN'] }],
  dirtyModel: false,
  dirtySoul: false,
  dirtySkills: false,
  dirtyToolsets: false,
  dirtyMcp: false
}

// Gateway rooms (R14) on the active source, members are local roster bots.
export const ROOM_MEMBERS = [
  { member_id: 'security', profile: 'security', handle: 'security', display_name: 'Security' },
  { member_id: 'default', profile: 'default', handle: 'default' }
]
export const ROOM = { room_id: 'r1', name: 'Launch', members: ROOM_MEMBERS, updated_at: 10 }
export const ROOM_LOG = [
  { seq: 1, event_id: 'e1', kind: 'message.user', actor: { kind: 'user', id: 'desktop' }, payload: { text: 'plan the launch', thread_id: 'e1' }, created_at: 1762560000 },
  { seq: 2, event_id: 'e2', kind: 'message.member', actor: { kind: 'member', id: 'default' }, payload: { text: 'On it.' }, created_at: 1762560005 },
  { seq: 3, event_id: 'e3', kind: 'turn.failed', actor: { kind: 'system', id: 'gw' }, payload: { member_id: 'security', error: 'insufficient credits (402)' }, created_at: 1762560006 },
  { seq: 4, event_id: 'e4', kind: 'room.activity', actor: { kind: 'system', id: 'gw' }, payload: { status: 'bounded', discussion_event_id: 'e1' }, created_at: 1762560007 }
]

export function roomAnswers({ log = ROOM_LOG, posted = [] } = {}) {
  return {
    'groups.capabilities': () => ({ driver: true, methods: ['groups.stop', 'groups.continue'] }),
    'groups.list': () => ({ rooms: [ROOM], next_offset: null }),
    'groups.state': () => ({ room: ROOM, driver_status: { running: false, working: false, blocked: false, counts: {}, pending_actions: [], member_activity: [], peer_routes: [] } }),
    'groups.log': params => ({ events: log.filter(e => e.seq > (params.since_seq || 0)), cursor: log.length, latest_seq: log.length, has_more: false }),
    'groups.send': params => (posted.push(params), { event: { seq: log.length + 1, event_id: params.event_id } })
  }
}

/** History with a tool call, markdown and a MEDIA image (C13, C15). */
export function richHistory(profile) {
  const base = history(profile)
  base.messages.push({ id: 15, role: 'assistant', content: `Chart for ${profile}:\nMEDIA:/tmp/chart.png`, timestamp: 1762560010 })
  return base
}

/** Boot with every surface from both branches reachable. */
export async function bootFull(t, { primitives = true, answers = {}, api, ...rest } = {}) {
  const React = reactRequire().require('react')
  const booted = await bootPlugin(t, {
    primitives,
    smoke: true,
    ...(rest.storage ? { storage: rest.storage } : {}),
    showWork: rest.showWork,
    rows: ROWS,
    sources: SOURCES,
    historyFor: richHistory,
    tweak: sdk => {
      // R16: core's own unread dot, drawn per Bot Chat id.
      sdk.SessionStatusDot = ({ storedSessionId }) => React.createElement('span', { className: 'fake-status-dot', 'data-session': storedSessionId })
      sdk.markSessionUnreadFinished = () => undefined
      sdk.ackStoredSessionId = () => undefined
      rest.tweak?.(sdk)
    },
    answers: {
      ...roomAnswers(),
      'cron.manage': params => (params?.action === 'list' ? { jobs: [{ ...JOB, name: `[bot:${params.profile}] Digest` }] } : {}),
      'display.status': () => ({ supported: true, installed: true, running: false, lease: { holder: 'agent', epoch: 1, since: 0 } }),
      'session.usage': () => ({ context_used: 12400, context_max: 200000, context_percent: 6, cost_usd: 0.42, calls: 3 }),
      ...answers
    },
    api: async request => {
      if (String(request.path).startsWith('/api/fs/read-data-url')) return { dataUrl: 'data:image/png;base64,iVBORw0KGgo=' }
      return api ? api(request) : undefined
    }
  })
  return booted
}

/** The menu a MenuButton opens: the SDK DropdownMenu content (always in the
 *  DOM, beside its trigger) or, on an older SDK, the inline list a click
 *  opens. */
export async function openMenu(button, primitives) {
  assert.ok(button, 'menu button exists')
  if (!primitives) button.click()
  return waitFor(() => {
    const menu = button.nextElementSibling
    return menu && menu.getAttribute('role') === 'menu' ? menu : null
  }, `the menu of ${button.getAttribute('aria-label')}`)
}

export function menuItem(menu, text) {
  return [...menu.querySelectorAll('[role="menuitem"]')].find(el => el.textContent.includes(text)) || null
}

export const byLabel = (root, label) => root.querySelector(`[aria-label="${label}"]`)
export const buttonWithText = (root, text) => [...root.querySelectorAll('button')].find(b => b.textContent.trim() === text || b.textContent.includes(text)) || null
export const rowButton = (rosterEl, name) => [...rosterEl.querySelectorAll('button.gbo-row:not(.gbo-room-row)')].find(b => b.textContent.includes(name)) || null

/** The open roster dialog (SDK Dialog content or the in-place fallback). */
export function dialogEl(primitives) {
  const all = [...document.querySelectorAll(primitives ? '[role="dialog"]' : '.gbo-modal-fallback')].filter(el => el.querySelector('.gbo-dialog-body'))
  return all[all.length - 1] || null
}

/** Close the open dialog the way a user would (Cancel / Close / Done). */
export async function closeDialog(internals, primitives) {
  const el = dialogEl(primitives)
  const btn = el && [...el.querySelectorAll('button')].find(b => /^(Cancel|Close|Done|Keep)$/.test(b.textContent.trim()))
  if (btn) btn.click()
  else internals.roster2.dialog.set(null)
  await waitFor(() => !dialogEl(primitives), 'the dialog to close')
}

export const reactErrors = errors => errors.map(e => `${e.kind}: ${e.error?.message}`)

/**
 * Render every surface of both parity branches through the loader and check
 * its content. Roster: rows, unread dots, pin / hidden / attention / retry,
 * filter and + menus, row menus, Group chats. Dialogs: all twelve states.
 * Chat: transcript, tool detail, owner-read media, message actions, composer,
 * a clarify card, the profile panel (jobs, computer, usage, profile, group
 * chats). Status-bar chip, Bot screen phases, side tab (C26), room tab (R14).
 */
export async function exerciseSurfaces(t, { primitives }) {
  const booted = await bootFull(t, { primitives, showWork: true })
  const { panes, workspaces, mount, errors, internals, emit } = booted
  assert.ok(internals, 'the smoke seam handed over the internals')
  const { app, roster2, openDialog, openBotScreen, screenStore, primeModelOptions } = internals

  // ── roster (R1-R18) ──
  const rosterEl = mount(panes.find(p => p.id === 'roster').render)
  await waitFor(() => rowButton(rosterEl, 'Security') && rowButton(rosterEl, 'Scout') && rosterEl.querySelector('.gbo-room-row'), 'roster rows and group chats')
  roster2.attention.set({ 'mini::scout': { reason: 'provider_auth_or_access', at: Date.now(), message: '401' } })
  await waitFor(() => rosterEl.querySelector('[aria-label="needs attention"]'), 'the attention badge')
  for (const text of ['Scout', 'Cloud is not reachable', 'Retry', 'Hidden', 'Group chats', 'Launch']) assert.ok(rosterEl.textContent.includes(text), `roster: ${text}`)
  assert.ok(rosterEl.querySelector('.fake-status-dot[data-session="s-root"]'), 'R16 unread dot on the Bot Chat id')
  assert.ok(!rosterEl.textContent.includes('Open Hermes Bot Mode'), 'no hand-off link in the roster')

  const plus = await openMenu(byLabel(rosterEl, 'New bot or group'), primitives)
  assert.ok(menuItem(plus, 'New bot…'), '+ → New bot…')
  assert.ok(menuItem(plus, 'New group chat…'), '+ → New group chat… (R14 wired in)')
  if (!primitives) byLabel(rosterEl, 'New bot or group').click()

  // The filters live in the search field (the top row is toggle, search, +).
  assert.equal(byLabel(rosterEl, 'Filter roster'), null, 'no filter button in the top row')
  byLabel(rosterEl, 'Search bots').click()
  const filter = await openMenu(await waitFor(() => byLabel(rosterEl, 'Filter roster'), 'the filters in the search field'), primitives)
  for (const text of ['Bots and groups', 'Bots only', 'Active now', 'Recently active', 'All gateways']) assert.ok(menuItem(filter, text), `filter: ${text}`)
  const groupsOnly = menuItem(filter, 'Groups only')
  assert.ok(groupsOnly && !groupsOnly.disabled && groupsOnly.getAttribute('aria-disabled') !== 'true', 'Groups only is enabled once group rows exist')
  if (!primitives) byLabel(rosterEl, 'Filter roster').click()

  const actions = await openMenu(byLabel(rosterEl, 'Actions for Scout'), primitives)
  for (const text of ['Open Bot Chat', 'Open in new tab', 'Unpin', 'Hide', 'Edit profile…', 'Skills, tools and model…', 'Duplicate', 'New chat with this agent', 'Delete…']) {
    assert.ok(menuItem(actions, text), `row menu: ${text}`)
  }
  if (!primitives) byLabel(rosterEl, 'Actions for Scout').click()

  roster2.filters.set({ kind: 'groups', activity: 'all', gateway: 'all' })
  await waitFor(() => !rowButton(rosterEl, 'Security') && rosterEl.querySelector('.gbo-room-row'), 'Groups only lists the rooms only')
  roster2.filters.set({ kind: 'bots', activity: 'all', gateway: 'all' })
  await waitFor(() => rowButton(rosterEl, 'Security') && !rosterEl.querySelector('.gbo-room-row'), 'Bots only hides the rooms')
  roster2.filters.set({ kind: 'all', activity: 'all', gateway: 'all' })
  roster2.hiddenExpanded.set(true)
  await waitFor(() => rowButton(rosterEl, 'quiet') || rowButton(rosterEl, 'Quiet'), 'Show hidden lists the hidden bot')
  roster2.hiddenExpanded.set(false)

  // ── dialogs (R11-R13, P3, P6, C21), hosted by the roster pane ──
  primeModelOptions(SCOUT, { providers: [{ slug: 'nous', name: 'Nous', models: ['hermes-4', 'hermes-3'] }] })
  primeModelOptions(null, { providers: [{ slug: 'nous', name: 'Nous', models: ['hermes-4'] }] })
  const dialogs = [
    [{ kind: 'create' }, ['New bot', 'Create bot', 'Shuffle face', 'What is it for?']],
    [{ kind: 'create', tab: 'model' }, ['Start from', 'Provider', 'Nous', 'Share sign-ins']],
    [{ kind: 'create', tab: 'capabilities', caps: { source: 'default', skills: [{ name: 'web', enabled: true }], toolsets: [], mcp: [] } }, ['Skills', 'web']],
    [{ kind: 'edit', bot: SCOUT }, ['Edit profile', 'Name shown', 'Description', 'Skills, tools, MCP, model and SOUL']],
    [{ kind: 'config', bot: SCOUT, initial: CONFIG }, ['Provider', 'hermes-3', 'Skills · 1 of 1 on', 'terminal', 'github', 'Set up', 'SOUL', 'Find skills in the hub', 'Configure a toolset']],
    [{ kind: 'groups', bot: SCOUT }, ['Groups', 'Research', 'Create & join', 'Remove from all groups']],
    [{ kind: 'delete', bot: SCOUT }, ['Delete this bot?', 'scout', 'cannot be undone']],
    [{ kind: 'cron-edit', bot: SCOUT, job: null }, ['New scheduled job', 'When to run', 'Send results to', 'Continue from the previous run']],
    [{ kind: 'cron-edit', bot: SCOUT, job: JOB }, ['Edit scheduled job', 'Digest', 'Summarise']],
    [{ kind: 'cron-detail', bot: SCOUT, job: JOB }, ['Digest', 'boom', 'Run now', 'Last result', 'Failed']],
    [{ kind: 'cron-remove', bot: SCOUT, job: JOB }, ['Delete this job?', 'Delete job']]
  ]
  for (const [state, texts] of dialogs) {
    // Each state opens fresh (a dialog keeps its own tab while it is open).
    openDialog(null)
    await waitFor(() => !dialogEl(primitives), 'the previous dialog to close')
    openDialog(state)
    const el = await waitFor(() => dialogEl(primitives), `${state.kind} dialog`)
    const text = el.textContent + [...el.querySelectorAll('input,textarea')].map(i => ` ${i.value} ${i.placeholder || ''}`).join('') + [...el.querySelectorAll('option')].map(o => ` ${o.textContent}`).join('')
    for (const want of texts) assert.ok(text.includes(want), `${state.kind}${state.tab ? `/${state.tab}` : ''}: ${want}`)
    if (state.kind === 'config') assert.ok(el.querySelector('[data-toolset="terminal"]'), 'SDK ToolsetConfigPanel embedded')
  }
  openDialog(null)
  await waitFor(() => !dialogEl(primitives), 'dialogs closed')

  // ── chat (C1-C30) ──
  rowButton(rosterEl, 'Security').click()
  const chatEl = mount((await waitFor(() => workspaces.get('grokbot-override'), 'the chat workspace')).render)
  await waitFor(() => chatEl.textContent.includes('hello security') && chatEl.querySelector('.gbo-media-image img'), 'transcript with media')
  assert.ok(chatEl.querySelector('.aui-md'), 'C15 markdown through the SDK renderer')
  assert.ok(chatEl.textContent.includes('1 tool'), 'C12/C13 tool activity')
  for (const label of ['Copy message', 'Edit message', 'Regenerate reply', 'React', 'Voice input', 'Share']) assert.ok(byLabel(chatEl, label), `chat control: ${label}`)
  const share = await openMenu(byLabel(chatEl, 'Share'), primitives)
  assert.ok(menuItem(share, 'Open another chat beside this one'), 'Share → open another chat')
  if (!primitives) byLabel(chatEl, 'Share').click()
  assert.ok(chatEl.querySelector('textarea'), 'composer')
  emit({ type: 'clarify.request', session_id: 'rt-security', payload: { request_id: 'q1', question: 'Which branch?', choices: ['main', 'dev'] } })
  await waitFor(() => chatEl.textContent.includes('Which branch?'), 'C11 clarify card')

  // Profile panel (P1-P7, the Model row, R14 group chats in the panel).
  if (!chatEl.querySelector('.gbo-panel')) byLabel(chatEl, 'Show profile').click()
  const panel = await waitFor(() => chatEl.querySelector('.gbo-panel') && chatEl.querySelector('.gbo-job-open') && chatEl.querySelector('.gbo-panel'), 'the profile panel with jobs')
  for (const text of ['Scheduled', 'Digest', 'Bot’s computer', 'Edit profile and avatar', 'Skills, tools, MCP and model', 'Groups', 'Launch', 'New group chat…']) assert.ok(panel.textContent.includes(text), `profile panel: ${text}`)
  assert.ok(panel.querySelector('button.gbo-model-row'), 'profile panel: the Model row')
  for (const text of ['Context', 'Input tokens', 'Cache hits']) assert.ok(!panel.textContent.includes(text), `no usage block in the panel: ${text}`)
  assert.ok(!panel.textContent.includes('Group chats are listed'), 'no hand-off to stock for group chats')

  // C25 status-bar chip.
  roster2.usage.set({ key: 'local::security', runtimeId: 'rt-security', usage: { context_used: 12400, context_max: 200000, context_percent: 6, cost_usd: 0.42, calls: 3 }, error: null })
  const chipEl = mount(panes.find(p => p.id === 'usage-meter').render)
  await waitFor(() => chipEl.textContent.includes('12k/200k'), 'the usage chip')

  // P4 the bot's computer, every phase.
  openBotScreen(SCOUT)
  const [, screenTab] = await waitFor(() => [...workspaces.entries()].find(([id]) => String(id).startsWith('grokbot-override-screen-')), 'the screen tab')
  const screenEl = mount(screenTab.render)
  const store = screenStore(SCOUT)
  const lease = { holder: 'agent', epoch: 1, since: 0 }
  for (const [status, texts] of [
    [{ supported: true, installed: true, running: false, lease }, ['asleep', 'Start']],
    [{ supported: true, installed: false, running: false, missing: ['xvfb'], install_command: 'apt install xvfb', lease }, ['not installed', 'xvfb', 'Install']],
    [{ supported: true, installed: true, running: false, image_switch: { current_image: 'a', target_image: 'b', containers: 1 }, lease }, ['newer sandbox image', 'Switch']],
    [{ supported: false, installed: false, running: false, lease }, ['No screen for this bot']]
  ]) {
    store.setStatus(status)
    await waitFor(() => texts.every(text => screenEl.textContent.includes(text)), `screen: ${texts.join(', ')}`)
  }
  store.setUnavailable()
  await waitFor(() => screenEl.textContent.includes('No screen on this Hermes'), 'screen unavailable')

  // C26 side tab, through the R12 row menu (setNewTabOpener wiring).
  const knowMenu = await openMenu(byLabel(rosterEl, 'Actions for Scholar'), primitives)
  menuItem(knowMenu, 'Open in new tab').click()
  const [, sideTab] = await waitFor(() => [...workspaces.entries()].find(([id]) => id.startsWith('grokbot-override-tab-')), 'the side-by-side tab')
  const sideEl = mount(sideTab.render)
  await waitFor(() => sideEl.textContent.includes('hello scholar'), 'the side tab transcript')

  // R14 room tab; its failed member turn badges the member's row (R15).
  rosterEl.querySelector('.gbo-room-row').click()
  const [, roomTab] = await waitFor(() => [...workspaces.entries()].find(([id]) => id === 'grokbot-override-room-r1'), 'the room tab')
  const roomEl = mount(roomTab.render)
  await waitFor(() => roomEl.textContent.includes('On it.') && roomEl.textContent.includes('Continue'), 'the room log')
  await waitFor(() => rowButton(rosterEl, 'Security')?.querySelector('[aria-label="needs attention"]'), 'the failed group turn badges Security')

  assert.deepEqual(reactErrors(errors), [], 'no React error anywhere')
  assert.ok(app.enabled.get(), 'still on')
  return booted
}
