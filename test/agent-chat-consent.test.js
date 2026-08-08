import test from 'node:test'
import assert from 'node:assert/strict'
import { startTestServer, makeWsClient } from './helpers.js'
import { createUser, createAgent } from '../src/auth.js'
import { openDb } from '../src/db.js'
import { upsertConversation } from '../src/journal.js'
import { getParticipant, parkInvite, answerParkedInvite } from '../src/participants.js'
import { addAllowance, isAllowed } from '../src/allowances.js'
import { deliverPendingInvites } from '../src/invite-delivery.js'

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
async function roomFleet(t, { ownerName = 'dev-a', connectB = true } = {}) {
  const s = await startTestServer()
  t.after(() => s.close())
  const dan = await createUser(s.db, 'dan', 'pw')
  const agA = createAgent(s.db, dan.id, ownerName)
  const agB = createAgent(s.db, dan.id, 'dev-b')
  const login = await s.http('/login', { method: 'POST', body: { username: 'dan', password: 'pw', device_name: 'mac' } })
  const clientToken = login.json.token
  const a = await makeWsClient(s.base, { token: agA.token, cursor: null })
  // connectB:false stands in for a target that is offline at the moment of
  // approval — the HTTP answer-route tests need a device that genuinely has
  // no live socket, not one that raced a close.
  const b = connectB ? await makeWsClient(s.base, { token: agB.token, cursor: null }) : null
  const client = await makeWsClient(s.base, { token: clientToken, cursor: null })
  await a.waitFor((f) => f.op === 'hello_ok')
  if (b) await b.waitFor((f) => f.op === 'hello_ok')
  await client.waitFor((f) => f.op === 'hello_ok')
  t.after(() => { a.close(); b?.close(); client.close() })
  a.send({ op: 'convo_upsert', convo_id: 'room', title: 'room', session_state: 'running' })
  await a.waitFor((f) => f.kind === 'journal' && f.type === 'session_status')
  await client.waitFor((f) => f.kind === 'journal' && f.type === 'session_status')
  a.frames.length = 0
  if (b) b.frames.length = 0
  client.frames.length = 0
  return { s, dan, agA, agB, clientToken, a, b, client }
}

const isCard = (f) => f.kind === 'journal' && f.type === 'permission_request' && f.payload?.kind === 'agent_chat'

// Publishes a FORGED card via the generic `publish` op — permission_request
// is in ws.js's AGENT_PUBLISH_TYPES, so before the ws.js guard this drove a
// real trip through appendAndFan/fanOut. Now used only by the rejection
// tests below (IMP-1): the card must be unforgeable via publish/finalize, so
// it must be minted exclusively by the server's own agent_invite/agent_join
// park path (exercised via roomFleet + `agent_invite` in the tests that
// follow).
function publishCard(agent) {
  agent.send({ op: 'publish', convo_id: 'room', type: 'permission_request', payload: { kind: 'agent_chat', justification: 'SECRET' } })
}

test('client-only agent-chat card: live fan-out reaches the client, never the owning/requesting agent', async (t) => {
  const { agA, agB, client, a, b } = await roomFleet(t)
  // The requesting agent is also the room's recorded owner — exactly the
  // device broadcastJournal's default targets (owner + joined participants)
  // would otherwise deliver to first. Drive the card through the real
  // agent_invite park path (IMP-1: publish/finalize can no longer mint it).
  a.send({ op: 'agent_invite', room_id: 'room', target_device_id: agB.deviceId, justification: 'SECRET' })
  await a.waitFor((f) => f.kind === 'invite' && f.event === 'delivered')
  const seen = await client.waitFor(isCard)
  assert.equal(seen.payload.justification, 'SECRET')

  // The live frame is delivered synchronously inside the same handleOp call
  // that delivers the client's copy, so there's no real race to wait out —
  // this is just a courtesy beat before asserting the negative.
  await new Promise((r) => setTimeout(r, 50))
  assert.ok(!a.frames.some(isCard), 'the agent that manages/requested the room must not see the card live')
  assert.equal(b.frames.length, 0, 'the invite target must not see the card live either')
  assert.ok(!JSON.stringify(a.frames).includes('SECRET'), 'no trace of the justification text reached the agent live')
})

test('client-only agent-chat card: hello replay from cursor 0 excludes it for the agent, includes it for the client', async (t) => {
  const { s, agA, agB, clientToken, a, client } = await roomFleet(t)
  a.send({ op: 'agent_invite', room_id: 'room', target_device_id: agB.deviceId, justification: 'SECRET' })
  await a.waitFor((f) => f.kind === 'invite' && f.event === 'delivered')
  await client.waitFor(isCard)
  // A benign follow-up event both devices are entitled to, appended after
  // the card — once it shows up in a fresh replay, the card (an earlier
  // seq) is guaranteed to have already been processed by that same replay
  // loop, since eventsAfter delivers in seq order and each batch is sent
  // synchronously before the next is fetched.
  client.send({ op: 'send', convo_id: 'room', type: 'text', payload: { body: 'marker' } })
  await a.waitFor((f) => f.kind === 'journal' && f.type === 'text' && f.payload?.body === 'marker')

  const agentReplay = await makeWsClient(s.base, { token: agA.token, cursor: 0 })
  const clientReplay = await makeWsClient(s.base, { token: clientToken, cursor: 0 })
  t.after(() => { agentReplay.close(); clientReplay.close() })
  await agentReplay.waitFor((f) => f.kind === 'journal' && f.type === 'text' && f.payload?.body === 'marker')
  await clientReplay.waitFor((f) => f.kind === 'journal' && f.type === 'text' && f.payload?.body === 'marker')

  assert.ok(!agentReplay.journal().some(isCard), 'the agent must not receive the card as replayed history')
  assert.ok(clientReplay.journal().some(isCard), 'the client must still receive the card as replayed history')
  assert.ok(!JSON.stringify(agentReplay.frames).includes('SECRET'), 'no trace of the justification text reached the agent via replay')
})

