// The sidebar footer's person: a round initials avatar and a name. The name
// is whatever the running app exposes (ui/app.ts loadUserName); never a name
// written into the plugin.

/** Up to two initials: first and last word ("Alex Rivera" -> "AR"), one
 *  letter for a single word ("alex" -> "A"). Words split on spaces, dots,
 *  underscores and dashes; digits and symbols are skipped. '' for no letter. */
export function initialsOf(name) {
  const words = String(name || '')
    .split(/[\s._-]+/)
    .map(word => word.match(/\p{L}/u)?.[0] || '')
    .filter(Boolean)
  if (!words.length) return ''
  const picked = words.length > 1 ? [words[0], words[words.length - 1]] : [words[0]]
  return picked.join('').toLocaleUpperCase()
}

/** What the footer shows: { initials, name }, or the "You" fallback. */
export function footerPerson(name) {
  const clean = String(name || '').trim()
  const initials = initialsOf(clean)
  if (!clean || !initials) return { initials: 'You', name: '', known: false }
  return { initials, name: clean, known: true }
}
