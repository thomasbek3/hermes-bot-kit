// A bot's "no reply" sentinel. Hermes agents answer a turn they chose not to
// reply to with a silence marker (`[SILENT]`, `NO_REPLY`, …). Hermes's
// gateway drops it from the delivered reply, but the stored row keeps the
// model's text as written (tui_gateway/prompt_turn.py: "only the delivered
// copy drops a silence marker"), the roster preview is the newest stored
// message (methods_profiles.py _latest_message_preview), and a session that
// is not titled "Bot Chat" gets the marker live too. Stock Desktop has no
// renderer-side filter, so it would draw the bubble.
//
// Port of Hermes Agent gateway/response_filters.py (@2bd378ed1b, MIT, (c)
// Nous Research): LIVE_GATEWAY_SILENT_MARKERS, is_intentional_silence_response
// and is_partial_silence_marker. Only a WHOLE reply that is a marker counts;
// a reply that mentions the word anywhere else is a normal reply.

export const SILENCE_MARKERS = Object.freeze(['[SILENT]', 'SILENT', 'NO_REPLY', 'NO REPLY', '[静默]', '静默', '[沉默]', '沉默'])

const MARKERS = new Set(SILENCE_MARKERS)
const MARKER_LENGTH_CAP = 64
const PUNCT = /\p{P}/u

const canonical = text => text.trim().toUpperCase().split(/\s+/).filter(Boolean).join(' ')

// Square brackets stay structural, so a malformed "[SILENT" never becomes "SILENT".
const edgePunct = ch => ch !== '[' && ch !== ']' && PUNCT.test(ch)

function stripEdgePunctuation(text) {
  const chars = Array.from(text)
  let start = 0
  let end = chars.length
  while (start < end && edgePunct(chars[start])) start += 1
  while (end > start && edgePunct(chars[end - 1])) end -= 1
  return chars.slice(start, end).join('').trim()
}

function candidates(text) {
  const stripped = typeof text === 'string' ? text.trim() : ''
  if (!stripped || stripped.length > MARKER_LENGTH_CAP) return []
  const bare = stripEdgePunctuation(stripped)
  return (bare === stripped ? [stripped] : [stripped, bare]).map(canonical)
}

/** True only when the whole reply is a silence marker ("[SILENT]",
 *  "**NO_REPLY**", " silent "). Blank text is not silence. */
export function isSilenceReply(text) {
  return candidates(text).some(c => MARKERS.has(c))
}

/** True while a streaming reply could still turn out to be a marker ("[SIL",
 *  "NO"): the bubble waits instead of flashing the marker. */
export function couldBeSilenceReply(text) {
  return candidates(text).some(c => c && SILENCE_MARKERS.some(marker => marker.startsWith(c)))
}

/** The text a reply line or preview shows: '' for a silence marker. */
export function shownReplyText(text) {
  return isSilenceReply(text) ? '' : text
}
