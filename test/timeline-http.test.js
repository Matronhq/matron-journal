import test from 'node:test'
import assert from 'node:assert/strict'
import { startTestServer } from './helpers.js'
import { createUser, createAgent } from '../src/auth.js'
import { upsertConversation } from '../src/journal.js'
import { pinDevicePrivate } from '../src/db.js'
import { createProject, closeProject } from '../src/projects.js'
import { createMission, closeMission } from '../src/missions.js'
import { weekStartOf, formatWeekKey, previousWeekStart, parseWeekKey, userTimeZone } from '../src/timeline.js'

async function fleet(t) {
  const s = await startTestServer({})
  t.after(() => s.close())
  const alice = await createUser(s.db, 'alice', 'pw')
  const agent = createAgent(s.db, alice.id, 'box-2')
  const priv = createAgent(s.db, alice.id, 'private-box')
  pinDevicePrivate(s.db, priv.deviceId, true)
  upsertConversation(s.db, { id: 'c1', ownerUserId: alice.id, title: 'c1', agentDeviceId: agent.deviceId })
  upsertConversation(s.db, { id: 'secret', ownerUserId: alice.id, title: 'S', agentDeviceId: priv.deviceId })
  const login = await s.http('/login', { method: 'POST', body: { username: 'alice', password: 'pw', device_name: 'mac' } })
  return { s, alice, agent, priv, client: login.json.token }
}
const thisWeek = (s, alice) => {
  const tz = userTimeZone(s.db, alice.id)
  return formatWeekKey(weekStartOf(Date.now(), tz), tz)
}
const lastWeek = (s, alice) => {
  const tz = userTimeZone(s.db, alice.id)
  return formatWeekKey(previousWeekStart(weekStartOf(Date.now(), tz), tz), tz)
}
const get = (s, path, token) => s.http(path, { token })

test('every timeline route is 401 without a token', async (t) => {
  const { s } = await fleet(t)
  for (const p of ['/timeline/weeks', '/timeline/weeks/2026-11-09', '/timeline/quiet', '/timeline/long', '/timeline/finished']) {
    assert.equal((await get(s, p, undefined)).status, 401, p)
  }
})

test('a client reads all five routes, each in the shape the timeline reads return', async (t) => {
  const { s, alice, agent, client } = await fleet(t)
  const p = createProject(s.db, { userId: alice.id, deviceId: agent.deviceId, createdBy: 'agent', title: 'Promo launch' }).project
  const m = createMission(s.db, { userId: alice.id, deviceId: agent.deviceId, createdBy: 'agent', convoId: 'c1', title: 'one', projectId: p.id }).mission
  const weeks = await get(s, '/timeline/weeks', client)
  assert.equal(weeks.status, 200)
  assert.equal(weeks.json.weeks[0].week, thisWeek(s, alice))
  assert.equal(weeks.json.weeks[0].moved, 1)
  assert.equal(weeks.json.next_before, null)
  assert.deepEqual(Object.keys(weeks.json).sort(), ['next_before', 'weeks'])
  const detail = await get(s, `/timeline/weeks/${thisWeek(s, alice)}`, client)
  assert.equal(detail.status, 200)
  assert.equal(detail.json.week, thisWeek(s, alice)); assert.equal(detail.json.final, false)
  assert.deepEqual(detail.json.stories.map((x) => x.project.title), ['Promo launch'])
  assert.deepEqual(detail.json.also, [])
  const quiet = await get(s, '/timeline/quiet', client)
  assert.equal(quiet.status, 200); assert.deepEqual(quiet.json, { total: 0, rows: [] })
  const long = await get(s, '/timeline/long', client)
  assert.equal(long.status, 200); assert.deepEqual(long.json, { total: 0, rows: [] })
  const open = await get(s, '/timeline/finished', client)
  assert.equal(open.status, 200); assert.deepEqual(open.json, { rows: [], next_before: null })
  closeMission(s.db, { userId: alice.id, missionId: m.id, by: 'user', summary: 'done' })
  const done = await get(s, '/timeline/finished', client)
  assert.equal(done.json.rows.length, 1)
  assert.equal(done.json.rows[0].project.title, 'Promo launch')
  assert.equal(typeof done.json.rows[0].finished_at, 'number')
})

test(':week must be a real Monday week key, else 400', async (t) => {
  const { s, alice, client } = await fleet(t)
  assert.equal((await get(s, `/timeline/weeks/${lastWeek(s, alice)}`, client)).status, 200)
  for (const bad of ['2026-11-10', '2026-02-30', 'nope', '2026-11-9', '%E0%A4%A']) {
    assert.equal((await get(s, `/timeline/weeks/${bad}`, client)).status, 400, bad)
  }
})

