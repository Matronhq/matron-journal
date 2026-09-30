import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Database from 'better-sqlite3'
import { openDb } from '../src/db.js'
import { backfillMissionLinks } from '../src/mission-links.js'
import { upsertConversation } from '../src/journal.js'
import { createItem } from '../src/items.js'
import { createMission, joinMission, closeMission, CONVOS_MAX } from '../src/missions.js'

const cols = (db, t) => db.prepare(`PRAGMA table_info(${t})`).all().map((c) => c.name)
const indexes = (db) => db.prepare("SELECT name FROM sqlite_master WHERE type='index'").all().map((r) => r.name)
const tmpPath = (tag) => path.join(os.tmpdir(), `${tag}-${process.pid}-${Date.now()}.sqlite`)
const rmDb = (p) => { for (const s of ['', '-wal', '-shm']) fs.rmSync(`${p}${s}`, { force: true }) }

const PROJECT_COLS = [
  'id', 'user_id', 'num', 'state', 'title', 'body',
  'status', 'status_by', 'status_convo_id', 'status_device_id', 'status_updated_at',
  'close_summary', 'closed_by', 'closed_over_open_missions', 'closed_at', 'merged_into',
  'origin_convo_id', 'origin_device_id', 'created_by', 'idem_key', 'created_at', 'updated_at',
]

test('schema: mission_conversations and projects exist; missions gains project_id; constraints hold', () => {
  const db = openDb(':memory:')
  assert.deepEqual(cols(db, 'mission_conversations'), ['mission_id', 'convo_id', 'user_id', 'how', 'joined_at', 'ended_at'])
  assert.deepEqual(cols(db, 'projects'), PROJECT_COLS)
  assert.ok(cols(db, 'missions').includes('project_id'))
  for (const n of ['idx_mc_convo', 'idx_projects_user_state', 'idx_missions_project']) assert.ok(indexes(db).includes(n), n)
  db.prepare("INSERT INTO users(id, name, password_hash, created_at) VALUES(1,'dan','x',0)").run()
  const link = db.prepare('INSERT INTO mission_conversations(mission_id, convo_id, user_id, how, joined_at) VALUES(?,?,1,?,0)')
  link.run('ms_a', 'c1', 'joined')
  assert.throws(() => link.run('ms_a', 'c1', 'joined'), /UNIQUE/)
  assert.throws(() => link.run('ms_b', 'c1', 'teleported'), /CHECK/)
  const pj = db.prepare("INSERT INTO projects(id,user_id,num,title,origin_device_id,created_by,created_at,updated_at) VALUES(?,1,?,'P',1,'agent',0,0)")
  pj.run('pj_a', 5)
  assert.throws(() => pj.run('pj_b', 5), /UNIQUE/)
  const row = db.prepare('SELECT state, body, closed_over_open_missions FROM projects WHERE id=?').get('pj_a')
  assert.deepEqual(row, { state: 'open', body: '', closed_over_open_missions: 0 })
  assert.throws(() => db.prepare("UPDATE projects SET state='archived' WHERE id='pj_a'").run(), /CHECK/)
})

test('schema: opening a pre-projects database adds the tables, project_id and its index once', () => {
  const p = tmpPath('projects-migration')
  try {
    openDb(p).close()
    const raw = new Database(p)
    raw.exec('DROP INDEX IF EXISTS idx_missions_project')
    raw.exec('ALTER TABLE missions DROP COLUMN project_id')
    raw.exec('DROP TABLE mission_conversations')
    raw.exec('DROP TABLE projects')
    raw.close()

    const db2 = openDb(p)
    assert.ok(cols(db2, 'missions').includes('project_id'))
    assert.deepEqual(cols(db2, 'projects'), PROJECT_COLS)
    assert.ok(indexes(db2).includes('idx_missions_project'))
    const after = { missions: cols(db2, 'missions'), projects: cols(db2, 'projects'), links: cols(db2, 'mission_conversations') }
    db2.close()

    const db3 = openDb(p)
    assert.deepEqual({ missions: cols(db3, 'missions'), projects: cols(db3, 'projects'), links: cols(db3, 'mission_conversations') }, after)
    db3.close()
  } finally { rmDb(p) }
})

