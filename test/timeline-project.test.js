import test from 'node:test'
import assert from 'node:assert/strict'
import { openDb } from '../src/db.js'
import { upsertConversation, append } from '../src/journal.js'
import { createItem, addComment } from '../src/items.js'
import { createMission, closeMission, createMilestone } from '../src/missions.js'
import { createProject, mergeProject, updateProject, resolveProject } from '../src/projects.js'
import { writeWeek } from '../src/week-stories.js'
import { weekStartOf, formatWeekKey } from '../src/timeline.js'
import { projectPage, PROJECT_PAGE } from '../src/timeline-project.js'

// ---- fixtures: alice (user 1) with an ordinary box (7), a client (8) and a
// private box (9, the `secret` conversation) ----

const LON = 'Europe/London'
const DAY = 86400e3
const NOW = Date.UTC(2026, 10, 11, 12) // Wed 11 Nov 2026, week of Mon 9 Nov
const W0 = weekStartOf(NOW, LON)
// Week n relative to the current one (0 = this week, -1 = last week): its
// start, a Wednesday-noon instant inside it, and its key.
const weekOf = (n) => weekStartOf(W0 + n * 7 * DAY + 2 * DAY, LON)
const mid = (n, hours = 0) => weekOf(n) + 2 * DAY + 12 * 3600e3 + hours * 3600e3
const keyOf = (n) => formatWeekKey(weekOf(n), LON)
const at = { now: NOW }
const sieved = { now: NOW, excludePrivateOwned: true }

function seeded() {
  const db = openDb(':memory:')
  db.prepare("INSERT INTO users(id, name, password_hash, created_at) VALUES(1,'alice','x',0)").run()
  db.prepare("INSERT INTO devices(id, user_id, kind, name, token_hash, created_at) VALUES(7,1,'agent','box-2','h',0)").run()
  db.prepare("INSERT INTO devices(id, user_id, kind, name, token_hash, created_at) VALUES(8,1,'client','mac','h3',0)").run()
  db.prepare("INSERT INTO devices(id, user_id, kind, name, token_hash, created_at, private) VALUES(9,1,'agent','priv-box','h2',0,1)").run()
  upsertConversation(db, { id: 'secret', ownerUserId: 1, title: 'S', agentDeviceId: 9 })
  return db
}
// A mission in its own conversation on the project, created at `createdAt`
// (a mission's creation is itself a move).
function missionOn(db, p, title, createdAt) {
  const convo = `k${db.prepare('SELECT COUNT(*) AS n FROM missions').get().n + 1}`
  upsertConversation(db, { id: convo, ownerUserId: 1, title: convo, agentDeviceId: 7 })
  const { mission: m } = createMission(db, { userId: 1, deviceId: 7, createdBy: 'agent', convoId: convo, title, projectId: p.id })
  db.prepare('UPDATE missions SET created_at=?, updated_at=? WHERE id=?').run(createdAt, createdAt, m.id)
  return { m, convo }
}
// A project with one mission, both created at `createdAt`.
function proj(db, title, { createdAt = mid(-20) } = {}) {
  const p = createProject(db, { userId: 1, deviceId: 7, createdBy: 'agent', title }).project
  db.prepare('UPDATE projects SET created_at=?, updated_at=? WHERE id=?').run(createdAt, createdAt, p.id)
  return { p, ...missionOn(db, p, title, createdAt) }
}
// A mission born on the private box, on the project.
function privateMission(db, p, createdAt) {
  const { mission: m } = createMission(db, { userId: 1, deviceId: 9, createdBy: 'agent', convoId: 'secret', title: 'quiet work', projectId: p.id })
  db.prepare('UPDATE missions SET created_at=?, updated_at=? WHERE id=?').run(createdAt, createdAt, m.id)
  return m
}
const postAt = (db, convoId, title, ts) => {
  const { milestone } = createMilestone(db, {
    userId: 1, deviceId: convoId === 'secret' ? 9 : 7, createdBy: 'agent', convoId, kind: 'progress', title,
    appendMarker: (payload) => append(db, { userId: 1, convoId, sender: 'agent:x', type: 'milestone', payload }),
  })
  db.prepare('UPDATE milestones SET created_at=? WHERE id=?').run(ts, milestone.id)
  return milestone
}
const closeAt = (db, m, ts) => {
  closeMission(db, { userId: 1, missionId: m.id, by: 'user', summary: 'done' })
  db.prepare('UPDATE missions SET closed_at=?, updated_at=? WHERE id=?').run(ts, ts, m.id)
}
const item = (db, convoId, kind, title, extra = {}) => createItem(db, {
  userId: 1, originDeviceId: convoId === 'secret' ? 9 : 7, createdBy: 'agent', kind, title, originConvoId: convoId, ...extra,
}).item
const blobRow = (db, id, mime = 'image/png') =>
  db.prepare("INSERT INTO blobs(id, owner_user_id, content_type, size, sha256, disk_path, created_at) VALUES(?,1,?,4,'s','p',0)").run(id, mime)