test('client-only agent-chat card: HTTP GET /convo/:id/messages omits it for the agent, includes it for the client', async (t) => {
  const { s, agA, agB, clientToken, a, client } = await roomFleet(t)
  a.send({ op: 'agent_invite', room_id: 'room', target_device_id: agB.deviceId, justification: 'SECRET' })
  await a.waitFor((f) => f.kind === 'invite' && f.event === 'delivered')
  await client.waitFor(isCard)

  const asAgent = await s.http('/convo/room/messages', { token: agA.token })
  const asClient = await s.http('/convo/room/messages', { token: clientToken })
  assert.equal(asAgent.status, 200)
  assert.equal(asClient.status, 200)
  assert.ok(!asAgent.json.events.some((e) => e.type === 'permission_request' && e.payload?.kind === 'agent_chat'),
    'the agent-token page must not include the card')
  assert.ok(asClient.json.events.some((e) => e.type === 'permission_request' && e.payload?.kind === 'agent_chat'),
    'the client-token page must include the card')
  assert.ok(!JSON.stringify(asAgent.json).includes('SECRET'), 'no trace of the justification text reached the agent via HTTP')
})

// --- IMP-1: the card is unforgeable via the generic agent-write ops --------
//
// permission_request is in AGENT_PUBLISH_TYPES (bridges legitimately publish
// ordinary permission_request cards, e.g. tool-approval prompts), but a
// payload shaped like the agent_chat consent card (`kind:'agent_chat'`) must
// only ever be minted by the server's own agent_invite/agent_join park path,
// which runs sanitizePeerText over from_name/topic/justification. A bare
// publish/finalize never runs that sanitiser, so allowing it through would
// let any agent forge an unsanitised, impersonating consent card (fake
// from_device_id/from_name, control-char justification) straight into a
// room it manages.

test('agent publish of a forged agent_chat permission_request is rejected: error frame, nothing appended, no frame reaches anyone', async (t) => {
  const { s, agent, client } = await fleet(t)
  publishCard(agent)
  const err = await agent.waitFor((f) => f.kind === 'control' && f.op === 'error' && f.code === 'bad_request' && f.ref === 'publish')
  assert.equal(err.detail, 'agent_chat consent cards are server-minted only')

  await new Promise((r) => setTimeout(r, 50))
  assert.ok(!agent.frames.some(isCard), 'no card reached the publishing agent')
  assert.ok(!client.frames.some(isCard), 'no card reached the client either — nothing was appended at all')
  assert.ok(!JSON.stringify(agent.frames).includes('SECRET'))
  assert.ok(!JSON.stringify(client.frames).includes('SECRET'))
  assert.equal(s.db.prepare("SELECT COUNT(*) n FROM events WHERE convo_id='room' AND type='permission_request'").get().n, 0,
    'the forged card must never be appended to the journal')
})

test('agent finalize of a forged agent_chat permission_request is rejected: error frame, nothing appended, no frame reaches anyone', async (t) => {
  const { s, agent, client } = await fleet(t)
  agent.send({
    op: 'finalize', convo_id: 'room', message_ref: 'm1',
    type: 'permission_request', payload: { kind: 'agent_chat', justification: 'SECRET' },
  })
  const err = await agent.waitFor((f) => f.kind === 'control' && f.op === 'error' && f.code === 'bad_request' && f.ref === 'finalize')
  assert.equal(err.detail, 'agent_chat consent cards are server-minted only')

  await new Promise((r) => setTimeout(r, 50))
  assert.ok(!agent.frames.some(isCard), 'no card reached the publishing agent')
  assert.ok(!client.frames.some(isCard), 'no card reached the client either — nothing was appended at all')
  assert.ok(!JSON.stringify(agent.frames).includes('SECRET'))
  assert.ok(!JSON.stringify(client.frames).includes('SECRET'))
  assert.equal(s.db.prepare("SELECT COUNT(*) n FROM events WHERE convo_id='room' AND type='permission_request'").get().n, 0,
    'the forged card must never be appended to the journal')
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
  // A join self-targets: the parked row is keyed on the JOINER, so the card's
  // target_device_id — the field a client feeds back to /agent-chat/answer —
  // is agB, not the room owner. The `invite/delivered` ack above is the frame
  // that names the owner (who got asked), and it still does.
  assert.equal(card.payload.target_device_id, agB.deviceId)
  assert.equal(card.payload.justification, 'let me help with this bug')
  assert.equal(card.sender, 'agent:dev-b', 'every agent-authored append carries the agent: prefix (docs/protocol.md)')

  await new Promise((r) => setTimeout(r, 100))
  assert.equal(a.frames.length, 0, 'the room owner (join target) must not be relayed to while parked')
})

// --- Bugbot finding: whitespace-only justification must not pass validation.
// The handlers validated msg.justification (the RAW string) for
// non-emptiness, then ran it through sanitizePeerText afterward — so a
// payload of spaces/control chars satisfied the raw check but sanitised
// down to '', storing an empty justification and publishing an empty card
// body. The fix validates the SANITISED value instead.