const linkMap = (db) => Object.fromEntries(db.prepare('SELECT * FROM mission_conversations ORDER BY mission_id, convo_id').all()
  .map((r) => [`${r.mission_id}/${r.convo_id}`, { how: r.how, joined_at: r.joined_at, ended_at: r.ended_at }]))

test('backfill: the first open with an empty link table recovers current, origin, inherited and history links; later opens never touch it', () => {
  const p = tmpPath('mc-backfill')
  try {
    const db1 = openDb(p)
    db1.exec(`
      INSERT INTO users(id, name, password_hash, created_at) VALUES(1,'dan','x',0), (2,'pat','x',0);
      INSERT INTO devices(id, user_id, kind, name, token_hash, created_at) VALUES(7,1,'agent','dev-2','h',0);
      INSERT INTO conversations(id, owner_user_id, title, created_at, mission_id, parent_convo_id) VALUES
        ('origin',1,'o',100,'ms_a',NULL), ('joiner',1,'j',200,'ms_a',NULL), ('kid',1,'k',300,'ms_a','origin'),
        ('mover',1,'m',400,'ms_b',NULL), ('quiet',1,'q',500,NULL,NULL), ('foreign',2,'f',600,NULL,NULL);
      INSERT INTO missions(id,user_id,num,state,title,origin_convo_id,origin_device_id,created_by,created_at,updated_at) VALUES
        ('ms_a',1,1,'open','A','origin',7,'agent',1000,1000),
        ('ms_b',1,2,'open','B','mover',7,'agent',2000,2000),
        ('ms_old',1,3,'closed','Old','mover',7,'agent',50,50);
      INSERT INTO milestones(id,mission_id,user_id,num,kind,title,convo_id,seq,device_id,created_by,created_at) VALUES
        ('ml_1','ms_old',1,4,'progress','x','mover',1,7,'agent',60),
        ('ml_2','ms_old',1,5,'progress','y','mover',2,7,'agent',70),
        ('ml_3','ms_a',1,6,'progress','z','joiner',3,7,'agent',1500),
        ('ml_4','ms_a',1,7,'progress','f','foreign',4,7,'agent',1600);
      INSERT INTO items(id,user_id,num,kind,state,rank,title,origin_convo_id,origin_device_id,created_by,created_at,updated_at,mission_id) VALUES
        ('it_1',1,8,'task','closed',1024,'t','mover',7,'agent',80,80,'ms_old');
      INSERT INTO events(user_id, seq, convo_id, ts, sender, type, payload) VALUES
        (1, 10, 'joiner', 1200, 'agent:dev-2', 'mission', '{"mission_id":"ms_a","num":1,"action":"joined","by":"agent"}');
      DELETE FROM mission_conversations;
    `)
    db1.close()

    const db2 = openDb(p)
    assert.deepEqual(linkMap(db2), {
      'ms_a/joiner': { how: 'joined', joined_at: 1200, ended_at: null },     // joined_at from its joined marker
      'ms_a/kid': { how: 'inherited', joined_at: 1000, ended_at: null },     // sub-chat; max(300, 1000)
      'ms_a/origin': { how: 'origin', joined_at: 1000, ended_at: null },     // max(100, 1000)
      'ms_b/mover': { how: 'origin', joined_at: 2000, ended_at: null },
      'ms_old/mover': { how: 'backfill', joined_at: 60, ended_at: 80 },      // first/last milestone-or-item trace
      // 'ms_a/foreign' is absent: the conversation belongs to another user.
    })
    // Invariant: every current pointer has an active link.
    assert.equal(db2.prepare(`SELECT COUNT(*) AS n FROM conversations c WHERE c.mission_id IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM mission_conversations l WHERE l.mission_id = c.mission_id AND l.convo_id = c.id AND l.ended_at IS NULL)`).get().n, 0)
    assert.equal(backfillMissionLinks(db2), 0, 'a non-empty table is never backfilled again')
    db2.prepare("UPDATE mission_conversations SET ended_at=9999 WHERE convo_id='joiner'").run()
    db2.close()

    const db3 = openDb(p)
    assert.equal(db3.prepare('SELECT COUNT(*) AS n FROM mission_conversations').get().n, 5)
    assert.equal(db3.prepare("SELECT ended_at FROM mission_conversations WHERE convo_id='joiner'").get().ended_at, 9999, 'an ended link stays ended')
    db3.close()
  } finally { rmDb(p) }
})

