import test from 'node:test'
import assert from 'node:assert/strict'
import { startTestServer, makeWsClient } from './helpers.js'
import { createUser, createAgent } from '../src/auth.js'
import { getParticipant, inviteParticipant, answerInvite } from '../src/participants.js'
import { handleOp } from '../src/ws.js'

async function fleet(t) {
  const s = await startTestServer()
  t.after(() => s.close())
  const dan = await createUser(s.db, 'dan', 'pw')
  const agA = createAgent(s.db, dan.id, 'dev-a')
  const agB = createAgent(s.db, dan.id, 'dev-b')
  const a = await makeWsClient(s.base, { token: agA.token, cursor: null })
  const b = await makeWsClient(s.base, { token: agB.token, cursor: null })
  await a.waitFor((f) => f.op === 'hello_ok')
  await b.waitFor((f) => f.op === 'hello_ok')
  t.after(() => { a.close(); b.close() })
  a.send({ op: 'convo_upsert', convo_id: 'room', title: 'room', session_state: 'running' })
  await a.waitFor((f) => f.kind === 'journal' && f.type === 'session_status')
  return { s, dan, agA, agB, a, b }
}

test('full invite happy path: request → delivered → ack → answer(accept) → joined', async (t) => {
  const { s, agB, a, b } = await fleet(t)
  a.send({ op: 'agent_invite', room_id: 'room', target_device_id: agB.deviceId, topic: 'ci', justification: 'need your logs' })

  const req = await b.waitFor((f) => f.kind === 'invite' && f.event === 'request')
  assert.equal(req.room_id, 'room')
  assert.equal(req.from_name, 'dev-a')
  assert.equal(req.topic, 'ci')
  assert.equal(req.justification, 'need your logs')

  await a.waitFor((f) => f.kind === 'invite' && f.event === 'delivered' && f.target_device_id === agB.deviceId)

  b.send({ op: 'agent_invite_ack', room_id: 'room', session_state: 'idle' })
  const ack = await a.waitFor((f) => f.kind === 'invite' && f.event === 'ack')
  assert.equal(ack.session_state, 'idle')
  assert.equal(ack.from_device_id, agB.deviceId)

  b.send({ op: 'agent_invite_answer', room_id: 'room', accept: true })
  const ans = await a.waitFor((f) => f.kind === 'invite' && f.event === 'answer')
  assert.equal(ans.accept, true)
  assert.equal(ans.peer_device_id, agB.deviceId)
  assert.equal(getParticipant(s.db, 'room', agB.deviceId).state, 'joined')
})

test('refusal carries the reason back and blocks the room for the target', async (t) => {
  const { s, agB, a, b } = await fleet(t)
  a.send({ op: 'agent_invite', room_id: 'room', target_device_id: agB.deviceId, justification: 'x' })
  await b.waitFor((f) => f.kind === 'invite' && f.event === 'request')
  b.send({ op: 'agent_invite_answer', room_id: 'room', accept: false, reason: 'mid-release, no' })
  const ans = await a.waitFor((f) => f.kind === 'invite' && f.event === 'answer')
  assert.equal(ans.accept, false)
  assert.equal(ans.reason, 'mid-release, no')
  assert.equal(getParticipant(s.db, 'room', agB.deviceId).state, 'refused')
  // Refused device cannot write (ties into Task 3's gate).
  b.send({ op: 'publish', convo_id: 'room', type: 'text', payload: { body: 'sneak' } })
  const err = await b.waitFor((f) => f.op === 'error' && f.ref === 'publish')
  assert.equal(err.code, 'forbidden')
})

test('join flow: peer asks, owner acks busy and accepts via peer_device_id', async (t) => {
  const { s, agA, agB, a, b } = await fleet(t)
  b.send({ op: 'agent_join', room_id: 'room', justification: 'I have context on this bug' })
  const jr = await a.waitFor((f) => f.kind === 'invite' && f.event === 'join_request')
  assert.equal(jr.from_device_id, agB.deviceId)
  assert.equal(jr.from_name, 'dev-b')
  await b.waitFor((f) => f.kind === 'invite' && f.event === 'delivered' && f.target_device_id === agA.deviceId)

  a.send({ op: 'agent_invite_ack', room_id: 'room', session_state: 'busy', peer_device_id: agB.deviceId })
  const ack = await b.waitFor((f) => f.kind === 'invite' && f.event === 'ack')
  assert.equal(ack.session_state, 'busy')

  a.send({ op: 'agent_invite_answer', room_id: 'room', accept: true, peer_device_id: agB.deviceId })
  const ans = await b.waitFor((f) => f.kind === 'invite' && f.event === 'answer')
  assert.equal(ans.accept, true)
  assert.equal(getParticipant(s.db, 'room', agB.deviceId).state, 'joined')
})

