import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Database from 'better-sqlite3'
import { openDb } from '../src/db.js'
import { backfillMissionLinks } from '../src/mission-links.js'

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