// A file on a comment of the item, posted at `ts`.
const attachAt = (db, it, blobId, ts, mime = 'image/png') => {
  blobRow(db, blobId, mime)
  return addComment(db, {
    userId: 1, itemId: it.id, author: 'agent', deviceId: 7, attachments: [{ blob_ref: blobId, mime, name: `${blobId}.png`, size: 4 }], now: ts,
  })
}
// A story as the Coordinator writes it (project_ids etc. are references).
const tale = (over = {}) => ({ title: 'Launch', sentence: 'It shipped.', next: null, project_ids: [], item_ids: [], media_blob_id: null, ...over })
const put = (db, n, stories, o = {}) => {
  const r = writeWeek(db, 1, keyOf(n), { lede: null, stories, final: false, notes: [] }, { now: NOW, excludePrivateOwned: false, ...o })
  assert.equal(r.ok, true, JSON.stringify(r))
}
const pic = (id) => ({ blob_id: id, content_type: 'image/png', name: `${id}.png` })
const page = (db, p, o = at) => projectPage(db, 1, resolveProject(db, 1, p.id, o).project, o)

// ---- projectPage ----

test('projectPage: a bare project, in full', () => {
  const db = seeded()
  const a = proj(db, 'Promo launch')
  assert.deepEqual(page(db, a.p), {
    project: { id: a.p.id, num: a.p.num, title: 'Promo launch', state: 'open', live: true },
    sentence: null, sentence_source: null, next: null,
    needs_you: [], needs_you_total: 0, media: null,
    counts: { weeks: 1, missions_open: 1, missions_done: 0, files: 0 },
  })
})

test('projectPage sentence: the status, else the newest milestone title, else null', () => {
  const db = seeded()
  const a = proj(db, 'Promo launch')
  const read = () => { const { sentence, sentence_source: source } = page(db, a.p); return [sentence, source] }
  assert.deepEqual(read(), [null, null])
  postAt(db, a.convo, 'Drafted the page', mid(-2))
  postAt(db, a.convo, 'Page is live', mid(-1))
  postAt(db, a.convo, 'An older step', mid(-3))
  assert.deepEqual(read(), ['Page is live', 'milestone'])
  updateProject(db, { userId: 1, projectId: a.p.id, fields: { status: 'Waiting on the last screenshots.' }, statusWriter: { by: 'agent', deviceId: 7, convoId: null } })
  assert.deepEqual(read(), ['Waiting on the last screenshots.', 'status'])
})

test('projectPage sentence under the agent sieve: a status from the private box and a private milestone are not read', () => {
  const db = seeded()
  const a = proj(db, 'Promo launch')
  privateMission(db, a.p, mid(-20))
  postAt(db, a.convo, 'Public step', mid(-2))
  postAt(db, 'secret', 'Private step', mid(-1))
  updateProject(db, { userId: 1, projectId: a.p.id, fields: { status: 'Secret plans' }, statusWriter: { by: 'agent', deviceId: 9, convoId: null } })
  assert.equal(page(db, a.p).sentence, 'Secret plans')
  const agent = page(db, a.p, sieved)
  assert.equal(agent.sentence, 'Public step'); assert.equal(agent.sentence_source, 'milestone')
})

test('projectPage next: from the newest stored week whose story has the project as its main project; null when that story has none', () => {
  const db = seeded()
  const a = proj(db, 'Alpha'); const b = proj(db, 'Bravo')
  const next = () => page(db, a.p).next
  assert.equal(next(), null)
  put(db, -3, [tale({ project_ids: [a.p.id], next: 'Old plan' })])
  put(db, -2, [tale({ project_ids: [a.p.id], next: 'Docs' })])
  assert.equal(next(), 'Docs')
  // A newer week that does not name it, or names it behind another project, changes nothing.
  put(db, -1, [tale({ project_ids: [b.p.id, a.p.id], next: 'Not ours' })])
  assert.equal(next(), 'Docs')
  assert.equal(page(db, b.p).next, 'Not ours')
  // A newer week that names it without a next: nothing comes next.
  put(db, -1, [tale({ project_ids: [a.p.id] }), tale({ project_ids: [a.p.id, b.p.id], next: 'The second story loses' })])
  assert.equal(next(), null)
})

