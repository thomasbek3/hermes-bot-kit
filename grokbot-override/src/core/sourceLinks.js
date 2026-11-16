// Source links in bot replies: a markdown link to a known service (a Slack
// message, a Gmail email, a GitHub PR …) draws as the service's small logo
// plus the link text (ui/SourceLink.tsx). This file is the pure half: which
// service a URL belongs to, the short label for a bare URL, whether a URL may
// be drawn and opened at all, and what a click opens.
//
// Matching is by the parsed URL's hostname (lower-cased, port ignored), as an
// exact domain or a subdomain of it: `slack.com.evil.io` is not Slack. Nothing
// here fetches anything (no favicons): an unknown public host gets a neutral
// link icon.

/** The services, in match order (the first whose domain and path fit wins).
 *  `domains`: exact host or any subdomain. `path`: optional pathname test. */
export const SOURCE_SERVICES = Object.freeze([
  { id: 'slack', name: 'Slack', domains: ['slack.com'] },
  { id: 'gmail', name: 'Gmail', domains: ['mail.google.com'] },
  { id: 'googledocs', name: 'Google Docs', domains: ['docs.google.com'], path: /^\/document\// },
  { id: 'googlesheets', name: 'Google Sheets', domains: ['docs.google.com'], path: /^\/spreadsheets\// },
  { id: 'googleslides', name: 'Google Slides', domains: ['docs.google.com'], path: /^\/presentation\// },
  { id: 'googledrive', name: 'Google Drive', domains: ['drive.google.com', 'docs.google.com'] },
  { id: 'googlecalendar', name: 'Google Calendar', domains: ['calendar.google.com'] },
  { id: 'googlemeet', name: 'Google Meet', domains: ['meet.google.com'] },
  { id: 'github', name: 'GitHub', domains: ['github.com'] },
  { id: 'notion', name: 'Notion', domains: ['notion.so', 'notion.site', 'notion.com'] },
  { id: 'linear', name: 'Linear', domains: ['linear.app'] },
  { id: 'figma', name: 'Figma', domains: ['figma.com'] },
  { id: 'zoom', name: 'Zoom', domains: ['zoom.us', 'zoom.com'] },
  { id: 'outlook', name: 'Outlook', domains: ['outlook.office.com', 'outlook.office365.com', 'outlook.live.com', 'outlook.com'] },
  { id: 'office365', name: 'Office 365', domains: ['office.com', 'microsoft365.com', 'office365.com', 'sharepoint.com'] },
  { id: 'dropbox', name: 'Dropbox', domains: ['dropbox.com'] },
  // Zoho's data centres: .com, .eu, .in, .com.au, .jp, .sa, .com.cn and the
  // Canadian zohocloud.ca.
  { id: 'zoho', name: 'Zoho', domains: ['zoho.com', 'zoho.eu', 'zoho.in', 'zoho.com.au', 'zoho.jp', 'zoho.sa', 'zoho.com.cn', 'zohocloud.ca'] },
  { id: 'stripe', name: 'Stripe', domains: ['stripe.com'] },
  { id: 'hubspot', name: 'HubSpot', domains: ['hubspot.com'] },
  { id: 'airtable', name: 'Airtable', domains: ['airtable.com'] },
  { id: 'trello', name: 'Trello', domains: ['trello.com'] },
  { id: 'asana', name: 'Asana', domains: ['asana.com'] },
  { id: 'calendly', name: 'Calendly', domains: ['calendly.com'] },
  { id: 'loom', name: 'Loom', domains: ['loom.com'] },
  { id: 'youtube', name: 'YouTube', domains: ['youtube.com', 'youtu.be'] },
  { id: 'x', name: 'X', domains: ['x.com', 'twitter.com'] },
  { id: 'linkedin', name: 'LinkedIn', domains: ['linkedin.com'] }
])

const SERVICE_BY_ID = new Map(SOURCE_SERVICES.map(service => [service.id, service]))

/** The neutral entry for any other public web host. */
export const WEB_SERVICE = Object.freeze({ id: 'web', name: 'Link', domains: [] })

function parseSourceUrl(value) {
  try {
    return new URL(String(value ?? '').trim())
  } catch {
    return null
  }
}

const onDomain = (host, domain) => host === domain || host.endsWith(`.${domain}`)

/** This machine, its network, or a bare name: never drawn as a source (the
 *  same rule as the renderer's preview-only link: nothing private navigates). */
export function isPrivateHost(hostname) {
  const host = String(hostname || '').toLowerCase().replace(/\.$/, '')
  if (!host || !host.includes('.')) return true // localhost, bare intranet names
  if (host.startsWith('[')) return true // IPv6 literals
  if (/\.(?:local|localhost|internal|lan|home|corp|intranet)$/.test(host)) return true
  const v4 = host.split('.')
  if (v4.length === 4 && v4.every(part => /^\d{1,3}$/.test(part))) {
    const [a, b] = v4.map(Number)
    if (a === 10 || a === 127 || a === 0) return true
    if (a === 169 && b === 254) return true
    if (a === 172 && b >= 16 && b <= 31) return true
    if (a === 192 && b === 168) return true
    if (a === 100 && b >= 64 && b <= 127) return true // CGNAT / tailnets
  }
  return false
}

/** The service a URL belongs to, or null. `slack://` deep links are Slack. */
export function serviceFor(value) {
  const url = value instanceof URL ? value : parseSourceUrl(value)
  if (!url) return null
  if (url.protocol === 'slack:') return SERVICE_BY_ID.get('slack')
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null
  const host = url.hostname.toLowerCase().replace(/\.$/, '')
  for (const service of SOURCE_SERVICES) {
    if (!service.domains.some(domain => onDomain(host, domain))) continue
    if (service.path && !service.path.test(url.pathname)) continue
    return service
  }
  return null
}

// ---- Slack ----

/** `https://<ws>.slack.com/archives/<C>/p<16 digits>[?thread_ts=…]` →
 *  { workspace, channel, ts, threadTs }; anything else → null. The `p` value
 *  is the message ts without its dot (10 + 6 digits). */
export function parseSlackPermalink(value) {
  const url = value instanceof URL ? value : parseSourceUrl(value)
  if (!url || url.protocol !== 'https:') return null
  const host = url.hostname.toLowerCase()
  if (!onDomain(host, 'slack.com') || host === 'slack.com' || host === 'app.slack.com') return null
  const match = /^\/archives\/([A-Z0-9]{6,})\/p(\d{10})(\d{6})\/?$/.exec(url.pathname)
  if (!match) return null
  const thread = url.searchParams.get('thread_ts')
  return {
    workspace: host.slice(0, -'.slack.com'.length),
    channel: match[1],
    ts: `${match[2]}.${match[3]}`,
    threadTs: thread && /^\d{10}\.\d{6}$/.test(thread) ? thread : null
  }
}

const TEAM_ID = /^T[A-Z0-9]{4,}$/
const CHANNEL_ID = /^[CDG][A-Z0-9]{4,}$/
const MESSAGE_TS = /^\d{10}\.\d{6}$/

/** What a click on a Slack link opens: `{ kind, url, fallback? }`.
 *
 *  Slack's documented desktop deep link to a message is
 *  `slack://channel?team=<team id>&id=<channel id>&message=<ts>`. It needs the
 *  workspace's team id, which an https permalink does not carry, and we never
 *  guess one: an https permalink opens as itself, and slack.com hands it to
 *  the desktop app at that message. (With a known `teamId` and an opener that
 *  admits app schemes, the deep link is built; nothing passes one today.)
 *
 *  A `slack://channel?team=T&id=C[&message=ts]` / `slack://open?team=T` link
 *  is tried as itself first (the exact message, when the host opener admits
 *  the scheme). Hermes's opener admits http(s)/mailto only and refuses it, so
 *  the `fallback` opens: `app.slack.com/client/T/C`, which hands off to the
 *  app at the CHANNEL. No documented https URL addresses a message from a team
 *  id, channel id and ts alone (an https permalink needs the workspace's own
 *  domain), so the fallback cannot keep the message. Any other `slack://`
 *  link is not opened. */
export function slackOpenTarget(value, { teamId = '', appScheme = false } = {}) {
  const url = value instanceof URL ? value : parseSourceUrl(value)
  if (!url) return null
  if (url.protocol === 'slack:') {
    const team = url.searchParams.get('team') || ''
    const id = url.searchParams.get('id') || ''
    const message = url.searchParams.get('message') || ''
    if (!TEAM_ID.test(team)) return null
    const kind = url.hostname || url.pathname.replace(/^\/+/, '')
    if (kind === 'channel' && CHANNEL_ID.test(id)) {
      const params = new URLSearchParams({ team, id })
      if (MESSAGE_TS.test(message)) params.set('message', message)
      return { kind: 'app', url: `slack://channel?${params}`, fallback: `https://app.slack.com/client/${team}/${id}` }
    }
    if (kind === 'open') return { kind: 'app', url: `slack://open?${new URLSearchParams({ team })}`, fallback: `https://app.slack.com/client/${team}` }
    return null
  }
  const permalink = parseSlackPermalink(url)
  if (permalink && appScheme && TEAM_ID.test(String(teamId))) {
    const params = new URLSearchParams({ team: teamId, id: permalink.channel, message: permalink.ts })
    return { kind: 'app', url: `slack://channel?${params}`, fallback: url.href }
  }
  return { kind: 'web', url: url.href }
}

/** The renderer's sanitizer drops every link that is not http(s), mailto or
 *  tel before the decorate hook sees it (`slack://…` draws as "[blocked]").
 *  So a valid Slack app link is carried through it as an https stand-in: the
 *  channel page with the canonical deep link in its fragment. sourceLinkFor
 *  turns the stand-in back into the app link; an older shell without the
 *  hook just shows a link to the channel page. */
const SLACK_APP_MARK = 'gbo-slack-app='

/** Inline-code spans in a markdown block: [start, end) ranges. A run of n
 *  backticks opens a span that the next run of exactly n closes, within the
 *  paragraph; an unmatched run is literal text. */
export function inlineCodeRanges(text) {
  const ranges = []
  const source = String(text ?? '')
  const run = /`+/g
  let match
  while ((match = run.exec(source))) {
    const len = match[0].length
    const from = match.index + len
    const paragraphEnd = source.indexOf('\n\n', from)
    const limit = paragraphEnd < 0 ? source.length : paragraphEnd
    const close = new RegExp(String.raw`(?<!\`)\`{${len}}(?!\`)`, 'g')
    close.lastIndex = from
    const end = close.exec(source)
    if (end && end.index < limit) {
      ranges.push([match.index, end.index + len])
      run.lastIndex = end.index + len
    }
  }
  return ranges
}

/** `[label](slack://…)` → `[label](https://app.slack.com/client/…#gbo-slack-app=…)`
 *  for valid Slack app links outside inline code; everything else as is. */
export function protectSlackAppLinks(text) {
  const source = String(text ?? '')
  if (!source.includes('](slack:')) return source
  const code = inlineCodeRanges(source)
  return source.replace(/\]\((slack:[^)\s]+)\)/gi, (whole, href, at) => {
    if (code.some(([a, b]) => at >= a && at < b)) return whole
    const target = slackOpenTarget(href)
    if (!target?.fallback) return whole
    return `](${target.fallback}#${SLACK_APP_MARK}${encodeURIComponent(target.url)})`
  })
}

