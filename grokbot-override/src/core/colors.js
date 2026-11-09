// Copyright 2026 Rakazo contributors
//
// Licensed under the Apache License, Version 2.0 (the "License"); you may not
// use this file except in compliance with the License. A copy is in
// LICENSE-APACHE-2.0 next to this plugin, or at
// http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS, WITHOUT
// WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
//
// Source: https://github.com/elie222/rakazo @ c800ad5,
// packages/core/src/bot-avatar-colors.ts (chatUserBubbleColors, hexToOklch,
// oklchToHex, contrastRatio, expandHex).
// Modified 2026-11-08 by Thomas Bekkers: takes a hex colour directly instead of
// Rakazo's avatar string and colour list; near-white colours return undefined.

const BUBBLE_TEXT_CONTRAST = 4.5
const LIGHT_TEXT = '#FFFFFF'

export function expandHex(hex) {
  const c = String(hex || '').replace('#', '')
  if (c.length === 3) return `${c[0]}${c[0]}${c[1]}${c[1]}${c[2]}${c[2]}`
  return c
}

export function isHexColor(value) {
  return /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i.test(String(value || '').trim())
}

function relativeLuminance(hex) {
  const c = expandHex(hex)
  const [r, g, b] = [0, 2, 4].map(offset => {
    const channel = (Number.parseInt(c.substring(offset, offset + 2), 16) || 0) / 255
    return channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4
  })
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

/** WCAG contrast ratio between two hex colours. */
export function contrastRatio(a, b) {
  const [high, low] = [relativeLuminance(a), relativeLuminance(b)].sort((x, y) => y - x)
  return (high + 0.05) / (low + 0.05)
}

export function hexToOklch(hex) {
  const c = expandHex(hex)
  const [r, g, b] = [0, 2, 4].map(offset => {
    const channel = (Number.parseInt(c.substring(offset, offset + 2), 16) || 0) / 255
    return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4
  })
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b)
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b)
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b)
  const lightness = 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s
  const a = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s
  const bb = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s
  return [lightness, Math.hypot(a, bb), Math.atan2(bb, a)]
}

export function oklchToHex(lightness, chroma, hue) {
  const a = chroma * Math.cos(hue)
  const b = chroma * Math.sin(hue)
  const l = (lightness + 0.3963377774 * a + 0.2158037573 * b) ** 3
  const m = (lightness - 0.1055613458 * a - 0.0638541728 * b) ** 3
  const s = (lightness - 0.0894841775 * a - 1.291485548 * b) ** 3
  const linear = [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s
  ]
  return `#${linear
    .map(value => {
      const v = Math.min(1, Math.max(0, value))
      const srgb = v <= 0.0031308 ? v * 12.92 : 1.055 * v ** (1 / 2.4) - 0.055
      return Math.round(srgb * 255)
        .toString(16)
        .padStart(2, '0')
    })
    .join('')}`.toUpperCase()
}

/** Your messages in a bot's chat wear the bot's colour under white text,
 *  deepened in OKLCH until the text reaches AA contrast. Near-white colours
 *  (and anything that is not a hex colour) keep the neutral bubble. */
export function chatUserBubbleColors(hex) {
  if (!isHexColor(hex)) return undefined
  let background = `#${expandHex(hex.trim())}`.toUpperCase()
  if (contrastRatio(background, '#FFFFFF') < 1.25) return undefined
  const [lightness, chroma, hue] = hexToOklch(background)
  for (let l = lightness; contrastRatio(background, LIGHT_TEXT) < BUBBLE_TEXT_CONTRAST && l > 0; ) {
    l -= 0.01
    background = oklchToHex(l, chroma, hue)
  }
  return { background, foreground: LIGHT_TEXT }
}

// ── bot colour swatches ──────────────────────────────────────────────────
// The eleven bot colours of the chat look, each as fill (avatar), bubble
// (your messages, under white text), action (send button, switches) and
// hover. A bot's own colour (any CSS hex, rgb() or hsl() string) is mapped to
// the nearest swatch in OKLab. Black has no colours of its own: its bubble and
// action follow the theme's ink and primary tokens (null here).

