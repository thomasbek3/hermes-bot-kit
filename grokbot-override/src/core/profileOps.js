// Profile operations behind the roster's context menu and New bot dialog.
// Ports from apps/desktop/src/plugins/hermes-bots (Hermes Agent, MIT,
// (c) Nous Research):
//
//   - duplicateName / duplicate params    ← profile-ops.ts:346 duplicateBot
//   - deleteBotProfile                    ← profile-ops.ts:430 deleteBot
//   - describeArgv (Edit profile)         ← edit-profile-dialog.tsx:135
//   - editedLook                          ← edit-profile-look.ts
//   - slugifyProfileName, botProfileIdentity, displayName ← labels.ts
//   - NAME_RE, slugTaken, capabilityPayload, requestOnTarget,
//     the profiles.create body            ← create-dialog.tsx:92,138,168,450,520
//   - composeSoul, ensureMessagingProtocol ← soul.ts
//   - newBotChat (New chat with this agent) ← data.ts:1391

import { botRouteKey, botRouteProblem, resolveBotConnectionRoute } from './routing.js'

export const NAME_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/

export function isDefaultBot(bot) {
  return String(bot?.name || '').trim().toLowerCase() === 'default'
}

function slugify(value, max = 64) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, max)
}

/** labels.ts slugifyProfileName */
export function slugifyProfileName(value) {
  const folded = String(value || '')
    .normalize('NFC')
    .replace(/[\p{L}\p{N}]/gu, ch => {
      const base = ch.normalize('NFKD').replace(/\p{M}+/gu, '')
      return /^[a-zA-Z0-9]+$/.test(base) ? base : `-u${ch.codePointAt(0).toString(16)}-`
    })
    .replace(/-+/g, '-')
  const slug = slugify(folded, Infinity)
  if (slug.length <= 64) return slug
  const cut = slug.slice(0, 64)
  const boundary = slug[64] === '-' ? 64 : cut.lastIndexOf('-')
  return (boundary > 0 ? cut.slice(0, boundary) : cut).replace(/-+$/, '')
}

/** labels.ts botProfileIdentity */
export function botProfileIdentity(name, title) {
  const enteredName = String(name || '').trim()
  return {
    slug: slugifyProfileName(enteredName),
    title: String(title || '').trim() || (/[^ -~]/.test(enteredName) ? enteredName : '')
  }
}

/** labels.ts displayName, the parts a new bot needs (no alias, no meta). */
export function plainDisplayName({ name, title }) {
  if (String(title || '').trim()) return String(title).trim()
  if (String(name || '').trim().toLowerCase() === 'default') return 'Hermes'
  return String(name || '').replace(/[-_]+/g, ' ').trim().replace(/\b\w/g, ch => ch.toUpperCase())
}

/** data.ts:1241 botHandle */
export function botHandle(name, bot) {
  if (bot?.handle && bot.handle !== name && !(bot.hermesHandleTaken && bot.handle === 'hermes')) return bot.handle
  return String(name || '').trim().toLowerCase() === 'default' && !bot?.hermesHandleTaken ? 'hermes' : name
}

// ── SOUL (soul.ts) ───────────────────────────────────────────────────────

function messagingProtocolSection(name, roster) {
  const teammates = (roster || []).filter(b => b.name !== name)
  const handle = botHandle(name, (roster || []).find(b => b.name === name))
  return [
    '## Messaging other agents',
    '',
    'You work alongside other named agents. Every agent (including you) has',
    'ONE canonical conversation titled "Bot Chat" — created with the agent,',
    'so it always exists. Agent-to-agent messages are delivered straight',
    'into it, like a DM. To message a teammate, run:',
    '',
    '```',
    'hermes -p <agent-name> chat --in ~ -c "Bot Chat" --create-if-missing -Q -q "Message from 🤖 ' +
      handle +
      ' (@' +
      handle +
      '): your message"',
    '',
    'Run the send with background=true and notify_on_complete=true on the',
    'terminal tool, then finish your turn — the reply arrives later as a',
    'background process notification. Never block waiting for it.',
    '```',
    '',
    '(`--in ~ -c "Bot Chat" --create-if-missing` resumes their canonical',
    'conversation in the home workspace, creating it if the target has no',
    '"Bot Chat" yet. `-Q` keeps output clean. Always open with the',
    '"Message from 🤖 ' + handle + ' (@' + handle + '):" prefix so they know',
    'who is talking (the @handle lets the app show your avatar to them).',
    'Their reply prints to stdout — relay the relevant part back to the',
    'user, and say which agent it came from.)',
    '',
    'If a message in YOUR chat starts with "Message from 🤖 <name>", it is',
    'a teammate messaging you, not the user. Answer it directly — your reply',
    'reaches them via their own delivery — and use the same command if you',
    'need to start a conversation yourself.',
    '',
    'When the user writes @<agent-name> or says "ask <name> to ..." /',
    '"tell <name> ...", that is a handoff: message that agent, wait for the',
    'reply, and report back.',
    '',
    'The roster grows over time — run `hermes profile list` for the LIVE',
    'teammate list before a handoff. Teammates when you were created:',
    ...(teammates.length ? teammates.map(b => `- \`${b.name}\`${b.description ? ` — ${b.description}` : ''}`) : ['- (none yet)'])
  ].join('\n')
}

