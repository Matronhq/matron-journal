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
import { createProject, mergeProject, updateProject, closeProject } from '../src/projects.js'
import {
  projectMoves, projectWeeklyMoves, weeksList, weekDetail, wentQuiet, openLong, finished,
} from '../src/timeline.js'

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

// ---- the five reads ----

const DAY = 86400e3
const NOW = Date.UTC(2026, 10, 11, 12) // Wed 11 Nov 2026, week of Mon 9 Nov
const W0 = weekStartOf(NOW, LON)
// Week n relative to the current one (0 = this week, -1 = last week): its
// start, a Wednesday-noon instant inside it, and its key.
const weekOf = (n) => weekStartOf(W0 + n * 7 * DAY + 2 * DAY, LON)
const mid = (n, hours = 0) => weekOf(n) + 2 * DAY + 12 * 3600e3 + hours * 3600e3
const keyOf = (n) => formatWeekKey(weekOf(n), LON)
const at = { now: NOW }

// A project with one mission in its own conversation, both created at
// `createdAt` (the mission's creation is itself a move).
function proj(db, title, { createdAt = mid(-20) } = {}) {
  const convo = `k${db.prepare('SELECT COUNT(*) AS n FROM missions').get().n + 1}`
  upsertConversation(db, { id: convo, ownerUserId: 1, title: convo, agentDeviceId: 7 })
  const p = project(db, title)
  const { mission: m } = createMission(db, { userId: 1, deviceId: 7, createdBy: 'agent', convoId: convo, title, projectId: p.id })
  db.prepare('UPDATE missions SET created_at=?, updated_at=? WHERE id=?').run(createdAt, createdAt, m.id)
  db.prepare('UPDATE projects SET created_at=?, updated_at=? WHERE id=?').run(createdAt, createdAt, p.id)
  return { p, m, convo }
}
const postAt = (db, convo, title, ts) => {
  const { milestone } = post(db, convo, title)
  db.prepare('UPDATE milestones SET created_at=? WHERE id=?').run(ts, milestone.id)
  return milestone
}
const closeAt = (db, m, ts) => {
  closeMission(db, { userId: 1, missionId: m.id, by: 'user', summary: 'done' })
  db.prepare('UPDATE missions SET closed_at=?, updated_at=? WHERE id=?').run(ts, ts, m.id)
}
const ref = (p) => ({ id: p.id, num: p.num, title: p.title })

test('weekDetail ranks stories by moves, caps them at 8 and lists the rest under also', () => {
  const db = seeded()
  const ps = []
  for (let i = 1; i <= 10; i++) {
    const { p, convo } = proj(db, `P${i}`)
    for (let j = 0; j < i; j++) postAt(db, convo, `P${i} step ${j}`, mid(-1, j))
    ps.push(p)
  }
  const out = weekDetail(db, 1, keyOf(-1), at)
  assert.equal(out.week, keyOf(-1)); assert.equal(out.start, weekOf(-1)); assert.equal(out.end, weekOf(0))
  assert.equal(out.final, true); assert.equal(out.lede, null)
  assert.deepEqual(out.stories.map((s) => s.project.title), ['P10', 'P9', 'P8', 'P7', 'P6', 'P5', 'P4', 'P3'])
  assert.deepEqual(out.stories[0].project, ref(ps[9]))
  assert.equal(out.stories[0].next, null)
  assert.deepEqual(out.also, [{ ...ref(ps[1]), moved: 2 }, { ...ref(ps[0]), moved: 1 }])
})

test("a story's sentence is the newest milestone of that week, not a newer one the week after", () => {
  const db = seeded()
  const { convo } = proj(db, 'Search')
  postAt(db, convo, 'Index built', mid(-1, -24))
  postAt(db, convo, 'Search page live', mid(-1, 24))
  postAt(db, convo, 'Search tuned', mid(0))
  const [story] = weekDetail(db, 1, keyOf(-1), at).stories
  assert.equal(story.sentence, 'Search page live')
  assert.equal(weekDetail(db, 1, keyOf(0), at).stories[0].sentence, 'Search tuned')
})

