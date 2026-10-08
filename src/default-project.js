// Every mission has a project (there is no Inbox). A mission created without one gets its own
// project, named and described like the mission, with the mission's origin
// as the project's origin — so the privacy sieve treats the pair alike.
// Its own module so missions.js and db.js can both use it without importing
// projects.js (which imports missions.js).
import { nextNum, newId } from './items.js'

export function insertDefaultProject(db, { userId, deviceId, createdBy, convoId, title, body = '', ts = Date.now() }) {
  const id = newId('pj')
  db.prepare(`INSERT INTO projects(id,user_id,num,state,title,body,origin_convo_id,origin_device_id,created_by,created_at,updated_at)
    VALUES(?,?,?,'open',?,?,?,?,?,?,?)`).run(id, userId, nextNum(db, userId), title, body, convoId, deviceId, createdBy, ts, ts)
  return id
}

// Open missions still without a project (created before this rule, or by an
// older journal) each get one. Runs on every open; idempotent, because it
// only touches rows whose project_id is NULL. Closed missions are history
// and stay as they are. Returns how many it filed.
export function backfillDefaultProjects(db) {
  const rows = db.prepare(`SELECT id, user_id, title, body, origin_convo_id, origin_device_id, created_by, created_at
    FROM missions WHERE state = 'open' AND project_id IS NULL ORDER BY user_id, num`).all()
  if (rows.length === 0) return 0
  db.transaction(() => {
    for (const m of rows) {
      const projectId = insertDefaultProject(db, {
        userId: m.user_id, deviceId: m.origin_device_id, createdBy: m.created_by, convoId: m.origin_convo_id,
        title: m.title, body: m.body, ts: m.created_at,
      })
      db.prepare('UPDATE missions SET project_id = ? WHERE id = ?').run(projectId, m.id)
    }
  })()
  return rows.length
}