export function hasMessagingProtocol(soul) {
  return /(^|\n)## Messaging other agents(\s|$)/.test(soul || '')
}

/** soul.ts ensureMessagingProtocol; `injected`: the backend's
 *  bot_mode_protocol flag (the server injects it, SOUL stays as typed). */
export function ensureMessagingProtocol(soul, name, roster, injected = false) {
  const text = String(soul || '').trim()
  if (injected || hasMessagingProtocol(text)) return text
  const section = messagingProtocolSection(name, roster)
  return text ? text + '\n\n' + section : section
}

/** soul.ts composeSoul */
export function composeSoul({ name, title, description, roster, customSoul, injected = false }) {
  if (customSoul && String(customSoul).trim()) return ensureMessagingProtocol(customSoul, name, roster, injected)
  const who = plainDisplayName({ name, title })
  const identity = [
    `# ${who}`,
    '',
    title ? `**Role:** ${title}` : null,
    description ? `**Mission:** ${description}` : null,
    '',
    `You are ${who}, a persistent named agent (profile \`${name}\`) on this machine.`,
    'You keep your own memory, skills, and conversation history across sessions.'
  ]
    .filter(line => line !== null)
    .join('\n')
  return injected ? identity : identity + '\n\n' + messagingProtocolSection(name, roster)
}

// ── create (create-dialog.tsx) ───────────────────────────────────────────

/** Gateway RPC on a create target: a registry connection id (its default
 *  backend, no gateway switch) or '' for the active gateway (create-dialog.tsx:168). */
export function requestOnTarget(host, target, method, params = {}) {
  return target
    ? host.requestProfile({ connectionId: target, mode: 'remote', profile: 'default', targetProfile: 'default' }, method, params)
    : host.request(method, params)
}

/** create-dialog.tsx:250 slugTaken */
export function slugTaken(roster, slug, target, draft = null) {
  return (roster || []).some(
    b => b.name === slug && b.name !== draft && (target ? Boolean(b.remoteSource) && b.connectionId === target : !b.remoteSource)
  )
}

/** create-dialog.tsx:138 capabilityPayload */
export function capabilityPayload(caps, dirty) {
  const payload = {}
  if (!caps) return payload
  if (dirty?.skills) payload.disabled_skills = caps.skills.filter(s => !s.enabled).map(s => s.name)
  if (dirty?.toolsets) {
    const en = caps.toolsets.filter(t => t.enabled)
    payload.enabled_toolsets = en.length === caps.toolsets.length || en.length === 0 ? [] : en.map(t => t.name)
  }
  if (dirty?.mcp) payload.enabled_mcp_servers = caps.mcp.filter(m => m.enabled).map(m => m.name)
  return payload
}

/** The profiles.create body (create-dialog.tsx:523). */
export function createProfileParams({ slug, descriptionText, cloneFrom = 'default', remoteTarget = false, noSkills = false, shareAuth = true, soul, model = '', provider = '' }) {
  return {
    name: slug,
    description: descriptionText,
    clone_from: cloneFrom === '__none__' ? null : remoteTarget ? 'default' : cloneFrom,
    no_skills: noSkills,
    share_auth: shareAuth,
    soul,
    ...(String(model).trim() && String(provider).trim() ? { model: String(model).trim(), provider: String(provider).trim() } : {})
  }
}

