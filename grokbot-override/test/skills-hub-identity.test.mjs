import assert from 'node:assert/strict'
import test from 'node:test'
import { skillAmbiguous, skillIdentity, skillSource } from '../src/core/profileConfig.js'

test('skills hub: install is bound to the shown entry, ambiguous names are not installable', () => {
  const rows = [{ name: 'notes' }, { name: 'notes', description: 'other' }, { name: 'web' }, { name: 'pdf', identifier: 'official/pdf' }, { name: 'pdf', identifier: 'community/pdf' }]
  assert.equal(skillAmbiguous(rows, rows[0]), true, 'two hub entries named notes with no identifier')
  assert.equal(skillAmbiguous(rows, rows[1]), true)
  assert.equal(skillAmbiguous(rows, rows[2]), false, 'a unique name is fine')
  assert.equal(skillAmbiguous(rows, rows[3]), false, 'a source-qualified identifier is exact')
  assert.equal(skillIdentity(rows[3]), 'official/pdf')
  assert.equal(skillIdentity(rows[2]), 'web')
  assert.equal(skillSource({ source: 'official', trust: 'trusted' }), 'official, trusted')
  assert.equal(skillAmbiguous([], {}), false)
})
