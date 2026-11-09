import test from 'node:test'
import assert from 'node:assert/strict'
import { openDb } from '../src/db.js'
import { createUser } from '../src/auth.js'
import {
  userTimeZone, weekStartOf, weekEndOf, previousWeekStart, formatWeekKey, parseWeekKey,
} from '../src/timeline.js'

import { upsertConversation, append } from '../src/journal.js'
import { createItem, addComment, closeItem } from '../src/items.js'
import { createMission, closeMission, createMilestone } from '../src/missions.js'
import { createProject, mergeProject, updateProject } from '../src/projects.js'
import { projectMoves, projectWeeklyMoves } from '../src/timeline.js'

const LON = 'Europe/London'

test('userTimeZone defaults to Europe/London and honours a stored zone', async () => {
  const db = openDb(':memory:')
  const alice = await createUser(db, 'alice', 'pw')
  assert.equal(userTimeZone(db, alice.id), LON)
  const id = alice.id
  db.prepare('UPDATE users SET time_zone = ? WHERE id = ?').run('America/New_York', id)
  assert.equal(userTimeZone(db, id), 'America/New_York')
  db.prepare('UPDATE users SET time_zone = ? WHERE id = ?').run('Not/AZone', id)
  assert.equal(userTimeZone(db, id), LON)
  assert.equal(userTimeZone(db, 99999), LON)
})

test('weekStartOf is the local Monday 00:00 at or before the instant', () => {
  assert.equal(weekStartOf(Date.UTC(2026, 10, 9, 14, 0), LON), Date.UTC(2026, 10, 9, 0, 0))
  assert.equal(weekStartOf(Date.UTC(2026, 10, 9, 0, 0), LON), Date.UTC(2026, 10, 9, 0, 0))
  // Sunday 15 Nov 23:30 local (GMT) -> Monday 9 Nov.
  assert.equal(weekStartOf(Date.UTC(2026, 10, 15, 23, 30), LON), Date.UTC(2026, 10, 9, 0, 0))
  // BST: Sunday 4 Oct 23:30 local = 22:30 UTC -> Monday 28 Sep 00:00 BST = 27 Sep 23:00 UTC.
  assert.equal(weekStartOf(Date.UTC(2026, 9, 4, 22, 30), LON), Date.UTC(2026, 8, 27, 23, 0))
})

test('weekEndOf spans the 25 Oct 2026 clock change as a 169 hour week', () => {
  const start = weekStartOf(Date.UTC(2026, 9, 21), LON)
  assert.equal(weekEndOf(start, LON) - start, 169 * 3600e3)
  const plain = weekStartOf(Date.UTC(2026, 10, 10), LON)
  assert.equal(weekEndOf(plain, LON) - plain, 168 * 3600e3)
})

test('previousWeekStart steps back one local week across the change', () => {
  const nov2 = Date.UTC(2026, 10, 2, 0, 0)
  const oct26 = previousWeekStart(nov2, LON)
  assert.equal(oct26, Date.UTC(2026, 9, 26, 0, 0))
  const oct19 = previousWeekStart(oct26, LON) // Mon 19 Oct 00:00 BST
  assert.equal(oct19, Date.UTC(2026, 9, 18, 23, 0))
  assert.equal(oct26 - oct19, 169 * 3600e3)
  assert.equal(weekEndOf(oct19, LON), oct26)
})

test('formatWeekKey and parseWeekKey round-trip the local Monday date', () => {
  const start = weekStartOf(Date.UTC(2026, 9, 21), LON) // Mon 19 Oct, BST
  assert.equal(formatWeekKey(start, LON), '2026-10-19')
  assert.equal(parseWeekKey('2026-10-19', LON), start)
  const nov9 = Date.UTC(2026, 10, 9, 0, 0)
  assert.equal(formatWeekKey(nov9, LON), '2026-11-09')
  assert.equal(parseWeekKey('2026-11-09', LON), nov9)
  const ny = weekStartOf(Date.UTC(2026, 10, 11, 12), 'America/New_York')
  assert.equal(parseWeekKey(formatWeekKey(ny, 'America/New_York'), 'America/New_York'), ny)
})