export const BOT_SWATCHES = Object.freeze([
  { name: 'black', fill: '#000000', bubble: null, action: null, hover: null },
  { name: 'brown', fill: '#A06B39', bubble: '#86592E', action: '#9D6937', hover: '#86592E' },
  { name: 'red', fill: '#FB2B3E', bubble: '#C82532', action: '#E72E3B', hover: '#C82532' },
  { name: 'orange', fill: '#FD690F', bubble: '#D2550A', action: '#EE620D', hover: '#D2550A' },
  { name: 'yellow', fill: '#F59312', bubble: '#C2730B', action: '#DA830E', hover: '#C2730B' },
  { name: 'green', fill: '#14C16F', bubble: '#0D9655', action: '#10AB61', hover: '#0D9655' },
  { name: 'cyan', fill: '#13B7A2', bubble: '#0D9381', action: '#10A693', hover: '#0D9381' },
  { name: 'blue', fill: '#1E86FC', bubble: '#126FD4', action: '#1680F3', hover: '#126FD4' },
  { name: 'violet', fill: '#8F59F9', bubble: '#7442D1', action: '#8351E4', hover: '#7442D1' },
  { name: 'magenta', fill: '#F93498', bubble: '#C82779', action: '#E52F8B', hover: '#C82779' },
  { name: 'gray', fill: '#959595', bubble: '#6E6E6E', action: '#7A7A7A', hover: '#6E6E6E' }
].map(swatch => Object.freeze(swatch)))

function hslToRgb(h, s, l) {
  const hue = ((h % 360) + 360) % 360
  const a = s * Math.min(l, 1 - l)
  const f = n => {
    const k = (n + hue / 30) % 12
    return l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1))
  }
  return [f(0), f(8), f(4)].map(v => Math.round(v * 255))
}

/** A CSS colour string as [r, g, b] (0-255): #rgb, #rrggbb, #rrggbbaa,
 *  rgb()/rgba() and hsl()/hsla() in comma or space syntax. Null otherwise. */
export function parseColor(value) {
  const text = String(value ?? '').trim().toLowerCase()
  const hex = text.match(/^#([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/)
  if (hex) {
    const c = expandHex(hex[1]).slice(0, 6)
    return [0, 2, 4].map(offset => Number.parseInt(c.substring(offset, offset + 2), 16))
  }
  const fn = text.match(/^(rgba?|hsla?)\(([^)]*)\)$/)
  if (!fn) return null
  const parts = fn[2].split(/[\s,/]+/).filter(Boolean)
  if (parts.length < 3) return null
  const num = part => Number.parseFloat(part)
  if (fn[1].startsWith('rgb')) {
    const rgb = parts.slice(0, 3).map(part => (part.endsWith('%') ? (num(part) / 100) * 255 : num(part)))
    return rgb.every(Number.isFinite) ? rgb.map(v => Math.round(Math.min(255, Math.max(0, v)))) : null
  }
  const [h, s, l] = [num(parts[0]), num(parts[1]) / 100, num(parts[2]) / 100]
  if (![h, s, l].every(Number.isFinite)) return null
  return hslToRgb(h, Math.min(1, Math.max(0, s)), Math.min(1, Math.max(0, l)))
}

function toHex(rgb) {
  return `#${rgb.map(v => v.toString(16).padStart(2, '0')).join('')}`.toUpperCase()
}

function oklab(hex) {
  const [l, c, h] = hexToOklch(hex)
  return [l, c * Math.cos(h), c * Math.sin(h)]
}

const SWATCH_LAB = BOT_SWATCHES.map(swatch => oklab(swatch.fill))

/** The swatch nearest a bot's colour (OKLab distance). Anything that is not
 *  a colour gets the violet swatch (the default bot's colour). */
export function botSwatch(color) {
  const rgb = parseColor(color)
  if (!rgb) return BOT_SWATCHES.find(swatch => swatch.name === 'violet')
  const [l, a, b] = oklab(toHex(rgb))
  let best = 0
  let bestDistance = Infinity
  SWATCH_LAB.forEach(([sl, sa, sb], index) => {
    const distance = (l - sl) ** 2 + (a - sa) ** 2 + (b - sb) ** 2
    if (distance < bestDistance) {
      bestDistance = distance
      best = index
    }
  })
  return BOT_SWATCHES[best]
}

/** CSS custom properties a bot's chat wears: your bubbles in its bubble
 *  colour under white text, the send button and switches in its action
 *  colour. Black sets none, so the theme's ink and primary apply. */
export function botTintVars(color) {
  const swatch = botSwatch(color)
  if (!swatch.bubble) return undefined
  return {
    '--gbo-tint-bg': swatch.bubble,
    '--gbo-tint-fg': '#FFFFFF',
    '--gbo-action': swatch.action,
    '--gbo-action-hover': swatch.hover
  }
}
