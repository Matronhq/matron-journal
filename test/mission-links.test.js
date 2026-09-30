import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Database from 'better-sqlite3'
import { openDb } from '../src/db.js'

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
