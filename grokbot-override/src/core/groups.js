// Message groups, the reference layout's transcript rhythm: consecutive
// messages from one side (yours on the right, the bot's on the left) sit in
// one group 4px apart, a new sender or a gap of five minutes starts a new
// group 12px below, and any other row (divider, tools, card, notice) ends
// the group. Bubbles in a group of two or more get "tail" corners: first,
// middle and last (cornerClass).

export const GROUP_GAP_MS = 5 * 60 * 1000

/** 'right' for your messages, 'left' for the bot's, '' for any other row. */
export function messageSide(item) {
  if (item?.kind === 'user') return 'right'
  if (item?.kind === 'assistant') return 'left'
  return ''
}

/** Items with runs of same-side messages folded into
 *  `{ kind: 'group', id, side, items }`; every other item passes through. */
export function groupMessages(items) {
  const out = []
  for (const item of items || []) {
    const side = messageSide(item)
    if (!side) {
      out.push(item)
      continue
    }
    const last = out[out.length - 1]
    const prev = last?.kind === 'group' ? last.items[last.items.length - 1] : null
    const prevAt = Number(prev?.at || 0)
    const at = Number(item?.at || 0)
    const close = !prevAt || !at || Math.abs(at - prevAt) < GROUP_GAP_MS
    if (prev && last.side === side && close) last.items.push(item)
    else out.push({ kind: 'group', id: `group:${item.id}`, side, items: [item] })
  }
  return out
}

/** The tail-corner class of bubble `index` of `count` in one group. */
export function cornerClass(index, count) {
  if (count < 2) return ''
  if (index === 0) return ' is-first'
  if (index === count - 1) return ' is-last'
  return ' is-mid'
}
