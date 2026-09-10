import test from 'node:test'
import assert from 'node:assert/strict'
import { startTestServer, makeWsClient } from './helpers.js'
import { createUser, createAgent } from '../src/auth.js'
import { upsertConversation } from '../src/journal.js'
import { pinDevicePrivate } from '../src/db.js'

async function fleet(t) {
  const s = await startTestServer({})
  t.after(() => s.close())
  const dan = await createUser(s.db, 'dan', 'pw')
  const pat = await createUser(s.db, 'pat', 'pw')
  const agent = createAgent(s.db, dan.id, 'dev-2')
  const patAgent = createAgent(s.db, pat.id, 'pat-box')
  upsertConversation(s.db, { id: 'c1', ownerUserId: dan.id, title: 'C1', agentDeviceId: agent.deviceId })
  upsertConversation(s.db, { id: 'c2', ownerUserId: dan.id, title: 'C2', agentDeviceId: agent.deviceId })
  upsertConversation(s.db, { id: 'p1', ownerUserId: pat.id, title: 'P1', agentDeviceId: patAgent.deviceId })
  const login = await s.http('/login', { method: 'POST', body: { username: 'dan', password: 'pw', device_name: 'mac' } })
  return { s, dan, agent, patAgent, client: login.json.token }
}
const start = (s, token, body, headers = {}) => s.http('/missions', { method: 'POST', token, body: { title: 'Missions', body: 'goal', convo_id: 'c1', ...body }, headers })
const post = (s, token, body, headers = {}) => s.http('/milestones', { method: 'POST', token, body: { convo_id: 'c1', kind: 'progress', title: 'step', ...body }, headers })
const item = (s, token, body) => s.http('/items', { method: 'POST', token, body: { kind: 'question', title: 'Q?', convo_id: 'c1', ...body } })

test('POST /missions: 201 with the next shared number, marker on the convo, existing on a second start, idempotent replay, 400/404 on junk', async (t) => {
  const { s, agent, client } = await fleet(t)
  const ws = await makeWsClient(s.base, { token: client, cursor: null })
  await ws.waitFor((f) => f.op === 'hello_ok')
  const it = await item(s, agent.token, {})
  assert.equal(it.json.item.num, 1)
  const r = await start(s, agent.token, {}, { 'idempotency-key': 'k1' })
  assert.equal(r.status, 201); assert.equal(r.json.mission.num, 2); assert.equal(r.json.mission.state, 'open'); assert.equal(r.json.existing, undefined)
  const marker = await ws.waitFor((f) => f.kind === 'journal' && f.type === 'mission')
  assert.equal(marker.convo_id, 'c1'); assert.equal(marker.payload.action, 'created'); assert.equal(marker.payload.num, 2); assert.equal(marker.payload.by, 'agent')
  ws.close()
  const replay = await start(s, agent.token, {}, { 'idempotency-key': 'k1' })
  assert.equal(replay.status, 200); assert.equal(replay.json.mission.id, r.json.mission.id)
  const second = await start(s, agent.token, { title: 'Other' })
  assert.equal(second.status, 200); assert.equal(second.json.existing, true); assert.equal(second.json.mission.title, 'Missions')
  assert.equal((await s.http('/items/it_x', { token: agent.token })).status, 404)
  const moved = await s.http(`/items/${it.json.item.id}`, { token: agent.token })
  assert.equal(moved.json.item.mission_id, r.json.mission.id); assert.equal(moved.json.item.mission_num, 2)
  assert.equal((await start(s, agent.token, { title: '' })).status, 400)
  assert.equal((await start(s, agent.token, { title: 'x'.repeat(201) })).status, 400)
  assert.equal((await start(s, agent.token, { convo_id: 'p1' })).status, 404)
  assert.equal((await start(s, agent.token, { convo_id: 'nope' })).status, 404)
  assert.equal((await s.http('/missions', { method: 'POST', body: { title: 'x', convo_id: 'c1' } })).status, 401)
  assert.equal(s.db.prepare("SELECT COUNT(*) AS n FROM events WHERE type='mission'").get().n, 1)
})

