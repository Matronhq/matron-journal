import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Database from 'better-sqlite3'
import { openDb } from '../src/db.js'
import { nextNum, newId } from '../src/items.js'
import { MISSION_EVENT_TYPE, MILESTONE_EVENT_TYPE, MISSION_ACTIONS, milestoneMarkerPayload, missionMarkerPayload } from '../src/missions-marker.js'
import { append, broadcastAppended, snippetOf, upsertConversation } from '../src/journal.js'
import { classify } from '../src/push.js'
import {
  createMission, getMission, listMissions, missionDetail, updateMission, joinMission, closeMission, repointItems, validateMissionFields,
  createMilestone, listMilestones,
} from '../src/missions.js'
import { createItem } from '../src/items.js'

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

test('broadcastAppended fans the already-committed event with journal targeting', () => {
  const db = openDb(':memory:')
  db.prepare("INSERT INTO users(id, name, password_hash, created_at) VALUES(1,'dan','x',0)").run()
  upsertConversation(db, { id: 'c1', ownerUserId: 1, title: 'C1' })
  const frames = []
  const hub = { broadcastJournal: (userId, frame, targets) => frames.push({ userId, frame, targets }) }
  const r = append(db, { userId: 1, convoId: 'c1', sender: 'agent:dev-2', type: 'milestone', payload: { num: 1 } })
  broadcastAppended(db, hub, { userId: 1, convoId: 'c1', seq: r.seq, ts: r.ts, sender: 'agent:dev-2', type: 'milestone', payload: { num: 1 } })
  assert.equal(frames.length, 1)
  assert.equal(frames[0].frame.kind, 'journal'); assert.equal(frames[0].frame.seq, r.seq); assert.equal(frames[0].frame.type, 'milestone')
  assert.equal(frames[0].targets, null)  // no agent owner recorded → every agent
})

function seeded() {
  const db = openDb(':memory:')
  db.prepare("INSERT INTO users(id, name, password_hash, created_at) VALUES(1,'dan','x',0)").run()
  db.prepare("INSERT INTO devices(id, user_id, kind, name, token_hash, created_at) VALUES(7,1,'agent','dev-2','h',0)").run()
  upsertConversation(db, { id: 'c1', ownerUserId: 1, title: 'C1', agentDeviceId: 7 })
  upsertConversation(db, { id: 'c2', ownerUserId: 1, title: 'C2', agentDeviceId: 7 })
  return db
}

test('createMission: numbers from the shared pool, attaches the convo, repoints its items, replays are idempotent', () => {
  const db = seeded()
  const { item } = createItem(db, { userId: 1, originDeviceId: 7, createdBy: 'agent', kind: 'task', title: 'T', originConvoId: 'c1' })
  assert.equal(item.num, 1); assert.equal(item.mission_id, null)
  const r = createMission(db, { userId: 1, deviceId: 7, createdBy: 'agent', convoId: 'c1', title: 'M', body: 'goal', idemKey: '7:k1' })
  assert.equal(r.duplicate, false); assert.equal(r.existing, false)
  assert.equal(r.mission.num, 2); assert.equal(r.mission.state, 'open'); assert.equal(r.mission.origin_convo_id, 'c1')
  assert.equal(db.prepare('SELECT mission_id FROM conversations WHERE id=?').get('c1').mission_id, r.mission.id)
  assert.equal(db.prepare('SELECT mission_id FROM items WHERE id=?').get(item.id).mission_id, r.mission.id)
  // replay
  const again = createMission(db, { userId: 1, deviceId: 7, createdBy: 'agent', convoId: 'c1', title: 'M', idemKey: '7:k1' })
  assert.equal(again.duplicate, true); assert.equal(again.mission.id, r.mission.id)
  // a second mission for the same convo: existing, nothing changed
  const second = createMission(db, { userId: 1, deviceId: 7, createdBy: 'agent', convoId: 'c1', title: 'Other', idemKey: '7:k2' })
  assert.equal(second.existing, true); assert.equal(second.mission.id, r.mission.id)
  assert.equal(second.mission.title, 'M')
  assert.equal(getMission(db, 1, '#2').id, r.mission.id); assert.equal(getMission(db, 1, r.mission.id).num, 2)
  assert.equal(getMission(db, 1, 'ms_nope'), null); assert.equal(getMission(db, 2, 2), null)
})

