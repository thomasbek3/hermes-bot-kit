// Slash commands in a Bot Chat (PARITY C19), on the same gateway calls the
// app's composer makes (apps/desktop/src/app/session/hooks/use-prompt-actions/
// slash.ts, slash-session-commands.ts; lib/desktop-slash-commands.ts names how
// each command is fulfilled; Hermes Agent, MIT, (c) Nous Research, 2bd378ed1b):
//
//  - `/compress` (alias `/compact`): `session.compress {session_id,
//    focus_topic?}` with the long budget (slash.ts:803-960, 660 s), never
//    slash.exec (#44456). `pending` = still running on the host.
//  - `/new` and `/reset` in a Bot Chat become `/compact`: the forever-chat
//    never resets (hermes-bots/plugin.tsx:767-799, the new-compact guard).
//  - `/status`: `session.status {session_id}` (an `rpc` surface).
//  - `/steer <text>`: `session.steer` while a turn runs, else the words are
//    queued as the next turn (slash-session-commands.ts:340-388).
//  - `/queue <text>`: `prompt.submit {queued: true}` (the busy path holds it
//    for the next turn, never redirects; submit.ts:1100-1106).
//  - `/undo [N]` and `/retry`: the canonical rewind (`session.rewind`, the
//    host's `session.mutate rewind`) derived from the owner's resume snapshot
//    (slash-session-commands.ts:166-338); a legacy gateway that does not
//    serve it runs them through slash.exec (stock runExec). The canonical
//    shared gateway refuses them as slash.exec (desktop-slash-commands.ts:305).
//  - everything else, skills included: `slash.exec {session_id, command}`,
//    then the typed directive (exec/plugin output, alias, send, skill,
//    prefill) per `parseCommandDispatch` (apps/shared/src/slash.ts:85-117);
//    a failed slash.exec falls back to `command.dispatch {session_id, name,
//    arg}` (slash.ts:520-582), but only after the gateway answered with a
//    refusal: a lost reply may mean the command ran (core/outcomes.js
//    slashExecFailure).
//  - `/title` is refused here: the Bot Chat's identity IS its title
//    (canonical-chat.ts), so renaming it would orphan the forever-chat.
//  - Desktop-app actions with no gateway call (`/skin`, `/profile`, `/pet`,
//    `/save`, …) are the Hermes window's own UI; the override says so.

export const COMPRESS_TIMEOUT_MS = 660_000

const ALIASES = { compact: 'compress', commands: 'help', s: 'steer', q: 'queue', reset: 'new' }

/** Commands whose fulfilment is a Desktop window action (no gateway call). */
export const DESKTOP_ONLY = new Set([
  'wake', 'handoff', 'profile', 'skin', 'browser', 'journey', 'learning', 'memory-graph', 'resume', 'sessions',
  'switch', 'pet', 'pets', 'hatch', 'generate-pet', 'rollback', 'agents', 'tasks', 'config', 'history', 'save',
  'export', 'import', 'timestamps', 'ts', 'palette', 'density', 'details', 'logs', 'mouse', 'btw', 'bg', 'background'
])

/** `/name arg` → { name, arg, command } (name lowercased, alias-resolved),
 *  or null when the text is not a command. */
export function parseSlash(text) {
  const match = /^\/([^\s/]+)(?:\s+([\s\S]*))?$/.exec(String(text || '').trim())
  if (!match) return null
  const raw = match[1].toLowerCase()
  const name = ALIASES[raw] || raw
  const arg = (match[2] || '').trim()
  return { name, raw, arg, command: `${match[1]}${arg ? ` ${arg}` : ''}` }
}

/** How the override fulfils a parsed command. */
export function slashSurface(parsed) {
  if (!parsed) return 'none'
  if (parsed.name === 'new') return parsed.arg ? 'exec' : 'new-guard'
  if (['compress', 'status', 'help', 'title', 'steer', 'queue', 'model', 'undo', 'retry'].includes(parsed.name)) return parsed.name
  if (DESKTOP_ONLY.has(parsed.raw) || DESKTOP_ONLY.has(parsed.name)) return 'desktop'
  return 'exec'
}

const str = value => (typeof value === 'string' ? value : '')

/** apps/shared/src/slash.ts parseCommandDispatch. */
export function parseCommandDispatch(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  switch (raw.type) {
    case 'alias':
      return typeof raw.target === 'string' ? { type: 'alias', target: raw.target } : null
    case 'exec':
    case 'plugin':
      return { type: raw.type, output: str(raw.output) }
    case 'prefill':
      return typeof raw.message === 'string' ? { type: 'prefill', message: raw.message, notice: str(raw.notice) } : null
    case 'send':
      return typeof raw.message === 'string' ? { type: 'send', message: raw.message, notice: str(raw.notice), display: str(raw.display) } : null
    case 'skill':
      return typeof raw.name === 'string' ? { type: 'skill', name: raw.name, message: str(raw.message), display: str(raw.display) } : null
    default:
      return null
  }
}

/** utils.ts renderRpcResult, the parts a Bot Chat can get back. */
export function renderRpcResult(response) {
  if (!response || typeof response !== 'object') return ''
  const summary = response.summary
  if (summary && typeof summary === 'object' && typeof summary.headline === 'string' && summary.headline) {
    return [`${summary.noop ? '' : '✓ '}${summary.headline}`, summary.token_line ? `  ${summary.token_line}` : '', summary.note ? `  ${summary.note}` : '']
      .filter(Boolean)
      .join('\n')
  }
  if (typeof response.output === 'string') return response.output
  if (typeof response.text === 'string') return response.text
  if (typeof response.message === 'string') return response.message
  return ''
}

export const HELP_TEXT = [
  'Commands in this chat:',
  '/compress [focus] (/compact): summarise earlier messages; the chat goes on',
  '/new, /reset: this Bot Chat never resets, so it compacts instead',
  '/status: this session’s status',
  '/steer <text>: nudge the running reply; /queue <text>: send after it',
  '/<skill> and every other gateway command run here as in Hermes',
  'Window commands (/skin, /profile, /pet, /save …) belong to the Hermes window.'
].join('\n')
