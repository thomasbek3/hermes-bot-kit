// The one door to the Hermes SDK. A namespace import, never named imports: a
// named import the running Desktop does not export is a module link error that
// would stop the whole plugin from loading, while a missing namespace member
// is just `undefined` and gets feature-detected at the call site.

import * as sdk from '@hermes/plugin-sdk'
import * as React from 'react'

export { sdk }

export const host: any = (sdk as any).host

export const PALETTE_AREA: string = (sdk as any).PALETTE_AREA ?? 'palette'
export const PANES_AREA: string = (sdk as any).PANES_AREA ?? 'panes'

export const CANONICAL_HYDRATION_TIMEOUT_MS: number = Number.isFinite((sdk as any).BOT_CHAT_SESSION_HYDRATION_TIMEOUT_MS)
  ? (sdk as any).BOT_CHAT_SESSION_HYDRATION_TIMEOUT_MS
  : 60_000

export function queryClient(): any {
  return (sdk as any).queryClient ?? null
}

export function profileColor(name: string): string {
  try {
    const fn = (sdk as any).profileColor
    return typeof fn === 'function' ? String(fn(name) || '') : ''
  } catch {
    return ''
  }
}

export function blobatarMarkup(seed: string, size: number, trait?: number): null | string {
  const fn = (sdk as any).blobatarSvg
  if (typeof fn !== 'function') return null
  try {
    return String(fn(seed, trait === undefined ? { size } : { size, traits: { shape: trait } }))
  } catch {
    return null
  }
}

/** Markdown through the app's own renderer when the SDK has it.
 *
 *  Always in the renderer's owner-safe mode (`media: false, previewOnly: true`,
 *  markdown-text.tsx `MessageTextContent`): media paths and file links there
 *  resolve against the ACTIVE gateway and session, but this screen shows bots
 *  on other connections without activating them, so a rich render could read
 *  or open a same-path file on the wrong machine (review r1 #2). Images, file
 *  links and rich fences stay inert; public web links still open. Rich media
 *  is drawn by ui/Media.tsx from the bot's own backend (PARITY C15). */
export const MARKDOWN_SAFE_PROPS = Object.freeze({ media: false, previewOnly: true })

export function Markdown({ text }: { text: string }) {
  const Component = (sdk as any).MessageTextContent
  if (typeof Component === 'function' || (Component && typeof Component === 'object')) {
    return React.createElement(Component, { text, ...MARKDOWN_SAFE_PROPS })
  }
  return React.createElement('div', { className: 'gbo-plain' }, text)
}

/** Read another plugin's (or Bot Mode's) plugin storage: localStorage keys
 *  `hermes.plugin.<id>.<key>` holding JSON. Read-only; never throws. */
export function readPluginStorage<T>(pluginId: string, key: string, fallback: T): T {
  try {
    const raw = globalThis.localStorage?.getItem(`hermes.plugin.${pluginId}.${key}`)
    if (raw === null || raw === undefined) return fallback
    return JSON.parse(raw) as T
  } catch {
    return fallback
  }
}