/** The look a new bot is born with (create-dialog.tsx:587 / 621). */
export function newBotLook({ shape, color, image, title, now = Date.now() }) {
  return { shape, color: color ?? undefined, image: image ?? null, imageKind: image ? 'photo' : 'shape', title, created: now }
}

// ── edit (edit-profile-look.ts, edit-profile-dialog.tsx) ─────────────────

/** The fields the user changed since the dialog opened, or null. */
export function editedLook(opened, current) {
  const patch = {}
  if (current.shape !== opened.shape) patch.shape = current.shape
  if (current.color !== opened.color) patch.color = current.color ?? undefined
  if (current.image !== opened.image) {
    patch.image = current.image
    patch.imageKind = current.image ? 'photo' : 'shape'
  }
  if (Object.keys(patch).length > 0) patch.custom = true
  if (String(current.title || '').trim() !== String(opened.title || '').trim()) patch.title = String(current.title || '').trim()
  return Object.keys(patch).length > 0 ? patch : null
}

export function describeArgv(bot, text) {
  return ['profile', 'describe', String(bot?.name || ''), '--text', String(text || '')]
}

// ── duplicate (profile-ops.ts:346) ───────────────────────────────────────

/** "<base>-2", "-3", … — the first slot free on the bot's own connection. */
export function duplicateName(bot, roster) {
  const base = String(bot?.name || '')
  const route = resolveBotConnectionRoute(bot).route
  const ownerKey = route ? botRouteKey(route) : null
  const metaKey = row => {
    const r = resolveBotConnectionRoute(row).route
    return r ? botRouteKey(r) : String(row?.name || '')
  }
  for (let n = 2; n < 100; n += 1) {
    const suffix = `-${n}`
    const candidate = base.slice(0, 64 - suffix.length) + suffix
    if (!(roster || []).some(b => b.name === candidate && (!ownerKey || metaKey(b).startsWith(`${route.connectionId}::`)))) return candidate
  }
  throw new Error('No free name for the duplicate.')
}

export function duplicateParams(bot, name) {
  return { name, clone_from: String(bot?.name || ''), description: bot?.description || '' }
}

/** The copy's look: everything but chat/created, titled "(copy)". */
export function duplicateLook(meta) {
  if (!meta) return null
  const { chat: _chat, created: _created, ...look } = meta
  return { ...look, title: meta.title ? `${meta.title} (copy)` : '' }
}

/** The row the duplicate becomes (same owner as the source). */
export function duplicateRow(bot, name) {
  const route = resolveBotConnectionRoute(bot).route
  return {
    ...bot,
    name,
    canonical_session: undefined,
    last_session: undefined,
    ...(route ? { route: { ...route, profile: name, targetProfile: name }, sourceScoped: true } : { route: undefined, sourceScoped: false })
  }
}

// ── delete (profile-ops.ts:430) ──────────────────────────────────────────

export async function deleteBotProfile(host, bot, activeConnectionId) {
  // A row whose route is not known must never fall through to a delete BY
  // NAME on this machine: that would remove a different, same-named profile.
  const problem = botRouteProblem(bot, activeConnectionId)
  if (problem) throw new Error(problem)
  const route = resolveBotConnectionRoute(bot).route
  if (isDefaultBot(bot) || String(route?.targetProfile || '').toLowerCase() === 'default') {
    throw new Error('The default profile cannot be deleted.')
  }
  if (typeof host?.deleteProfile === 'function') {
    await host.deleteProfile(route || bot.name)
    return
  }
  if (route) throw new Error('Source-scoped profile deletion requires host.deleteProfile.')
  const result = await host.request('cli.exec', { argv: ['profile', 'delete', bot.name, '--yes'] })
  if (result?.blocked || result?.code !== 0) throw new Error(result?.hint || result?.output || `Could not delete profile ${bot.name}.`)
}

// ── new chat with this agent (data.ts:1391) ──────────────────────────────

/** Opens a fresh (non-Bot-Chat) chat with the bot on its own route, in Bot
 *  Mode's workspace, exactly as stock does. Returns false when unsupported. */
export function newBotChat(host, bot, ownerKey) {
  if (typeof host?.newChat !== 'function') return false
  // Stock requires a route: botConnectionRoute throws for an orphan and
  // returns null for a not-scoped row, and both are refused (data.ts:1402).
  const route = resolveBotConnectionRoute(bot).route
  if (!route) return false
  host.newChat(route, { workspaceMode: 'bots', workspaceOwnerKey: ownerKey })
  return true
}