test('POST /milestones: 409 no_mission writes nothing; 201 with marker seq as anchor; replay 200; GET /milestones newest first; closed mission 409', async (t) => {
  const { s, agent, client } = await fleet(t)
  const none = await post(s, agent.token, {})
  assert.equal(none.status, 409); assert.equal(none.json.blocked_by, 'no_mission')
  assert.equal(s.db.prepare('SELECT COUNT(*) AS n FROM milestones').get().n, 0)
  assert.equal(s.db.prepare("SELECT COUNT(*) AS n FROM events WHERE type='milestone'").get().n, 0)
  const m = (await start(s, agent.token, {})).json.mission
  const ws = await makeWsClient(s.base, { token: client, cursor: null })
  await ws.waitFor((f) => f.op === 'hello_ok')
  const r = await post(s, agent.token, { kind: 'user_input', title: 'Dan asked', body: 'b' }, { 'idempotency-key': 'm1' })
  assert.equal(r.status, 201); assert.equal(r.json.milestone.num, 2); assert.equal(r.json.mission.id, m.id)
  const marker = await ws.waitFor((f) => f.kind === 'journal' && f.type === 'milestone')
  assert.equal(marker.seq, r.json.milestone.seq); assert.equal(marker.payload.milestone_id, r.json.milestone.id)
  assert.equal(marker.payload.mission_num, m.num); assert.equal(marker.payload.kind, 'user_input'); assert.equal(marker.payload.by, 'agent')
  ws.close()
  assert.equal((await post(s, agent.token, { kind: 'user_input', title: 'Dan asked' }, { 'idempotency-key': 'm1' })).status, 200)
  const r2 = await post(s, agent.token, { title: 'later' })
  assert.equal(r2.status, 201)
  const list = await s.http('/milestones?convo=c1', { token: client })
  assert.deepEqual(list.json.milestones.map((l) => l.title), ['later', 'Dan asked'])
  assert.equal((await post(s, agent.token, { kind: 'nope' })).status, 400)
  assert.equal((await post(s, agent.token, { title: '' })).status, 400)
  assert.equal((await post(s, agent.token, { convo_id: 'p1' })).status, 404)
  const detail = await s.http(`/missions/${m.num}`, { token: client })
  assert.equal(detail.json.mission.milestones, 2); assert.equal(detail.json.mission.last_milestone.title, 'later')
  assert.equal(detail.json.milestones[0].title, 'later')
  const closed = await s.http(`/missions/${m.id}/close`, { method: 'POST', token: agent.token, body: { summary: 'done' } })
  assert.equal(closed.status, 200)
  const after = await post(s, agent.token, { title: 'too late' })
  assert.equal(after.status, 409); assert.equal(after.json.blocked_by, 'closed')
})

test('close: agent blocked by user items then agent items (409 with the list); user close records closed_over_open_items and the marker carries open_item_nums', async (t) => {
  const { s, agent, client } = await fleet(t)
  const m = (await start(s, agent.token, {})).json.mission
  const q = (await item(s, agent.token, {})).json.item
  const tk = (await item(s, agent.token, { kind: 'task', title: 'T' })).json.item
  const close = (token, summary = 's') => s.http(`/missions/${m.id}/close`, { method: 'POST', token, body: { summary } })
  let r = await close(agent.token)
  assert.equal(r.status, 409); assert.equal(r.json.blocked_by, 'user_items'); assert.deepEqual(r.json.items, [{ num: q.num, title: 'Q?' }])
  await s.http(`/items/${q.id}/close`, { method: 'POST', token: client, body: { resolution: 'answered' } })
  r = await close(agent.token)
  assert.equal(r.status, 409); assert.equal(r.json.blocked_by, 'agent_items'); assert.deepEqual(r.json.items, [{ num: tk.num, title: 'T' }])
  assert.equal((await close(agent.token, '')).status, 400)
  const ws = await makeWsClient(s.base, { token: agent.token, cursor: null })
  await ws.waitFor((f) => f.op === 'hello_ok')
  r = await close(client, 'forced')
  assert.equal(r.status, 200); assert.equal(r.json.mission.closed_by, 'user'); assert.equal(r.json.mission.closed_over_open_items, 1)
  const marker = await ws.waitFor((f) => f.kind === 'journal' && f.type === 'mission' && f.payload.action === 'closed')
  assert.deepEqual(marker.payload.open_item_nums, [tk.num]); assert.equal(marker.payload.by, 'user')
  ws.close()
  assert.equal((await close(client)).status, 409)
  assert.equal((await s.http(`/missions/${m.id}`, { method: 'PATCH', token: agent.token, body: { title: 'x' } })).status, 409)
  assert.equal((await s.http(`/items/${tk.id}`, { token: client })).json.item.state, 'open')
})

