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
  for (const id of ['c1', 'c2', 'c3']) upsertConversation(s.db, { id, ownerUserId: dan.id, title: id.toUpperCase(), agentDeviceId: agent.deviceId })
  upsertConversation(s.db, { id: 'p1', ownerUserId: pat.id, title: 'P1', agentDeviceId: patAgent.deviceId })
  const login = await s.http('/login', { method: 'POST', body: { username: 'dan', password: 'pw', device_name: 'mac' } })
  return { s, dan, pat, agent, patAgent, client: login.json.token }
}
const start = (s, token, body) => s.http('/missions', { method: 'POST', token, body: { title: 'A', convo_id: 'c1', ...body } })
const join = (s, token, missionId, convoId) => s.http(`/missions/${missionId}/join`, { method: 'POST', token, body: { convo_id: convoId } })
const markerCount = (s, convoId, action) => s.db.prepare(
  "SELECT COUNT(*) AS n FROM events WHERE convo_id=? AND type='mission' AND json_extract(payload,'$.action')=?").get(convoId, action).n

test('POST /missions/:id/join: a conversation on another mission now joins (200, was 409 other_mission), becomes current, and the marker says which', async (t) => {
  const { s, agent, client } = await fleet(t)
  const a = (await start(s, agent.token, {})).json.mission
  const b = (await start(s, agent.token, { title: 'B', convo_id: 'c2' })).json.mission
  const ws = await makeWsClient(s.base, { token: client, cursor: null })
  await ws.waitFor((f) => f.op === 'hello_ok')
  const j = await join(s, agent.token, b.id, 'c1')
  assert.equal(j.status, 200); assert.equal(j.json.mission.id, b.id)
  const joined = await ws.waitFor((f) => f.kind === 'journal' && f.type === 'mission' && f.convo_id === 'c1' && f.payload.action === 'joined')
  assert.equal(joined.payload.num, b.num)
  assert.equal((await join(s, agent.token, a.id, 'c1')).status, 200)
  const moved = await ws.waitFor((f) => f.kind === 'journal' && f.type === 'mission' && f.convo_id === 'c1' && f.payload.action === 'current_changed')
  assert.equal(moved.payload.num, a.num)
  ws.close()
  // Re-joining the current mission: 200, no new marker.
  assert.equal((await join(s, agent.token, a.id, 'c1')).status, 200)
  assert.equal(markerCount(s, 'c1', 'current_changed'), 1)
  assert.equal(markerCount(s, 'c1', 'joined'), 1)
})

test('POST /missions/:id/leave: ends the link, moves current, writes left + current_changed; repeat is a 200 no-op; no link, foreign or unknown convo is 404', async (t) => {
  const { s, agent, client } = await fleet(t)
  const a = (await start(s, agent.token, {})).json.mission
  const b = (await start(s, agent.token, { title: 'B', convo_id: 'c2' })).json.mission
  await join(s, agent.token, b.id, 'c1')
  const leave = (missionId, convoId, token = agent.token) => s.http(`/missions/${missionId}/leave`, { method: 'POST', token, body: { convo_id: convoId } })
  const ws = await makeWsClient(s.base, { token: client, cursor: null })
  await ws.waitFor((f) => f.op === 'hello_ok')
  const r = await leave(b.id, 'c1')
  assert.equal(r.status, 200)
  assert.equal(r.json.mission.id, b.id); assert.equal(r.json.current_mission.id, a.id)
  const left = await ws.waitFor((f) => f.kind === 'journal' && f.type === 'mission' && f.convo_id === 'c1' && f.payload.action === 'left')
  assert.equal(left.payload.num, b.num)
  const moved = await ws.waitFor((f) => f.kind === 'journal' && f.type === 'mission' && f.convo_id === 'c1' && f.payload.action === 'current_changed')
  assert.equal(moved.payload.num, a.num)
  ws.close()
  const again = await leave(b.id, 'c1')
  assert.equal(again.status, 200); assert.equal(markerCount(s, 'c1', 'left'), 1)
  assert.equal((await leave(b.id, 'c3')).status, 404, 'no link')
  assert.equal((await leave(b.id, 'p1')).status, 404, 'another user\'s conversation')
  assert.equal((await leave(b.id, 'nope')).status, 404)
  // Leaving the last one: current_mission null, and no current_changed marker.
  const last = await leave(a.id, 'c1')
  assert.equal(last.status, 200); assert.equal(last.json.current_mission, null)
  assert.equal(markerCount(s, 'c1', 'current_changed'), 1)
})
