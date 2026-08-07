import test from 'node:test'
import assert from 'node:assert/strict'
import { startTestServer, makeWsClient } from './helpers.js'
import { createUser, createAgent } from '../src/auth.js'
import { getParticipant } from '../src/participants.js'
import { addAllowance } from '../src/allowances.js'

// Harness pattern copied from the top of test/invites.test.js: one user, one
// client device, one agent device — both connected, both hello_ok'd, and a
// room the agent owns (so the recorded owner IS the device the card must be
// hidden from — the worst case a naive fan-out would deliver to first, not
// just some other agent).
async function fleet(t) {
  const s = await startTestServer()
  t.after(() => s.close())
  const dan = await createUser(s.db, 'dan', 'pw')
  const agentDev = createAgent(s.db, dan.id, 'bridge')
  const login = await s.http('/login', { method: 'POST', body: { username: 'dan', password: 'pw', device_name: 'mac' } })
  const clientToken = login.json.token
  const agent = await makeWsClient(s.base, { token: agentDev.token, cursor: null })
  const client = await makeWsClient(s.base, { token: clientToken, cursor: null })
  await agent.waitFor((f) => f.op === 'hello_ok')
  await client.waitFor((f) => f.op === 'hello_ok')
  t.after(() => { agent.close(); client.close() })
  agent.send({ op: 'convo_upsert', convo_id: 'room', title: 'room', session_state: 'running' })
  await agent.waitFor((f) => f.kind === 'journal' && f.type === 'session_status')
  await client.waitFor((f) => f.kind === 'journal' && f.type === 'session_status')
  // Drain the session_status frames both sides just got — everything after
  // this point in a test is signal, not setup noise.
  agent.frames.length = 0
  client.frames.length = 0
  return { s, dan, agentDev, clientToken, agent, client }
}

// A second fleet shape for Task 7's room-op tests: TWO agent devices (a room
// owner and an invite/join counterpart) plus a client, mirroring
// test/invites.test.js's `fleet` but with the client connection this file's
// scenarios need to observe the consent card. `agA` owns 'room'; `agB` is
// the invite target / join requester, depending on the test. `name` lets one
// test give `agA` an attacker-shaped device name to prove the card sanitises
// from_name too.
async function roomFleet(t, { ownerName = 'dev-a' } = {}) {
  const s = await startTestServer()
  t.after(() => s.close())
  const dan = await createUser(s.db, 'dan', 'pw')
  const agA = createAgent(s.db, dan.id, ownerName)
  const agB = createAgent(s.db, dan.id, 'dev-b')
  const login = await s.http('/login', { method: 'POST', body: { username: 'dan', password: 'pw', device_name: 'mac' } })
  const clientToken = login.json.token
  const a = await makeWsClient(s.base, { token: agA.token, cursor: null })
  const b = await makeWsClient(s.base, { token: agB.token, cursor: null })
  const client = await makeWsClient(s.base, { token: clientToken, cursor: null })
  await a.waitFor((f) => f.op === 'hello_ok')
  await b.waitFor((f) => f.op === 'hello_ok')
  await client.waitFor((f) => f.op === 'hello_ok')
  t.after(() => { a.close(); b.close(); client.close() })
  a.send({ op: 'convo_upsert', convo_id: 'room', title: 'room', session_state: 'running' })
  await a.waitFor((f) => f.kind === 'journal' && f.type === 'session_status')
  await client.waitFor((f) => f.kind === 'journal' && f.type === 'session_status')
  a.frames.length = 0
  b.frames.length = 0
  client.frames.length = 0
  return { s, dan, agA, agB, clientToken, a, b, client }
}

const isCard = (f) => f.kind === 'journal' && f.type === 'permission_request' && f.payload?.kind === 'agent_chat'

// Publishes the card via the existing generic `publish` op — permission_request
// is already in ws.js's AGENT_PUBLISH_TYPES, so this drives a real trip through
// appendAndFan/fanOut (the exact choke point Task 7's dedicated op will also
// use), not a simulation of one.
function publishCard(agent) {
  agent.send({ op: 'publish', convo_id: 'room', type: 'permission_request', payload: { kind: 'agent_chat', justification: 'SECRET' } })
}

test('client-only agent-chat card: live fan-out reaches the client, never the owning agent', async (t) => {
  const { agent, client } = await fleet(t)
  // The publishing agent is also the room's recorded owner — exactly the
  // device broadcastJournal's default targets (owner + joined participants)
  // would otherwise deliver to first.
  publishCard(agent)
  const seen = await client.waitFor(isCard)
  assert.equal(seen.payload.justification, 'SECRET')

  // The live frame is delivered synchronously inside the same handleOp call
  // that delivers the client's copy, so there's no real race to wait out —
  // this is just a courtesy beat before asserting the negative.
  await new Promise((r) => setTimeout(r, 50))
  assert.ok(!agent.frames.some(isCard), 'the agent that manages the room must not see the card live')
  assert.ok(!JSON.stringify(agent.frames).includes('SECRET'), 'no trace of the justification text reached the agent live')
})

