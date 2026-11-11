// A bot's face. A real photo (`meta.image`) always wins, clipped round;
// next, for a bot on another connection, the picture its own gateway holds
// (core/remoteAvatars.js, keyed by the exact route key `shapeKey`).
// Otherwise the override draws a silhouette (avatarShapes.ts),
// chosen from the bot's exact route key, filled with the bot's swatch colour
// (core/colors.js botSwatch). The bot editor's previews (`look="hermes"`)
// keep Bot Mode's own faces: a blobatar (`meta.shape` =
// 'blobatar[:seed[:kind]]') through the SDK's `blobatarSvg`, or a rounded
// face in the bot's colour (PARITY.md R2), so they show what Bot Mode saves.

import { botSwatch } from '../core/colors.js'
import { avatarShapeFor } from './avatarShapes'
import { roster2 } from './rosterStores'
import { blobatarMarkup, profileColor } from './sdk'
import { useStore } from './store'

const BLOB_KIND_TRAIT: Record<string, number> = {
  round: 0.11,
  organic: 0.35,
  boxy: 0.54,
  capsule: 0.65,
  nub: 0.745,
  cloud: 0.825,
  droplet: 0.8875,
  hexagon: 0.9325,
  sun: 0.965,
  triangle: 0.99
}

export function botColor(name: string, meta: any): string {
  if (String(name || '').toLowerCase() === 'default' && !meta?.custom) return '#8b5cf6'
  return String(meta?.color || profileColor(name) || '#8b5cf6')
}

function isBlobShape(shape: unknown): shape is string {
  return shape === 'blobatar' || (typeof shape === 'string' && shape.startsWith('blobatar:'))
}

/** A silhouette face: the body outline in white, then the body with its eye
 *  holes in the swatch fill, so the eyes read white on any background. */
export function ShapeFace({ shapeKey, fill, swatch }: { shapeKey: string; fill: string; swatch?: string }) {
  const shape = avatarShapeFor(shapeKey)
  return (
    <svg viewBox={shape.viewBox} data-shape={shape.name} data-swatch={swatch} overflow="visible">
      <path d={shape.outline} fill="#fff" />
      <path d={shape.outline + shape.eyes} fill={fill} fillRule="evenodd" />
    </svg>
  )
}

function swatchProps(color: string) {
  const swatch = botSwatch(color)
  return { fill: swatch.fill, swatch: swatch.name }
}

export function BotAvatar({
  name,
  meta,
  size = 38,
  working = false,
  shapeKey,
  look = 'shape'
}: {
  name: string
  meta: any
  size?: number
  working?: boolean
  /** The bot's exact route key (roster rowKey): picks its silhouette. */
  shapeKey?: string
  /** 'hermes' draws Bot Mode's own face (the bot editor's previews). */
  look?: 'shape' | 'hermes'
}) {
  const cls = `gbo-avatar${working ? ' is-working' : ''}`
  const style = { width: size, height: size }
  const remote = useStore(roster2.remoteAvatars)

  if (typeof meta?.image === 'string' && meta.image) {
    return (
      <span className={cls} style={style} aria-hidden>
        <img alt="" src={meta.image} />
      </span>
    )
  }

  // The bot editor's previews (`look="hermes"`) show what Bot Mode saves, so
  // only the roster's own faces take the server picture.
  const served = look !== 'hermes' && shapeKey ? remote[shapeKey] : undefined
  if (served) {
    return (
      <span className={cls} style={style} aria-hidden data-avatar="server">
        <img alt="" src={served} />
      </span>
    )
  }

  if (look !== 'hermes') {
    return (
      <span className={cls} style={style} aria-hidden>
        <ShapeFace shapeKey={shapeKey || String(name || 'default')} {...swatchProps(botColor(name, meta))} />
      </span>
    )
  }

  const isDefault = String(name || '').toLowerCase() === 'default' && !meta?.custom
  if (!isDefault && isBlobShape(meta?.shape)) {
    const parts = meta.shape.split(':')
    const seed = parts[1] || name || 'agent'
    const trait = BLOB_KIND_TRAIT[parts[2]]
    const markup = blobatarMarkup(seed, size, trait)
    if (markup) {
      return <span className={cls} style={style} aria-hidden dangerouslySetInnerHTML={{ __html: markup }} />
    }
  }

  const color = botColor(name, meta)
  return (
    <span className={cls} style={style} aria-hidden>
      <svg viewBox="0 0 40 40">
        <rect x="2" y="2" width="36" height="36" rx="13" fill={color} />
        <circle cx="15" cy="18" r="2.6" fill="#fff" />
        <circle cx="25" cy="18" r="2.6" fill="#fff" />
      </svg>
    </span>
  )
}
