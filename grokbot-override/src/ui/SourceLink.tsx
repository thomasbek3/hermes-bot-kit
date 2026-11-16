// Source links in bot prose: a markdown link (or an autolinked bare URL) to a
// public web page draws as the service's small logo plus the link text,
// underlined text, logo not (core/sourceLinks.js decides the service, the
// label and what a click opens). Hooked into the SDK renderer through its
// `decorateText` prop (markdown-text.tsx: paragraph, list item and table cell
// children), so the renderer still parses the markdown, keeps inline code and
// fenced code plain, and refuses unsafe links: a link it drew as plain text
// (javascript:, data:, a private host) has no `href` here and is left alone.

import * as React from 'react'

import { bareLinkLabel, isBareLink, needsLightOnDark, sourceLinkFor } from '../core/sourceLinks.js'
import { app } from './app'
import { BRAND_MARKS } from './brandMarks'
import { openExternalLink } from './slackActions'

/** Open a source link outside the app. `urls` are tried in order through the
 *  plugin SDK's `ctx.os.openExternal` (it answers false when the host refuses,
 *  e.g. an app scheme such as `slack://`); when none is taken, the first web
 *  URL goes to the desktop bridge / window.open. Callers pass only targets
 *  from core/sourceLinks.js (validated). */
export async function openSource(urls: string | string[]) {
  const list = (Array.isArray(urls) ? urls : [urls]).filter(Boolean)
  const open = app.ctx?.os?.openExternal
  if (typeof open === 'function') {
    for (const url of list) {
      try {
        if ((await open.call(app.ctx.os, url)) !== false) return
      } catch {
        /* the next one */
      }
    }
  }
  const web = list.find(url => /^https?:\/\//i.test(url))
  if (web) openExternalLink(web)
}

function GlobeMark() {
  return (
    <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" focusable="false">
      <circle cx="12" cy="12" r="9" />
      <path d="M3 12h18M12 3c2.6 2.7 3.8 5.7 3.8 9s-1.2 6.3-3.8 9M12 3c-2.6 2.7-3.8 5.7-3.8 9s1.2 6.3 3.8 9" />
    </svg>
  )
}

export function SourceIcon({ id }: { id: string }) {
  const mark = BRAND_MARKS[id]
  if (!mark) {
    return (
      <span className="gbo-src-icon is-web" aria-hidden="true">
        <GlobeMark />
      </span>
    )
  }
  // A tile mark (own drawing) carries its own contrast; a plain glyph too
  // dark for the dark bubble takes the light text colour there.
  const dark = Boolean(mark.path) && needsLightOnDark(mark.hex)
  const style = { '--gbo-src-color': `#${mark.hex}` } as React.CSSProperties
  return (
    <span className={`gbo-src-icon${dark ? ' is-light-on-dark' : ''}`} data-service={id} aria-hidden="true" style={style}>
      {mark.path ? (
        <svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor" focusable="false">
          <path d={mark.path} />
        </svg>
      ) : (
        <svg viewBox="0 0 24 24" width="14" height="14" focusable="false" dangerouslySetInnerHTML={{ __html: String(mark.inner || '') }} />
      )}
    </span>
  )
}

export function SourceLink({ href, children }: { href: string; children?: React.ReactNode }) {
  const link = sourceLinkFor(href)
  if (!link) return null
  const text = typeof children === 'string' || typeof children === 'number' ? String(children) : childText(children)
  const label = isBareLink(text, href) ? bareLinkLabel(href) : children
  return (
    <a
      className="gbo-src"
      href={link.href}
      title={link.href}
      data-service={link.service.id}
      rel="noopener noreferrer"
      onClick={event => {
        event.preventDefault()
        event.stopPropagation()
        void openSource(link.opens)
      }}
      onAuxClick={event => {
        if (event.button !== 1) return
        event.preventDefault()
        event.stopPropagation()
        void openSource(link.opens)
      }}
    >
      <SourceIcon id={link.service.id} />
      <span className="gbo-src-text">{label}</span>
    </a>
  )
}

function childText(node: React.ReactNode): string {
  if (node === null || node === undefined || typeof node === 'boolean') return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(childText).join('')
  if (React.isValidElement(node)) return childText((node.props as any)?.children)
  return ''
}

const isCode = (el: React.ReactElement) => el.type === 'code' || el.type === 'pre' || (el.props as any)?.['data-gbo-code'] !== undefined

/** The renderer's `decorateText` hook: every rendered link with a web or
 *  Slack href becomes a SourceLink; nested inline markup (bold around a
 *  link) is walked; code is never touched. */
function decorate(children: React.ReactNode): React.ReactNode {
  let changed = false
  const next = React.Children.map(children, child => {
    if (!React.isValidElement(child) || isCode(child)) return child
    const props = child.props as any
    if (typeof props?.href === 'string') {
      if (!sourceLinkFor(props.href)) return child
      changed = true
      return (
        <SourceLink key={child.key ?? undefined} href={props.href}>
          {props.children}
        </SourceLink>
      )
    }
    if (props?.children === undefined || typeof props.children === 'string') return child
    const inner = decorate(props.children)
    if (inner === props.children) return child
    changed = true
    return React.cloneElement(child, undefined, inner)
  })
  return changed ? next : children
}

/** Stable identity: the renderer memoises its components on it. */
export const decorateSourceLinks = (children: React.ReactNode) => decorate(children)

// ---- headings and table headers (review SL24-05) ----
//
// The host renderer calls `decorateText` for p / li / td only; links in
// h1-h6 and th are its own anchors. Those are enhanced in place after each
// render: the same logo (a node prepended inside the anchor, aria-hidden),
// the full URL as the title, and a click routed through openSource by a
// capture handler on the plugin's own prose element (so the host anchor's
// own click never runs). Same validation as the chips; never inside code.
// The anchor's text is React's and stays as the host drew it.

const SVG_NS = 'http://www.w3.org/2000/svg'
const HOST_LINKS = ':is(h1, h2, h3, h4, h5, h6, th) a[href]'

function iconNode(doc: Document, id: string): HTMLElement {
  const span = doc.createElement('span')
  span.setAttribute('aria-hidden', 'true')
  span.setAttribute('data-gbo-src-icon', '')
  const svg = doc.createElementNS(SVG_NS, 'svg')
  svg.setAttribute('viewBox', '0 0 24 24')
  svg.setAttribute('width', '14')
  svg.setAttribute('height', '14')
  svg.setAttribute('focusable', 'false')
  const mark = BRAND_MARKS[id]
  if (!mark) {
    span.className = 'gbo-src-icon is-web'
    svg.setAttribute('fill', 'none')
    svg.setAttribute('stroke', 'currentColor')
    svg.setAttribute('stroke-width', '1.8')
    svg.setAttribute('stroke-linecap', 'round')
    for (const d of ['M3 12a9 9 0 1 0 18 0a9 9 0 1 0 -18 0', 'M3 12h18M12 3c2.6 2.7 3.8 5.7 3.8 9s-1.2 6.3-3.8 9M12 3c-2.6 2.7-3.8 5.7-3.8 9s1.2 6.3 3.8 9']) {
      const path = doc.createElementNS(SVG_NS, 'path')
      path.setAttribute('d', d)
      svg.appendChild(path)
    }
  } else {
    span.className = `gbo-src-icon${mark.path && needsLightOnDark(mark.hex) ? ' is-light-on-dark' : ''}`
    span.setAttribute('data-service', id)
    span.style.setProperty('--gbo-src-color', `#${mark.hex}`)
    if (mark.path) {
      svg.setAttribute('fill', 'currentColor')
      const path = doc.createElementNS(SVG_NS, 'path')
      path.setAttribute('d', mark.path)
      svg.appendChild(path)
    } else {
      svg.innerHTML = String(mark.inner || '') // the kit's own static marks (brandMarks.ts)
    }
  }
  span.appendChild(svg)
  return span
}

/** Give heading and table-header links inside `root` the source-link look
 *  and title. Idempotent; returns how many it enhanced. */
export function enhanceSourceLinks(root: Element | null): number {
  if (!root?.querySelectorAll) return 0
  let count = 0
  for (const anchor of Array.from(root.querySelectorAll(HOST_LINKS)) as HTMLAnchorElement[]) {
    if (anchor.classList.contains('gbo-src') || anchor.closest('code, pre, .gbo-code')) continue
    const href = anchor.getAttribute('href') || ''
    const link = sourceLinkFor(href)
    if (!link) continue
    // React may have reset the anchor's text (textContent), taking the logo
    // with it: enhanced means the same href AND the logo still there.
    if (anchor.getAttribute('data-gbo-src-host') === href && anchor.querySelector(':scope > [data-gbo-src-icon]')) continue
    anchor.querySelectorAll(':scope > [data-gbo-src-icon]').forEach(node => node.remove())
    anchor.setAttribute('data-gbo-src-host', href)
    anchor.setAttribute('data-service', link.service.id)
    anchor.classList.add('gbo-src-host')
    anchor.title = link.href
    anchor.insertBefore(iconNode(anchor.ownerDocument, link.service.id), anchor.firstChild)
    count += 1
  }
  return count
}

/** Capture-phase click on the prose element: an enhanced host link opens
 *  through openSource, and the host anchor's own handler never runs. */
export function onSourceClickCapture(event: React.MouseEvent) {
  if (event.type === 'auxclick' && event.button !== 1) return
  const anchor = (event.target as Element | null)?.closest?.('a[data-gbo-src-host]')
  if (!anchor) return
  const link = sourceLinkFor(anchor.getAttribute('href') || '')
  if (!link) return
  event.preventDefault()
  event.stopPropagation()
  void openSource(link.opens)
}

/** Enhance heading / header links after every render of `ref`'s element. */
export function useHostSourceLinks(ref: React.RefObject<HTMLElement | null>) {
  React.useLayoutEffect(() => {
    enhanceSourceLinks(ref.current)
  })
}
