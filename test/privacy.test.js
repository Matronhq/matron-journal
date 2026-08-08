import { test } from 'node:test'
import assert from 'node:assert/strict'
import WebSocket from 'ws'
import { openDb, isPrivateDevice, pinDevicePrivate, unpinDevicePrivate, applyBridgePrivate } from '../src/db.js'
import { createUser, createAgent } from '../src/auth.js'
import { upsertConversation } from '../src/journal.js'
import { addAllowance } from '../src/allowances.js'
import { getParticipant, answerParkedInvite } from '../src/participants.js'
import { startTestServer, makeWsClient } from './helpers.js'

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

// Extends privacyFixture with live sockets for kit (ordinary) and ghost
// (private), and a room each manages.
async function chatPrivacyFixture() {
  const fx = await privacyFixture()
  const kitWs = await makeWsClient(fx.s.base, { token: fx.kit.token, cursor: 0 })
  await kitWs.waitFor((f) => f.op === 'hello_ok')
  const ghostWs = await makeWsClient(fx.s.base, { token: fx.ghost.token, cursor: 0 })
  await ghostWs.waitFor((f) => f.op === 'hello_ok')
  kitWs.send({ op: 'convo_upsert', convo_id: 'kit-room', title: 'Kit room', session_state: 'running' })
  ghostWs.send({ op: 'convo_upsert', convo_id: 'ghost-room', title: 'Ghost room', session_state: 'running' })
  await new Promise((r) => setTimeout(r, 100))
  return { ...fx, kitWs, ghostWs }
}

test('agent_invite: a private target answers not_found, byte-identical to an unknown id', async () => {
  const { s, kitWs, ghost } = await chatPrivacyFixture()
  kitWs.send({ op: 'agent_invite', room_id: 'kit-room', target_device_id: ghost.deviceId, justification: 'let me in' })
  const priv = await kitWs.waitFor((f) => f.op === 'error' && f.ref === 'agent_invite')
  kitWs.send({ op: 'agent_invite', room_id: 'kit-room', target_device_id: 999999, justification: 'let me in' })
  const unknown = await kitWs.waitFor((f) => f.op === 'error' && f.ref === 'agent_invite' && f !== priv)
  assert.equal(priv.code, 'not_found')
  const strip = ({ ...f }) => f
  assert.deepEqual(strip(priv), strip(unknown), 'frames identical — existence never confirmed')
  kitWs.close(); await s.close()
})

test('agent_join: a private-owned room answers not_found like a room that does not exist', async () => {
  const { s, kitWs } = await chatPrivacyFixture()
  kitWs.send({ op: 'agent_join', room_id: 'ghost-room', justification: 'curious' })
  const priv = await kitWs.waitFor((f) => f.op === 'error' && f.ref === 'agent_join')
  kitWs.send({ op: 'agent_join', room_id: 'no-such-room', justification: 'curious' })
  const unknown = await kitWs.waitFor((f) => f.op === 'error' && f.ref === 'agent_join' && f.room_id === 'no-such-room')
  assert.equal(priv.code, 'not_found')
  assert.equal(unknown.code, 'not_found')
  kitWs.close(); await s.close()
})

test('a private agent keeps full outbound capability: it can invite an ordinary agent', async () => {
  const { s, ghostWs, kit } = await chatPrivacyFixture()
  ghostWs.send({ op: 'agent_invite', room_id: 'ghost-room', target_device_id: kit.deviceId, justification: 'need your eyes' })
  const ack = await ghostWs.waitFor((f) => f.kind === 'invite' && f.event === 'delivered')
  assert.equal(ack.room_id, 'ghost-room')
  ghostWs.close(); await s.close()
})

test('a private agent can invite another private agent (the boundary is with ordinary agents)', async () => {
  const { s, ghostWs, wraith } = await chatPrivacyFixture()
  ghostWs.send({ op: 'agent_invite', room_id: 'ghost-room', target_device_id: wraith.deviceId, justification: 'ghost to wraith' })
  const ack = await ghostWs.waitFor((f) => (f.kind === 'invite' && f.event === 'delivered') || f.op === 'error')
  assert.equal(ack.event, 'delivered')
  ghostWs.close(); await s.close()
})

