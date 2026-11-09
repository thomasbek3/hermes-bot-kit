// Keyboard handling for the narrow-pane profile drawer (review r2 #8): a modal
// over the chat must take focus, keep Tab inside itself, make the chat behind
// it inert, close on Escape pressed inside it (not on any Escape in the app),
// and hand focus back to whatever opened it. DOM-agnostic: `doc` and the
// elements are passed in, so node:test drives it with fakes.

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'

function focusables(container) {
  try {
    return Array.from(container?.querySelectorAll?.(FOCUSABLE) || []).filter(el => !el?.hasAttribute?.('disabled'))
  } catch {
    return []
  }
}

/** Take focus into `container`, make `background` inert. Returns the release
 *  that undoes both and gives focus back to the element that had it. */
export function trapFocus(container, { background = null, doc = globalThis.document } = {}) {
  const opener = doc?.activeElement || null
  const hadInert = Boolean(background?.hasAttribute?.('inert'))
  const hadHidden = Boolean(background?.hasAttribute?.('aria-hidden'))
  try {
    if (background && !hadInert) background.setAttribute('inert', '')
    if (background && !hadHidden) background.setAttribute('aria-hidden', 'true')
  } catch {
    /* detached */
  }
  const first = focusables(container)[0]
  try {
    ;(first || container)?.focus?.()
  } catch {
    /* not focusable */
  }
  let released = false
  return () => {
    if (released) return
    released = true
    try {
      if (background && !hadInert) background.removeAttribute('inert')
      if (background && !hadHidden) background.removeAttribute('aria-hidden')
    } catch {
      /* detached */
    }
    if (opener && opener.isConnected !== false && typeof opener.focus === 'function') {
      try {
        opener.focus()
      } catch {
        /* gone */
      }
    }
  }
}

/** keydown inside the drawer: Escape closes it, Tab / Shift+Tab wrap. */
export function drawerKeyDown(event, container, onClose, doc = globalThis.document) {
  if (event.key === 'Escape') {
    event.preventDefault?.()
    event.stopPropagation?.()
    onClose()
    return
  }
  if (event.key !== 'Tab') return
  const list = focusables(container)
  if (!list.length) {
    event.preventDefault?.()
    return
  }
  const active = doc?.activeElement
  const index = list.indexOf(active)
  const inside = Boolean(active && container?.contains?.(active))
  if (event.shiftKey && (index <= 0 || !inside)) {
    event.preventDefault?.()
    list[list.length - 1].focus()
  } else if (!event.shiftKey && (index === list.length - 1 || !inside)) {
    event.preventDefault?.()
    list[0].focus()
  }
}