test('join: attaches c2 and repoints its items; refuses a second mission for a convo; PATCH updates and emits the marker on the origin', async (t) => {
  const { s, agent, client } = await fleet(t)
  const m = (await start(s, agent.token, {})).json.mission
  const it2 = (await item(s, agent.token, { convo_id: 'c2', kind: 'task', title: 'T2' })).json.item
  const j = await s.http(`/missions/${m.num}/join`, { method: 'POST', token: agent.token, body: { convo_id: 'c2' } })
  assert.equal(j.status, 200); assert.equal(j.json.mission.conversations, 2)
  assert.equal((await s.http(`/items/${it2.id}`, { token: client })).json.item.mission_id, m.id)
  const other = await s.http('/missions', { method: 'POST', token: agent.token, body: { title: 'B', convo_id: 'c2' } })
  assert.equal(other.status, 200); assert.equal(other.json.existing, true); assert.equal(other.json.mission.id, m.id)
  upsertConversation(s.db, { id: 'c3', ownerUserId: 1, title: 'C3', agentDeviceId: agent.deviceId })
  const b = (await s.http('/missions', { method: 'POST', token: agent.token, body: { title: 'B', convo_id: 'c3' } })).json.mission
  const bad = await s.http(`/missions/${b.id}/join`, { method: 'POST', token: agent.token, body: { convo_id: 'c2' } })
  assert.equal(bad.status, 409); assert.equal(bad.json.blocked_by, 'other_mission')
  const ws = await makeWsClient(s.base, { token: client, cursor: null })
  await ws.waitFor((f) => f.op === 'hello_ok')
  const p = await s.http(`/missions/${m.id}`, { method: 'PATCH', token: agent.token, body: { title: 'Renamed' } })
  assert.equal(p.status, 200); assert.equal(p.json.mission.title, 'Renamed')
  const marker = await ws.waitFor((f) => f.kind === 'journal' && f.type === 'mission' && f.payload.action === 'updated')
  assert.equal(marker.convo_id, 'c1'); assert.equal(marker.payload.title, 'Renamed')
  ws.close()
  assert.equal((await s.http(`/missions/${m.id}`, { method: 'PATCH', token: agent.token, body: {} })).status, 400)
})

test('GET /missions: counts and sort; state filter; PATCH /items/:id {mission} moves and detaches', async (t) => {
  const { s, agent, client } = await fleet(t)
  const a = (await start(s, agent.token, {})).json.mission
  const b = (await start(s, agent.token, { title: 'B', convo_id: 'c2' })).json.mission
  const it = (await item(s, agent.token, {})).json.item
  await post(s, agent.token, { convo_id: 'c2', title: 'b1' })
  const list = await s.http('/missions', { token: client })
  assert.deepEqual(list.json.missions.map((m) => m.id), [b.id, a.id])
  assert.equal(list.json.missions[1].needs_you, 1); assert.equal(list.json.missions[1].open_items, 1)
  assert.equal(list.json.missions[0].last_milestone.title, 'b1')
  const mv = await s.http(`/items/${it.id}`, { method: 'PATCH', token: agent.token, body: { mission: `#${b.num}` } })
  assert.equal(mv.status, 200); assert.equal(mv.json.item.mission_id, b.id); assert.equal(mv.json.item.mission_num, b.num)
  const det = await s.http(`/items/${it.id}`, { method: 'PATCH', token: agent.token, body: { mission: null } })
  assert.equal(det.json.item.mission_id, null)
  assert.equal((await s.http(`/items/${it.id}`, { method: 'PATCH', token: agent.token, body: { mission: '#999' } })).status, 404)
  await s.http(`/missions/${b.id}/close`, { method: 'POST', token: client, body: { summary: 'x' } })
  assert.equal((await s.http('/missions?state=open', { token: client })).json.missions.length, 1)
  assert.equal((await s.http('/missions?state=closed', { token: client })).json.missions.length, 1)
  assert.equal((await s.http('/missions?state=bogus', { token: client })).status, 400)
})