test("media is the newest image or video of that week on the project's missions, null when there is none", () => {
  const db = seeded()
  const { convo } = proj(db, 'Site')
  const plain = proj(db, 'Docs')
  const it = item(db, convo, 'task', 'Screens')
  const attach = (name, mime, ts) => addComment(db, {
    userId: 1, itemId: it.id, author: 'agent', deviceId: 7, attachments: [{ blob_ref: `b-${name}`, mime, name, size: 4 }], now: ts,
  })
  attach('old.png', 'image/png', mid(-1, -24))
  attach('demo.mp4', 'video/mp4', mid(-1, 0))
  attach('spec.pdf', 'application/pdf', mid(-1, 12))
  attach('next.png', 'image/png', mid(0))
  const docsItem = item(db, plain.convo, 'task', 'Docs')
  addComment(db, { userId: 1, itemId: docsItem.id, author: 'agent', deviceId: 7, attachments: [{ blob_ref: 'b-d.pdf', mime: 'application/pdf', name: 'd.pdf', size: 4 }], now: mid(-1) })
  db.prepare('UPDATE items SET created_at=?, updated_at=?').run(mid(-1), mid(-1))
  const stories = weekDetail(db, 1, keyOf(-1), at).stories
  const site = stories.find((s) => s.project.title === 'Site')
  assert.deepEqual(site.media, { blob_id: 'b-demo.mp4', content_type: 'video/mp4', name: 'demo.mp4' })
  assert.equal(stories.find((s) => s.project.title === 'Docs').media, null)
})

test("needs_you lists the open items awaiting the user on the project's missions, newest first, consent cards left out", () => {
  const db = seeded()
  const { convo, p } = proj(db, 'Billing')
  const other = proj(db, 'Other')
  postAt(db, convo, 'moved', mid(-1))
  const older = item(db, convo, 'question', 'Which plan?', { now: mid(-1) })
  const newer = item(db, convo, 'question', 'Ship it?', { now: mid(-1, 1) })
  item(db, convo, 'task', 'Agent work', { now: mid(-1) }) // awaits the agent
  const answered = item(db, convo, 'question', 'Old ask', { now: mid(-1) })
  closeItem(db, { userId: 1, itemId: answered.id, resolution: 'answered', author: 'agent', deviceId: 7 })
  item(db, convo, 'decision', 'Approve the spawn', { consent: 'spawn:x', awaiting: 'user', now: mid(-1) })
  item(db, other.convo, 'question', 'Elsewhere?', { now: mid(-1) })
  const story = weekDetail(db, 1, keyOf(-1), at).stories.find((s) => s.project.id === p.id)
  assert.deepEqual(story.needs_you, [
    { id: newer.id, num: newer.num, title: 'Ship it?' },
    { id: older.id, num: older.num, title: 'Which plan?' },
  ])
})

test('weekDetail empty: a week with no movement has no stories and nothing in also; a current week is not final; a bad key is null', () => {
  const db = seeded()
  proj(db, 'Old', { createdAt: mid(-9) })
  const empty = weekDetail(db, 1, keyOf(-3), at)
  assert.deepEqual(empty.stories, []); assert.deepEqual(empty.also, [])
  assert.equal(empty.final, true)
  assert.equal(weekDetail(db, 1, keyOf(0), at).final, false)
  assert.equal(weekDetail(db, 1, '2026-11-10', at), null)
  assert.equal(weekDetail(db, 1, 'nope', at), null)
})

test('weekDetail leaves out merged projects and, for a filtered caller, private-origin projects', () => {
  const db = seeded()
  const a = proj(db, 'Survivor'); const b = proj(db, 'Gone')
  postAt(db, a.convo, 'a', mid(-1)); postAt(db, b.convo, 'b', mid(-1, 1))
  mergeProject(db, { userId: 1, projectId: b.p.id, intoId: a.p.id, by: 'user' })
  const hidden = createProject(db, { userId: 1, deviceId: 9, createdBy: 'agent', title: 'Hidden', convoId: 'secret' }).project
  const hm = mission(db, 'c1', 'visible mission'); file(db, hm.id, hidden.id)
  db.prepare('UPDATE missions SET created_at=? WHERE id=?').run(mid(-1), hm.id)
  const all = weekDetail(db, 1, keyOf(-1), at)
  assert.deepEqual(all.stories.map((s) => s.project.title).sort(), ['Hidden', 'Survivor'])
  assert.equal(all.stories.find((s) => s.project.title === 'Survivor').sentence, 'b')
  const filtered = weekDetail(db, 1, keyOf(-1), { ...at, excludePrivateOwned: true })
  assert.deepEqual(filtered.stories.map((s) => s.project.title), ['Survivor'])
})