test('validateMissionFields: title ≤200, body ≤32 KiB, partial allows either', () => {
  assert.equal(validateMissionFields({ title: 'x'.repeat(201) }).ok, false)
  assert.equal(validateMissionFields({ title: '' }).ok, false)
  assert.equal(validateMissionFields({ title: 'ok', body: 'y'.repeat(32769) }).ok, false)
  assert.deepEqual(validateMissionFields({ title: ' ok ', body: 'b' }).value, { title: 'ok', body: 'b' })
  assert.equal(validateMissionFields({}, { partial: true }).ok, true)
  assert.equal(validateMissionFields({}).ok, false)
})

test('join: attaches a second conversation and repoints its items; refuses a convo with another mission or a closed mission', () => {
  const db = seeded()
  const a = createMission(db, { userId: 1, deviceId: 7, createdBy: 'agent', convoId: 'c1', title: 'A' }).mission
  const { item } = createItem(db, { userId: 1, originDeviceId: 7, createdBy: 'agent', kind: 'task', title: 'T', originConvoId: 'c2' })
  joinMission(db, { userId: 1, missionId: a.id, convoId: 'c2' })
  assert.equal(db.prepare('SELECT mission_id FROM conversations WHERE id=?').get('c2').mission_id, a.id)
  assert.equal(db.prepare('SELECT mission_id FROM items WHERE id=?').get(item.id).mission_id, a.id)
  upsertConversation(db, { id: 'c3', ownerUserId: 1, title: 'C3', agentDeviceId: 7 })
  const b = createMission(db, { userId: 1, deviceId: 7, createdBy: 'agent', convoId: 'c3', title: 'B' }).mission
  assert.throws(() => joinMission(db, { userId: 1, missionId: b.id, convoId: 'c2' }), /other_mission/)
  closeMission(db, { userId: 1, missionId: b.id, by: 'agent', summary: 'done' })
  upsertConversation(db, { id: 'c4', ownerUserId: 1, title: 'C4', agentDeviceId: 7 })
  assert.throws(() => joinMission(db, { userId: 1, missionId: b.id, convoId: 'c4' }), /closed/)
})

test('close: agent blocked by user items, then by agent items; user close records the count; closed rejects update', () => {
  const db = seeded()
  const m = createMission(db, { userId: 1, deviceId: 7, createdBy: 'agent', convoId: 'c1', title: 'A' }).mission
  const q = createItem(db, { userId: 1, originDeviceId: 7, createdBy: 'agent', kind: 'question', title: 'Q?', originConvoId: 'c1' }).item
  const t = createItem(db, { userId: 1, originDeviceId: 7, createdBy: 'agent', kind: 'task', title: 'T', originConvoId: 'c1' }).item
  assert.equal(q.awaiting, 'user'); assert.equal(t.awaiting, 'agent')
  let err
  try { closeMission(db, { userId: 1, missionId: m.id, by: 'agent', summary: 's' }) } catch (e) { err = e }
  assert.equal(err.message, 'user_items'); assert.deepEqual(err.items, [{ num: q.num, title: 'Q?' }])
  db.prepare("UPDATE items SET state='closed', awaiting=NULL, resolution='answered' WHERE id=?").run(q.id)
  try { closeMission(db, { userId: 1, missionId: m.id, by: 'agent', summary: 's' }) } catch (e) { err = e }
  assert.equal(err.message, 'agent_items'); assert.deepEqual(err.items, [{ num: t.num, title: 'T' }])
  const r = closeMission(db, { userId: 1, missionId: m.id, by: 'user', summary: 'forced' })
  assert.equal(r.mission.state, 'closed'); assert.equal(r.mission.closed_by, 'user')
  assert.equal(r.mission.closed_over_open_items, 1); assert.deepEqual(r.openItemNums, [t.num])
  assert.equal(r.mission.close_summary, 'forced')
  assert.equal(db.prepare('SELECT state, mission_id FROM items WHERE id=?').get(t.id).state, 'open')
  assert.throws(() => updateMission(db, { userId: 1, missionId: m.id, fields: { title: 'x' } }), /closed/)
  assert.throws(() => closeMission(db, { userId: 1, missionId: m.id, by: 'user', summary: 'x' }), /closed/)
})

