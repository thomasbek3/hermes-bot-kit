// A main-pane model for the "the override owns the main pane" tests (pass 6
// C): Hermes's main zone holds one active pane at a time, either a session
// view ('workspace', 'session-tile:<id>', 'route-tile:<id>', store/layout.ts:798)
// or a plugin workspace. paneVisibility atoms follow it (tree/store.ts
// isPaneVisible: the active slot of its group), revealPane fronts a pane,
// openWorkspace docked center fronts its own pane, and a session tile shows
// as a selected [data-tree-tab] in the DOM.

const ROSTER = 'grokbot-override:roster'

export function mainPaneModel(initial = 'workspace') {
  const state = { pane: initial, history: [initial], reveals: [] }
  const subs = new Map()
  const atomCache = new Map()
  const isMain = id => /^(?:workspace|session-tile:|route-tile:|plugin-workspace:)/.test(id)
  const shown = id => (isMain(id) ? state.pane === id : id === ROSTER ? true : false)
  const notifyAll = () => {
    for (const [id, set] of subs) for (const fn of [...set]) fn(shown(id))
  }
  const tabEl = () => {
    let el = document.getElementById('claim-tab')
    if (!el) {
      el = document.createElement('div')
      el.id = 'claim-tab'
      document.body.appendChild(el)
    }
    return el
  }
  const front = pane => {
    state.pane = pane
    state.history.push(pane)
    if (typeof document !== 'undefined') {
      const el = tabEl()
      el.setAttribute('data-tree-tab', pane)
      el.setAttribute('aria-selected', 'true')
    }
    notifyAll()
  }
  const atom = id => {
    if (!atomCache.has(id)) {
      atomCache.set(id, {
        get: () => shown(id),
        subscribe: fn => {
          if (!subs.has(id)) subs.set(id, new Set())
          subs.get(id).add(fn)
          fn(shown(id))
          return () => subs.get(id)?.delete(fn)
        }
      })
    }
    return atomCache.get(id)
  }
  const focusedSubs = new Set()
  let focused = null
  const focusedAtom = {
    get: () => focused,
    subscribe: fn => (focusedSubs.add(fn), fn(focused), () => focusedSubs.delete(fn))
  }
  /** Hermes restores / opens one of its own session tabs. */
  const restoreSession = storedId => {
    focused = storedId
    front(`session-tile:${storedId}`)
    for (const fn of [...focusedSubs]) fn(focused)
  }
  const tweak = sdk => {
    const { host } = sdk
    host.paneVisibility = atom
    host.state.focusedStoredSessionId = focusedAtom
    host.revealPane = id => {
      state.reveals.push(id)
      if (isMain(id)) front(id)
    }
    const openWorkspace = host.openWorkspace
    host.openWorkspace = (id, options) => {
      const close = openWorkspace(id, options)
      const pane = `plugin-workspace:${id}`
      const dock = options?.dock
      if ((dock?.pane === 'workspace' && dock.pos === 'center') || state.pane !== pane) {
        if (dock?.pane === 'workspace' && dock.pos === 'center') front(pane)
      }
      return () => {
        close()
        if (state.pane === pane) front('workspace')
        options.onClose?.()
      }
    }
    const openSession = host.openSession
    host.openSession = async (id, ...rest) => {
      restoreSession(id)
      return openSession(id, ...rest)
    }
  }
  return { state, tweak, front, restoreSession, setFocused: v => (focused = v) }
}