test('weeksList: one sentence per week for 0, 1, 2, 3 and 5 moving projects, newest first, back to the earliest mission', () => {
  const db = seeded()
  const names = ['Alpha', 'Bravo', 'Charlie', 'Delta', 'Echo']
  const ps = names.map((n) => proj(db, n, { createdAt: mid(-5) }))
  // week -3: Alpha; -2: Alpha, Bravo; -1: Alpha, Bravo, Charlie; 0: all five,
  // Echo the busiest. Week -4 is quiet.
  const moves = { [-3]: [1], [-2]: [1, 2], [-1]: [1, 2, 3], 0: [1, 2, 3, 4, 5] }
  for (const [w, counts] of Object.entries(moves)) {
    counts.forEach((n, i) => { for (let j = 0; j < n; j++) postAt(db, ps[i].convo, `${names[i]} ${w}.${j}`, mid(Number(w), j)) })
  }
  const out = weeksList(db, 1, at)
  assert.deepEqual(out.weeks.map((w) => w.week), [0, -1, -2, -3, -4, -5].map(keyOf))
  assert.deepEqual(out.weeks.map((w) => w.sentence), [
    'Echo, Delta, Charlie and 2 more moved.',
    'Charlie, Bravo and Alpha moved.',
    'Bravo and Alpha moved.',
    'Alpha moved.',
    'A quiet week.',
    'Alpha, Bravo, Charlie and 2 more moved.', // each mission's creation, tied, by number
  ])
  assert.deepEqual(out.weeks.map((w) => w.moved), [5, 3, 2, 1, 0, 5])
  assert.equal(out.weeks[1].start, weekOf(-1)); assert.equal(out.weeks[1].end, weekOf(0))
  assert.equal(out.next_before, null)
})

test('weeksList pages backwards by week key and stops at the week of the earliest mission', () => {
  const db = seeded()
  proj(db, 'Alpha', { createdAt: mid(-5) })
  const first = weeksList(db, 1, { ...at, limit: 4 })
  assert.deepEqual(first.weeks.map((w) => w.week), [0, -1, -2, -3].map(keyOf))
  assert.equal(first.next_before, keyOf(-3))
  const second = weeksList(db, 1, { ...at, before: first.next_before, limit: 4 })
  assert.deepEqual(second.weeks.map((w) => w.week), [-4, -5].map(keyOf))
  assert.equal(second.next_before, null)
  const exact = weeksList(db, 1, { ...at, limit: 6 })
  assert.equal(exact.weeks.length, 6); assert.equal(exact.next_before, null)
  assert.equal(weeksList(db, 1, { ...at, before: '2026-11-10' }), null)
  // No missions at all: just this week.
  const fresh = weeksList(seeded(), 1, at)
  assert.deepEqual(fresh.weeks.map((w) => w.week), [keyOf(0)]); assert.equal(fresh.next_before, null)
})

test('wentQuiet: moved in two of the eight weeks before it stopped and not for 14 days; one-week, recent and finished projects left out', () => {
  const db = seeded()
  const quiet = proj(db, 'Quiet', { createdAt: mid(-6) })
  postAt(db, quiet.convo, 'paused', mid(-4))
  proj(db, 'Once', { createdAt: mid(-5) })
  const recent = proj(db, 'Recent', { createdAt: mid(-6) })
  postAt(db, recent.convo, 'still going', NOW - 10 * DAY)
  const done = proj(db, 'Done', { createdAt: mid(-6) })
  postAt(db, done.convo, 'wrapping up', mid(-5))
  closeAt(db, done.m, mid(-4))
  const out = wentQuiet(db, 1, at)
  assert.equal(out.total, 1)
  assert.deepEqual(out.rows, [{
    project: ref(quiet.p), last_moved_at: mid(-4), weekly: [0, 1, 0, 1, 0, 0, 0, 0], note: null,
  }])
})

test('wentQuiet ranks by moves in the eight weeks before it stopped, shows the top 10 and counts them all', () => {
  const db = seeded()
  for (let i = 1; i <= 12; i++) {
    const { convo } = proj(db, `Q${i}`, { createdAt: mid(-8) })
    for (let j = 0; j < i; j++) postAt(db, convo, `Q${i}.${j}`, mid(-4, j))
  }
  const out = wentQuiet(db, 1, at)
  assert.equal(out.total, 12)
  assert.deepEqual(out.rows.map((r) => r.project.title), ['Q12', 'Q11', 'Q10', 'Q9', 'Q8', 'Q7', 'Q6', 'Q5', 'Q4', 'Q3'])
  assert.equal(out.rows[0].weekly.length, 8)
})