test('parseWeekKey rejects non-Mondays, bad shapes and impossible dates', () => {
  assert.equal(parseWeekKey('2026-11-10', LON), null)
  assert.equal(parseWeekKey('2026-02-30', LON), null)
  assert.equal(parseWeekKey('2026-1-09', LON), null)
  assert.equal(parseWeekKey('nope', LON), null)
  assert.equal(parseWeekKey(undefined, LON), null)
})

test('an invalid zone falls back to Europe/London', () => {
  const t = Date.UTC(2026, 10, 9, 14, 0)
  assert.equal(weekStartOf(t, 'Bogus/Zone'), weekStartOf(t, LON))
})

test('weekStartOf handles the exact Monday boundary and sub-second edges', () => {
  const mon = Date.UTC(2026, 10, 9, 0, 0)
  assert.equal(weekStartOf(mon, LON), mon)
  assert.equal(weekStartOf(mon + 500, LON), mon)
  assert.equal(weekStartOf(mon - 1, LON), Date.UTC(2026, 10, 2, 0, 0))
  assert.equal(weekStartOf(weekEndOf(mon, LON) - 1, LON), mon)
})

// ---- projectMoves / projectWeeklyMoves ----

function seeded() {
  const db = openDb(':memory:')
  db.prepare("INSERT INTO users(id, name, password_hash, created_at) VALUES(1,'alice','x',0)").run()
  db.prepare("INSERT INTO devices(id, user_id, kind, name, token_hash, created_at) VALUES(7,1,'agent','box-2','h',0)").run()
  db.prepare("INSERT INTO devices(id, user_id, kind, name, token_hash, created_at) VALUES(8,1,'client','mac','h3',0)").run()
  db.prepare("INSERT INTO devices(id, user_id, kind, name, token_hash, created_at, private) VALUES(9,1,'agent','priv-box','h2',0,1)").run()
  for (const id of ['c1', 'c2']) upsertConversation(db, { id, ownerUserId: 1, title: id, agentDeviceId: 7 })
  upsertConversation(db, { id: 'secret', ownerUserId: 1, title: 'S', agentDeviceId: 9 })
  return db
}
const project = (db, title = 'Promo launch') => createProject(db, { userId: 1, deviceId: 7, createdBy: 'agent', title }).project
const mission = (db, convoId, title, deviceId = 7) => createMission(db, { userId: 1, deviceId, createdBy: 'agent', convoId, title }).mission
const file = (db, missionId, projectId) => db.prepare('UPDATE missions SET project_id=? WHERE id=?').run(projectId, missionId)
const item = (db, convoId, kind, title, extra = {}) => createItem(db, {
  userId: 1, originDeviceId: convoId === 'secret' ? 9 : 7, createdBy: 'agent', kind, title, originConvoId: convoId, ...extra,
}).item
const post = (db, convoId, title, deviceId = 7) => createMilestone(db, {
  userId: 1, deviceId, createdBy: 'agent', convoId, kind: 'progress', title,
  appendMarker: (payload) => append(db, { userId: 1, convoId, sender: 'agent:x', type: 'milestone', payload }),
})

const T = 1_000_000
const WIN = { from: T, to: T + 1000 }
// Pin every timestamp a fixture wrote to T so the window is the only variable.
function pinAll(db, at) {
  for (const sql of [
    'UPDATE milestones SET created_at=?', 'UPDATE items SET created_at=?, updated_at=?',
    'UPDATE items SET closed_at=? WHERE closed_at IS NOT NULL', 'UPDATE item_comments SET created_at=?',
    'UPDATE missions SET created_at=?, updated_at=?', 'UPDATE missions SET closed_at=? WHERE closed_at IS NOT NULL',
  ]) db.prepare(sql).run(...Array(sql.split('?').length - 1).fill(at))
}
// A project with one mission on c1, everything the fixture adds pinned to T.
function lone(build) {
  const db = seeded()
  const p = project(db)
  const m = mission(db, 'c1', 'one'); file(db, m.id, p.id)
  build(db, m, p)
  pinAll(db, T)
  return { db, p }
}
const count = (db, p, opts = {}) => projectMoves(db, 1, { ...WIN, ...opts }).get(p.id) ?? 0