test('projectPage next follows a merge: a week written about a project merged into this one counts', () => {
  const db = seeded()
  const a = proj(db, 'Survivor'); const gone = proj(db, 'Gone')
  put(db, -1, [tale({ project_ids: [gone.p.id], next: 'Carry on' })])
  assert.equal(page(db, a.p).next, null)
  mergeProject(db, { userId: 1, projectId: gone.p.id, intoId: a.p.id, by: 'user' })
  assert.equal(page(db, a.p).next, 'Carry on')
})

test('projectPage needs_you: open items awaiting the user, newest first, at most 10 with the full count; consent cards left out', () => {
  const db = seeded()
  const a = proj(db, 'Alpha'); const other = proj(db, 'Other')
  const made = []
  for (let i = 0; i < 12; i++) made.push(item(db, a.convo, 'question', `Q${i}`, { now: mid(-1, i) }))
  item(db, a.convo, 'question', 'Approve the spawn', { now: mid(0), consent: 'spawn:x', awaiting: 'user' })
  item(db, a.convo, 'task', 'Agent work', { now: mid(0) })
  item(db, other.convo, 'question', 'Elsewhere', { now: mid(0) })
  const out = page(db, a.p)
  assert.equal(out.needs_you_total, 12)
  assert.equal(PROJECT_PAGE.needsYou, 10)
  assert.deepEqual(out.needs_you, made.slice(2).reverse().map((it) => ({ id: it.id, num: it.num, title: it.title })))
})

test('projectPage media: the stored pick when it is newer than the newest file, the file when the file is newer', () => {
  const db = seeded()
  const a = proj(db, 'Site')
  const it = item(db, a.convo, 'task', 'Screens', { now: mid(-6) })
  assert.equal(page(db, a.p).media, null)
  attachAt(db, it, 'b-pick', mid(-5))
  attachAt(db, it, 'b-doc', mid(-2), 'application/pdf')
  attachAt(db, it, 'b-old', mid(-3))
  // No stored week: the newest picture, never the newer document.
  assert.deepEqual(page(db, a.p).media, pic('b-old'))
  // Last week's pick dates from the end of that week, after the newest file.
  put(db, -1, [tale({ project_ids: [a.p.id], media_blob_id: 'b-pick' })])
  assert.deepEqual(page(db, a.p).media, pic('b-pick'))
  // A file posted since is newer.
  attachAt(db, it, 'b-new', weekOf(0) + 3600e3)
  assert.deepEqual(page(db, a.p).media, pic('b-new'))
})

test('projectPage media: a pick in the week still running dates from when it was written', () => {
  const db = seeded()
  const a = proj(db, 'Site')
  const it = item(db, a.convo, 'task', 'Screens', { now: mid(-6) })
  attachAt(db, it, 'b-pick', mid(-5))
  put(db, 0, [tale({ project_ids: [a.p.id], media_blob_id: 'b-pick' })], { now: NOW - DAY })
  assert.deepEqual(page(db, a.p).media, pic('b-pick'))
  attachAt(db, it, 'b-after', NOW - 3600e3)
  assert.deepEqual(page(db, a.p).media, pic('b-after'))
})

test('projectPage media: a pick whose blob is gone falls back to an older pick that resolves, then to the roll-up', () => {
  const db = seeded()
  const a = proj(db, 'Site')
  const it = item(db, a.convo, 'task', 'Screens', { now: mid(-6) })
  attachAt(db, it, 'b-first', mid(-6))
  attachAt(db, it, 'b-second', mid(-5))
  attachAt(db, it, 'b-file', mid(-4))
  put(db, -2, [tale({ project_ids: [a.p.id], media_blob_id: 'b-first' })])
  put(db, -1, [tale({ project_ids: [a.p.id], media_blob_id: 'b-second' })])
  assert.deepEqual(page(db, a.p).media, pic('b-second'))
  db.prepare("DELETE FROM blobs WHERE id = 'b-second'").run()
  assert.deepEqual(page(db, a.p).media, pic('b-first'))
  db.prepare("DELETE FROM blobs WHERE id = 'b-first'").run()
  assert.deepEqual(page(db, a.p).media, pic('b-file'))
})