test('backfill: a malformed mission-marker payload never aborts openDb; the link falls back to its non-marker joined_at', () => {
  const p = tmpPath('mc-backfill-bad-json')
  try {
    const db1 = openDb(p)
    db1.exec(`
      INSERT INTO users(id, name, password_hash, created_at) VALUES(1,'dan','x',0);
      INSERT INTO devices(id, user_id, kind, name, token_hash, created_at) VALUES(7,1,'agent','dev-2','h',0);
      INSERT INTO conversations(id, owner_user_id, title, created_at, mission_id, parent_convo_id) VALUES
        ('origin',1,'o',100,'ms_a',NULL), ('joiner',1,'j',200,'ms_a',NULL);
      INSERT INTO missions(id,user_id,num,state,title,origin_convo_id,origin_device_id,created_by,created_at,updated_at) VALUES
        ('ms_a',1,1,'open','A','origin',7,'agent',1000,1000);
      -- Malformed JSON: not valid, so json_extract would raise 'malformed JSON'
      -- without the json_valid guard. It carries a ts (150) earlier than the
      -- fallback (max(200,1000)=1000), so if it were (wrongly) used as the
      -- marker, joined_at would read 150 instead of 1000.
      INSERT INTO events(user_id, seq, convo_id, ts, sender, type, payload) VALUES
        (1, 10, 'joiner', 150, 'agent:dev-2', 'mission', '{not json');
      DELETE FROM mission_conversations;
    `)
    db1.close()

    const db2 = openDb(p) // must not throw
    assert.deepEqual(linkMap(db2), {
      'ms_a/joiner': { how: 'joined', joined_at: 1000, ended_at: null }, // marker ignored (invalid JSON); falls back to max(200,1000)
      'ms_a/origin': { how: 'origin', joined_at: 1000, ended_at: null },
    })
    db2.close()
  } finally { rmDb(p) }
})

function seeded() {
  const db = openDb(':memory:')
  db.prepare("INSERT INTO users(id, name, password_hash, created_at) VALUES(1,'dan','x',0)").run()
  db.prepare("INSERT INTO devices(id, user_id, kind, name, token_hash, created_at) VALUES(7,1,'agent','dev-2','h',0)").run()
  for (const id of ['c1', 'c2', 'c3']) upsertConversation(db, { id, ownerUserId: 1, title: id.toUpperCase(), agentDeviceId: 7 })
  return db
}
function withPrivateBox() {
  const db = seeded()
  db.prepare("INSERT INTO devices(id, user_id, kind, name, token_hash, created_at, private) VALUES(9,1,'agent','priv-box','h2',0,1)").run()
  upsertConversation(db, { id: 'secret', ownerUserId: 1, title: 'S', agentDeviceId: 9 })
  return db
}
const linksOf = (db, convoId) => db.prepare('SELECT mission_id, how, ended_at FROM mission_conversations WHERE convo_id=? ORDER BY rowid').all(convoId)
const currentOf = (db, convoId) => db.prepare('SELECT mission_id FROM conversations WHERE id=?').get(convoId).mission_id
const startOn = (db, convoId, title, extra = {}) => createMission(db, { userId: 1, deviceId: 7, createdBy: 'agent', convoId, title, ...extra }).mission
const join = (db, missionId, convoId, extra = {}) => joinMission(db, { userId: 1, missionId, convoId, ...extra })
function packLinks(db, missionId, n, prefix) {
  const conv = db.prepare("INSERT INTO conversations(id, owner_user_id, title, session_state, mission_id, created_at) VALUES(?,1,'x','running',?,0)")
  const link = db.prepare("INSERT INTO mission_conversations(mission_id, convo_id, user_id, how, joined_at) VALUES(?,?,1,'joined',0)")
  for (let i = 0; i < n; i++) { conv.run(`${prefix}${i}`, missionId); link.run(missionId, `${prefix}${i}`) }
}