test('closeMission: excludePrivateOwned filters the blocked-by items list, but a hidden open item still blocks the close', () => {
  const db = seeded()
  db.prepare("INSERT INTO devices(id, user_id, kind, name, token_hash, created_at, private) VALUES(9,1,'agent','priv-box','h2',0,1)").run()
  upsertConversation(db, { id: 'c3', ownerUserId: 1, title: 'C3', agentDeviceId: 9 })
  const m = createMission(db, { userId: 1, deviceId: 7, createdBy: 'agent', convoId: 'c1', title: 'A' }).mission
  joinMission(db, { userId: 1, missionId: m.id, convoId: 'c3' })
  const hidden = createItem(db, { userId: 1, originDeviceId: 9, createdBy: 'agent', kind: 'task', title: 'Hidden', originConvoId: 'c3' }).item
  assert.equal(hidden.mission_id, m.id); assert.equal(hidden.awaiting, 'agent')
  // Sieved: the close is still blocked (a hidden open item exists), but the
  // item named in the error is filtered away — an ordinary agent's 409 must
  // never name a private item or its title.
  let sieved
  try { closeMission(db, { userId: 1, missionId: m.id, by: 'agent', summary: 's', excludePrivateOwned: true }) } catch (e) { sieved = e }
  assert.equal(sieved.message, 'agent_items'); assert.deepEqual(sieved.items, [])
  // Unsieved (a private agent, or an internal caller that never filters):
  // the same item is named.
  let full
  try { closeMission(db, { userId: 1, missionId: m.id, by: 'agent', summary: 's', excludePrivateOwned: false }) } catch (e) { full = e }
  assert.deepEqual(full.items, [{ num: hidden.num, title: 'Hidden' }])
})

test('getMission/listMissions/missionDetail: excludePrivateOwned sieves the COUNTS subqueries and last_milestone, not just missionDetail\'s own arrays', () => {
  const db = seeded()
  db.prepare("INSERT INTO devices(id, user_id, kind, name, token_hash, created_at, private) VALUES(9,1,'agent','priv-box','h2',0,1)").run()
  upsertConversation(db, { id: 'c3', ownerUserId: 1, title: 'C3', agentDeviceId: 9 })
  const m = createMission(db, { userId: 1, deviceId: 7, createdBy: 'agent', convoId: 'c1', title: 'Pub' }).mission
  joinMission(db, { userId: 1, missionId: m.id, convoId: 'c3' })
  createItem(db, { userId: 1, originDeviceId: 9, createdBy: 'agent', kind: 'task', title: 'Hidden item', originConvoId: 'c3' })
  const appendMarker = (payload) => append(db, { userId: 1, convoId: 'c3', sender: 'agent:priv-box', type: 'milestone', payload })
  createMilestone(db, { userId: 1, deviceId: 9, createdBy: 'agent', convoId: 'c3', kind: 'progress', title: 'hidden step', appendMarker })

  const sieved = getMission(db, 1, m.id, { excludePrivateOwned: true })
  assert.equal(sieved.conversations, 1); assert.equal(sieved.milestones, 0); assert.equal(sieved.open_items, 0)
  assert.equal(sieved.last_milestone, null)
  const full = getMission(db, 1, m.id, { excludePrivateOwned: false })
  assert.equal(full.conversations, 2); assert.equal(full.milestones, 1); assert.equal(full.open_items, 1)
  assert.equal(full.last_milestone.title, 'hidden step')

  const listSieved = listMissions(db, 1, { excludePrivateOwned: true }).find((x) => x.id === m.id)
  assert.equal(listSieved.milestones, 0); assert.equal(listSieved.conversations, 1); assert.equal(listSieved.last_milestone, null)
  const listFull = listMissions(db, 1, { excludePrivateOwned: false }).find((x) => x.id === m.id)
  assert.equal(listFull.milestones, 1); assert.equal(listFull.conversations, 2)

  const detailSieved = missionDetail(db, 1, m.id, { excludePrivateOwned: true })
  assert.equal(detailSieved.mission.milestones, 0); assert.equal(detailSieved.milestones.length, 0)
  assert.equal(detailSieved.mission.conversations, detailSieved.conversations.length)
  assert.equal(detailSieved.mission.open_items, detailSieved.items.length)
})

