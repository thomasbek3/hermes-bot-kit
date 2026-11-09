// A fake bot gateway for the chat controller: records every RPC, answers from
// per-method handlers, delivers events, and runs timers on demand.

export const BOT = {
  name: 'scholar',
  connectionId: 'home-server',
  connectionKind: 'ssh',
  remoteSource: true,
  sourceScoped: true,
  route: { connectionId: 'home-server', mode: 'remote', profile: 'scholar', targetProfile: 'scholar' },
  canonical_session: { id: 'root', resolved_id: 'tip' }
}

export function gateway(handlers = {}) {
  const calls = []
  const listeners = new Set()
  const timers = []
  let clock = 1_762_560_000_000

  const defaults = {
    'session.list': () => ({ sessions: [{ id: 'root', resolved_id: 'tip', message_count: 3, title: 'Bot Chat' }] }),
    'session.resume': () => ({ session_id: 'rt-1', message_count: 3, messages: [], running: false }),
    'prompt.submit': () => ({ status: 'streaming' }),
    'session.interrupt': () => ({ status: 'interrupted' }),
    'approval.pending': () => ({ approvals: [] }),
    'approval.respond': () => ({ resolved: 1 }),
    // A started turn keeps running until its own events say otherwise.
    'session.active_list': params => ({ sessions: params?.current_session_id ? [{ id: params.current_session_id, status: 'working' }] : [] }),
    REST: () => ({
      session_id: 'tip',
      messages: [
        { id: 1, role: 'user', content: 'hi', timestamp: 1762560000 },
        { id: 2, role: 'assistant', content: 'hello', timestamp: 1762560001 }
      ],
      pagination: { limit: 120, offset: 0, order: 'latest', returned: 2 }
    })
  }

  const answer = async (method, params) => {
    const handler = handlers[method] ?? defaults[method]
    if (!handler) throw Object.assign(new Error(`unexpected ${method}`), { code: -32601 })
    return handler(params, calls)
  }

  const deps = {
    requestForBot: async (bot, method, params = {}, options) => {
      calls.push({ method, params, options })
      return answer(method, params)
    },
    readHistory: async (bot, sessionId, page) => {
      calls.push({ method: 'REST', params: { sessionId, ...page } })
      return answer('REST', { sessionId, ...page })
    },
    onEvent: (type, listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    setTimer: (fn, ms) => {
      const timer = { fn, ms, cancelled: false }
      timers.push(timer)
      return () => {
        timer.cancelled = true
      }
    },
    now: () => (clock += 1000)
  }

  return {
    deps,
    calls,
    methods: () => calls.map(c => c.method),
    emit(event) {
      for (const listener of [...listeners]) listener(event)
    },
    listenerCount: () => listeners.size,
    async runTimers() {
      const due = timers.splice(0).filter(t => !t.cancelled)
      for (const timer of due) await timer.fn()
      await new Promise(resolve => setImmediate(resolve))
    }
  }
}

export const flush = () => new Promise(resolve => setImmediate(resolve))

/** A remote route through a pooled socket that behaves like Hermes's
 *  secondary gateway pool (store/gateway.ts): every RPC is its own request
 *  lease, and when the lease count reaches zero the socket closes and the
 *  gateway reaps every runtime session minted on it (the next RPC naming one
 *  fails 4001). `deps.retainRoute` is the host.retainProfile lease. */
export function pooledGateway({ retainGate = null, retainFails = false, handlers = {} } = {}) {
  let leases = 0
  let minted = 0
  const alive = new Set()
  const failures = []
  const order = []
  const retains = []
  let releases = 0

  const live = (method, id) => {
    if (alive.has(id)) return
    failures.push(method)
    throw Object.assign(new Error(`session ${id} not in memory`), { code: 4001 })
  }
  const drop = () => {
    leases -= 1
    if (leases === 0) alive.clear()
  }

  const gw = gateway({
    'session.resume': () => {
      const id = `rt-${(minted += 1)}`
      alive.add(id)
      return { session_id: id, running: false }
    },
    'prompt.submit': params => (live('prompt.submit', params.session_id), { status: 'streaming' }),
    'image.attach_bytes': params => (live('image.attach_bytes', params.session_id), { attached: true }),
    'file.attach': params => (live('file.attach', params.session_id), { attached: true, ref_text: `@file:${params.name}` }),
    'approval.pending': params => (live('approval.pending', params.session_id), { approvals: [] }),
    'approval.respond': params => (live('approval.respond', params.session_id), { resolved: 1 }),
    'session.interrupt': params => (live('session.interrupt', params.session_id), { status: 'interrupted' }),
    ...handlers
  })
  const inner = gw.deps.requestForBot
  gw.deps.requestForBot = async (bot, method, params = {}, options) => {
    leases += 1
    order.push(method)
    try {
      return await inner(bot, method, params, options)
    } finally {
      drop()
    }
  }
  gw.deps.retainRoute = async (bot, options) => {
    order.push('retain')
    retains.push({ bot: bot?.name, options })
    if (retainGate) await retainGate
    if (typeof retainFails === 'function' ? retainFails() : retainFails) throw new Error('retain failed')
    leases += 1
    let released = false
    return () => {
      if (released) return
      released = true
      releases += 1
      drop()
    }
  }
  return {
    ...gw,
    live,
    alive: id => alive.has(id),
    leases: () => leases,
    failures,
    order,
    retains,
    get releases() {
      return releases
    }
  }
}
