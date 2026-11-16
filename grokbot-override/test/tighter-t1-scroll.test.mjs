// Tighter T1: the transcript stays pinned to its bottom when content grows
// after it rendered (an image decoding, a card sizing itself), never moves a
// reader who scrolled up, keeps the reader's place when "Show earlier
// messages" prepends a page, and offers jump-to-latest when a newer message
// arrives while they are away. jsdom + the real OverlayScroll and
// useStickToBottom (bundled with esbuild); layout is modelled because jsdom
// does none.

import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import test from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const ready = ['esbuild', 'jsdom', 'react', 'react-dom'].every(name => existsSync(join(ROOT, 'node_modules', name)))
const skip = !ready && 'dev dependencies not installed'

const ENTRY = `
import * as React from 'react'
import { OverlayScroll } from './src/ui/OverlayScroll'
import { ANCHOR_ATTR, JUMP_MAX_MS, STICK_PX, useStickToBottom } from './src/ui/stickToBottom'
import { groupMessages } from './src/core/groups.js'
export { JUMP_MAX_MS, STICK_PX }
// Rows as Chat.tsx draws them: messages (kind user/assistant) fold into
// groups (the real groupMessages, keyed by the group id), each message root
// carrying its React identity in ANCHOR_ATTR; any other row stands alone.
const message = i => React.createElement('div', { key: i.renderKey ?? i.id, 'data-id': i.id, [ANCHOR_ATTR]: String(i.renderKey ?? i.id) }, i.id)
const rowsView = items =>
  groupMessages(items).map(entry =>
    entry.kind === 'group'
      ? React.createElement('div', { key: entry.id, className: 'group' }, entry.items.map(message))
      : React.createElement('div', { key: entry.id, 'data-id': entry.id }, entry.id)
  )
export function Harness({ items, api }) {
  const mine = items.filter(i => i.mine).map(i => i.id).pop() || ''
  const latest = items.length ? items[items.length - 1].id : ''
  const s = useStickToBottom(items, mine, latest)
  api.current = s
  return React.createElement(
    OverlayScroll,
    {
      className: 'transcript',
      scrollRef: s.ref,
      onScroll: s.onScroll,
      onContentResize: s.onContentResize,
      overlay: s.unseen ? React.createElement('button', { className: 'jump-btn', onClick: s.jump }, 'v') : null
    },
    React.createElement('div', { className: 'transcript__col' }, rowsView(items))
  )
}
`

const ROW = 40
const VIEW = 400