test('a milestone, an item creation, a user comment, an item close, a mission create and a mission close each count one move', () => {
  // A mission's own creation is one move, so each other kind is measured on top of it.
  const BASE = 1
  const moves = (build) => { const { db, p } = lone(build); return count(db, p) - BASE }
  assert.equal(moves(() => {}), 0)
  assert.equal(moves((db) => post(db, 'c1', 'shipped')), 1)
  assert.equal(moves((db) => item(db, 'c1', 'task', 'Do it')), 1)
  assert.equal(moves((db) => {
    const it = item(db, 'c1', 'task', 'Do it')
    addComment(db, { userId: 1, itemId: it.id, author: 'user', deviceId: 8, body: 'hello' })
  }), 2) // the item's creation + the comment
  assert.equal(moves((db) => {
    const it = item(db, 'c1', 'task', 'Do it')
    closeItem(db, { userId: 1, itemId: it.id, resolution: 'done', author: 'agent', deviceId: 7 })
  }), 2) // the item's creation + its close
  assert.equal(moves((db, m) => closeMission(db, { userId: 1, missionId: m.id, by: 'user', summary: 'done' })), 1)
})

test('chat events and a project status edit are not moves', () => {
  const { db, p } = lone((d) => {
    append(d, { userId: 1, convoId: 'c1', sender: 'agent:x', type: 'text', payload: { body: 'chatter' } })
  })
  db.prepare('UPDATE events SET ts=?').run(T)
  updateProject(db, { userId: 1, projectId: p.id, fields: { status: 'going well' }, statusWriter: { by: 'agent', deviceId: 7, convoId: 'c1' } })
  db.prepare('UPDATE projects SET status_updated_at=?, updated_at=?').run(T, T)
  assert.equal(count(db, p), 1) // only the mission's own creation
})

test('a withdrawn comment and an agent status line are not moves', () => {
  const { db, p } = lone((d) => {
    const it = item(d, 'c1', 'task', 'Do it')
    addComment(d, { userId: 1, itemId: it.id, author: 'user', deviceId: 8, body: 'oops' })
    d.prepare('UPDATE item_comments SET withdrawn_at=1 WHERE item_id=?').run(it.id)
    d.prepare("INSERT INTO item_comments(id,item_id,user_id,author,device_id,kind,body,created_at) VALUES('s1',?,1,'agent',7,'status','moved on',0)").run(it.id)
  })
  assert.equal(count(db, p), 2) // mission creation + item creation
})

test('a consent card created, commented on and closed counts 0', () => {
  const { db, p } = lone((d) => {
    const card = item(d, 'c1', 'decision', 'Approve the spawn', { consent: 'spawn:x' })
    addComment(d, { userId: 1, itemId: card.id, author: 'user', deviceId: 8, body: 'ok' })
    addComment(d, { userId: 1, itemId: card.id, author: 'agent', deviceId: 7, body: 'thanks' })
    closeItem(d, { userId: 1, itemId: card.id, resolution: 'decided', author: 'user', deviceId: 8 })
  })
  assert.equal(count(db, p), 1) // only the mission's own creation
})

test('the window is [from, to): activity outside it counts 0', () => {
  const { db, p } = lone((d) => post(d, 'c1', 'shipped'))
  assert.equal(projectMoves(db, 1, { from: T + 1, to: T + 2000 }).has(p.id), false)
  assert.equal(projectMoves(db, 1, { from: 0, to: T }).has(p.id), false)
  assert.equal(count(db, p), 2)
})

test('merged project moves roll up to the survivor', () => {
  const db = seeded()
  const survivor = project(db, 'Survivor'); const gone = project(db, 'Gone')
  const m1 = mission(db, 'c1', 'one'); file(db, m1.id, survivor.id)
  const m2 = mission(db, 'c2', 'two'); file(db, m2.id, gone.id)
  mergeProject(db, { userId: 1, projectId: gone.id, intoId: survivor.id, by: 'user' })
  // A mission still filed under the merged project (a late write) counts for the survivor.
  db.prepare('UPDATE missions SET project_id=? WHERE id=?').run(gone.id, m2.id)
  post(db, 'c2', 'late')
  pinAll(db, T)
  const moves = projectMoves(db, 1, WIN)
  assert.equal(moves.get(survivor.id), 3) // two missions + one milestone
  assert.equal(moves.has(gone.id), false)
})