test('weeks: limit must be an integer in 1..52 and before a Monday week key, else 400; before pages back', async (t) => {
  const { s, alice, agent, client } = await fleet(t)
  for (const bad of ['0', '53', '-1', '1.5', 'x', '']) {
    assert.equal((await get(s, `/timeline/weeks?limit=${bad}`, client)).status, 400, `limit=${bad}`)
  }
  for (const ok of ['1', '52']) assert.equal((await get(s, `/timeline/weeks?limit=${ok}`, client)).status, 200, `limit=${ok}`)
  for (const bad of ['2026-11-10', 'junk', '']) {
    assert.equal((await get(s, `/timeline/weeks?before=${bad}`, client)).status, 400, `before=${bad}`)
  }
  // The current week is the page's first week; paging before it starts the week earlier.
  const p = createProject(s.db, { userId: alice.id, deviceId: agent.deviceId, createdBy: 'agent', title: 'Old' }).project
  const m = createMission(s.db, { userId: alice.id, deviceId: agent.deviceId, createdBy: 'agent', convoId: 'c1', title: 'old', projectId: p.id }).mission
  s.db.prepare('UPDATE missions SET created_at = ? WHERE id = ?').run(Date.now() - 20 * 86400e3, m.id)
  const first = await get(s, '/timeline/weeks?limit=2', client)
  assert.equal(first.json.weeks.length, 2)
  assert.ok(first.json.next_before)
  const next = await get(s, `/timeline/weeks?limit=2&before=${first.json.next_before}`, client)
  assert.equal(next.status, 200)
  const tz = userTimeZone(s.db, alice.id)
  assert.equal(next.json.weeks[0].week, formatWeekKey(previousWeekStart(parseWeekKey(first.json.next_before, tz), tz), tz))
})
test('finished: limit must be an integer in 1..100 and before a cursor, else 400; before pages', async (t) => {
  const { s, alice, agent, client } = await fleet(t)
  for (const bad of ['0', '101', '-1', '2.5', 'x', '']) {
    assert.equal((await get(s, `/timeline/finished?limit=${bad}`, client)).status, 400, `limit=${bad}`)
  }
  for (const ok of ['1', '100']) assert.equal((await get(s, `/timeline/finished?limit=${ok}`, client)).status, 200, `limit=${ok}`)
  for (const bad of ['junk', '12', ':abc', '']) {
    assert.equal((await get(s, `/timeline/finished?before=${bad}`, client)).status, 400, `before=${bad}`)
  }
  const ids = []
  for (const [i, title] of ['A', 'B', 'C'].entries()) {
    const p = createProject(s.db, { userId: alice.id, deviceId: agent.deviceId, createdBy: 'agent', title }).project
    closeProject(s.db, { userId: alice.id, projectId: p.id, by: 'user', summary: 'x' })
    s.db.prepare('UPDATE projects SET closed_at = ? WHERE id = ?').run(1_000_000 + i, p.id)
    ids.push(p.id)
  }
  const page1 = await get(s, '/timeline/finished?limit=2', client)
  assert.deepEqual(page1.json.rows.map((r) => r.project.title), ['C', 'B'])
  assert.ok(page1.json.next_before)
  const page2 = await get(s, `/timeline/finished?limit=2&before=${encodeURIComponent(page1.json.next_before)}`, client)
  assert.deepEqual(page2.json.rows.map((r) => r.project.title), ['A'])
  assert.equal(page2.json.next_before, null)
})

test('an agent device does not see a private-origin project; the client does', async (t) => {
  const { s, alice, agent, priv, client } = await fleet(t)
  const hidden = createProject(s.db, { userId: alice.id, deviceId: priv.deviceId, createdBy: 'agent', title: 'Hidden', convoId: 'secret' }).project
  closeProject(s.db, { userId: alice.id, projectId: hidden.id, by: 'user', summary: 'x' })
  const open = createProject(s.db, { userId: alice.id, deviceId: agent.deviceId, createdBy: 'agent', title: 'Visible' }).project
  closeProject(s.db, { userId: alice.id, projectId: open.id, by: 'user', summary: 'x' })
  const titles = async (token) => (await get(s, '/timeline/finished', token)).json.rows.map((r) => r.project.title).sort()
  assert.deepEqual(await titles(client), ['Hidden', 'Visible'])
  assert.deepEqual(await titles(agent.token), ['Visible'])
})

test('non-GET methods and unknown timeline paths are not handled (404)', async (t) => {
  const { s, client } = await fleet(t)
  assert.equal((await s.http('/timeline/weeks', { method: 'POST', token: client, body: {} })).status, 404)
  assert.equal((await get(s, '/timeline/nope', client)).status, 404)
  assert.equal((await get(s, '/timeline/weeks/2026-11-09/extra', client)).status, 404)
})