test('agent_invite rejects a whitespace-only justification exactly like an empty one: nothing parked, no card published', async (t) => {
  const { s, agB, client, a } = await roomFleet(t)
  a.send({ op: 'agent_invite', room_id: 'room', target_device_id: agB.deviceId, justification: '   \n\t  ' })
  const err = await a.waitFor((f) => f.op === 'error' && f.ref === 'agent_invite')
  assert.equal(err.code, 'bad_request')
  assert.equal(err.detail, 'bad justification', 'same error shape as the empty-string case')
  assert.equal(getParticipant(s.db, 'room', agB.deviceId), null, 'nothing parked for a whitespace-only ask')

  await new Promise((r) => setTimeout(r, 50))
  assert.ok(!client.frames.some(isCard), 'no card published for a whitespace-only ask')
})

test('agent_join rejects a whitespace-only justification exactly like an empty one: nothing parked, no card published', async (t) => {
  const { s, agB, client, b } = await roomFleet(t)
  b.send({ op: 'agent_join', room_id: 'room', justification: '   \n\t  ' })
  const err = await b.waitFor((f) => f.op === 'error' && f.ref === 'agent_join')
  assert.equal(err.code, 'bad_request')
  assert.equal(err.detail, 'bad justification', 'same error shape as the empty-string case')
  assert.equal(getParticipant(s.db, 'room', agB.deviceId), null, 'nothing parked for a whitespace-only ask')

  await new Promise((r) => setTimeout(r, 50))
  assert.ok(!client.frames.some(isCard), 'no card published for a whitespace-only ask')
})

// --- Task 8: delivery pump + hello hook + awaiting_user sweep --------------

// Minimal fixture for the pump's own unit tests: a real db (schema +
// foreign_keys enforced, so undeliveredInvites' join to conversations has
// something to join against) but no sockets at all — the stub hub below
// stands in for hub.js entirely.
async function pumpFleet() {
  const db = openDb(':memory:')
  const dan = await createUser(db, 'dan', 'pw')
  const agA = createAgent(db, dan.id, 'dev-a') // room owner / invite initiator
  const agB = createAgent(db, dan.id, 'dev-b') // invite target / joiner
  upsertConversation(db, {
    id: 'room', ownerUserId: dan.id, title: 'room', sessionState: 'running',
    agentDeviceId: agA.deviceId, parentConvoId: null, summary: null,
  })
  return { db, dan, agA, agB }
}

// Exact shape the brief specifies: records every attempted send (so a test
// can tell an offline attempt from no attempt at all) and reports success
// per the `online` set, same as hub.sendRpcRequest's single-socket contract.
function stubHub(onlineDeviceIds = []) {
  const calls = []
  const online = new Set(onlineDeviceIds)
  return { calls, sendRpcRequest: (u, d, f) => { calls.push([u, d, f]); return online.has(d) } }
}

test('deliverPendingInvites: an offline recipient is attempted but never stamped delivered', async () => {
  const { db, agA, agB } = await pumpFleet()
  parkInvite(db, { convoId: 'room', agentDeviceId: agB.deviceId, initiatorDeviceId: agA.deviceId, justification: 'need logs', topic: 'ci' })
  assert.ok(answerParkedInvite(db, { convoId: 'room', agentDeviceId: agB.deviceId, approve: true }))
  const hub = stubHub([]) // agB is not online
  const sent = deliverPendingInvites(db, hub)
  assert.equal(sent, 0)
  assert.equal(hub.calls.length, 1, 'the pump must still try — that attempt is how it learns the target is offline')
  assert.equal(getParticipant(db, 'room', agB.deviceId).delivered_at, null, 'an offline recipient must not be stamped delivered')
})

test('deliverPendingInvites: an online recipient gets the exact request frame and is stamped, exactly once', async () => {
  const { db, dan, agA, agB } = await pumpFleet()
  parkInvite(db, { convoId: 'room', agentDeviceId: agB.deviceId, initiatorDeviceId: agA.deviceId, justification: 'need logs', topic: 'ci' })
  answerParkedInvite(db, { convoId: 'room', agentDeviceId: agB.deviceId, approve: true })
  const hub = stubHub([agB.deviceId])

  const sent = deliverPendingInvites(db, hub)
  assert.equal(sent, 1)
  assert.equal(hub.calls.length, 1)
  const [userId, deviceId, frame] = hub.calls[0]
  assert.equal(userId, dan.id)
  assert.equal(deviceId, agB.deviceId)
  assert.deepEqual(frame, {
    kind: 'invite', event: 'request', room_id: 'room',
    from_device_id: agA.deviceId, from_name: 'dev-a', topic: 'ci', justification: 'need logs',
  })
  assert.ok(getParticipant(db, 'room', agB.deviceId).delivered_at != null)

  // Exactly-once: a second pump call must find nothing left undelivered.
  const sentAgain = deliverPendingInvites(db, hub)
  assert.equal(sentAgain, 0)
  assert.equal(hub.calls.length, 1, 'no second attempt against an already-delivered row')
})

test('deliverPendingInvites: a join-direction row routes to room_agent_device_id, not agent_device_id', async () => {
  const { db, dan, agA, agB } = await pumpFleet()
  // agB is both the row's agent_device_id AND its initiator — the join-request
  // shape (see undeliveredInvites' doc comment in participants.js). The
  // recipient must be agA (the room's recorded owner), not agB itself.
  parkInvite(db, { convoId: 'room', agentDeviceId: agB.deviceId, initiatorDeviceId: agB.deviceId, justification: 'let me help', topic: '' })
  answerParkedInvite(db, { convoId: 'room', agentDeviceId: agB.deviceId, approve: true })
  const hub = stubHub([agA.deviceId])

  const sent = deliverPendingInvites(db, hub)
  assert.equal(sent, 1)
  assert.equal(hub.calls.length, 1)
  const [userId, deviceId, frame] = hub.calls[0]
  assert.equal(userId, dan.id)
  assert.equal(deviceId, agA.deviceId, 'a join request must be routed to the room owner, not back to the joiner')
  assert.deepEqual(frame, {
    kind: 'invite', event: 'join_request', room_id: 'room',
    from_device_id: agB.deviceId, from_name: 'dev-b', justification: 'let me help',
  })
  assert.ok(getParticipant(db, 'room', agB.deviceId).delivered_at != null)
})