test('validation and authorization failures', async (t) => {
  const { s, dan, agA, agB, a, b } = await fleet(t)
  const expectErr = async (w, msg, code) => {
    w.send(msg)
    const err = await w.waitFor((f) => f.op === 'error' && f.ref === msg.op)
    assert.equal(err.code, code, `${msg.op} -> ${code}`)
    // Drain so the next waitFor doesn't match this frame again.
    w.frames.length = 0
  }
  // Non-owner cannot invite into A's room.
  await expectErr(b, { op: 'agent_invite', room_id: 'room', target_device_id: agA.deviceId, justification: 'x' }, 'forbidden')
  // Owner cannot invite itself.
  await expectErr(a, { op: 'agent_invite', room_id: 'room', target_device_id: agA.deviceId, justification: 'x' }, 'bad_request')
  // Missing justification.
  await expectErr(a, { op: 'agent_invite', room_id: 'room', target_device_id: agB.deviceId }, 'bad_request')
  // Unknown room.
  await expectErr(a, { op: 'agent_invite', room_id: 'nope', target_device_id: agB.deviceId, justification: 'x' }, 'not_found')
  // Target that is a client device is indistinguishable from missing.
  const login = await s.http('/login', { method: 'POST', body: { username: 'dan', password: 'pw', device_name: 'mac' } })
  const clientDeviceId = s.db.prepare("SELECT id FROM devices WHERE kind='client' ORDER BY id DESC LIMIT 1").get().id
  await expectErr(a, { op: 'agent_invite', room_id: 'room', target_device_id: clientDeviceId, justification: 'x' }, 'not_found')
  // Double-invite: first goes through, second conflicts.
  a.send({ op: 'agent_invite', room_id: 'room', target_device_id: agB.deviceId, justification: 'x' })
  await b.waitFor((f) => f.kind === 'invite' && f.event === 'request')
  await expectErr(a, { op: 'agent_invite', room_id: 'room', target_device_id: agB.deviceId, justification: 'x' }, 'conflict')
  // Answer without a pending invite (already answered).
  b.send({ op: 'agent_invite_answer', room_id: 'room', accept: true })
  await a.waitFor((f) => f.kind === 'invite' && f.event === 'answer')
  await expectErr(b, { op: 'agent_invite_answer', room_id: 'room', accept: true }, 'conflict')
  // Owner joining its own room is a bad_request.
  await expectErr(a, { op: 'agent_join', room_id: 'room', justification: 'x' }, 'bad_request')
  // Client connections may not use invite ops at all.
  const c = await makeWsClient(s.base, { token: login.json.token, cursor: null })
  await c.waitFor((f) => f.op === 'hello_ok')
  t.after(() => c.close())
  await expectErr(c, { op: 'agent_invite', room_id: 'room', target_device_id: agB.deviceId, justification: 'x' }, 'forbidden')
})

test('inviting an offline device fails with offline and leaves no row', async (t) => {
  const { s, dan, a } = await fleet(t)
  const ghost = createAgent(s.db, dan.id, 'dev-ghost') // never connects
  a.send({ op: 'agent_invite', room_id: 'room', target_device_id: ghost.deviceId, justification: 'x' })
  const err = await a.waitFor((f) => f.op === 'error' && f.ref === 'agent_invite')
  assert.equal(err.code, 'offline')
  assert.equal(getParticipant(s.db, 'room', ghost.deviceId), null)
})

test('agent_leave flips joined to left and notifies the owner', async (t) => {
  const { s, agA, agB, a, b } = await fleet(t)
  inviteParticipant(s.db, { convoId: 'room', agentDeviceId: agB.deviceId, initiatorDeviceId: agA.deviceId, justification: 'x' })
  answerInvite(s.db, { convoId: 'room', agentDeviceId: agB.deviceId, accept: true })
  b.send({ op: 'agent_leave', room_id: 'room' })
  const left = await a.waitFor((f) => f.kind === 'invite' && f.event === 'left')
  assert.equal(left.from_device_id, agB.deviceId)
  assert.equal(getParticipant(s.db, 'room', agB.deviceId).state, 'left')
  // Leaving twice conflicts.
  b.send({ op: 'agent_leave', room_id: 'room' })
  const err = await b.waitFor((f) => f.op === 'error' && f.ref === 'agent_leave')
  assert.equal(err.code, 'conflict')
})