let env = null
async function setup(t) {
  if (env) return env
  const { build } = await import('esbuild')
  mkdirSync(join(ROOT, 'dev/.out'), { recursive: true })
  const dir = mkdtempSync(join(ROOT, 'dev/.out/preview-'))
  const out = join(dir, 't1.mjs')
  await build({
    stdin: { contents: ENTRY, resolveDir: ROOT, loader: 'tsx', sourcefile: 't1-entry.tsx' },
    bundle: true,
    format: 'esm',
    platform: 'node',
    jsx: 'automatic',
    outfile: out,
    external: ['react', 'react-dom', 'react/jsx-runtime'],
    logLevel: 'error'
  })
  const { JSDOM } = await import('jsdom')
  const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/', pretendToBeVisual: true })
  const w = dom.window
  const set = (key, value) => Object.defineProperty(globalThis, key, { value, configurable: true, writable: true })
  for (const key of ['window', 'document', 'navigator', 'HTMLElement', 'Element', 'Node', 'Text', 'Event', 'MutationObserver', 'getComputedStyle']) {
    set(key, key === 'getComputedStyle' ? w.getComputedStyle.bind(w) : w[key])
  }
  set('requestAnimationFrame', fn => setTimeout(() => fn(Date.now()), 0))
  set('cancelAnimationFrame', id => clearTimeout(id))
  set('IS_REACT_ACT_ENVIRONMENT', false)

  // Layout model: every row is ROW px plus `extra` (a late-growing image);
  // the scroller shows VIEW px and clamps its scrollTop like a browser.
  // Every message/row is ROW px plus layout.heights[id]; the LAST one also
  // holds `extra` (the live reply or an image growing at the tail).
  const layout = { extra: 0, heights: {} }
  const units = scroller => [...scroller.querySelectorAll('[data-id]')]
  const heightOf = (el, list) => ROW + (layout.heights[el.getAttribute('data-id')] || 0) + (el === list[list.length - 1] ? layout.extra : 0)
  const content = el => {
    const list = units(el)
    return list.reduce((sum, u) => sum + heightOf(u, list), 0)
  }
  const unitTop = (el, list) => {
    let y = 0
    for (const u of list) {
      if (u === el) return y
      y += heightOf(u, list)
    }
    return y
  }
  const tops = new WeakMap()
  const proto = w.HTMLElement.prototype
  Object.defineProperty(proto, 'scrollHeight', { configurable: true, get() { return this.classList.contains('transcript') ? Math.max(VIEW, content(this)) : 0 } })
  Object.defineProperty(proto, 'clientHeight', { configurable: true, get() { return this.classList.contains('transcript') ? VIEW : 0 } })
  Object.defineProperty(proto, 'scrollTop', {
    configurable: true,
    get() { return tops.get(this) || 0 },
    set(v) { tops.set(this, Math.max(0, Math.min(Number(v) || 0, this.scrollHeight - this.clientHeight))) }
  })
  // Geometry: units stack in document order; a group spans its messages.
  // The scroller's viewport starts at 0.
  const zero = { top: 0, bottom: 0, height: 0, left: 0, right: 0, width: 0 }
  Object.defineProperty(proto, 'getBoundingClientRect', {
    configurable: true,
    value() {
      if (this.classList.contains('transcript')) return { top: 0, bottom: VIEW, height: VIEW, left: 0, right: 0, width: 0 }
      const scroller = this.closest('.transcript')
      if (!scroller) return zero
      const list = units(scroller)
      const span = this.hasAttribute('data-id') ? [this] : [...this.querySelectorAll('[data-id]')]
      if (!span.length) return zero
      const top = unitTop(span[0], list) - scroller.scrollTop
      const bottom = unitTop(span[span.length - 1], list) + heightOf(span[span.length - 1], list) - scroller.scrollTop
      return { top, bottom, height: bottom - top, left: 0, right: 0, width: 0 }
    }
  })
  // Element.scrollTo: an instant jump by default (one scroll event); with
  // layout.manualSmooth the test plays the animation's progress itself.
  layout.scrollCalls = []
  Object.defineProperty(proto, 'scrollTo', {
    configurable: true,
    value(options) {
      layout.scrollCalls.push(options)
      if (layout.manualSmooth && options?.behavior === 'smooth') {
        layout.target = options.top
        return
      }
      this.scrollTop = options?.top ?? 0
      this.dispatchEvent(new w.Event('scroll'))
    }
  })
  // prefers-reduced-motion, switched by the test.
  layout.reduced = false
  w.matchMedia = query => ({ matches: /prefers-reduced-motion: reduce/.test(query) ? layout.reduced : false, media: query, addEventListener() {}, removeEventListener() {} })
  // ResizeObserver: the test fires it (a browser does after layout).
  const observers = new Set()
  set('ResizeObserver', class {
    constructor(fn) { this.fn = fn; observers.add(this) }
    observe() {}
    disconnect() { observers.delete(this) }
  })
  const fireResize = () => observers.forEach(o => o.fn([]))

  const m = await import(pathToFileURL(out).href)
  const React = (await import('react')).default
  const { createRoot } = await import('react-dom/client')
  t.after(() => {
    rmSync(dir, { recursive: true, force: true })
    dom.window.close()
  })
  env = { m, React, createRoot, layout, fireResize }
  return env
}

