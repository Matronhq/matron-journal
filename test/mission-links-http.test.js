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