test('agent_invite_ack/agent_invite_answer/agent_leave reject an unregistered agent connection', async (t) => {
  // hello_ok flips conn.registered=true only after the auth+replay dance
  // completes; mid-replay this socket is invisible to hub scans, same
  // reasoning as agent_invite/agent_join's existing gate (see loadRoom's
  // comment). Simulate that pre-registration window directly via handleOp,
  // since a real ws.hello() races the registration flag closed too fast to
  // observe from a public-interface test.
  const { s, dan, agA, agB } = await fleet(t)
  inviteParticipant(s.db, { convoId: 'room', agentDeviceId: agB.deviceId, initiatorDeviceId: agA.deviceId, justification: 'x' })
  const frames = []
  const unregistered = {
    ws: { send: (str) => frames.push(JSON.parse(str)) },
    userId: dan.id, deviceId: agB.deviceId, kind: 'agent', name: 'dev-b', registered: false,
  }
  for (const msg of [
    { op: 'agent_invite_ack', room_id: 'room', session_state: 'idle' },
    { op: 'agent_invite_answer', room_id: 'room', accept: true },
    { op: 'agent_leave', room_id: 'room' },
  ]) {
    frames.length = 0
    handleOp({ db: s.db, hub: s.hub, conn: unregistered, msg })
    assert.equal(frames.length, 1, `${msg.op} should reply with exactly one frame`)
    assert.equal(frames[0].code, 'not_ready', `${msg.op} -> not_ready`)
  }
  // The gate short-circuits before any state mutation: the invite is still
  // pending, untouched by the rejected ack/answer/leave attempts above.
  assert.equal(getParticipant(s.db, 'room', agB.deviceId).state, 'invited')
})

test('a refused row is restored (not erased) when a retry join fails because the owner is offline', async (t) => {
  const { s, agA, agB, a, b } = await fleet(t)
  a.send({ op: 'agent_invite', room_id: 'room', target_device_id: agB.deviceId, justification: 'first ask' })
  await b.waitFor((f) => f.kind === 'invite' && f.event === 'request')
  b.send({ op: 'agent_invite_answer', room_id: 'room', accept: false, reason: 'not now' })
  await a.waitFor((f) => f.kind === 'invite' && f.event === 'answer')
  const refused = getParticipant(s.db, 'room', agB.deviceId)
  assert.equal(refused.state, 'refused')
  assert.equal(refused.justification, 'first ask')

  // Take the owner offline so the retry's delivery fails.
  a.close()
  await new Promise((r) => setTimeout(r, 150))

  b.send({ op: 'agent_join', room_id: 'room', justification: 'let me back in' })
  const err = await b.waitFor((f) => f.op === 'error' && f.ref === 'agent_join')
  assert.equal(err.code, 'offline')

  // The failed retry must restore the PRIOR refused row exactly — not erase
  // it (a bare delete would let a refused device wipe its own refusal
  // history just by join-requesting while the owner happens to be offline).
  const after = getParticipant(s.db, 'room', agB.deviceId)
  assert.equal(after.state, 'refused')
  assert.equal(after.justification, 'first ask', 'original refusal justification must survive, not the failed retry\'s')
  assert.equal(after.initiator_device_id, agA.deviceId, 'original initiator (the owner\'s invite) must survive')
})

test('an unanswered invite expires and the initiator is told', async (t) => {
  const s = await startTestServer({ revocationSweepMs: 100, inviteTtlMs: 150 })
  t.after(() => s.close())
  const dan = await createUser(s.db, 'dan', 'pw')
  const agA = createAgent(s.db, dan.id, 'dev-a')
  const agB = createAgent(s.db, dan.id, 'dev-b')
  const a = await makeWsClient(s.base, { token: agA.token, cursor: null })
  const b = await makeWsClient(s.base, { token: agB.token, cursor: null })
  await a.waitFor((f) => f.op === 'hello_ok')
  await b.waitFor((f) => f.op === 'hello_ok')
  t.after(() => { a.close(); b.close() })
  a.send({ op: 'convo_upsert', convo_id: 'room', session_state: 'running' })
  await a.waitFor((f) => f.kind === 'journal' && f.type === 'session_status')
  a.send({ op: 'agent_invite', room_id: 'room', target_device_id: agB.deviceId, justification: 'x' })
  await b.waitFor((f) => f.kind === 'invite' && f.event === 'request')
  // B never answers; the sweep expires it.
  const ans = await a.waitFor((f) => f.kind === 'invite' && f.event === 'answer', 3000)
  assert.equal(ans.accept, false)
  assert.equal(ans.reason, 'expired')
  assert.equal(ans.peer_device_id, agB.deviceId)
  assert.equal(getParticipant(s.db, 'room', agB.deviceId).state, 'expired')
  // A late answer from B is a clean conflict, not a resurrection.
  b.send({ op: 'agent_invite_answer', room_id: 'room', accept: true })
  const err = await b.waitFor((f) => f.op === 'error' && f.ref === 'agent_invite_answer')
  assert.equal(err.code, 'conflict')
})
