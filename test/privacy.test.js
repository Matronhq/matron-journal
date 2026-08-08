import { test } from 'node:test'
import assert from 'node:assert/strict'
import WebSocket from 'ws'
import { openDb, isPrivateDevice, pinDevicePrivate, unpinDevicePrivate, applyBridgePrivate } from '../src/db.js'
import { createUser, createAgent } from '../src/auth.js'
import { upsertConversation } from '../src/journal.js'
import { startTestServer } from './helpers.js'

async function dbWithAgent() {
  const db = openDb(':memory:')
  const u = await createUser(db, 'dan', 'pw')
  const a = createAgent(db, u.id, 'kit')
  return { db, userId: u.id, deviceId: a.deviceId, token: a.token }
}

test('privacy flag: defaults to 0 and unpinned for every device', async () => {
  const { db, deviceId } = await dbWithAgent()
  assert.equal(isPrivateDevice(db, deviceId), false)
  const row = db.prepare('SELECT private, private_pinned FROM devices WHERE id=?').get(deviceId)
  assert.deepEqual(row, { private: 0, private_pinned: 0 })
  db.close()
})

test('privacy flag: bridge assertion applies only while unpinned', async () => {
  const { db, deviceId } = await dbWithAgent()
  applyBridgePrivate(db, deviceId, true)
  assert.equal(isPrivateDevice(db, deviceId), true)
  applyBridgePrivate(db, deviceId, false)
  assert.equal(isPrivateDevice(db, deviceId), false)
  pinDevicePrivate(db, deviceId, true)
  applyBridgePrivate(db, deviceId, false) // the forgot-the-env-var deploy
  assert.equal(isPrivateDevice(db, deviceId), true, 'admin pin survives a contrary hello')
  unpinDevicePrivate(db, deviceId)
  assert.equal(isPrivateDevice(db, deviceId), true, 'unpinning alone changes no value')
  applyBridgePrivate(db, deviceId, false)
  assert.equal(isPrivateDevice(db, deviceId), false, 'after unpin the bridge assertion applies again')
  db.close()
})

test('privacy flag: pin off is also pinned — admin can force-visible', async () => {
  const { db, deviceId } = await dbWithAgent()
  pinDevicePrivate(db, deviceId, false)
  applyBridgePrivate(db, deviceId, true)
  assert.equal(isPrivateDevice(db, deviceId), false)
  db.close()
})

test('privacy flag: isPrivateDevice on an unknown/deleted id is false, never a throw', async () => {
  const { db } = await dbWithAgent()
  assert.equal(isPrivateDevice(db, 99999), false)
  db.close()
})

async function serverWithAgent() {
  const s = await startTestServer()
  await createUser(s.db, 'dan', 'password-123')
  const login = await s.http('/login', { method: 'POST', body: { username: 'dan', password: 'password-123' } })
  const userId = login.json.user_id
  const clientToken = login.json.token
  const agent = createAgent(s.db, userId, 'kit')
  return { s, userId, clientToken, agent }
}

// hello with an explicit private field needs a raw client — makeWsClient's
// hello only sends token+cursor, so drive the frame by hand.
function helloRaw(base, frame) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(base.replace('http', 'ws') + '/ws')
    const frames = []
    ws.on('message', (d) => frames.push(JSON.parse(d)))
    ws.on('error', reject)
    ws.on('close', () => resolve({ frames, closed: true }))
    ws.on('open', () => {
      ws.send(JSON.stringify(frame))
      setTimeout(() => { if (ws.readyState === 1) resolve({ frames, closed: false, ws }) }, 150)
    })
  })
}

test('hello: an agent asserting private:true is marked private before registration', async () => {
  const { s, agent } = await serverWithAgent()
  const r = await helloRaw(s.base, { op: 'hello', token: agent.token, private: true })
  assert.ok(r.frames.some((f) => f.op === 'hello_ok'))
  assert.equal(s.db.prepare('SELECT private FROM devices WHERE id=?').get(agent.deviceId).private, 1)
  r.ws?.close()
  await s.close()
})

test('hello: omitting the field asserts visible — bridge-set privacy does not survive a re-register', async () => {
  const { s, agent } = await serverWithAgent()
  const r1 = await helloRaw(s.base, { op: 'hello', token: agent.token, private: true })
  r1.ws?.close()
  const r2 = await helloRaw(s.base, { op: 'hello', token: agent.token })
  assert.equal(s.db.prepare('SELECT private FROM devices WHERE id=?').get(agent.deviceId).private, 0)
  r2.ws?.close()
  await s.close()
})

