import test from 'node:test'
import assert from 'node:assert/strict'
import { openDb } from '../src/db.js'
import { stripServerLabel, healBakedTitles } from '../src/heal-titles.js'

test('stripServerLabel removes baked bridge label prefixes and nothing else', () => {
  // fallback / Gemini form: label + ':' + 2-char session fragment + space
  assert.equal(stripServerLabel('DEV-:a3 Fix the thing'), 'Fix the thing')
  assert.equal(stripServerLabel('2:f0 fix the folder picker'), 'fix the folder picker')
  assert.equal(stripServerLabel('mac:A1 Ship the release'), 'Ship the release')
  // workdir-seed form: label + ': ' + a single space-free basename
  assert.equal(stripServerLabel('DEV-: matron-apple'), 'matron-apple')
  assert.equal(stripServerLabel('3: yearbook_app'), 'yearbook_app')

  // organic titles are untouched
  assert.equal(stripServerLabel('Fix: parser bug'), 'Fix: parser bug')
  assert.equal(stripServerLabel('TODO: ship the thing'), 'TODO: ship the thing')
  assert.equal(stripServerLabel('Fix the thing'), 'Fix the thing')
  assert.equal(stripServerLabel(''), '')
  // a 3-char fragment is not the fallback shape, and the remainder has
  // spaces so it is not the seed shape either
  assert.equal(stripServerLabel('dev:abc something'), 'dev:abc something')
  // a >12-char "label" is prose, not a bridge label
  assert.equal(stripServerLabel('averylonglabelx:a3 nope'), 'averylonglabelx:a3 nope')
  // idempotent: healed output re-heals to itself
  for (const t of ['DEV-:a3 Fix the thing', 'DEV-: matron-apple', 'Fix: parser bug']) {
    assert.equal(stripServerLabel(stripServerLabel(t)), stripServerLabel(t))
  }
})

test('healBakedTitles rewrites stored titles once and is gated on user_version', () => {
  const db = openDb(':memory:')
  const now = Date.now()
  db.prepare('INSERT INTO users(id, name, password_hash, created_at) VALUES(1, ?, ?, ?)').run('dan', 'x', now)
  const insert = db.prepare('INSERT INTO conversations(id, owner_user_id, title, created_at) VALUES(?,1,?,?)')
  insert.run('c1', 'DEV-:a3 Fix the thing', now)
  insert.run('c2', 'DEV-: matron-apple', now)
  insert.run('c3', 'Fix: parser bug', now)

  // openDb already ran it — user_version is claimed and titles are healed
  assert.equal(db.pragma('user_version', { simple: true }) >= 1, true)
  const titles = () => Object.fromEntries(
    db.prepare('SELECT id, title FROM conversations').all().map((r) => [r.id, r.title]))
  // rows inserted AFTER open are untouched by that first run
  assert.deepEqual(titles(), {
    c1: 'DEV-:a3 Fix the thing', c2: 'DEV-: matron-apple', c3: 'Fix: parser bug',
  })

  // a direct call still heals (this is what a real upgrade does, at open,
  // with rows already present)
  const logged = []
  const r = healBakedTitles(db, { log: (m) => logged.push(m), force: true })
  assert.deepEqual(titles(), { c1: 'Fix the thing', c2: 'matron-apple', c3: 'Fix: parser bug' })
  assert.equal(r.healed, 2)
  assert.equal(logged.length, 2)
  assert.match(logged[0], /c1/)

  // gated: a second ungated call is a no-op because user_version is set
  const again = healBakedTitles(db, { log: () => {} })
  assert.equal(again.healed, 0)
})
