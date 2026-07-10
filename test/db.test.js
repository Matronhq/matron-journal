import test from 'node:test'
import assert from 'node:assert/strict'
import { openDb } from '../src/db.js'

test('openDb creates schema idempotently', () => {
  const db = openDb(':memory:')
  const tables = db.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"
  ).all().map(r => r.name)
  for (const t of ['users', 'devices', 'conversations', 'events', 'user_seq']) {
    assert.ok(tables.includes(t), `missing table ${t}`)
  }
  assert.equal(db.pragma('foreign_keys', { simple: true }), 1)
})

test('events PK is (user_id, seq)', () => {
  const db = openDb(':memory:')
  db.prepare("INSERT INTO users(name, password_hash, created_at) VALUES('a','x',0)").run()
  db.prepare("INSERT INTO conversations(id, owner_user_id, created_at) VALUES('c1',1,0)").run()
  const ins = db.prepare(
    "INSERT INTO events(user_id, seq, convo_id, ts, sender, type, payload) VALUES(1,1,'c1',0,'s','text','{}')"
  )
  ins.run()
  assert.throws(() => ins.run(), /UNIQUE|PRIMARY/)
})