test('client-only agent-chat card: hello replay from cursor 0 excludes it for the agent, includes it for the client', async (t) => {
  const { s, agentDev, clientToken, agent, client } = await fleet(t)
  publishCard(agent)
  await client.waitFor(isCard)
  // A benign follow-up event both devices are entitled to, appended after
  // the card — once it shows up in a fresh replay, the card (an earlier
  // seq) is guaranteed to have already been processed by that same replay
  // loop, since eventsAfter delivers in seq order and each batch is sent
  // synchronously before the next is fetched.
  client.send({ op: 'send', convo_id: 'room', type: 'text', payload: { body: 'marker' } })
  await agent.waitFor((f) => f.kind === 'journal' && f.type === 'text' && f.payload?.body === 'marker')

  const agentReplay = await makeWsClient(s.base, { token: agentDev.token, cursor: 0 })
  const clientReplay = await makeWsClient(s.base, { token: clientToken, cursor: 0 })
  t.after(() => { agentReplay.close(); clientReplay.close() })
  await agentReplay.waitFor((f) => f.kind === 'journal' && f.type === 'text' && f.payload?.body === 'marker')
  await clientReplay.waitFor((f) => f.kind === 'journal' && f.type === 'text' && f.payload?.body === 'marker')

  assert.ok(!agentReplay.journal().some(isCard), 'the agent must not receive the card as replayed history')
  assert.ok(clientReplay.journal().some(isCard), 'the client must still receive the card as replayed history')
  assert.ok(!JSON.stringify(agentReplay.frames).includes('SECRET'), 'no trace of the justification text reached the agent via replay')
})

test('client-only agent-chat card: HTTP GET /convo/:id/messages omits it for the agent, includes it for the client', async (t) => {
  const { s, agentDev, clientToken, agent, client } = await fleet(t)
  publishCard(agent)
  await client.waitFor(isCard)

  const asAgent = await s.http('/convo/room/messages', { token: agentDev.token })
  const asClient = await s.http('/convo/room/messages', { token: clientToken })
  assert.equal(asAgent.status, 200)
  assert.equal(asClient.status, 200)
  assert.ok(!asAgent.json.events.some((e) => e.type === 'permission_request' && e.payload?.kind === 'agent_chat'),
    'the agent-token page must not include the card')
  assert.ok(asClient.json.events.some((e) => e.type === 'permission_request' && e.payload?.kind === 'agent_chat'),
    'the client-token page must include the card')
  assert.ok(!JSON.stringify(asAgent.json).includes('SECRET'), 'no trace of the justification text reached the agent via HTTP')
})

// --- Task 7: agent_invite/agent_join park for user consent -----------------

test('agent_invite parks: the target hears nothing, the requester gets the same delivered ack, and the client sees a permission_request card', async (t) => {
  const { agA, agB, client, a, b } = await roomFleet(t)
  a.send({ op: 'agent_invite', room_id: 'room', target_device_id: agB.deviceId, topic: 'ci', justification: 'need your logs' })

  const ack = await a.waitFor((f) => f.kind === 'invite' && f.event === 'delivered' && f.target_device_id === agB.deviceId)
  assert.ok(ack, 'the requester gets the bridge-compat delivered ack even though nothing was relayed')

  const card = await client.waitFor((f) => f.kind === 'journal' && f.type === 'permission_request' && f.payload?.kind === 'agent_chat')
  assert.equal(card.payload.request, 'invite')
  assert.equal(card.payload.room_id, 'room')
  assert.equal(card.payload.from_device_id, agA.deviceId)
  assert.equal(card.payload.from_name, 'dev-a')
  assert.equal(card.payload.target_device_id, agB.deviceId)
  assert.equal(card.payload.topic, 'ci')
  assert.equal(card.payload.justification, 'need your logs')
  assert.equal(card.sender, 'agent:dev-a', 'every agent-authored append carries the agent: prefix (docs/protocol.md)')

  // The live frame is delivered synchronously inside the same handleOp call
  // that delivers the client's copy, so this is a courtesy settle beat, not
  // a real race — the security property under test is zero frames, ever.
  await new Promise((r) => setTimeout(r, 100))
  assert.equal(b.frames.length, 0, 'the invite target must never be relayed to while parked')
  assert.ok(!a.frames.some((f) => f.kind === 'journal' && f.type === 'permission_request'),
    'the requesting agent (also the room owner) must not see the card live either — client-only means no agent, not just not-the-target')
})