test('projectPage counts: open and closed missions, files, and the local weeks the project moved in', () => {
  const db = seeded()
  const a = proj(db, 'Alpha', { createdAt: mid(-3) })
  missionOn(db, a.p, 'two', mid(-3, 1))
  const third = missionOn(db, a.p, 'three', mid(-3, 2))
  closeAt(db, third.m, mid(-1))
  const it = item(db, a.convo, 'task', 'Screens', { now: mid(-1, 1) })
  attachAt(db, it, 'b1', mid(-1, 2)); attachAt(db, it, 'b2', mid(-1, 3)); attachAt(db, it, 'b3', mid(-1, 4), 'application/pdf')
  // Sunday 23:30 is still that week; the next Monday 00:00 would be another.
  postAt(db, a.convo, 'late on Sunday', weekOf(0) - 30 * 60e3)
  const other = proj(db, 'Other'); postAt(db, other.convo, 'elsewhere', mid(-2))
  assert.deepEqual(page(db, a.p).counts, { weeks: 2, missions_open: 2, missions_done: 1, files: 3 })
  postAt(db, a.convo, 'Monday', weekOf(0))
  assert.equal(page(db, a.p).counts.weeks, 3)
})

test('projectPage: a project with no open mission is not live', () => {
  const db = seeded()
  const a = proj(db, 'Alpha')
  closeAt(db, a.m, mid(-1))
  const out = page(db, a.p)
  assert.deepEqual(out.project, { id: a.p.id, num: a.p.num, title: 'Alpha', state: 'open', live: false })
  assert.deepEqual(out.counts, { weeks: 2, missions_open: 0, missions_done: 1, files: 0 })
})

test('projectPage: a merged project answers as its survivor, with the work done before the merge', () => {
  const db = seeded()
  const a = proj(db, 'Survivor', { createdAt: mid(-4) }); const gone = proj(db, 'Gone', { createdAt: mid(-6) })
  postAt(db, gone.convo, 'Before the merge', mid(-2))
  item(db, gone.convo, 'question', 'Which plan?', { now: mid(-2, 1) })
  mergeProject(db, { userId: 1, projectId: gone.p.id, intoId: a.p.id, by: 'user' })
  const r = resolveProject(db, 1, gone.p.num)
  assert.deepEqual(r.mergedFrom, { id: gone.p.id, num: gone.p.num })
  const out = projectPage(db, 1, r.project, at)
  assert.equal(out.project.id, a.p.id); assert.equal(out.project.title, 'Survivor'); assert.equal(out.project.live, true)
  assert.equal(out.sentence, 'Before the merge')
  assert.deepEqual(out.needs_you.map((n) => n.title), ['Which plan?'])
  assert.deepEqual(out.counts, { weeks: 3, missions_open: 2, missions_done: 0, files: 0 })
})

test('projectPage under the agent sieve: a private-origin project is not found, and the counts leave out the secret conversation', () => {
  const db = seeded()
  const a = proj(db, 'Alpha', { createdAt: mid(-3) })
  privateMission(db, a.p, mid(-5))
  postAt(db, 'secret', 'Private step', mid(-4))
  const hid = item(db, 'secret', 'question', 'Private question', { now: mid(-3, 1) })
  attachAt(db, hid, 'b-secret', mid(-3, 2))
  const open = item(db, a.convo, 'question', 'Public question', { now: mid(-3, 3) })
  attachAt(db, open, 'b-public', mid(-3, 4))
  put(db, -1, [tale({ project_ids: [a.p.id], media_blob_id: 'b-secret' })])
  const client = page(db, a.p)
  assert.deepEqual(client.counts, { weeks: 3, missions_open: 2, missions_done: 0, files: 2 })
  assert.equal(client.needs_you_total, 2)
  assert.deepEqual(client.media, pic('b-secret'))
  const agent = page(db, a.p, sieved)
  assert.deepEqual(agent.counts, { weeks: 1, missions_open: 1, missions_done: 0, files: 1 })
  assert.equal(agent.needs_you_total, 1)
  assert.deepEqual(agent.needs_you.map((n) => n.title), ['Public question'])
  assert.deepEqual(agent.media, pic('b-public'))
  const hidden = proj(db, 'Hidden')
  db.prepare('UPDATE projects SET origin_convo_id = ? WHERE id = ?').run('secret', hidden.p.id)
  assert.equal(resolveProject(db, 1, hidden.p.id, { excludePrivateOwned: true }), null)
  assert.notEqual(resolveProject(db, 1, hidden.p.id), null)
})

test('projectPage: the number of statements does not grow with the stored weeks', () => {
  const db = seeded()
  const a = proj(db, 'Alpha')
  const count = () => {
    let n = 0
    const prepare = db.prepare.bind(db)
    db.prepare = (sql) => { n += 1; return prepare(sql) }
    try { page(db, a.p) } finally { db.prepare = prepare }
    return n
  }
  put(db, -1, [tale({ project_ids: [a.p.id] })])
  const one = count()
  for (let n = 2; n <= 9; n++) put(db, -n, [tale({ project_ids: [a.p.id] })])
  assert.equal(count(), one)
})
