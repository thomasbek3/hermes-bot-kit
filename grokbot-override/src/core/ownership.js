// Which machine each connection is: ONE table, connectionId -> { installId,
// host, generation, listed, gone }, synced from authoritative registry answers
// (`sources` from host.agents and Bot Mode's roster snapshot).
//
// - A connection whose answer names another machine (`installId`) than the one
//   on record gets a new generation; one that a non-empty enumeration no longer
//   lists is retired, also a new generation.
// - A machine that is merely offline is still listed (reachable false): it keeps
//   its owner. An empty or failed enumeration changes nothing.
// - `stableHost(connectionId)` returns the stable host/install identity for a
//   connection when known, so a re-created connection for the same host maps to
//   the same unread key and the old connectionId does not linger.

export function sourceHostId(source) {
  if (!source || typeof source !== 'object') return ''
  for (const field of ['installId', 'install_id', 'host', 'sshHost', 'ssh_host', 'hostname']) {
    const val = String(source[field] || '').trim()
    if (val) return val
  }
  return ''
}

export function createOwnership({ onRetire = () => undefined } = {}) {
  /** connectionId -> { installId, host, generation, listed, gone } */
  const table = new Map()

  const entryOf = id => {
    const key = String(id || '').trim() || 'local'
    if (!table.has(key)) table.set(key, { installId: '', host: '', generation: 1, listed: false, gone: false })
    return table.get(key)
  }

  function retire(id, entry) {
    entry.generation += 1
    entry.installId = ''
    try {
      onRetire(id)
    } catch {
      /* the owner moves regardless */
    }
  }

  function sync(sources) {
    const list = (Array.isArray(sources) ? sources : []).filter(source => String(source?.connectionId || '').trim())
    if (!list.length) return
    const listed = new Set()
    for (const source of list) {
      const id = String(source.connectionId).trim()
      listed.add(id)
      const entry = entryOf(id)
      entry.listed = true
      entry.gone = false
      const install = String(source.installId || source.install_id || '').trim()
      if (install && entry.installId && install !== entry.installId) retire(id, entry)
      if (install) entry.installId = install
      const host = sourceHostId(source)
      if (host) entry.host = host
    }
    for (const [id, entry] of table) {
      if (listed.has(id) || !entry.listed || entry.gone) continue
      entry.gone = true
      retire(id, entry)
    }
  }

  function accept(id, installId) {
    const install = String(installId || '').trim()
    if (!install) return true
    const entry = entryOf(id)
    if (entry.installId && entry.installId !== install) return false
    entry.installId = install
    if (!entry.host) entry.host = install
    return true
  }

  return {
    sync,
    accept,
    token: id => `${String(id || '').trim() || 'local'}#${entryOf(id).generation}`,
    stableHost: id => entryOf(id).installId || entryOf(id).host || ''
  }
}