test('listMissions: counts, sort by last milestone then creation, state filter, since; detail lists open items awaiting-user first', () => {
  const db = seeded()
  const a = createMission(db, { userId: 1, deviceId: 7, createdBy: 'agent', convoId: 'c1', title: 'A' }).mission
  const b = createMission(db, { userId: 1, deviceId: 7, createdBy: 'agent', convoId: 'c2', title: 'B' }).mission
  createItem(db, { userId: 1, originDeviceId: 7, createdBy: 'agent', kind: 'question', title: 'Q', originConvoId: 'c1' })
  createItem(db, { userId: 1, originDeviceId: 7, createdBy: 'agent', kind: 'task', title: 'T', originConvoId: 'c1' })
  db.prepare('UPDATE missions SET last_milestone_at=? WHERE id=?').run(5000, b.id)
  const rows = listMissions(db, 1, {})
  assert.deepEqual(rows.map((m) => m.id), [b.id, a.id])
  const ra = rows.find((m) => m.id === a.id)
  assert.equal(ra.open_items, 2); assert.equal(ra.needs_you, 1); assert.equal(ra.conversations, 1); assert.equal(ra.milestones, 0)
  assert.equal(ra.last_milestone, null)
  assert.equal(listMissions(db, 1, { state: 'closed' }).length, 0)
  assert.equal(listMissions(db, 1, { since: 4000 }).length, 2)  // updated_at ≥ since (both created now)
  const d = missionDetail(db, 1, a.id, {})
  assert.deepEqual(d.items.map((i) => i.title), ['Q', 'T'])
  assert.deepEqual(d.conversations.map((c) => c.id), ['c1'])
  assert.equal(d.conversations[0].title, 'C1'); assert.equal(d.conversations[0].box, 'dev-2'); assert.equal(d.conversations[0].state, 'running')
})

test('repointItems only moves items with no mission', () => {
  const db = seeded()
  const m = createMission(db, { userId: 1, deviceId: 7, createdBy: 'agent', convoId: 'c1', title: 'A' }).mission
  const it = createItem(db, { userId: 1, originDeviceId: 7, createdBy: 'agent', kind: 'task', title: 'T', originConvoId: 'c2' }).item
  db.prepare('UPDATE items SET mission_id=? WHERE id=?').run('ms_other', it.id)
  repointItems(db, 1, 'c2', m.id)
  assert.equal(db.prepare('SELECT mission_id FROM items WHERE id=?').get(it.id).mission_id, 'ms_other')
})

test('createMilestone: marker appended inside the transaction, seq stored, mission activity bumped; no mission → no_mission and nothing written', () => {
  const db = seeded()
  const m = createMission(db, { userId: 1, deviceId: 7, createdBy: 'agent', convoId: 'c1', title: 'A' }).mission
  const appendMarker = (payload) => append(db, { userId: 1, convoId: 'c1', sender: 'agent:dev-2', type: 'milestone', payload })
  const r = createMilestone(db, { userId: 1, deviceId: 7, createdBy: 'agent', convoId: 'c1', kind: 'user_input', title: 'Start', body: 'b', idemKey: '7:m1', appendMarker })
  assert.equal(r.duplicate, false); assert.equal(r.milestone.num, 2); assert.equal(r.mission.id, m.id)
  const ev = db.prepare("SELECT seq, payload FROM events WHERE type='milestone'").get()
  assert.equal(ev.seq, r.milestone.seq)
  assert.equal(JSON.parse(ev.payload).milestone_id, r.milestone.id)
  assert.equal(getMission(db, 1, m.id).last_milestone_at, r.milestone.created_at)
  assert.equal(getMission(db, 1, m.id).last_milestone.num, 2)
  const again = createMilestone(db, { userId: 1, deviceId: 7, createdBy: 'agent', convoId: 'c1', kind: 'user_input', title: 'Start', idemKey: '7:m1', appendMarker })
  assert.equal(again.duplicate, true); assert.equal(again.milestone.id, r.milestone.id)
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM events WHERE type='milestone'").get().n, 1)
  // c2 has no mission
  assert.throws(() => createMilestone(db, { userId: 1, deviceId: 7, createdBy: 'agent', convoId: 'c2', kind: 'progress', title: 'x', appendMarker }), /no_mission/)
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM milestones').get().n, 1)
  assert.throws(() => createMilestone(db, { userId: 1, deviceId: 7, createdBy: 'agent', convoId: 'c1', kind: 'other', title: 'x', appendMarker }), /bad_kind/)
})

test('createMilestone: a failing marker append rolls the row back and surfaces marker_append_failed', () => {
  const db = seeded()
  createMission(db, { userId: 1, deviceId: 7, createdBy: 'agent', convoId: 'c1', title: 'A' })
  const boom = () => { throw new Error('disk on fire') }
  assert.throws(() => createMilestone(db, { userId: 1, deviceId: 7, createdBy: 'agent', convoId: 'c1', kind: 'progress', title: 'x', appendMarker: boom }), /marker_append_failed/)
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM milestones').get().n, 0)
  assert.equal(db.prepare('SELECT next_num FROM item_counters WHERE user_id=1').get().next_num, 2) // number allocation rolled back too
})