test('createMission: the attached origin gets an active origin link; attach:false links nothing', () => {
  const db = seeded()
  const a = startOn(db, 'c1', 'A')
  assert.deepEqual(linksOf(db, 'c1'), [{ mission_id: a.id, how: 'origin', ended_at: null }])
  startOn(db, 'c2', 'Parked', { attach: false })
  assert.deepEqual(linksOf(db, 'c2'), [])
  assert.equal(currentOf(db, 'c2'), null)
})

test('joinMission: a second mission becomes current and the first stays active; re-joining current is a no-op; joining an also-on mission is current_changed; closed refuses', () => {
  const db = seeded()
  const a = startOn(db, 'c1', 'A')
  const b = startOn(db, 'c2', 'B')
  const { item } = createItem(db, { userId: 1, originDeviceId: 7, createdBy: 'agent', kind: 'task', title: 'T', originConvoId: 'c1' })
  const j = join(db, b.id, 'c1')
  assert.equal(j.action, 'joined'); assert.equal(j.mission.id, b.id)
  assert.equal(currentOf(db, 'c1'), b.id)
  assert.deepEqual(linksOf(db, 'c1'), [
    { mission_id: a.id, how: 'origin', ended_at: null },
    { mission_id: b.id, how: 'joined', ended_at: null },
  ])
  // An item already on a mission stays there; only unassigned items follow.
  assert.equal(db.prepare('SELECT mission_id FROM items WHERE id=?').get(item.id).mission_id, a.id)
  assert.equal(join(db, b.id, 'c1').action, null)
  const back = join(db, a.id, 'c1')
  assert.equal(back.action, 'current_changed'); assert.equal(currentOf(db, 'c1'), a.id)
  assert.equal(linksOf(db, 'c1').length, 2)
  closeMission(db, { userId: 1, missionId: b.id, by: 'user', summary: 'done' })
  assert.throws(() => join(db, b.id, 'c1'), /closed/)
})

test('joinMission: records the how it is given; a reactivated backfill link takes the new how', () => {
  const db = seeded()
  const a = startOn(db, 'c1', 'A')
  join(db, a.id, 'c2', { how: 'spawned' })
  assert.equal(linksOf(db, 'c2')[0].how, 'spawned')
  db.prepare("INSERT INTO mission_conversations(mission_id, convo_id, user_id, how, joined_at, ended_at) VALUES(?, 'c3', 1, 'backfill', 1, 2)").run(a.id)
  assert.equal(join(db, a.id, 'c3').action, 'joined')
  assert.deepEqual(linksOf(db, 'c3'), [{ mission_id: a.id, how: 'joined', ended_at: null }])
})

test('joinMission: the cap counts active top-level links only — a sub-chat always joins, an ended link frees a slot', () => {
  const db = seeded()
  const m = startOn(db, 'c1', 'A')
  packLinks(db, m.id, CONVOS_MAX - 1, 'pad')   // c1 + 199 = 200 top-level
  assert.throws(() => join(db, m.id, 'c2'), /too_many_convos/)
  assert.equal(currentOf(db, 'c2'), null)
  upsertConversation(db, { id: 'kid', ownerUserId: 1, title: 'k', agentDeviceId: 7, parentConvoId: 'c2' })
  assert.equal(join(db, m.id, 'kid').action, 'joined')
  db.prepare("UPDATE mission_conversations SET ended_at=1 WHERE convo_id='pad0'").run()
  assert.equal(join(db, m.id, 'c2').action, 'joined')
})

test('inheritance: a sub-chat inherits its parent\'s CURRENT mission with an inherited link, even when that mission is at the top-level cap', () => {
  const db = seeded()
  startOn(db, 'c1', 'A')
  const b = startOn(db, 'c2', 'B')
  join(db, b.id, 'c1')
  packLinks(db, b.id, CONVOS_MAX - 2, 'pad')   // c2 + c1 + 198 = 200 top-level
  upsertConversation(db, { id: 'kid', ownerUserId: 1, title: 'k', agentDeviceId: 7, parentConvoId: 'c1' })
  assert.equal(currentOf(db, 'kid'), b.id)
  assert.deepEqual(linksOf(db, 'kid'), [{ mission_id: b.id, how: 'inherited', ended_at: null }])
  // A later upsert never adds or changes a link.
  upsertConversation(db, { id: 'kid', ownerUserId: 1, title: 'k2' })
  assert.equal(linksOf(db, 'kid').length, 1)
})
