// "@bot" tags in a draft (PARITY C20). Bot Mode's composer middleware
// annotates them before the text is sent: an identification note naming who
// each tag means and its message_agent target (hermes-bots/plugin.tsx:754-899).
// The override applies the same note itself (`mentionNote`), to the submitted
// text only, and offers the same completions (`mentionCompletions`,
// plugin.tsx:140-208).
//
// Matching follows apps/desktop/src/plugins/hermes-bots/data.ts
// `resolveRosterMentions` / `mentionNameForms` / `botHandle` (Hermes Agent,
// MIT, (c) Nous Research): code spans are ignored, a tag must start the text
// or follow whitespace (so e-mail addresses never match), the open bot is not
// a target, and a form two bots share resolves to neither.

import { rowKey } from './roster.js'

const RESERVED = new Set(['all', 'everyone', 'user', 'default', 'hermes'])

export function mentionNameForms(value) {
  const name = String(value || '').trim().toLowerCase()
  if (!name) return []
  const slug = name.replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '')
  const collapsed = name.replace(/[^a-z0-9_-]+/g, '')
  return [...new Set([slug, collapsed])].filter(form => /^[a-z0-9][a-z0-9_-]*$/.test(form) && !RESERVED.has(form))
}

/** data.ts botHandle: the precomputed handle, else 'hermes' for the default
 *  profile unless a real `hermes` profile holds that handle. */
export function botHandle(bot) {
  const name = String(bot?.name || '')
  if (bot?.handle && bot.handle !== name && !(bot.hermesHandleTaken && bot.handle === 'hermes')) return String(bot.handle).replace(/^@/, '')
  return name.trim().toLowerCase() === 'default' && !bot?.hermesHandleTaken ? 'hermes' : name
}

const handleFor = bot => botHandle(bot)

/** data.ts claimDefaultHandles: a default row whose source also lists a real
 *  `hermes` profile does not answer @hermes. */
export function claimDefaultHandles(rows) {
  const list = Array.isArray(rows) ? rows : []
  const taken = new Set(list.filter(row => String(row?.name || '').trim() === 'hermes').map(row => String(row?.connectionId || '')))
  return list.map(row => (String(row?.name || '').trim() === 'default' && taken.has(String(row?.connectionId || '')) ? { ...row, hermesHandleTaken: true } : row))
}

function friendlyTitle(bot) {
  return String(bot?.ui_meta?.['hermes-bots']?.title || bot?.title || '').trim()
}

/** data.ts botMentionTag: the friendly-name slug when the bot has one. */
export function botMentionTag(bot) {
  for (const friendly of [bot?.ui_meta?.['hermes-bots']?.title, bot?.title, bot?.display_name]) {
    const forms = mentionNameForms(friendly)
    if (forms.length) return forms[0]
  }
  return botHandle(bot)
}

/** The identification note stock's mention middleware appends to the
 *  submitted text (plugin.tsx:856-893), word for word. */
export function mentionNote(bots) {
  const list = Array.isArray(bots) ? bots : []
  if (!list.length) return ''
  const lines = list.map(bot => {
    const handle = botHandle(bot)
    const title = friendlyTitle(bot)
    const target =
      bot.remoteSource && bot.connectionId ? `${bot.name}@${bot.connectionId}` : botHandle({ name: bot.name, hermesHandleTaken: bot.hermesHandleTaken })
    const where = bot.remoteSource
      ? ` — on ${bot.connectionLabel || bot.connectionId} (message_agent target: "${target}")`
      : handle !== target
        ? ` (message_agent target: "${target}")`
        : ''
    return `@${handle} = agent profile "${bot.name}"${title ? ` ("${title}")` : ''}${where}`
  })
  return (
    '\n\n[@mentions resolved from the Bot Mode roster — the user is referring to: ' +
    lines.join('; ') +
    '. If they want one of these agents contacted, compose your own message and send it with your message_agent tool (agents on other connected machines are reachable too — the Desktop relays it); never forward the user\u2019s text verbatim. If this session has no message_agent tool, agent messaging is unavailable here — say so.]'
  )
}

/** The `@` completions stock offers (plugin.tsx:146-208): roster rows other
 *  than the open bot, matched on tag, handle or display name; a tag two rows
 *  share is pinned to its connection. At most 8. */
export function mentionCompletions(roster, openBot, query, displayName = bot => String(bot?.display_name || bot?.name || '')) {
  const openKey = openBot ? rowKey(openBot) : ''
  const q = String(query || '').toLowerCase()
  const offered = claimDefaultHandles(roster).filter(bot => bot?.name && rowKey(bot) !== openKey)
  const counts = new Map()
  for (const bot of offered) {
    const tag = botMentionTag(bot).toLowerCase()
    counts.set(tag, (counts.get(tag) || 0) + 1)
  }
  const items = []
  for (const bot of offered) {
    const handle = botHandle(bot)
    const display = displayName(bot)
    const tag = botMentionTag(bot)
    if (q && !tag.toLowerCase().startsWith(q) && !handle.toLowerCase().startsWith(q) && !display.toLowerCase().startsWith(q)) continue
    const qualified = (counts.get(tag.toLowerCase()) || 0) > 1 && bot.connectionId
    const insert = qualified ? `@${tag}@${bot.connectionId}` : `@${tag}`
    items.push({ insert, display: insert, meta: `Bot · ${display}${bot.connectionLabel ? ` · ${bot.connectionLabel}` : ''}`, bot })
  }
  return items.slice(0, 8)
}

function formsFor(bot) {
  const forms = new Set([handleFor(bot).toLowerCase(), String(bot.name).toLowerCase()])
  for (const friendly of [bot?.ui_meta?.['hermes-bots']?.title, bot?.title, bot?.display_name]) {
    for (const form of mentionNameForms(friendly)) forms.add(form)
  }
  return forms
}

/** Roster rows (other than `openBot`) the draft tags with "@…". */
export function mentionedBots(text, roster, openBot) {
  const prose = String(text || '').replace(/```[\s\S]*?```/g, ' ').replace(/`[^`\n]*`/g, ' ')
  if (!/(^|\s)@[a-z0-9]/i.test(prose)) return []
  const openKey = openBot ? rowKey(openBot) : ''
  const byForm = new Map()
  for (const bot of Array.isArray(roster) ? roster : []) {
    if (!bot?.name || (openKey && rowKey(bot) === openKey)) continue
    for (const form of formsFor(bot)) {
      if (!form) continue
      const existing = byForm.get(form)
      if (existing === undefined) byForm.set(form, bot)
      else if (existing !== bot) byForm.set(form, null)
    }
  }
  const found = []
  const seen = new Set()
  for (const match of prose.matchAll(/(^|\s)@([a-z0-9][a-z0-9_-]*)(?:@([a-z0-9][a-z0-9_-]*))?/gi)) {
    const token = match[2].toLowerCase()
    const connection = (match[3] || '').toLowerCase()
    let bot = byForm.get(token)
    if (connection) {
      bot = (Array.isArray(roster) ? roster : []).find(
        row => row?.name && rowKey(row) !== openKey && String(row.connectionId || '').toLowerCase() === connection && formsFor(row).has(token)
      )
    }
    if (!bot || seen.has(rowKey(bot))) continue
    seen.add(rowKey(bot))
    found.push(bot)
  }
  return found
}
