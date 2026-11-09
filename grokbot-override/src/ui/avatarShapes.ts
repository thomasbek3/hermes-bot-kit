// Avatar silhouettes: twelve simple shapes drawn for this project, each a
// body with two vertical oval eye holes (even-odd). Avatar.tsx paints the
// outline white underneath and the body with its holes in the bot's colour on
// top, so the eyes read white on any background. Every shape sits in a
// 100 x 100 box; each outline is one closed contour that never crosses itself
// (a crossing would punch an extra hole under the even-odd rule).

export interface AvatarShape {
  name: string
  viewBox: string
  /** The body outline: painted white underneath, and, with `eyes` added as
   *  even-odd holes, in the bot's fill colour on top. */
  outline: string
  eyes: string
}

/** Two vertical ovals, centred `gap` either side of x = 50 at height `y`. */
function eyes(y: number, gap = 12, rx = 6, ry = 9.5): string {
  const oval = (cx: number) => `M${cx - rx} ${y}a${rx} ${ry} 0 1 0 ${rx * 2} 0a${rx} ${ry} 0 1 0 ${-rx * 2} 0Z`
  return oval(50 - gap) + oval(50 + gap)
}

const BOX = '0 0 100 100'

export const AVATAR_SHAPES: readonly AvatarShape[] = Object.freeze(
  [
    {
      name: 'blob',
      outline: 'M50 6C73 6 93 19 93 45C93 71 78 94 51 94C24 94 7 78 7 52C7 26 27 6 50 6Z',
      eyes: eyes(45)
    },
    {
      name: 'cloud',
      outline: 'M20 88A17 17 0 0 1 12 56A19 19 0 0 1 34 30A22 22 0 0 1 73 30A18 18 0 0 1 89 58A16 16 0 0 1 81 88Z',
      eyes: eyes(58)
    },
    {
      name: 'clover',
      outline:
        'M29.1 29.1A21 21 0 1 1 70.9 29.1A21 21 0 1 1 70.9 70.9A21 21 0 1 1 29.1 70.9A21 21 0 1 1 29.1 29.1Z',
      eyes: eyes(47, 11)
    },
    {
      name: 'flower',
      outline:
        'M33 20.6A17 17 0 1 1 67 20.6A17 17 0 1 1 84 50A17 17 0 1 1 67 79.4A17 17 0 1 1 33 79.4A17 17 0 1 1 16 50A17 17 0 1 1 33 20.6Z',
      eyes: eyes(47, 11, 5.5, 9)
    },
    {
      name: 'heart',
      outline: 'M50 90C30 76 6 60 6 36C6 20 18 9 31 9C40 9 46 14 50 21C54 14 60 9 69 9C82 9 94 20 94 36C94 60 70 76 50 90Z',
      eyes: eyes(40, 13)
    },
    {
      name: 'hexagon',
      outline:
        'M41 8.2Q50 3 59 8.2L81.7 21.3Q90.7 26.5 90.7 36.8L90.7 63.2Q90.7 73.5 81.7 78.7L59 91.8Q50 97 41 91.8L18.3 78.7Q9.3 73.5 9.3 63.2L9.3 36.8Q9.3 26.5 18.3 21.3Z',
      eyes: eyes(46)
    },
    {
      name: 'house',
      outline:
        'M42.8 12.6Q50 6 57.2 12.6L83.8 36.8Q95 47 92.5 47L87.5 47Q85 47 85 58.5L85 83.8Q85 93 71 93L29 93Q15 93 15 83.8L15 58.5Q15 47 12.5 47L7.5 47Q5 47 16.3 36.8Z',
      eyes: eyes(60)
    },
    {
      name: 'sparkle',
      outline: 'M50 2Q62 38 98 50Q62 62 50 98Q38 62 2 50Q38 38 50 2Z',
      eyes: eyes(49, 8, 4.5, 7.5)
    },
    {
      name: 'square',
      outline: 'M30 8H70A22 22 0 0 1 92 30V70A22 22 0 0 1 70 92H30A22 22 0 0 1 8 70V30A22 22 0 0 1 30 8Z',
      eyes: eyes(46)
    },
    {
      name: 'star',
      outline:
        'M46.8 9.6Q50 4 53.2 9.6L64 28.8Q65.9 32.2 69.7 32.9L91.2 37.3Q97.6 38.5 93.2 43.3L78.3 59.5Q75.7 62.3 76.1 66.2L78.6 88Q79.4 94.5 73.5 91.8L53.5 82.6Q50 81 46.5 82.6L26.5 91.8Q20.6 94.5 21.4 88L23.9 66.2Q24.3 62.3 21.7 59.5L6.8 43.3Q2.4 38.5 8.8 37.3L30.3 32.9Q34.1 32.2 36 28.8Z',
      eyes: eyes(51, 9, 5, 7.5)
    },
    {
      name: 'teardrop',
      outline: 'M50 4C60 18 86 40 86 61A36 36 0 0 1 14 61C14 40 40 18 50 4Z',
      eyes: eyes(58)
    },
    {
      name: 'pebble',
      outline: 'M48 16C74 14 95 28 95 52C95 76 74 86 50 86C24 86 5 76 5 54C5 30 24 18 48 16Z',
      eyes: eyes(47)
    }
  ].map(shape => Object.freeze({ ...shape, viewBox: BOX }))
)

/** FNV-1a, 32-bit: a stable number for a route key. */
export function hashKey(key: string): number {
  let hash = 0x811c9dc5
  for (const ch of String(key ?? '')) {
    hash ^= ch.codePointAt(0) || 0
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash >>> 0
}

/** The shape a bot wears, chosen from its exact route key. */
export function avatarShapeFor(key: string): AvatarShape {
  return AVATAR_SHAPES[hashKey(key) % AVATAR_SHAPES.length]
}