test('hello hook: an invite approved while the target was offline is delivered the moment it connects; a later reconnect gets nothing', async (t) => {
  const s = await startTestServer()
  t.after(() => s.close())
  const dan = await createUser(s.db, 'dan', 'pw')
  const agA = createAgent(s.db, dan.id, 'dev-a')
  const agB = createAgent(s.db, dan.id, 'dev-b') // stays offline through the park+approve
  const a = await makeWsClient(s.base, { token: agA.token, cursor: null })
  await a.waitFor((f) => f.op === 'hello_ok')
  t.after(() => a.close())
  a.send({ op: 'convo_upsert', convo_id: 'room', title: 'room', session_state: 'running' })
  await a.waitFor((f) => f.kind === 'journal' && f.type === 'session_status')

  a.send({ op: 'agent_invite', room_id: 'room', target_device_id: agB.deviceId, topic: 'ci', justification: 'need logs' })
  await a.waitFor((f) => f.kind === 'invite' && f.event === 'delivered')
  assert.equal(getParticipant(s.db, 'room', agB.deviceId).state, 'awaiting_user')

  // Approve directly — standing in for the HTTP consent endpoint (a separate
  // task): the pump must not care WHO approved, only that the row is now
  // 'invited' and undelivered.
  assert.ok(answerParkedInvite(s.db, { convoId: 'room', agentDeviceId: agB.deviceId, approve: true }))

  const b = await makeWsClient(s.base, { token: agB.token, cursor: null })
  await b.waitFor((f) => f.op === 'hello_ok')
  t.after(() => b.close())
  const req = await b.waitFor((f) => f.kind === 'invite' && f.event === 'request')
  assert.equal(req.room_id, 'room')
  assert.equal(req.from_device_id, agA.deviceId)
  assert.equal(req.from_name, 'dev-a')
  assert.equal(req.topic, 'ci')
  assert.equal(req.justification, 'need logs')
  assert.ok(getParticipant(s.db, 'room', agB.deviceId).delivered_at != null)

  // A second reconnect of the same device must receive nothing further —
  // the row is already stamped delivered.
  b.close()
  await new Promise((r) => setTimeout(r, 50))
  const b2 = await makeWsClient(s.base, { token: agB.token, cursor: null })
  await b2.waitFor((f) => f.op === 'hello_ok')
  t.after(() => b2.close())
  await new Promise((r) => setTimeout(r, 100))
  assert.ok(!b2.frames.some((f) => f.kind === 'invite' && f.event === 'request'), 'a reconnect after delivery must receive nothing')
})

test('sweep: a parked ask nobody answered for 24h expires and the requester hears reason "refused", never "expired"', async (t) => {
  const s = await startTestServer({ revocationSweepMs: 100 })
  t.after(() => s.close())
  const dan = await createUser(s.db, 'dan', 'pw')
  const agA = createAgent(s.db, dan.id, 'dev-a')
  const agB = createAgent(s.db, dan.id, 'dev-b')
  const a = await makeWsClient(s.base, { token: agA.token, cursor: null })
  await a.waitFor((f) => f.op === 'hello_ok')
  t.after(() => a.close())
  a.send({ op: 'convo_upsert', convo_id: 'room', title: 'room', session_state: 'running' })
  await a.waitFor((f) => f.kind === 'journal' && f.type === 'session_status')

  a.send({ op: 'agent_invite', room_id: 'room', target_device_id: agB.deviceId, topic: 'ci', justification: 'x' })
  await a.waitFor((f) => f.kind === 'invite' && f.event === 'delivered')
  assert.equal(getParticipant(s.db, 'room', agB.deviceId).state, 'awaiting_user')

  // Force the park 25h stale — past the fixed 24h AWAITING_USER_TTL_MS —
  // same raw-UPDATE mechanism test/invites.test.js uses for expireInvites.
  s.db.prepare("UPDATE convo_agents SET created_at=? WHERE convo_id='room' AND agent_device_id=?")
    .run(Date.now() - 25 * 3600_000, agB.deviceId)

  const ans = await a.waitFor((f) => f.kind === 'invite' && f.event === 'answer', 3000)
  assert.equal(ans.accept, false)
  assert.equal(ans.reason, 'refused', 'a user-side timeout must read exactly like a refusal — a peer must never learn "expired" means the human never even saw it')
  assert.equal(ans.peer_device_id, agB.deviceId)
  assert.equal(getParticipant(s.db, 'room', agB.deviceId).state, 'expired')
})

// --- Task 9: client-gated HTTP /agent-chat/pending + /agent-chat/answer ---