const settle = async (n = 6) => {
  for (let i = 0; i < n; i += 1) await new Promise(r => setTimeout(r, 0))
}
const rows = (n, from = 0, prefix = 'r') => Array.from({ length: n }, (_, i) => ({ id: `${prefix}${from + i}` }))

function mount({ m, React, createRoot }, items) {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  const api = { current: null }
  let current = items
  const draw = next => {
    current = next
    root.render(React.createElement(m.Harness, { items: next, api }))
  }
  draw(items)
  const scroller = () => container.querySelector('.transcript')
  const scrollTo = top => {
    scroller().scrollTop = top
    scroller().dispatchEvent(new window.Event('scroll'))
  }
  return { container, api, draw, scroller, scrollTo, items: () => current, unmount: () => (root.unmount(), container.remove()) }
}

test('pinned: a late-growing image keeps the view at the bottom; scrolled up: it does not move', { skip }, async t => {
  const e = await setup(t)
  e.layout.extra = 0
  const view = mount(e, rows(30))
  await settle()
  const el = view.scroller()
  assert.equal(el.scrollTop, 30 * ROW - VIEW, 'opens at the bottom')

  // An <img> decodes and grows the column by 300px after the render.
  e.layout.extra = 300
  e.fireResize()
  assert.equal(el.scrollTop, 30 * ROW + 300 - VIEW, 'still at the bottom after late growth')

  // The reader scrolls up; more late growth leaves them where they are.
  view.scrollTo(200)
  await settle()
  e.layout.extra = 600
  e.fireResize()
  assert.equal(el.scrollTop, 200, 'a reader who scrolled up is not moved')
  view.unmount()
})

test('a newer message while scrolled up shows jump-to-latest; a click goes to the bottom and re-pins', { skip }, async t => {
  const e = await setup(t)
  e.layout.extra = 0
  e.layout.manualSmooth = false
  const view = mount(e, rows(30))
  await settle()
  assert.equal(view.container.querySelector('.jump-btn'), null, 'no button at the bottom')
  view.scrollTo(100)
  await settle()
  assert.equal(view.container.querySelector('.jump-btn'), null, 'scrolling up alone shows nothing')
  view.draw([...view.items(), { id: 'new1' }])
  await settle()
  assert.equal(view.scroller().scrollTop, 100, 'not pulled down')
  const btn = view.container.querySelector('.jump-btn')
  assert.ok(btn, 'the jump button shows')
  assert.ok(!view.scroller().contains(btn), 'outside the scroller, so it stays put')
  btn.click()
  await settle()
  assert.equal(view.scroller().scrollTop, 31 * ROW - VIEW, 'at the bottom')
  assert.equal(view.container.querySelector('.jump-btn'), null, 'button gone')
  e.layout.extra = 120
  e.fireResize()
  assert.equal(view.scroller().scrollTop, 31 * ROW + 120 - VIEW, 'pinned again: late growth follows')
  view.unmount()
})

test('Show earlier: 50 prepended rows leave the first visible row at the same offset', { skip }, async t => {
  const e = await setup(t)
  e.layout.extra = 0
  const view = mount(e, rows(40, 100))
  await settle()
  view.scrollTo(400)
  await settle()
  const el = view.scroller()
  const firstVisible = Math.floor(el.scrollTop / ROW) // index within the list
  const id = view.items()[firstVisible].id
  const offsetBefore = firstVisible * ROW - el.scrollTop
  await view.api.current.keepPlace(async () => {
    await settle(2)
    view.draw([...rows(50, 50), ...view.items()])
    await settle(2)
  })
  await settle()
  const index = view.items().findIndex(item => item.id === id)
  assert.equal(index, firstVisible + 50)
  assert.equal(index * ROW - el.scrollTop, offsetBefore, 'same row at the same offset')
  assert.equal(view.container.querySelector('.jump-btn'), null, 'older rows are not "newer"')
  view.unmount()
})