test('closed mission rejects milestones; listMilestones is newest first per conversation', () => {
  const db = seeded()
  const m = createMission(db, { userId: 1, deviceId: 7, createdBy: 'agent', convoId: 'c1', title: 'A' }).mission
  const appendMarker = (payload) => append(db, { userId: 1, convoId: 'c1', sender: 'agent:dev-2', type: 'milestone', payload })
  createMilestone(db, { userId: 1, deviceId: 7, createdBy: 'agent', convoId: 'c1', kind: 'user_input', title: 'one', appendMarker })
  createMilestone(db, { userId: 1, deviceId: 7, createdBy: 'agent', convoId: 'c1', kind: 'progress', title: 'two', appendMarker })
  assert.deepEqual(listMilestones(db, 1, { convoId: 'c1' }).map((l) => l.title), ['two', 'one'])
  closeMission(db, { userId: 1, missionId: m.id, by: 'agent', summary: 's' })
  assert.throws(() => createMilestone(db, { userId: 1, deviceId: 7, createdBy: 'agent', convoId: 'c1', kind: 'progress', title: 'x', appendMarker }), /closed/)
})

test('createMilestone: an idem_key collision at INSERT time throws idem_key_conflict and rolls the whole transaction back — no orphaned marker survives', () => {
  const db = seeded()
  const m = createMission(db, { userId: 1, deviceId: 7, createdBy: 'agent', convoId: 'c1', title: 'A' }).mission
  const raceKey = '7:race'
  // A genuine two-connection race (the early idem_key check passes, then a
  // CONCURRENT request's row lands before this call's own INSERT) can't be
  // forced here: better-sqlite3 is synchronous and single-writer, so two
  // calls into createMilestone's db.transaction() can never interleave —
  // one fully completes (or fully rolls back) before the next call even
  // starts, and by the time a genuinely concurrent writer's committed row
  // would be visible to this one at all, the EARLY check above would
  // already have seen it too (same limitation createMission's own
  // INSERT-race catch has — untested there for the same reason, per its
  // own comment). Deterministic stand-in instead: land a colliding row via
  // the appendMarker callback, which runs AFTER the early check but BEFORE
  // this call's own INSERT — this reproduces the exact code path (a
  // SQLITE_CONSTRAINT_UNIQUE at INSERT time) without claiming to reproduce
  // true concurrency.
  const appendMarker = (payload) => {
    db.prepare(`INSERT INTO milestones(id,mission_id,user_id,num,kind,title,body,convo_id,seq,device_id,created_by,idem_key,created_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`).run('ml_winner', m.id, 1, 999, 'progress', 'winner', '', 'c1', 42, 7, 'agent', raceKey, Date.now())
    return append(db, { userId: 1, convoId: 'c1', sender: 'agent:dev-2', type: 'milestone', payload })
  }
  assert.throws(
    () => createMilestone(db, { userId: 1, deviceId: 7, createdBy: 'agent', convoId: 'c1', kind: 'progress', title: 'loser', idemKey: raceKey, appendMarker }),
    /idem_key_conflict/,
  )
  // The whole transaction rolled back: not even the synthetic "winner" row
  // (or its own marker event, appended via append() inside appendMarker)
  // survives — let alone an orphaned marker for the loser's never-written
  // id. This is exactly the property the earlier "return duplicate instead
  // of throw" implementation broke: it committed a milestone event whose
  // milestone_id pointed at a row that was never inserted (verified over
  // real HTTP by the reviewer: one marker event, backing row absent).
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM milestones').get().n, 0)
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM events WHERE type='milestone'").get().n, 0)
})

test('a spawned conversation inherits its parent mission at creation; a later upsert never changes it', () => {
  const db = seeded()
  const m = createMission(db, { userId: 1, deviceId: 7, createdBy: 'agent', convoId: 'c1', title: 'A' }).mission
  upsertConversation(db, { id: 'child', ownerUserId: 1, title: 'kid', agentDeviceId: 7, parentConvoId: 'c1' })
  assert.equal(db.prepare('SELECT mission_id FROM conversations WHERE id=?').get('child').mission_id, m.id)
  upsertConversation(db, { id: 'child', ownerUserId: 1, title: 'kid2' })
  assert.equal(db.prepare('SELECT mission_id FROM conversations WHERE id=?').get('child').mission_id, m.id)
  upsertConversation(db, { id: 'orphan', ownerUserId: 1, title: 'o', agentDeviceId: 7, parentConvoId: 'c2' })
  assert.equal(db.prepare('SELECT mission_id FROM conversations WHERE id=?').get('orphan').mission_id, null)
})