test('openLong: a live project created 22 days ago is in, oldest first; 20 days ago and finished ones are out', () => {
  const db = seeded()
  const old = proj(db, 'Old', { createdAt: NOW - 40 * DAY })
  const mid22 = proj(db, 'Middle', { createdAt: NOW - 22 * DAY })
  postAt(db, mid22.convo, 'step', mid(0))
  proj(db, 'Young', { createdAt: NOW - 20 * DAY })
  const fin = proj(db, 'Finished', { createdAt: NOW - 30 * DAY })
  closeAt(db, fin.m, NOW - 25 * DAY)
  const closed = proj(db, 'Closed', { createdAt: NOW - 30 * DAY })
  closeProject(db, { userId: 1, projectId: closed.p.id, by: 'user', summary: 'stop' })
  const out = openLong(db, 1, at)
  assert.equal(out.total, 2)
  assert.deepEqual(out.rows.map((r) => r.project), [ref(old.p), ref(mid22.p)])
  assert.equal(out.rows[0].created_at, NOW - 40 * DAY)
  assert.equal(out.rows[0].last_moved_at, NOW - 40 * DAY)
  assert.equal(out.rows[1].last_moved_at, mid(0))
  assert.deepEqual(out.rows[1].weekly, [0, 0, 0, 0, 1, 0, 0, 1]) // created in week -3, a milestone this week
  assert.equal(out.rows[0].note, null)
})

test('finished: projects whose missions are all closed and closed projects, newest first, paged; live and merged ones left out', () => {
  const db = seeded()
  const allClosed = proj(db, 'All closed')
  closeAt(db, allClosed.m, NOW - 5 * DAY)
  const closed = proj(db, 'Closed')
  const gone = proj(db, 'Gone')
  mergeProject(db, { userId: 1, projectId: gone.p.id, intoId: closed.p.id, by: 'user' })
  closeProject(db, { userId: 1, projectId: closed.p.id, by: 'user', summary: 'stop' })
  db.prepare('UPDATE projects SET closed_at=? WHERE id=?').run(NOW - 2 * DAY, closed.p.id)
  const older = proj(db, 'Older')
  closeAt(db, older.m, NOW - 9 * DAY)
  proj(db, 'Live')
  const out = finished(db, 1, at)
  assert.deepEqual(out.rows, [
    { project: ref(closed.p), finished_at: NOW - 2 * DAY },
    { project: ref(allClosed.p), finished_at: NOW - 5 * DAY },
    { project: ref(older.p), finished_at: NOW - 9 * DAY },
  ])
  assert.equal(out.next_before, null)
  const p1 = finished(db, 1, { ...at, limit: 2 })
  assert.deepEqual(p1.rows.map((r) => r.project.title), ['Closed', 'All closed'])
  assert.equal(p1.next_before, `${NOW - 5 * DAY}:${allClosed.p.id}`)
  const p2 = finished(db, 1, { ...at, limit: 2, before: p1.next_before })
  assert.deepEqual(p2.rows.map((r) => r.project.title), ['Older'])
  assert.equal(p2.next_before, null)
  assert.equal(finished(db, 1, { ...at, before: 'bad cursor' }), null)
})

test('finished leaves out an open project that never had a mission, keeps a closed one, and keeps a closed project with open missions', () => {
  const db = seeded()
  const leftover = proj(db, 'Leftover')
  const target = proj(db, 'Target')
  file(db, leftover.m.id, target.p.id) // the move empties Leftover
  const emptyClosed = project(db, 'Empty closed')
  closeProject(db, { userId: 1, projectId: emptyClosed.id, by: 'user', summary: 'never started' })
  const stillOpen = proj(db, 'Closed over open missions')
  closeProject(db, { userId: 1, projectId: stillOpen.p.id, by: 'user', summary: 'stop' })
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM missions WHERE project_id=? AND state='open'").get(stillOpen.p.id).n, 1)
  const titles = finished(db, 1, at).rows.map((r) => r.project.title)
  assert.ok(!titles.includes('Leftover'))
  assert.ok(!titles.includes('Target'))
  assert.ok(titles.includes('Empty closed'))
  assert.ok(titles.includes('Closed over open missions'))
})

test('openLong includes a project created exactly 21 days ago', () => {
  const db = seeded()
  const edge = proj(db, 'Edge', { createdAt: NOW - 21 * DAY })
  proj(db, 'Just short', { createdAt: NOW - 21 * DAY + 1 })
  const out = openLong(db, 1, at)
  assert.deepEqual(out.rows.map((r) => r.project), [ref(edge.p)])
})

test('wentQuiet includes a project whose last move is exactly 14 days ago', () => {
  const db = seeded()
  const edge = proj(db, 'Edge', { createdAt: NOW - 20 * DAY })
  postAt(db, edge.convo, 'last', NOW - 14 * DAY)
  const short = proj(db, 'Just short', { createdAt: NOW - 20 * DAY })
  postAt(db, short.convo, 'last', NOW - 14 * DAY + 1)
  const out = wentQuiet(db, 1, at)
  assert.deepEqual(out.rows.map((r) => [r.project.title, r.last_moved_at]), [['Edge', NOW - 14 * DAY]])
})