test('STICK_PX stays small (Chat.tsx re-exports it: look9-card-scroll)', { skip }, async t => {
  const e = await setup(t)
  assert.ok(e.m.STICK_PX <= 24)
})

// ---- review r1 regressions ----

test('r1-02: a smooth jump keeps following while the live reply grows; its progress events never unpin', { skip }, async t => {
  const e = await setup(t)
  e.layout.extra = 0
  e.layout.reduced = false
  e.layout.manualSmooth = true
  const view = mount(e, rows(30))
  await settle()
  const el = view.scroller()
  view.scrollTo(100)
  await settle()
  view.draw([...view.items(), { id: 'live1' }])
  await settle()
  const btn = view.container.querySelector('.jump-btn')
  assert.ok(btn, 'jump offered')
  e.layout.scrollCalls.length = 0
  btn.click()
  await settle()
  assert.equal(e.layout.scrollCalls.at(-1)?.behavior, 'smooth')
  assert.equal(e.layout.target, 31 * ROW, 'aims at the bottom')
  // Animation progress: well above the bottom.
  el.scrollTop = 300
  el.dispatchEvent(new window.Event('scroll'))
  await settle()
  // The same live reply grows by 300px mid-animation: the jump re-targets.
  e.layout.extra = 300
  e.fireResize()
  assert.equal(e.layout.target, 31 * ROW + 300, 're-targeted at the new bottom')
  assert.equal(el.scrollTop, 300, 'still smooth: no instant snap')
  // The animation arrives.
  el.scrollTop = e.layout.target
  el.dispatchEvent(new window.Event('scroll'))
  await settle()
  assert.equal(el.scrollHeight - el.scrollTop - el.clientHeight, 0, 'at the bottom')
  assert.equal(view.container.querySelector('.jump-btn'), null)
  // Pinned again: more growth follows.
  e.layout.extra = 500
  e.fireResize()
  assert.equal(el.scrollHeight - el.scrollTop - el.clientHeight, 0, 'still following')
  view.unmount()
})

test('r1-02: the reader taking over (wheel) ends a jump in flight; the button comes back', { skip }, async t => {
  const e = await setup(t)
  e.layout.extra = 0
  e.layout.manualSmooth = true
  const view = mount(e, rows(30))
  await settle()
  const el = view.scroller()
  view.scrollTo(100)
  await settle()
  view.draw([...view.items(), { id: 'live2' }])
  await settle()
  view.container.querySelector('.jump-btn').click()
  await settle()
  el.scrollTop = 200
  el.dispatchEvent(new window.Event('scroll'))
  el.dispatchEvent(new window.Event('wheel'))
  await settle()
  e.layout.extra = 200
  e.fireResize()
  assert.equal(el.scrollTop, 200, 'no longer followed: the reader is in charge')
  assert.ok(view.container.querySelector('.jump-btn'), 'the newest message is still unseen')
  view.unmount()
})

test('r1-04: Jump to latest honours prefers-reduced-motion', { skip }, async t => {
  const e = await setup(t)
  e.layout.extra = 0
  e.layout.manualSmooth = true
  e.layout.reduced = true
  t.after(() => (e.layout.reduced = false))
  const view = mount(e, rows(30))
  await settle()
  view.scrollTo(100)
  await settle()
  view.draw([...view.items(), { id: 'n3' }])
  await settle()
  e.layout.scrollCalls.length = 0
  view.container.querySelector('.jump-btn').click()
  await settle()
  assert.ok(e.layout.scrollCalls.every(c => c?.behavior !== 'smooth'), 'no smooth scroll requested')
  const el = view.scroller()
  assert.equal(el.scrollHeight - el.scrollTop - el.clientHeight, 0, 'at the bottom at once')
  assert.equal(view.container.querySelector('.jump-btn'), null)
  view.unmount()
})

