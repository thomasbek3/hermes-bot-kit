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
import { STICK_PX, useStickToBottom } from './src/ui/stickToBottom'
export { STICK_PX }
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
    React.createElement('div', { className: 'transcript__col' }, items.map(i => React.createElement('div', { key: i.id, 'data-id': i.id }, i.id)))
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
  const layout = { extra: 0 }
  const content = el => el.querySelectorAll('[data-id]').length * ROW + layout.extra
  const tops = new WeakMap()
  const proto = w.HTMLElement.prototype
  Object.defineProperty(proto, 'scrollHeight', { configurable: true, get() { return this.classList.contains('transcript') ? Math.max(VIEW, content(this)) : 0 } })
  Object.defineProperty(proto, 'clientHeight', { configurable: true, get() { return this.classList.contains('transcript') ? VIEW : 0 } })
  Object.defineProperty(proto, 'scrollTop', {
    configurable: true,
    get() { return tops.get(this) || 0 },
    set(v) { tops.set(this, Math.max(0, Math.min(Number(v) || 0, this.scrollHeight - this.clientHeight))) }
  })
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