test('403: agent tokens are forbidden from both agent-chat HTTP routes, including answering a request addressed to itself', async (t) => {
  const { s, agA, agB, a } = await roomFleet(t)
  a.send({ op: 'agent_invite', room_id: 'room', target_device_id: agB.deviceId, topic: 'ci', justification: 'need logs' })
  await a.waitFor((f) => f.kind === 'invite' && f.event === 'delivered')

  const pending = await s.http('/agent-chat/pending', { token: agA.token })
  assert.equal(pending.status, 403)
  assert.deepEqual(pending.json, { error: 'forbidden' })

  const asOwner = await s.http('/agent-chat/answer', {
    method: 'POST', token: agA.token,
    body: { room_id: 'room', target_device_id: agB.deviceId, decision: 'approve' },
  })
  assert.equal(asOwner.status, 403)

  // The parked row's target IS agB — even so, agB's own agent token must not
  // be able to answer a request addressed to itself. Only a client token may
  // ever answer.
  const asTarget = await s.http('/agent-chat/answer', {
    method: 'POST', token: agB.token,
    body: { room_id: 'room', target_device_id: agB.deviceId, decision: 'approve' },
  })
  assert.equal(asTarget.status, 403)
  assert.equal(getParticipant(s.db, 'room', agB.deviceId).state, 'awaiting_user', 'the 403s must not have mutated the row')
})

test('POST /agent-chat/answer: an unknown room is 404', async (t) => {
  const { s, agB, clientToken } = await roomFleet(t)
  const r = await s.http('/agent-chat/answer', {
    method: 'POST', token: clientToken,
    body: { room_id: 'does-not-exist', target_device_id: agB.deviceId, decision: 'approve' },
  })
  assert.equal(r.status, 404)
  assert.deepEqual(r.json, { error: 'not_found' })
})

test('POST /agent-chat/answer: a room owned by another user is 404, not 403 (anti-enumeration parity)', async (t) => {
  const { s, agB, clientToken } = await roomFleet(t)
  await createUser(s.db, 'pat', 'pw')
  const patLogin = await s.http('/login', { method: 'POST', body: { username: 'pat', password: 'pw', device_name: 'x' } })
  const r = await s.http('/agent-chat/answer', {
    method: 'POST', token: patLogin.json.token,
    body: { room_id: 'room', target_device_id: agB.deviceId, decision: 'approve' },
  })
  assert.equal(r.status, 404)
  assert.deepEqual(r.json, { error: 'not_found' })
})

test('GET /agent-chat/pending lists a parked row with title+topic, and empties once it is answered', async (t) => {
  const { s, agA, agB, clientToken, a } = await roomFleet(t)
  a.send({ op: 'agent_invite', room_id: 'room', target_device_id: agB.deviceId, topic: 'ci topic', justification: 'need logs' })
  await a.waitFor((f) => f.kind === 'invite' && f.event === 'delivered')

  const before = await s.http('/agent-chat/pending', { token: clientToken })
  assert.equal(before.status, 200)
  assert.equal(before.json.pending.length, 1)
  const row = before.json.pending[0]
  assert.equal(row.convo_id, 'room')
  assert.equal(row.agent_device_id, agB.deviceId)
  assert.equal(row.initiator_device_id, agA.deviceId)
  assert.equal(row.topic, 'ci topic')
  assert.equal(row.justification, 'need logs')
  assert.equal(row.title, 'room')
  assert.ok(row.created_at)

  const ans = await s.http('/agent-chat/answer', {
    method: 'POST', token: clientToken,
    body: { room_id: 'room', target_device_id: agB.deviceId, decision: 'deny' },
  })
  assert.equal(ans.status, 200)

  const after = await s.http('/agent-chat/pending', { token: clientToken })
  assert.deepEqual(after.json.pending, [])
})

test('POST /agent-chat/answer approve, target offline: row -> invited, {ok:true, delivered:false}', async (t) => {
  const { s, agB, clientToken, a } = await roomFleet(t, { connectB: false })
  a.send({ op: 'agent_invite', room_id: 'room', target_device_id: agB.deviceId, topic: 'ci', justification: 'need logs' })
  await a.waitFor((f) => f.kind === 'invite' && f.event === 'delivered')

  const r = await s.http('/agent-chat/answer', {
    method: 'POST', token: clientToken,
    body: { room_id: 'room', target_device_id: agB.deviceId, decision: 'approve' },
  })
  assert.equal(r.status, 200)
  assert.deepEqual(r.json, { ok: true, delivered: false })
  const row = getParticipant(s.db, 'room', agB.deviceId)
  assert.equal(row.state, 'invited')
  assert.equal(row.delivered_at, null, 'nobody has actually relayed the request yet')
})

test('POST /agent-chat/answer approve, target online: target receives the request frame, delivered:true', async (t) => {
  const { s, agA, agB, clientToken, a, b } = await roomFleet(t)
  a.send({ op: 'agent_invite', room_id: 'room', target_device_id: agB.deviceId, topic: 'ci', justification: 'need logs' })
  await a.waitFor((f) => f.kind === 'invite' && f.event === 'delivered')

  const r = await s.http('/agent-chat/answer', {
    method: 'POST', token: clientToken,
    body: { room_id: 'room', target_device_id: agB.deviceId, decision: 'approve' },
  })
  assert.equal(r.status, 200)
  assert.deepEqual(r.json, { ok: true, delivered: true })

  const req = await b.waitFor((f) => f.kind === 'invite' && f.event === 'request')
  assert.equal(req.room_id, 'room')
  assert.equal(req.from_device_id, agA.deviceId)
  assert.equal(req.from_name, 'dev-a')
  assert.equal(req.topic, 'ci')
  assert.equal(req.justification, 'need logs')
  assert.ok(getParticipant(s.db, 'room', agB.deviceId).delivered_at != null)
})