test('r1-03: Show earlier during a live reply: growth below the reader moves nothing; the prepend keeps the row', { skip }, async t => {
  const e = await setup(t)
  e.layout.extra = 0
  e.layout.manualSmooth = false
  const view = mount(e, rows(30, 100))
  await settle()
  const el = view.scroller()
  view.scrollTo(100)
  await settle()
  const rowOffset = id => {
    const node = view.container.querySelector(`[data-id="${id}"]`)
    return node.getBoundingClientRect().top
  }
  // r102 starts at 80 - 100 = -20: r103 is the first fully visible row.
  const before = rowOffset('r103')
  let release
  const pending = view.api.current.keepPlace(() => new Promise(resolve => (release = resolve)))
  await settle()
  // The live reply at the tail grows by 300px while the page loads.
  e.layout.extra = 300
  e.fireResize()
  assert.equal(el.scrollTop, 100, 'growth below the reader does not move the view')
  assert.equal(rowOffset('r103'), before)
  // The older page lands.
  view.draw([...rows(50, 50), ...view.items()])
  await settle(2)
  assert.equal(rowOffset('r103'), before, 'same row, same offset after the prepend')
  release()
  await pending
  await settle()
  assert.equal(rowOffset('r103'), before, 'and after the load settles')
  // More tail growth afterwards: still not moved (the reader is scrolled up).
  e.layout.extra = 600
  e.fireResize()
  assert.equal(rowOffset('r103'), before)
  view.unmount()
})

test('r1-03: the reader scrolling while the older page loads keeps what they scrolled to', { skip }, async t => {
  const e = await setup(t)
  e.layout.extra = 0
  const view = mount(e, rows(30, 100))
  await settle()
  view.scrollTo(100)
  await settle()
  let release
  const pending = view.api.current.keepPlace(() => new Promise(resolve => (release = resolve)))
  await settle()
  view.scrollTo(220) // the reader moves down three rows
  await settle()
  const at = view.container.querySelector('[data-id="r106"]').getBoundingClientRect().top
  view.draw([...rows(50, 50), ...view.items()])
  await settle(2)
  release()
  await pending
  await settle()
  assert.equal(view.container.querySelector('[data-id="r106"]').getBoundingClientRect().top, at)
  view.unmount()
})

// ---- review r2 regressions (grouped DOM, as Chat.tsx draws it) ----

const T = 1_762_560_000_000
/** A run of bot messages one minute apart: one group. */
const botRun = (n, from, prefix = 'a', start = T) => Array.from({ length: n }, (_, i) => ({ kind: 'assistant', id: `${prefix}${from + i}`, at: start + (from + i) * 1000 }))

test('r2-02: reading inside a tall bot group whose last bubble streams: growth below never moves the reader, nor does the prepend', { skip }, async t => {
  const e = await setup(t)
  e.layout.extra = 0
  e.layout.heights = {}
  const items = [{ kind: 'user', id: 'u1', at: T }, ...botRun(30, 100)]
  const view = mount(e, items)
  await settle()
  const el = view.scroller()
  assert.equal(view.container.querySelectorAll('.group').length, 2, 'a user group and one 1200px bot group')
  view.scrollTo(100)
  await settle()
  const offset = id => view.container.querySelector(`[data-id="${id}"]`).getBoundingClientRect().top
  const before = offset('a102')
  assert.equal(before, 20)
  let release
  const pending = view.api.current.keepPlace(() => new Promise(resolve => (release = resolve)))
  await settle()
  e.layout.extra = 300 // the group's last (live) bubble grows below the viewport
  e.fireResize()
  assert.equal(el.scrollTop, 100, 'not moved by growth below')
  assert.equal(offset('a102'), before)
  view.draw([...Array.from({ length: 50 }, (_, i) => ({ kind: i % 2 ? 'assistant' : 'user', id: `o${i}`, at: T - 3_600_000 + i * 1000 })), ...view.items()])
  await settle(2)
  release()
  await pending
  await settle()
  assert.equal(offset('a102'), before, 'same message, same offset after 50 older rows')
  assert.equal(el.scrollTop, 2100)
  view.unmount()
})

