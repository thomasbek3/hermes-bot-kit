// URL checks for links the screen opens outside the app. One place, one
// style: parse with URL, then allow by scheme, host and path. Anything that
// does not parse, or is not allowed, is not opened.

function parsed(value) {
  try {
    return new URL(String(value))
  } catch {
    return null
  }
}

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]'])

/** Slack's OAuth authorize page, exactly (the Add to Slack flow). */
export function isSlackAuthorizationUrl(value) {
  const url = parsed(value)
  return Boolean(url && url.protocol === 'https:' && url.hostname === 'slack.com' && url.pathname === '/oauth/v2/authorize')
}

/** A connection's sign-in link: https anywhere, plain http only to this
 *  machine (a local OAuth helper). No other scheme (javascript:, file:,
 *  data:, custom app schemes) is ever opened. */
export function isOpenableConnectUrl(value) {
  const url = parsed(value)
  if (!url) return false
  if (url.protocol === 'https:') return Boolean(url.hostname)
  return url.protocol === 'http:' && LOOPBACK_HOSTS.has(url.hostname)
}