test('hello: an admin-pinned flag survives a contrary hello', async () => {
  const { s, agent } = await serverWithAgent()
  pinDevicePrivate(s.db, agent.deviceId, true)
  const r = await helloRaw(s.base, { op: 'hello', token: agent.token })
  assert.ok(r.frames.some((f) => f.op === 'hello_ok'))
  assert.equal(s.db.prepare('SELECT private FROM devices WHERE id=?').get(agent.deviceId).private, 1)
  r.ws?.close()
  await s.close()
})

test('hello: a client sending private is ignored; a non-boolean is rejected', async () => {
  const { s, clientToken } = await serverWithAgent()
  const ok = await helloRaw(s.base, { op: 'hello', token: clientToken, private: true })
  assert.ok(ok.frames.some((f) => f.op === 'hello_ok'), 'client hello unaffected')
  ok.ws?.close()
  const bad = await helloRaw(s.base, { op: 'hello', token: clientToken, private: 'yes' })
  assert.ok(bad.frames.some((f) => f.op === 'error' && f.code === 'bad_request' && f.ref === 'hello'))
  await s.close()
})

// Fixture: dan with a client, an ordinary agent (kit), and two private
// agents (ghost, wraith). ghost manages a conversation.
async function privacyFixture() {
  const s = await startTestServer()
  await createUser(s.db, 'dan', 'password-123')
  const login = await s.http('/login', { method: 'POST', body: { username: 'dan', password: 'password-123' } })
  const userId = login.json.user_id
  const clientToken = login.json.token
  const kit = createAgent(s.db, userId, 'kit')
  const ghost = createAgent(s.db, userId, 'ghost')
  const wraith = createAgent(s.db, userId, 'wraith')
  pinDevicePrivate(s.db, ghost.deviceId, true)
  pinDevicePrivate(s.db, wraith.deviceId, true)
  upsertConversation(s.db, { id: 'open-work', ownerUserId: userId, title: 'Open work', sessionState: 'running', agentDeviceId: kit.deviceId })
  upsertConversation(s.db, { id: 'ghost-work', ownerUserId: userId, title: 'Ghost work', sessionState: 'running', agentDeviceId: ghost.deviceId })
  upsertConversation(s.db, { id: 'legacy', ownerUserId: userId, title: 'Legacy', sessionState: 'done' }) // agent_device_id NULL
  return { s, userId, clientToken, kit, ghost, wraith }
}

test('roster: an ordinary agent cannot see private devices or their conversations', async () => {
  const { s, kit, ghost } = await privacyFixture()
  const r = await s.http('/roster', { token: kit.token })
  assert.equal(r.status, 200)
  const ids = r.json.agents.map((a) => a.device_id)
  assert.ok(ids.includes(kit.deviceId))
  assert.ok(!ids.includes(ghost.deviceId), 'private device absent')
  const convos = r.json.conversations.map((c) => c.id)
  assert.ok(convos.includes('open-work'))
  assert.ok(convos.includes('legacy'), 'NULL-owner conversations stay visible')
  assert.ok(!convos.includes('ghost-work'), 'private-owned conversation absent — the summaries are the point')
  await s.close()
})

test('roster: a client sees everything, unchanged', async () => {
  const { s, clientToken, ghost } = await privacyFixture()
  const r = await s.http('/roster', { token: clientToken })
  assert.ok(r.json.agents.some((a) => a.device_id === ghost.deviceId))
  assert.ok(r.json.conversations.some((c) => c.id === 'ghost-work'))
  await s.close()
})

test('roster: a private agent sees the whole roster — including another private agent', async () => {
  const { s, ghost, wraith } = await privacyFixture()
  const r = await s.http('/roster', { token: ghost.token })
  assert.ok(r.json.agents.some((a) => a.device_id === wraith.deviceId), 'two private agents see each other')
  assert.ok(r.json.conversations.some((c) => c.id === 'ghost-work'))
  await s.close()
})

test('roster: privacy is per-user — another user roster is unaffected either way', async () => {
  const { s, ghost } = await privacyFixture()
  await createUser(s.db, 'eve', 'password-123')
  const eve = (await s.http('/login', { method: 'POST', body: { username: 'eve', password: 'password-123' } })).json
  const eveAgent = createAgent(s.db, eve.user_id, 'evebot')
  const r = await s.http('/roster', { token: eveAgent.token })
  // dan's devices — private or not — were never visible to eve's agents and stay that way
  assert.ok(!r.json.agents.some((a) => a.device_id === ghost.deviceId))
  assert.deepEqual(r.json.conversations, [])
  await s.close()
})