// Fix-round findings: the privacy gate must live in loadRoom itself, ahead
// of every other check any room op makes — otherwise a caller-controlled
// field (a blank justification, an accept flag, an unrelated arg) picks
// which of two DIFFERENT rejections comes back, and that difference alone
// confirms a private room exists. room_id necessarily differs between the
// "real private room" and "no such room" probes in every test below, so
// deepEqual compares the frames with room_id stripped.
const stripRoomId = ({ room_id, ...rest }) => rest

test('agent_join: a blank justification does not flip the answer — the room-privacy not_found wins before the justification check ever runs', async () => {
  const { s, kitWs } = await chatPrivacyFixture()
  kitWs.send({ op: 'agent_join', room_id: 'ghost-room', justification: '' })
  const priv = await kitWs.waitFor((f) => f.op === 'error' && f.ref === 'agent_join')
  kitWs.send({ op: 'agent_join', room_id: 'no-such-room', justification: '' })
  const unknown = await kitWs.waitFor((f) => f.op === 'error' && f.ref === 'agent_join' && f !== priv)
  assert.equal(priv.code, 'not_found')
  assert.equal(unknown.code, 'not_found')
  assert.deepEqual(stripRoomId(priv), stripRoomId(unknown), 'a malformed justification never distinguishes a private room from an unknown one')
  kitWs.close(); await s.close()
})

test('per-op existence oracle: agent_invite, agent_invite_answer, and agent_leave all answer a private-owned room exactly like an unknown one', async () => {
  const { s, kitWs, ghost } = await chatPrivacyFixture()
  const probe = async (frame) => {
    kitWs.send({ ...frame, room_id: 'ghost-room' })
    const priv = await kitWs.waitFor((f) => f.op === 'error' && f.ref === frame.op)
    kitWs.send({ ...frame, room_id: 'no-such-room' })
    const unknown = await kitWs.waitFor((f) => f.op === 'error' && f.ref === frame.op && f !== priv)
    assert.equal(priv.code, 'not_found', `${frame.op} on the private-owned room`)
    assert.equal(unknown.code, 'not_found', `${frame.op} on an unknown room`)
    assert.deepEqual(stripRoomId(priv), stripRoomId(unknown), `${frame.op} frames identical modulo room_id`)
  }
  await probe({ op: 'agent_invite', target_device_id: ghost.deviceId, justification: 'probe' })
  await probe({ op: 'agent_invite_answer', accept: true })
  await probe({ op: 'agent_leave' })
  kitWs.close(); await s.close()
})

test('agent_join: a private caller (wraith) passes the room-privacy gate on another private device (ghost)\'s room', async () => {
  const { s, wraith } = await chatPrivacyFixture()
  const wraithWs = await makeWsClient(s.base, { token: wraith.token, cursor: 0 })
  await wraithWs.waitFor((f) => f.op === 'hello_ok')
  wraithWs.send({ op: 'agent_join', room_id: 'ghost-room', justification: 'wraith joining ghost' })
  const ack = await wraithWs.waitFor((f) => (f.kind === 'invite' && f.event === 'delivered') || f.op === 'error')
  assert.notEqual(ack.code, 'not_found', 'a private caller is invisible, not blinded — the gate never fires for it')
  assert.equal(ack.event, 'delivered', 'normal park-for-consent flow runs, same as any other valid join request')
  wraithWs.close(); await s.close()
})

