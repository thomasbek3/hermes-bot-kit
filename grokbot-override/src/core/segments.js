// Wire identity of a turn's streamed reply (tui_gateway/stream_segments.py).
//
// Port of apps/desktop/src/app/session/hooks/use-message-stream/
// segment-identity.ts (Hermes Agent, MIT, (c) Nous Research). A prompt turn
// stamps message.start with `turn_id`, every message.delta with `turn_id` +
// `segment` + `offset`, and every message.interim with the `turn_id` +
// `segment` it seals. The same frame can arrive twice (reconnect replay, a
// superseded attempt re-streaming, a second socket); the cursor remembers how
// far each turn has been applied so a re-sent chunk is an upsert, not a copy.
// Frames without a stamp pass through unchanged.

const nonNegativeInt = value => (typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : null)

/** The stamp a message.delta / message.interim payload carries, or null. */
export function segmentStamp(payload) {
  const record = payload ?? {}
  const turnId = typeof record.turn_id === 'string' ? record.turn_id : ''
  const segment = nonNegativeInt(record.segment)
  if (!turnId || segment === null) return null
  const offset = nonNegativeInt(record.offset)
  return offset === null ? { turnId, segment } : { turnId, segment, offset }
}

/** The part of a stamped delta not applied yet ('' when it is a re-send). */
export function admitSegmentDelta(cursor, stamp, text) {
  const offset = stamp.offset ?? 0
  const end = offset + text.length
  if (!cursor || cursor.turnId !== stamp.turnId || stamp.segment > cursor.segment) {
    return { cursor: { turnId: stamp.turnId, segment: stamp.segment, end }, text }
  }
  if (stamp.segment < cursor.segment || end <= cursor.end) return { cursor, text: '' }
  return { cursor: { ...cursor, end }, text: text.slice(Math.max(0, cursor.end - offset)) }
}

/** Whether a stamped seal closes a segment not sealed yet, and the cursor after it. */
export function admitSegmentSeal(cursor, stamp) {
  const next = { turnId: stamp.turnId, segment: stamp.segment + 1, end: 0 }
  if (cursor?.turnId === stamp.turnId && stamp.segment < cursor.segment) return { cursor, fresh: false }
  return { cursor: next, fresh: true }
}