test('a parked invite lands the row in awaiting_user with the topic stored, never delivered_at', async (t) => {
  const { s, agB, a } = await roomFleet(t)
  a.send({ op: 'agent_invite', room_id: 'room', target_device_id: agB.deviceId, topic: 'ci topic', justification: 'x' })
  await a.waitFor((f) => f.kind === 'invite' && f.event === 'delivered')
  const row = getParticipant(s.db, 'room', agB.deviceId)
  assert.equal(row.state, 'awaiting_user')
  assert.equal(row.topic, 'ci topic')
  assert.equal(row.justification, 'x')
  assert.equal(row.delivered_at, null)
})

test('the card sanitises attacker-controlled from_name, topic, and justification', async (t) => {
  const { agB, client, a } = await roomFleet(t, { ownerName: 'evil\nname' })
  a.send({ op: 'agent_invite', room_id: 'room', target_device_id: agB.deviceId, topic: 'evil\ntopic', justification: 'evil\njust' })
  const card = await client.waitFor((f) => f.kind === 'journal' && f.type === 'permission_request' && f.payload?.kind === 'agent_chat')
  assert.equal(card.payload.from_name, 'evil name')
  assert.equal(card.payload.topic, 'evil topic')
  assert.equal(card.payload.justification, 'evil just')
})

test('a 4th outstanding request from one requester device is rejected before parking, not queued', async (t) => {
  const { s, agB, a } = await roomFleet(t)
  const rooms = ['room', 'room2', 'room3', 'room4']
  for (const r of rooms.slice(1)) {
    a.send({ op: 'convo_upsert', convo_id: r, title: r, session_state: 'running' })
    await a.waitFor((f) => f.kind === 'journal' && f.type === 'session_status' && f.convo_id === r)
  }
  for (const r of rooms.slice(0, 3)) {
    a.send({ op: 'agent_invite', room_id: r, target_device_id: agB.deviceId, justification: 'ask' })
    await a.waitFor((f) => f.kind === 'invite' && f.event === 'delivered' && f.room_id === r)
  }
  a.send({ op: 'agent_invite', room_id: rooms[3], target_device_id: agB.deviceId, justification: 'ask 4' })
  const err = await a.waitFor((f) => f.op === 'error' && f.ref === 'agent_invite')
  assert.equal(err.code, 'conflict')
  assert.equal(err.room_id, rooms[3])
  // The cap check runs before parkInvite is ever called — the rejected 4th
  // ask must leave no trace in convo_agents for that room+device.
  assert.equal(getParticipant(s.db, rooms[3], agB.deviceId), null)
})

test('an allowed pair bypasses the park entirely: immediate relay, invited+delivered row, no card', async (t) => {
  const { s, dan, agA, agB, a, b, client } = await roomFleet(t)
  addAllowance(s.db, { userId: dan.id, fromDeviceId: agA.deviceId, targetDeviceId: agB.deviceId })
  a.send({ op: 'agent_invite', room_id: 'room', target_device_id: agB.deviceId, topic: 'ci', justification: 'need logs' })

  const req = await b.waitFor((f) => f.kind === 'invite' && f.event === 'request')
  assert.equal(req.room_id, 'room')
  assert.equal(req.from_name, 'dev-a')
  assert.equal(req.topic, 'ci')
  assert.equal(req.justification, 'need logs')
  await a.waitFor((f) => f.kind === 'invite' && f.event === 'delivered' && f.target_device_id === agB.deviceId)

  const row = getParticipant(s.db, 'room', agB.deviceId)
  assert.equal(row.state, 'invited')
  assert.ok(row.delivered_at != null, 'the allowance path stamps delivery, unlike the old pre-Task-7 flow')

  await new Promise((r) => setTimeout(r, 100))
  assert.ok(!client.frames.some((f) => f.kind === 'journal' && f.type === 'permission_request'),
    'no consent card is published when a standing allowance covers the pair')
})

test('agent_join parks for user consent symmetrically: the room owner hears nothing, the requester gets delivered, and the card requests join', async (t) => {
  const { agA, agB, client, a, b } = await roomFleet(t)
  b.send({ op: 'agent_join', room_id: 'room', justification: 'let me help with this bug' })

  await b.waitFor((f) => f.kind === 'invite' && f.event === 'delivered' && f.target_device_id === agA.deviceId)

  const card = await client.waitFor((f) => f.kind === 'journal' && f.type === 'permission_request' && f.payload?.kind === 'agent_chat')
  assert.equal(card.payload.request, 'join')
  assert.equal(card.payload.room_id, 'room')
  assert.equal(card.payload.from_device_id, agB.deviceId)
  assert.equal(card.payload.from_name, 'dev-b')
  assert.equal(card.payload.target_device_id, agA.deviceId)
  assert.equal(card.payload.justification, 'let me help with this bug')
  assert.equal(card.sender, 'agent:dev-b', 'every agent-authored append carries the agent: prefix (docs/protocol.md)')

  await new Promise((r) => setTimeout(r, 100))
  assert.equal(a.frames.length, 0, 'the room owner (join target) must not be relayed to while parked')
})