test('the drawn-in flow: once ghost invites kit and kit accepts, kit can answer and later leave — no step is rejected not_found', async () => {
  const { s, userId, ghost, kit, ghostWs, kitWs } = await chatPrivacyFixture()
  // Standing allowance bypasses the park-for-consent step so the invite
  // relays straight to kit's own socket and reaches 'invited' — this is
  // the real state machine's route to a drawn-in participant, not a DB
  // shortcut (see test/agent-chat-consent.test.js: "an allowed pair
  // bypasses the park entirely").
  addAllowance(s.db, { userId, fromDeviceId: ghost.deviceId, targetDeviceId: kit.deviceId })
  ghostWs.send({ op: 'agent_invite', room_id: 'ghost-room', target_device_id: kit.deviceId, justification: 'need your eyes' })
  const req = await kitWs.waitFor((f) => f.kind === 'invite' && f.event === 'request')
  assert.equal(req.room_id, 'ghost-room')
  // Pin the exemption's actual precondition (fix-round-2 finding): this
  // row must be delivered_at-set, not merely "any row exists" — that is
  // exactly what distinguishes it from the parked/denied rows the gate
  // must still block (see the isKnownParticipant test below).
  assert.ok(getParticipant(s.db, 'ghost-room', kit.deviceId).delivered_at != null, 'sanity: this is a delivered row, the case the gate must exempt')
  kitWs.send({ op: 'agent_invite_answer', room_id: 'ghost-room', accept: true })
  await ghostWs.waitFor((f) => f.kind === 'invite' && f.event === 'answer')
  kitWs.send({ op: 'agent_leave', room_id: 'ghost-room' })
  await ghostWs.waitFor((f) => f.kind === 'invite' && f.event === 'left')
  assert.equal(kitWs.frames.filter((f) => f.op === 'error').length, 0,
    'kit — drawn into ghost\'s private room by an accepted invite — never hit the room-privacy not_found gate')
  kitWs.close(); ghostWs.close(); await s.close()
})

test('agent_leave/agent_join: a merely parked (awaiting_user) or denied row does NOT exempt the gate — not_found byte-identical to an unknown room', async () => {
  const { s, kit, ghostWs, kitWs } = await chatPrivacyFixture()
  // No standing allowance: this invite parks for the user's consent
  // instead of ever reaching kit's socket (see appendAndFan's comment in
  // ws.js — a parked card is client-only, no agent device gets it).
  ghostWs.send({ op: 'agent_invite', room_id: 'ghost-room', target_device_id: kit.deviceId, justification: 'park me' })
  await ghostWs.waitFor((f) => f.kind === 'invite' && f.event === 'delivered')
  await new Promise((r) => setTimeout(r, 50))
  assert.ok(!kitWs.frames.some((f) => f.kind === 'invite' && f.event === 'request'), 'sanity: parked, never delivered to kit')
  assert.equal(getParticipant(s.db, 'ghost-room', kit.deviceId).state, 'awaiting_user')
  assert.equal(getParticipant(s.db, 'ghost-room', kit.deviceId).delivered_at, null)

  const stripRoomId = ({ room_id, ...rest }) => rest
  const probe = async (op, extra = {}) => {
    kitWs.send({ op, room_id: 'ghost-room', ...extra })
    const priv = await kitWs.waitFor((f) => f.op === 'error' && f.ref === op)
    kitWs.send({ op, room_id: 'no-such-room', ...extra })
    const unknown = await kitWs.waitFor((f) => f.op === 'error' && f.ref === op && f !== priv)
    assert.equal(priv.code, 'not_found', `${op} on the parked/denied private room`)
    assert.equal(unknown.code, 'not_found', `${op} on an unknown room`)
    assert.deepEqual(stripRoomId(priv), stripRoomId(unknown), `${op} frames identical modulo room_id`)
  }
  // awaiting_user: never delivered — probe/existence must still be hidden.
  await probe('agent_leave')
  await probe('agent_join', { justification: 'curious' })

  // Drive the same row to 'denied' (the user explicitly refused) and
  // confirm the gate still blocks — denied means the target was never told.
  assert.ok(answerParkedInvite(s.db, { convoId: 'ghost-room', agentDeviceId: kit.deviceId, approve: false }))
  assert.equal(getParticipant(s.db, 'ghost-room', kit.deviceId).state, 'denied')
  await probe('agent_leave')
  await probe('agent_join', { justification: 'curious again' })

  kitWs.close(); ghostWs.close(); await s.close()
})