test('delivered flag is scoped to the answered row: an unrelated ONLINE recipient must not make an OFFLINE target read delivered:true', async (t) => {
  const { s, dan, agA, agB, clientToken, a } = await roomFleet(t, { connectB: false })
  // The row we are about to answer: agB, offline throughout this test.
  a.send({ op: 'agent_invite', room_id: 'room', target_device_id: agB.deviceId, topic: 'ci', justification: 'need logs' })
  await a.waitFor((f) => f.kind === 'invite' && f.event === 'delivered')

  // An UNRELATED already-approved, undelivered row for a third device that
  // IS online — planted directly via the participants API (bypassing the
  // park flow) so it sits in exactly the state the pump sweeps: state
  // 'invited', delivered_at NULL. Before the fix, the unscoped pump call
  // inside POST /agent-chat/answer would deliver THIS row too (agC is
  // online) and report sent>0, making the response wrongly claim the
  // just-approved (still offline) agB row was delivered.
  const agC = createAgent(s.db, dan.id, 'dev-c')
  const c = await makeWsClient(s.base, { token: agC.token, cursor: null })
  await c.waitFor((f) => f.op === 'hello_ok')
  t.after(() => c.close())
  parkInvite(s.db, { convoId: 'room', agentDeviceId: agC.deviceId, initiatorDeviceId: agA.deviceId, justification: 'unrelated', topic: '' })
  assert.ok(answerParkedInvite(s.db, { convoId: 'room', agentDeviceId: agC.deviceId, approve: true }))
  assert.equal(getParticipant(s.db, 'room', agC.deviceId).delivered_at, null)

  const r = await s.http('/agent-chat/answer', {
    method: 'POST', token: clientToken,
    body: { room_id: 'room', target_device_id: agB.deviceId, decision: 'approve' },
  })
  assert.equal(r.status, 200)
  assert.deepEqual(r.json, { ok: true, delivered: false }, 'agB is offline — an unrelated online agC row must never leak into this response')
  assert.equal(getParticipant(s.db, 'room', agB.deviceId).delivered_at, null)
  // The pump call this request triggers must be scoped to agB's own
  // recipient only — agC's unrelated row is left exactly as it was.
  assert.equal(getParticipant(s.db, 'room', agC.deviceId).delivered_at, null, 'the scoped pump call must not touch an unrelated recipient\'s row')
})

// --- Bugbot finding: the join card must be answerable using its own fields.
// The card carried the room owner in target_device_id while the parked row is
// keyed on the joiner, so a client that echoed the field back got a 409 and
// the ask could never be approved from the card alone.

test('a join card is answerable using the card\'s own target_device_id: the ask unparks and reaches the room owner', async (t) => {
  const { s, agA, agB, clientToken, a, b, client } = await roomFleet(t)
  b.send({ op: 'agent_join', room_id: 'room', justification: 'let me help with this bug' })
  const card = await client.waitFor(isCard)
  assert.notEqual(card.payload.target_device_id, agA.deviceId, 'the owner is not the row this card asks about')

  // Exactly what a client UI does: read the card, POST its fields back.
  const r = await s.http('/agent-chat/answer', {
    method: 'POST', token: clientToken,
    body: { room_id: card.payload.room_id, target_device_id: card.payload.target_device_id, decision: 'approve' },
  })
  assert.equal(r.status, 200, 'echoing the card back must resolve the row it describes, not 409')
  // Approving a park unparks it to 'invited' and relays onward — for a join,
  // to the room owner, who still gets the final say.
  assert.equal(getParticipant(s.db, 'room', agB.deviceId).state, 'invited')
  const relay = await a.waitFor((f) => f.kind === 'invite' && f.event === 'join_request')
  assert.equal(relay.from_device_id, agB.deviceId, 'the owner is asked about the joiner, not about itself')
})

test('POST /agent-chat/answer deny: row -> denied, requester gets an answer frame with reason "refused" (never "denied")', async (t) => {
  const { s, agB, clientToken, a } = await roomFleet(t)
  a.send({ op: 'agent_invite', room_id: 'room', target_device_id: agB.deviceId, topic: 'ci', justification: 'need logs' })
  await a.waitFor((f) => f.kind === 'invite' && f.event === 'delivered')

  const r = await s.http('/agent-chat/answer', {
    method: 'POST', token: clientToken,
    body: { room_id: 'room', target_device_id: agB.deviceId, decision: 'deny' },
  })
  assert.equal(r.status, 200)
  assert.deepEqual(r.json, { ok: true })

  const ans = await a.waitFor((f) => f.kind === 'invite' && f.event === 'answer')
  assert.equal(ans.accept, false)
  assert.equal(ans.reason, 'refused')
  assert.equal(ans.peer_device_id, agB.deviceId)
  assert.equal(getParticipant(s.db, 'room', agB.deviceId).state, 'denied')
})

test('POST /agent-chat/answer on a non-awaiting row is 409', async (t) => {
  const { s, agB, clientToken } = await roomFleet(t)
  // No invite was ever parked for this pair — getParticipant returns null,
  // so the row is not in state 'awaiting_user'.
  const r = await s.http('/agent-chat/answer', {
    method: 'POST', token: clientToken,
    body: { room_id: 'room', target_device_id: agB.deviceId, decision: 'approve' },
  })
  assert.equal(r.status, 409)
  assert.deepEqual(r.json, { error: 'conflict' })
})

test('POST /agent-chat/answer: a bad decision value is 400', async (t) => {
  const { s, agB, clientToken } = await roomFleet(t)
  const r = await s.http('/agent-chat/answer', {
    method: 'POST', token: clientToken,
    body: { room_id: 'room', target_device_id: agB.deviceId, decision: 'maybe' },
  })
  assert.equal(r.status, 400)
  assert.deepEqual(r.json, { error: 'bad_request' })
})