test('excludePrivateOwned leaves out moves in a private conversation; false counts them', () => {
  const { db, p } = lone((d, m) => {
    d.prepare("UPDATE conversations SET mission_id=? WHERE id='secret'").run(m.id)
    item(d, 'secret', 'task', 'Private task')
    post(d, 'secret', 'private milestone', 9)
    const open = item(d, 'c1', 'task', 'Public task')
    addComment(d, { userId: 1, itemId: open.id, author: 'user', deviceId: 9, body: 'from the private box' })
  })
  assert.equal(count(db, p, { excludePrivateOwned: false }), 5) // mission, 2 items, milestone, comment
  assert.equal(count(db, p, { excludePrivateOwned: true }), 2) // mission + the public item
})

test('excludePrivateOwned leaves out a mission born in a private conversation, with its create and close', () => {
  const { db, p } = lone((d) => {
    const hidden = mission(d, 'secret', 'hidden', 9)
    file(d, hidden.id, d.prepare('SELECT project_id FROM missions WHERE title=?').get('one').project_id)
    closeMission(d, { userId: 1, missionId: hidden.id, by: 'user', summary: 'done' })
  })
  assert.equal(count(db, p, { excludePrivateOwned: false }), 3)
  assert.equal(count(db, p, { excludePrivateOwned: true }), 1)
})

test('projectWeeklyMoves gives one count per week, oldest first, zero for quiet weeks and quiet projects', () => {
  const db = seeded()
  const busy = project(db, 'Busy'); const quiet = project(db, 'Quiet')
  const m = mission(db, 'c1', 'one'); file(db, m.id, busy.id)
  const w0 = weekStartOf(Date.UTC(2026, 9, 19, 12), LON) // Mon 19 Oct (BST)
  const weeks = [w0, weekEndOf(w0, LON), weekEndOf(weekEndOf(w0, LON), LON)] // 19 Oct, 26 Oct, 2 Nov
  pinAll(db, weeks[0] + 3600e3) // the mission is created in week 0
  post(db, 'c1', 'a'); post(db, 'c1', 'b')
  db.prepare('UPDATE milestones SET created_at=?').run(weeks[2] + 5) // both in week 2
  const out = projectWeeklyMoves(db, 1, [busy.id, quiet.id], weeks, LON)
  assert.deepEqual(out.get(busy.id), [1, 0, 2])
  assert.deepEqual(out.get(quiet.id), [0, 0, 0])
  assert.equal(out.size, 2)
})

test('projectWeeklyMoves buckets the tail hour of the 169 hour week into that week, and the boundary into the next', () => {
  const db = seeded()
  const p = project(db)
  const m = mission(db, 'c1', 'one'); file(db, m.id, p.id)
  const w19 = weekStartOf(Date.UTC(2026, 9, 21), LON) // Mon 19 Oct 00:00 BST
  const w26 = weekEndOf(w19, LON) // Mon 26 Oct 00:00 GMT
  assert.equal(w26 - w19, 169 * 3600e3)
  const sunTail = Date.UTC(2026, 9, 25, 23, 30) // Sun 25 Oct 23:30 GMT, last hour of the week
  pinAll(db, w19 + 60e3)
  post(db, 'c1', 'tail'); post(db, 'c1', 'edge'); post(db, 'c1', 'start')
  const set = db.prepare('UPDATE milestones SET created_at=? WHERE title=?')
  set.run(sunTail, 'tail'); set.run(w26 - 1, 'edge'); set.run(w26, 'start')
  const out = projectWeeklyMoves(db, 1, [p.id], [w19, w26], LON)
  assert.deepEqual(out.get(p.id), [3, 1]) // mission + tail + edge | start
})