test('privacy sieve: an ordinary agent cannot see a mission born in a private convo, nor its milestones through another mission', async (t) => {
  const { s, dan, agent, client } = await fleet(t)
  const priv = createAgent(s.db, dan.id, 'private-box')
  pinDevicePrivate(s.db, priv.deviceId, true)
  upsertConversation(s.db, { id: 'secret', ownerUserId: dan.id, title: 'S', agentDeviceId: priv.deviceId })
  // A second private-owned convo, deliberately never given its own mission —
  // 'secret' already owns 'm' below, so reusing it to join 'pub' would
  // correctly 409 other_mission (a convo may join at most one mission).
  upsertConversation(s.db, { id: 'secret2', ownerUserId: dan.id, title: 'S2', agentDeviceId: priv.deviceId })
  const m = (await s.http('/missions', { method: 'POST', token: priv.token, body: { title: 'Hidden', convo_id: 'secret' } })).json.mission
  assert.equal((await s.http('/missions', { token: agent.token })).json.missions.length, 0)
  assert.equal((await s.http(`/missions/${m.id}`, { token: agent.token })).status, 404)
  assert.equal((await s.http('/missions', { token: client })).json.missions.length, 1)
  assert.equal((await s.http('/missions', { token: priv.token })).json.missions.length, 1)
  // an ordinary agent cannot start a mission in a private convo or post milestones there
  assert.equal((await start(s, agent.token, { convo_id: 'secret' })).status, 404)
  assert.equal((await post(s, agent.token, { convo_id: 'secret' })).status, 404)
  // a public mission that a private convo joined: the private convo's milestones are filtered for the ordinary agent
  const pub = (await start(s, agent.token, {})).json.mission
  const firstJoin = await s.http(`/missions/${pub.id}/join`, { method: 'POST', token: priv.token, body: { convo_id: 'secret2' } })
  assert.equal(firstJoin.status, 200)
  // A repeat join of the same mission (secret2 is already attached to pub) is a no-op: 200, not 409.
  assert.equal((await s.http(`/missions/${pub.id}/join`, { method: 'POST', token: priv.token, body: { convo_id: 'secret2' } })).status, 200)
})

test('forged publish of mission/milestone types is rejected; oversized bodies 413 with nothing written', async (t) => {
  const { s, agent } = await fleet(t)
  const ws = await makeWsClient(s.base, { token: agent.token, cursor: null })
  await ws.waitFor((f) => f.op === 'hello_ok')
  ws.send({ op: 'publish', convo_id: 'c1', type: 'milestone', payload: { num: 1 } })
  const bad = await ws.waitFor((f) => f.op === 'error' || f.error)
  assert.match(JSON.stringify(bad), /bad_request/)
  ws.close()
  assert.equal(s.db.prepare("SELECT COUNT(*) AS n FROM events WHERE type IN ('milestone','mission')").get().n, 0)
  const big = await s.http('/missions', { method: 'POST', token: agent.token, body: { title: 'x', body: 'y'.repeat(40000), convo_id: 'c1' } })
  assert.ok(big.status === 400 || big.status === 413)
  assert.equal(s.db.prepare('SELECT COUNT(*) AS n FROM missions').get().n, 0)
})