test('POST /agent-chat/answer: a non-integer target_device_id is 400', async (t) => {
  const { s, clientToken } = await roomFleet(t)
  const r = await s.http('/agent-chat/answer', {
    method: 'POST', token: clientToken,
    body: { room_id: 'room', target_device_id: 'not-a-number', decision: 'approve' },
  })
  assert.equal(r.status, 400)
  assert.deepEqual(r.json, { error: 'bad_request' })
})

test('always_allow:true on approve records the directed pair; a following agent_invite between them relays immediately', async (t) => {
  const { s, agB, clientToken, a, b } = await roomFleet(t)
  a.send({ op: 'agent_invite', room_id: 'room', target_device_id: agB.deviceId, topic: 'ci', justification: 'need logs' })
  await a.waitFor((f) => f.kind === 'invite' && f.event === 'delivered')

  const r = await s.http('/agent-chat/answer', {
    method: 'POST', token: clientToken,
    body: { room_id: 'room', target_device_id: agB.deviceId, decision: 'approve', always_allow: true },
  })
  assert.equal(r.status, 200)
  await b.waitFor((f) => f.kind === 'invite' && f.event === 'request')

  // A second room, second invite for the same directed pair: the allowance
  // just recorded must bypass the park entirely (Task 7's allowance-bypass
  // path), so no HTTP approval is needed this time.
  a.send({ op: 'convo_upsert', convo_id: 'room2', title: 'room2', session_state: 'running' })
  await a.waitFor((f) => f.kind === 'journal' && f.type === 'session_status' && f.convo_id === 'room2')
  a.frames.length = 0
  b.frames.length = 0

  a.send({ op: 'agent_invite', room_id: 'room2', target_device_id: agB.deviceId, topic: 'ci2', justification: 'again' })
  const req2 = await b.waitFor((f) => f.kind === 'invite' && f.event === 'request')
  assert.equal(req2.room_id, 'room2')
  assert.equal(getParticipant(s.db, 'room2', agB.deviceId).state, 'invited')
  assert.ok(getParticipant(s.db, 'room2', agB.deviceId).delivered_at != null)
})

test('always_allow JOIN direction: approving a join request records (joiner -> room owner), never the reverse', async (t) => {
  const { s, dan, agA, agB, clientToken, b } = await roomFleet(t)
  b.send({ op: 'agent_join', room_id: 'room', justification: 'let me help with this bug' })
  await b.waitFor((f) => f.kind === 'invite' && f.event === 'delivered')

  const r = await s.http('/agent-chat/answer', {
    method: 'POST', token: clientToken,
    body: { room_id: 'room', target_device_id: agB.deviceId, decision: 'approve', always_allow: true },
  })
  assert.equal(r.status, 200)

  assert.ok(isAllowed(s.db, dan.id, agB.deviceId, agA.deviceId), 'the pair recorded must be joiner -> room owner')
  assert.ok(!isAllowed(s.db, dan.id, agA.deviceId, agB.deviceId), 'must not record the reverse direction')
})

// --- Client allowance management: GET /agent-chat/allowances + revoke ---
//
// The client half of "always allow". Approving with always_allow:true was the
// only way to create an allowance and there was no way at all to see or undo
// one — a consent the user granted once, invisible and permanent.

test('GET /agent-chat/allowances: client-gated, lists the pair with both device names', async (t) => {
  const { s, agA, agB, clientToken, a } = await roomFleet(t)
  a.send({ op: 'agent_invite', room_id: 'room', target_device_id: agB.deviceId, topic: 'ci', justification: 'need logs' })
  await a.waitFor((f) => f.kind === 'invite' && f.event === 'delivered')
  await s.http('/agent-chat/answer', {
    method: 'POST', token: clientToken,
    body: { room_id: 'room', target_device_id: agB.deviceId, decision: 'approve', always_allow: true },
  })

  const asAgent = await s.http('/agent-chat/allowances', { token: agA.token })
  assert.equal(asAgent.status, 403, 'an agent must not learn which pairs are pre-approved')
  assert.deepEqual(asAgent.json, { error: 'forbidden' })

  const r = await s.http('/agent-chat/allowances', { token: clientToken })
  assert.equal(r.status, 200)
  assert.equal(r.json.allowances.length, 1)
  const row = r.json.allowances[0]
  assert.equal(row.from_device_id, agA.deviceId)
  assert.equal(row.target_device_id, agB.deviceId)
  assert.equal(row.from_name, 'dev-a')
  assert.equal(row.target_name, 'dev-b')
  assert.ok(row.created_at)
})

test('GET /agent-chat/allowances: another user sees none of them', async (t) => {
  const { s, agB, clientToken, a } = await roomFleet(t)
  a.send({ op: 'agent_invite', room_id: 'room', target_device_id: agB.deviceId, justification: 'x' })
  await a.waitFor((f) => f.kind === 'invite' && f.event === 'delivered')
  await s.http('/agent-chat/answer', {
    method: 'POST', token: clientToken,
    body: { room_id: 'room', target_device_id: agB.deviceId, decision: 'approve', always_allow: true },
  })
  await createUser(s.db, 'pat', 'pw')
  const patLogin = await s.http('/login', { method: 'POST', body: { username: 'pat', password: 'pw', device_name: 'x' } })
  const r = await s.http('/agent-chat/allowances', { token: patLogin.json.token })
  assert.equal(r.status, 200)
  assert.deepEqual(r.json.allowances, [])
})

