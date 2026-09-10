import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Database from 'better-sqlite3'
import { openDb } from '../src/db.js'
import { nextNum, newId } from '../src/items.js'
import { MISSION_EVENT_TYPE, MILESTONE_EVENT_TYPE, MISSION_ACTIONS, milestoneMarkerPayload, missionMarkerPayload } from '../src/missions-marker.js'
import { snippetOf } from '../src/journal.js'
import { classify } from '../src/push.js'

test('schema: missions and milestones exist with the expected columns; mission_id on conversations and items', () => {
  const db = openDb(':memory:')
  const cols = (t) => db.prepare(`PRAGMA table_info(${t})`).all().map((c) => c.name)
  assert.deepEqual(cols('missions'), [
    'id', 'user_id', 'num', 'state', 'title', 'body', 'close_summary', 'closed_by', 'closed_over_open_items',
    'origin_convo_id', 'origin_device_id', 'created_by', 'idem_key', 'created_at', 'updated_at', 'last_milestone_at', 'closed_at',
  ])
  assert.deepEqual(cols('milestones'), [
    'id', 'mission_id', 'user_id', 'num', 'kind', 'title', 'body', 'convo_id', 'seq', 'device_id', 'created_by', 'idem_key', 'created_at',
  ])
  assert.ok(cols('conversations').includes('mission_id'))
  assert.ok(cols('items').includes('mission_id'))
  db.prepare("INSERT INTO users(id, name, password_hash, created_at) VALUES(1,'dan','x',0)").run()
  const ins = db.prepare(`INSERT INTO missions(id,user_id,num,state,title,origin_convo_id,origin_device_id,created_by,created_at,updated_at)
    VALUES(?,1,1,'open','t','c1',1,'agent',0,0)`)
  ins.run('ms_a')
  assert.throws(() => ins.run('ms_b'), /UNIQUE/)
  assert.throws(() => db.prepare(`INSERT INTO milestones(id,mission_id,user_id,num,kind,title,convo_id,seq,device_id,created_by,created_at)
    VALUES('ml_a','ms_a',1,2,'nope','t','c1',1,1,'agent',0)`).run(), /CHECK/)
})

test('schema: opening an existing pre-missions database adds the guarded columns once', () => {
  const dbPath = path.join(os.tmpdir(), `missions-migration-${process.pid}-${Date.now()}.sqlite`)
  try {
    // Create the database with the current (post-missions) schema, then
    // simulate the pre-missions shape by dropping the guarded columns and
    // their indexes on a raw handle — openDb() must not be relied on to
    // have created them for this to be a real "existing database" test.
    const db1 = openDb(dbPath)
    db1.close()

    const raw = new Database(dbPath)
    raw.exec('DROP INDEX IF EXISTS idx_items_mission')
    raw.exec('DROP INDEX IF EXISTS idx_conversations_mission')
    raw.exec('ALTER TABLE items DROP COLUMN mission_id')
    raw.exec('ALTER TABLE conversations DROP COLUMN mission_id')
    const colsBefore = (t) => raw.prepare(`PRAGMA table_info(${t})`).all().map((c) => c.name)
    assert.ok(!colsBefore('items').includes('mission_id'))
    assert.ok(!colsBefore('conversations').includes('mission_id'))
    raw.close()

    // Reopening runs the guarded ALTER path and must add both columns back.
    const db2 = openDb(dbPath)
    const cols = (t) => db2.prepare(`PRAGMA table_info(${t})`).all().map((c) => c.name)
    assert.ok(cols('items').includes('mission_id'))
    assert.ok(cols('conversations').includes('mission_id'))
    const itemsAfterFirstReopen = cols('items')
    const conversationsAfterFirstReopen = cols('conversations')
    db2.close()

    // Opening a third time must be a no-op: nothing throws, and the column
    // lists are unchanged (the guard doesn't re-add or duplicate anything).
    const db3 = openDb(dbPath)
    const colsThird = (t) => db3.prepare(`PRAGMA table_info(${t})`).all().map((c) => c.name)
    assert.deepEqual(colsThird('items'), itemsAfterFirstReopen)
    assert.deepEqual(colsThird('conversations'), conversationsAfterFirstReopen)
    db3.close()
  } finally {
    fs.rmSync(dbPath, { force: true })
    fs.rmSync(`${dbPath}-wal`, { force: true })
    fs.rmSync(`${dbPath}-shm`, { force: true })
  }
})

test('numbers: items, missions and milestones share one per-user counter', () => {
  const db = openDb(':memory:')
  db.prepare("INSERT INTO users(id, name, password_hash, created_at) VALUES(1,'dan','x',0)").run()
  assert.equal(nextNum(db, 1), 1)
  assert.equal(nextNum(db, 1), 2)
  assert.equal(nextNum(db, 1), 3)
  assert.match(newId('ms'), /^ms_[0-9a-f]{16}$/)
  assert.match(newId('ml'), /^ml_[0-9a-f]{16}$/)
})

test('marker payloads carry exactly the documented fields', () => {
  const mission = { id: 'ms_1', num: 61, title: 'Missions & milestones' }
  const milestone = { id: 'ml_1', num: 63, kind: 'user_input', title: 'Wired the migration', body: 'b' }
  assert.deepEqual(milestoneMarkerPayload({ milestone, mission, by: 'agent' }), {
    milestone_id: 'ml_1', num: 63, kind: 'user_input', title: 'Wired the migration', body: 'b',
    mission_id: 'ms_1', mission_num: 61, mission_title: 'Missions & milestones', by: 'agent',
  })
  assert.deepEqual(missionMarkerPayload({ mission, action: 'created', by: 'agent' }),
    { mission_id: 'ms_1', num: 61, title: 'Missions & milestones', action: 'created', by: 'agent' })
  assert.deepEqual(missionMarkerPayload({ mission, action: 'closed', by: 'user', openItemNums: [64, 70] }),
    { mission_id: 'ms_1', num: 61, title: 'Missions & milestones', action: 'closed', by: 'user', open_item_nums: [64, 70] })
  assert.equal(MISSION_EVENT_TYPE, 'mission'); assert.equal(MILESTONE_EVENT_TYPE, 'milestone')
  assert.deepEqual(MISSION_ACTIONS, ['created', 'joined', 'updated', 'closed'])
})

test('snippetOf renders both markers; classify never pushes them', () => {
  assert.equal(snippetOf('milestone', { num: 63, kind: 'user_input', title: 'T' }), '🚩 #63 T')
  assert.equal(snippetOf('milestone', { num: 64, kind: 'progress', title: 'P' }), '🏁 #64 P')
  assert.equal(snippetOf('mission', { num: 61, title: 'M', action: 'closed' }), '🏁 Mission #61 closed')
  assert.equal(snippetOf('mission', { num: 61, title: 'M', action: 'created' }), '🏁 Mission #61 started: M')
  assert.equal(classify('milestone', { num: 63 }, 'agent:dev-2'), null)
  assert.equal(classify('mission', { num: 61, action: 'closed' }, 'user:dan'), null)
})