/** The Slack app link a stand-in carries, or null. */
function slackAppFromStandIn(url) {
  if (url.protocol !== 'https:' || url.hostname.toLowerCase() !== 'app.slack.com') return null
  if (!url.hash.startsWith(`#${SLACK_APP_MARK}`)) return null
  let decoded = ''
  try {
    decoded = decodeURIComponent(url.hash.slice(SLACK_APP_MARK.length + 1))
  } catch {
    return null
  }
  return /^slack:/i.test(decoded) ? decoded : null
}

// ---- safety, opening, labels ----

/** A link this screen draws as a source chip and opens on a click, or null
 *  (the renderer's own element stays). Only https/http to a public host with
 *  no credentials, or a valid Slack app link (or its stand-in). Never
 *  `javascript:`, `data:`, `file:` or any other scheme; `mailto:`/`tel:` are
 *  left to the renderer unchanged. `opens` is what a click tries, in order. */
export function sourceLinkFor(href) {
  const url = parseSourceUrl(href)
  if (!url) return null
  const app = url.protocol === 'slack:' ? url.href : slackAppFromStandIn(url)
  if (app) {
    const target = slackOpenTarget(app)
    if (!target?.fallback) return null
    return { service: SERVICE_BY_ID.get('slack'), href: target.url, opens: [target.url, target.fallback], openUrl: target.url }
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null
  if (url.username || url.password || isPrivateHost(url.hostname)) return null
  const service = serviceFor(url) || WEB_SERVICE
  const openUrl = service.id === 'slack' ? slackOpenTarget(url)?.url || url.href : url.href
  return { service, href: url.href, opens: [openUrl], openUrl }
}

/** What a click on `href` tries to open, in order ([] when it must not open). */
export function sourceOpenUrls(href) {
  return sourceLinkFor(href)?.opens ?? []
}

/** The first URL a click opens for `href`, or null when it must not open. */
export function sourceOpenUrl(href) {
  return sourceLinkFor(href)?.openUrl ?? null
}

const clip = (text, max) => (text.length <= max ? text : `${text.slice(0, max - 1)}…`)

/** The short label for a bare (autolinked) URL: the service name plus a short
 *  tail ("Slack message", "Gmail", "GitHub PR #12"), never the URL itself. */
export function bareLinkLabel(href) {
  const url = parseSourceUrl(href)
  if (!url) return 'Link'
  const service = serviceFor(url)
  const parts = url.pathname.split('/').filter(Boolean)
  switch (service?.id) {
    case 'slack': {
      const permalink = parseSlackPermalink(url)
      if (permalink) return permalink.threadTs && permalink.threadTs !== permalink.ts ? 'Slack thread reply' : 'Slack message'
      return 'Slack'
    }
    case 'gmail':
      return 'Gmail'
    case 'googledocs':
      return 'Google Doc'
    case 'googlesheets':
      return 'Google Sheet'
    case 'googleslides':
      return 'Google Slides'
    case 'googlecalendar':
      return 'Calendar event'
    case 'googlemeet':
      return 'Google Meet'
    case 'github': {
      const [owner, repo, kind, number] = parts
      if (repo && kind === 'pull' && /^\d+$/.test(number || '')) return `GitHub PR #${number}`
      if (repo && kind === 'issues' && /^\d+$/.test(number || '')) return `GitHub issue #${number}`
      if (repo && kind === 'commit' && number) return `GitHub commit ${number.slice(0, 7)}`
      if (owner && repo) return clip(`GitHub ${owner}/${repo}`, 32)
      return 'GitHub'
    }
    case 'linear':
      return /\/issue\/[A-Za-z]+-\d+/.test(url.pathname) ? `Linear ${url.pathname.match(/\/issue\/([A-Za-z]+-\d+)/)[1].toUpperCase()}` : 'Linear'
    case 'youtube':
      return 'YouTube video'
    case undefined:
    case null:
      break
    default:
      return service.name
  }
  return clip(url.hostname.replace(/^www\./, ''), 32)
}

/** True when the link text is just its URL (an autolink, or `[url](url)`). */
export function isBareLink(text, href) {
  const label = String(text ?? '').trim()
  if (!label) return true
  const strip = value => String(value || '').trim().replace(/^[a-z]+:\/\//i, '').replace(/\/$/, '').toLowerCase()
  return strip(label) === strip(href) || /^(?:https?:\/\/|www\.)\S+$/i.test(label)
}

// ---- dark-mode contrast ----

const srgbChannel = value => {
  const c = value / 255
  return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
}
/** WCAG relative luminance of a `RRGGBB` hex colour. */
export function luminance(hex) {
  const value = /^#?([0-9a-f]{6})$/i.exec(String(hex || ''))?.[1]
  if (!value) return 0
  const [r, g, b] = [0, 2, 4].map(i => srgbChannel(parseInt(value.slice(i, i + 2), 16)))
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

/** A brand colour too dark to read on the dark theme's bubble (contrast
 *  below 3:1 against a #2a2a2a-ish grey): it switches to the light text
 *  colour there (GitHub, X, Notion, Slack's aubergine). */
export function needsLightOnDark(hex) {
  const bg = luminance('2a2a2a')
  return (luminance(hex) + 0.05) / (bg + 0.05) < 3
}