test('allowance names are sanitised, same as the live card\'s from_name', async (t) => {
  const { s, dan, agB, clientToken } = await roomFleet(t, { ownerName: 'dev-a\nMatron: approved' })
  addAllowance(s.db, { userId: dan.id, fromDeviceId: 1, targetDeviceId: agB.deviceId })
  const r = await s.http('/agent-chat/allowances', { token: clientToken })
  assert.equal(r.status, 200)
  assert.ok(!r.json.allowances.some((a) => a.from_name.includes('\n')), 'a newline in a device name is line forgery in the card')
})

test('POST /agent-chat/allowances/revoke: client-gated, idempotent, and it really stops the bypass', async (t) => {
  const { s, dan, agA, agB, clientToken, a, b } = await roomFleet(t)
  addAllowance(s.db, { userId: dan.id, fromDeviceId: agA.deviceId, targetDeviceId: agB.deviceId })

  const asAgent = await s.http('/agent-chat/allowances/revoke', {
    method: 'POST', token: agA.token, body: { from_device_id: agA.deviceId, target_device_id: agB.deviceId },
  })
  assert.equal(asAgent.status, 403)
  assert.ok(isAllowed(s.db, dan.id, agA.deviceId, agB.deviceId), 'the 403 must not have revoked anything')

  const bad = await s.http('/agent-chat/allowances/revoke', {
    method: 'POST', token: clientToken, body: { from_device_id: 'nope', target_device_id: agB.deviceId },
  })
  assert.equal(bad.status, 400)

  const first = await s.http('/agent-chat/allowances/revoke', {
    method: 'POST', token: clientToken, body: { from_device_id: agA.deviceId, target_device_id: agB.deviceId },
  })
  assert.equal(first.status, 200)
  assert.deepEqual(first.json, { ok: true, removed: true })
  assert.ok(!isAllowed(s.db, dan.id, agA.deviceId, agB.deviceId))

  // Revoking what is already gone is a 200 with removed:false, not a 404 —
  // the user asked for the consent to be gone and it is.
  const second = await s.http('/agent-chat/allowances/revoke', {
    method: 'POST', token: clientToken, body: { from_device_id: agA.deviceId, target_device_id: agB.deviceId },
  })
  assert.equal(second.status, 200)
  assert.deepEqual(second.json, { ok: true, removed: false })

  // The point of the endpoint: the next invite for that pair parks for the
  // user again instead of riding the bypass straight through to the target.
  a.send({ op: 'agent_invite', room_id: 'room', target_device_id: agB.deviceId, topic: 'ci', justification: 'again' })
  await a.waitFor((f) => f.kind === 'invite' && f.event === 'delivered')
  assert.equal(getParticipant(s.db, 'room', agB.deviceId).state, 'awaiting_user')
  assert.ok(!b.frames.some((f) => f.kind === 'invite' && f.event === 'request'), 'a revoked pair must not reach the target')
})

test('GET /agent-chat/pending carries the requesting and target device names', async (t) => {
  const { s, agB, clientToken, a } = await roomFleet(t)
  a.send({ op: 'agent_invite', room_id: 'room', target_device_id: agB.deviceId, topic: 'ci', justification: 'need logs' })
  await a.waitFor((f) => f.kind === 'invite' && f.event === 'delivered')
  const r = await s.http('/agent-chat/pending', { token: clientToken })
  assert.equal(r.status, 200)
  assert.equal(r.json.pending[0].initiator_name, 'dev-a')
  assert.equal(r.json.pending[0].agent_name, 'dev-b')
})

// Device ids are reused: `devices.id` is a plain INTEGER PRIMARY KEY, so
// SQLite assigns max(rowid)+1 — revoke the newest device and the next one
// created lands on exactly its id. Anything keyed on a device id therefore
// has to die with the device. "Retire an agent, register its replacement" is
// the ordinary sequence that hits this.
test('revoking a device clears its allowances and room membership, so a reused id inherits nothing', async (t) => {
  const { s, dan, agA, clientToken } = await roomFleet(t)
  const doomed = createAgent(s.db, dan.id, 'dev-doomed')
  addAllowance(s.db, { userId: dan.id, fromDeviceId: agA.deviceId, targetDeviceId: doomed.deviceId })
  addAllowance(s.db, { userId: dan.id, fromDeviceId: doomed.deviceId, targetDeviceId: agA.deviceId })
  parkInvite(s.db, { convoId: 'room', agentDeviceId: doomed.deviceId, initiatorDeviceId: agA.deviceId })
  answerParkedInvite(s.db, { convoId: 'room', agentDeviceId: doomed.deviceId, approve: true })

  const r = await s.http(`/devices/${doomed.deviceId}/revoke`, { method: 'POST', token: clientToken })
  assert.equal(r.status, 200)

  assert.ok(!isAllowed(s.db, dan.id, agA.deviceId, doomed.deviceId), 'allowance naming the revoked device as target')
  assert.ok(!isAllowed(s.db, dan.id, doomed.deviceId, agA.deviceId), 'allowance naming it as requester')
  assert.equal(getParticipant(s.db, 'room', doomed.deviceId), null, 'its room membership')

  // The reused id is the real test: the replacement agent lands on the
  // revoked device's id and must start from nothing.
  const fresh = createAgent(s.db, dan.id, 'dev-replacement')
  assert.equal(fresh.deviceId, doomed.deviceId, 'precondition: SQLite reused the id')
  assert.ok(!isAllowed(s.db, dan.id, agA.deviceId, fresh.deviceId))
  assert.equal(getParticipant(s.db, 'room', fresh.deviceId), null)
})
