// The browser parts the "More unreads" pill needs, faked for jsdom (which has
// no layout, no IntersectionObserver, no ResizeObserver, no matchMedia):
// - a layout: the roster scroller is `view.height` tall at y 0; rows stack
//   `rowHeight` apart in document order, moved by the scroller's scrollTop;
// - an IntersectionObserver with Chromium's notification rule: a target is
//   reported when first observed, then only when its intersecting state or
//   threshold bucket changes; `report()` evaluates the layout now, and
//   `report({ before })` runs `before` between computing the entries and
//   delivering them (an entry that arrives after a scroll jump);
// - a ResizeObserver whose `resize()` calls every observer back;
// - matchMedia for prefers-reduced-motion.

const SCROLLER = '.gbo-roster-list'

export function installLayout({ view, rowHeight }) {
  const proto = window.Element.prototype
  const saved = proto.getBoundingClientRect
  proto.getBoundingClientRect = function () {
    const s = document.querySelector(SCROLLER)
    if (this === s) return { top: 0, bottom: view.height, left: 0, right: 280, width: 280, height: view.height }
    if (s && this.classList?.contains('gbo-row-wrap') && s.contains(this)) {
      const i = [...s.querySelectorAll('.gbo-row-wrap')].indexOf(this)
      const top = i * rowHeight - s.scrollTop
      return { top, bottom: top + rowHeight, left: 0, right: 280, width: 280, height: rowHeight }
    }
    return saved.call(this)
  }
  return () => (proto.getBoundingClientRect = saved)
}

export function installObserver() {
  const observers = new Set()
  let observeCalls = 0
  let unobserveCalls = 0
  class FakeIO {
    constructor(callback, options) {
      this.callback = callback
      this.options = options
      this.targets = new Map() // target -> last state key ('' = not reported yet)
      observers.add(this)
    }
    observe(el) {
      observeCalls += 1
      this.targets.set(el, '')
    }
    unobserve(el) {
      unobserveCalls += 1
      this.targets.delete(el)
    }
    disconnect() {
      this.targets.clear()
      observers.delete(this)
    }
  }
  globalThis.IntersectionObserver = FakeIO
  return {
    observers,
    calls: () => ({ observe: observeCalls, unobserve: unobserveCalls }),
    observed: () => [...observers].flatMap(o => [...o.targets.keys()]),
    report({ before } = {}) {
      const deliveries = []
      for (const o of observers) {
        const root = o.options.root.getBoundingClientRect()
        const thresholds = o.options.threshold
        const entries = []
        for (const [target, last] of o.targets) {
          const r = target.getBoundingClientRect()
          const overlap = Math.max(0, Math.min(r.bottom, root.bottom) - Math.max(r.top, root.top))
          const ratio = overlap / (r.bottom - r.top)
          const isIntersecting = overlap > 0
          const bucket = thresholds.filter(x => ratio >= x && (x > 0 || isIntersecting)).length
          const key = `${isIntersecting}:${bucket}`
          if (key === last) continue
          o.targets.set(target, key)
          entries.push({ target, isIntersecting, intersectionRatio: ratio, boundingClientRect: r, rootBounds: root })
        }
        if (entries.length) deliveries.push(() => o.callback(entries, o))
      }
      before?.()
      for (const deliver of deliveries) deliver()
    }
  }
}

export function installResizeObserver() {
  const observers = new Set()
  globalThis.ResizeObserver = class {
    constructor(callback) {
      this.callback = callback
      this.targets = new Set()
      observers.add(this)
    }
    observe(el) {
      this.targets.add(el)
    }
    unobserve(el) {
      this.targets.delete(el)
    }
    disconnect() {
      this.targets.clear()
      observers.delete(this)
    }
  }
  return {
    resize() {
      for (const o of observers) if (o.targets.size) o.callback([...o.targets].map(target => ({ target, contentRect: target.getBoundingClientRect() })), o)
    }
  }
}

export function installReducedMotion(state) {
  window.matchMedia = query => ({ matches: /prefers-reduced-motion:\s*reduce/.test(query) && state.reduce, media: query, addEventListener() {}, removeEventListener() {} })
  return () => delete window.matchMedia
}
