import test from 'node:test'
import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import { openDb } from '../src/db.js'
import { upsertConversation } from '../src/journal.js'
import { createMission, closeMission, getMission } from '../src/missions.js'
import { createProject, getProject } from '../src/projects.js'

function seeded(dbPath = ':memory:') {
  const db = openDb(dbPath)
  db.prepare("INSERT INTO users(id, name, password_hash, created_at) VALUES(1,'dan','x',0)").run()
  db.prepare("INSERT INTO devices(id, user_id, kind, name, token_hash, created_at) VALUES(7,1,'agent','dev-2','h',0)").run()
  db.prepare("INSERT INTO devices(id, user_id, kind, name, token_hash, created_at, private) VALUES(9,1,'agent','priv-box','h2',0,1)").run()
  for (const id of ['c1', 'c2', 'c3']) upsertConversation(db, { id, ownerUserId: 1, title: id, agentDeviceId: 7 })
  upsertConversation(db, { id: 'secret', ownerUserId: 1, title: 'S', agentDeviceId: 9 })
  return db
}
const start = (db, convoId, title, extra = {}) => createMission(db, { userId: 1, deviceId: convoId === 'secret' ? 9 : 7, createdBy: 'agent', convoId, title, ...extra })

test('a mission created without a project gets its own: same title and body, same origin, numbered right after it', () => {
  const db = seeded()
  const m = start(db, 'c1', 'Promo launch', { body: 'Ship on 7 Oct' }).mission
  const p = getProject(db, 1, m.project_id)
  assert.equal(p.title, 'Promo launch'); assert.equal(p.body, 'Ship on 7 Oct')
  assert.equal(p.num, m.num + 1); assert.equal(m.project_num, p.num)
  assert.equal(p.origin_convo_id, 'c1'); assert.equal(p.origin_device_id, 7); assert.equal(p.created_by, 'agent'); assert.equal(p.state, 'open')
})

test('a named project is used as is; an existing-mission reply, an idempotent replay and attach:false create no extra project', () => {
  const db = seeded()
  const named = createProject(db, { userId: 1, deviceId: 7, createdBy: 'agent', title: 'Named' }).project
  const m = start(db, 'c1', 'A', { projectId: named.id }).mission
  assert.equal(m.project_id, named.id)
  const count = () => db.prepare('SELECT COUNT(*) AS n FROM projects').get().n
  assert.equal(count(), 1)
  assert.equal(start(db, 'c1', 'again').existing, true)
  assert.equal(count(), 1)
  start(db, 'c2', 'B', { idemKey: '7:k' }); assert.equal(count(), 2)
  assert.equal(start(db, 'c2', 'B', { idemKey: '7:k' }).duplicate, true); assert.equal(count(), 2)
  const unassigned = start(db, 'c1', 'For someone else', { attach: false }).mission
  assert.notEqual(unassigned.project_id, null); assert.equal(count(), 3)
})

test('a private mission\'s own project is private too: hidden from a filtered agent, like the mission', () => {
  const db = seeded()
  const m = start(db, 'secret', 'Hidden work').mission
  assert.ok(getProject(db, 1, m.project_id))
  assert.equal(getProject(db, 1, m.project_id, { excludePrivateOwned: true }), null)
})

test('openDb gives every open mission still without a project one of its own, once; closed missions stay as they are', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'default-project-'))
  const file = path.join(dir, 'j.db')
  const db = seeded(file)
  const open = start(db, 'c1', 'Old open').mission
  const closed = start(db, 'c2', 'Old closed').mission
  closeMission(db, { userId: 1, missionId: closed.id, by: 'user', summary: 'x' })
  // Rows from before the rule: no project at all.
  db.prepare('UPDATE missions SET project_id = NULL').run()
  db.prepare('DELETE FROM projects').run()
  db.close()
  const again = openDb(file)
  const filed = getMission(again, 1, open.id)
  assert.match(filed.project_id, /^pj_/)
  assert.equal(getProject(again, 1, filed.project_id).title, 'Old open')
  assert.equal(getMission(again, 1, closed.id).project_id, null)
  again.close()
  const third = openDb(file)
  assert.equal(third.prepare('SELECT COUNT(*) AS n FROM projects').get().n, 1, 'idempotent: a second open adds nothing')
  third.close()
  fs.rmSync(dir, { recursive: true, force: true })
})