test('r2-02: older bot bubbles joining the front of the reader’s group (group re-created) keep the reader’s message in place', { skip }, async t => {
  const e = await setup(t)
  e.layout.extra = 0
  e.layout.heights = {}
  const view = mount(e, botRun(30, 100))
  await settle()
  const el = view.scroller()
  view.scrollTo(100)
  await settle()
  const node = () => view.container.querySelector('[data-id="a103"]')
  const first = node()
  const before = first.getBoundingClientRect().top
  let release
  const pending = view.api.current.keepPlace(() => new Promise(resolve => (release = resolve)))
  await settle()
  e.layout.extra = 200
  e.fireResize()
  // 50 older bot bubbles, a minute apart: they join the same group at its
  // front, so the group gets a new key and is re-created.
  view.draw([...botRun(50, 50), ...view.items()])
  await settle(2)
  release()
  await pending
  await settle()
  assert.equal(view.container.querySelectorAll('.group').length, 1, 'one group')
  assert.notEqual(node(), first, 'the group was re-created (new DOM)')
  assert.equal(node().getBoundingClientRect().top, before, 'found again by its key, same offset')
  assert.equal(el.scrollTop, 100 + 50 * ROW)
  view.unmount()
})

test('r2-02: reading inside one tall streaming bubble: its growth does not move the reader', { skip }, async t => {
  const e = await setup(t)
  e.layout.extra = 0
  e.layout.heights = { a109: 1000 }
  const view = mount(e, [{ kind: 'user', id: 'u1', at: T }, ...botRun(10, 100)])
  await settle()
  const el = view.scroller()
  view.scrollTo(500) // inside a109 (top 400, 1040 tall)
  await settle()
  const top = () => view.container.querySelector('[data-id="a109"]').getBoundingClientRect().top
  const before = top()
  let release
  const pending = view.api.current.keepPlace(() => new Promise(resolve => (release = resolve)))
  await settle()
  e.layout.extra = 400 // a109 is the last bubble: it streams on
  e.fireResize()
  assert.equal(el.scrollTop, 500)
  assert.equal(top(), before)
  view.draw([...botRun(20, 50, 'a', T - 3_600_000), ...view.items()])
  await settle(2)
  release()
  await pending
  await settle()
  assert.equal(top(), before)
  view.unmount()
})

test('r2-03: a jump still animating at its time limit settles at the bottom and keeps following', { skip }, async t => {
  const e = await setup(t)
  e.layout.extra = 0
  e.layout.heights = {}
  e.layout.manualSmooth = true
  e.layout.reduced = false
  const view = mount(e, rows(30))
  await settle()
  const el = view.scroller()
  view.scrollTo(100)
  await settle()
  view.draw([...view.items(), { id: 'live3' }])
  await settle()
  view.container.querySelector('.jump-btn').click()
  await settle()
  const gap = () => el.scrollHeight - el.scrollTop - el.clientHeight
  // A sustained reply: every 100 ms the animation advances 60px and the
  // reply grows 60px, so it never arrives before the limit.
  const started = Date.now()
  while (Date.now() - started < e.m.JUMP_MAX_MS + 100) {
    el.scrollTop += 60
    el.dispatchEvent(new window.Event('scroll'))
    e.layout.extra += 60
    e.fireResize()
    await new Promise(r => setTimeout(r, 100))
  }
  await settle()
  assert.equal(gap(), 0, 'settled at the bottom at the limit')
  assert.equal(view.container.querySelector('.jump-btn'), null, 'no button: nothing unseen')
  e.layout.scrollCalls.length = 0
  e.layout.extra += 300
  e.fireResize()
  assert.equal(gap(), 0, 'still pinned: later growth follows')
  view.unmount()
})
