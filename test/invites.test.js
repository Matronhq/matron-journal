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
  assert.equal(ans.from_device_id, agB.deviceId, 'the answering device is stamped on the live relay')
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
  // In the join-request direction, from_device_id is the OWNER (who actually
  // answered) — distinct from peer_device_id, which names the join-requester
  // the row is about. This is how the join-requester learns who answered.
  assert.equal(ans.from_device_id, agA.deviceId)
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

test('owner leave dissolves the room: joined peers are told, pending invites die', async (t) => {
  const { s, dan, agA, agB, a, b } = await fleet(t)
  const agC = createAgent(s.db, dan.id, 'dev-c')
  const c = await makeWsClient(s.base, { token: agC.token, cursor: null })
  await c.waitFor((f) => f.op === 'hello_ok')
  t.after(() => c.close())
  inviteParticipant(s.db, { convoId: 'room', agentDeviceId: agB.deviceId, initiatorDeviceId: agA.deviceId, justification: 'x' })
  answerInvite(s.db, { convoId: 'room', agentDeviceId: agB.deviceId, accept: true })
  inviteParticipant(s.db, { convoId: 'room', agentDeviceId: agC.deviceId, initiatorDeviceId: agA.deviceId, justification: 'x' })
  // C stays merely invited.

  a.send({ op: 'agent_leave', room_id: 'room' })
  const left = await b.waitFor((f) => f.kind === 'invite' && f.event === 'left')
  assert.equal(left.room_id, 'room')
  assert.equal(left.from_device_id, agA.deviceId)
  assert.equal(getParticipant(s.db, 'room', agB.deviceId).state, 'left')
  // The pending invite dies with the room — but its device was never joined,
  // so it gets no 'left' frame; its next answer attempt tells the story.
  assert.equal(getParticipant(s.db, 'room', agC.deviceId).state, 'left')
  c.send({ op: 'agent_invite_answer', room_id: 'room', accept: true })
  const err = await c.waitFor((f) => f.op === 'error' && f.ref === 'agent_invite_answer')
  assert.equal(err.code, 'conflict')
  assert.ok(!c.frames.some((f) => f.kind === 'invite'), 'a pending invitee the OWNER invited is not notified at all')

  // Repeated owner-leave is a silent success (no-error-means-success), not a
  // conflict. Proven with a barrier: a deliberately-failing leave on an
  // unknown room — per-connection FIFO means its not_found arriving proves
  // the repeat before it produced no error frame.
  a.frames.length = 0
  a.send({ op: 'agent_leave', room_id: 'room' })
  a.send({ op: 'agent_leave', room_id: 'nope' })
  const barrier = await a.waitFor((f) => f.op === 'error' && f.ref === 'agent_leave')
  assert.equal(barrier.code, 'not_found')
  assert.equal(barrier.room_id, 'nope')
  assert.ok(!a.frames.some((f) => f.op === 'error' && f.room_id === 'room'), 'repeated owner-leave must be silent')
})

test('owner leave answers a pending JOIN REQUEST instead of orphaning the requester', async (t) => {
  // The join-requester is its own row's initiator, so it never sends an
  // agent_invite_answer and has nothing to conflict against; the dissolve
  // flips its row invited -> left, which also puts it out of reach of the
  // expiry sweep (predicate: state='invited'). Without an answer here the
  // requesting bridge waits forever with no server-side recovery.
  const { s, agB, a, b } = await fleet(t)
  b.send({ op: 'agent_join', room_id: 'room', justification: 'I have context on this bug' })
  await a.waitFor((f) => f.kind === 'invite' && f.event === 'join_request')
  await b.waitFor((f) => f.kind === 'invite' && f.event === 'delivered')

  a.send({ op: 'agent_leave', room_id: 'room' })
  const ans = await b.waitFor((f) => f.kind === 'invite' && f.event === 'answer')
  assert.equal(ans.room_id, 'room')
  assert.equal(ans.accept, false)
  assert.equal(ans.reason, 'left')
  assert.equal(ans.peer_device_id, agB.deviceId)
  // Same synthetic shape as the expiry sweep's answer (no answering
  // connection behind it, so no from_device_id) — the initiator's existing
  // expiry handling fires unchanged, only the reason differs.
  assert.equal(ans.from_device_id, undefined)
  assert.equal(getParticipant(s.db, 'room', agB.deviceId).state, 'left')
})

test('a throwing notify neither undoes a committed dissolve nor strands the remaining peers', async (t) => {
  // The DB flip is committed before any frame goes out, so a send that
  // throws (a socket that died between the hub's lookup and the write) must
  // not surface as {code:'internal'}: the caller would retry a leave that
  // already happened, the retry would no-op, and everyone after the throw
  // would never be told. Unit-level with a deliberately broken hub — a real
  // socket can't be made to throw on cue.
  const { s, dan, agA, agB } = await fleet(t)
  const agC = createAgent(s.db, dan.id, 'dev-c')
  inviteParticipant(s.db, { convoId: 'room', agentDeviceId: agB.deviceId, initiatorDeviceId: agA.deviceId, justification: 'x' })
  answerInvite(s.db, { convoId: 'room', agentDeviceId: agB.deviceId, accept: true })
  // C is a pending join request — notified after B, so B's throw is what
  // would swallow C's answer.
  inviteParticipant(s.db, { convoId: 'room', agentDeviceId: agC.deviceId, initiatorDeviceId: agC.deviceId, justification: 'x' })

  const mute = t.mock.method(console, 'error', () => {}) // the guard is expected to log; keep test output clean
  const seen = []
  const brokenHub = {
    sendToDevice: (userId, deviceId, frame) => {
      if (deviceId === agB.deviceId) throw new Error('socket died between lookup and write')
      seen.push({ deviceId, frame })
    },
  }
  const frames = []
  const owner = {
    ws: { send: (str) => frames.push(JSON.parse(str)) },
    userId: dan.id, deviceId: agA.deviceId, kind: 'agent', name: 'dev-a', registered: true,
  }
  handleOp({ db: s.db, hub: brokenHub, conn: owner, msg: { op: 'agent_leave', room_id: 'room' } })

  assert.deepEqual(frames, [], 'a committed leave stays a silent success, not an internal error')
  assert.equal(getParticipant(s.db, 'room', agB.deviceId).state, 'left')
  assert.equal(getParticipant(s.db, 'room', agC.deviceId).state, 'left')
  assert.equal(seen.length, 1, 'the peer after the throwing one is still notified')
  assert.equal(seen[0].deviceId, agC.deviceId)
  assert.equal(seen[0].frame.reason, 'left')
  assert.ok(mute.mock.callCount() >= 1, 'the swallowed send failure is logged server-side')
})

test('owner leave: a participant-less convo conflicts, a dissolved room stays silently idempotent', async (t) => {
  const { s, agA, agB, a, b } = await fleet(t)
  // convo_upsert stamps agent_device_id on EVERY agent-created conversation,
  // so "the caller is the recorded owner" alone would drag a plain solo
  // convo into the dissolve branch. A convo nobody was ever drawn into is
  // not a room: leaving it conflicts, exactly as it did before owner-leave
  // existed. Exactly one error frame — the guard must not be entangled with
  // the room_id echo, so assert the count as well as the contents.
  a.send({ op: 'agent_leave', room_id: 'room' })
  const err = await a.waitFor((f) => f.op === 'error' && f.ref === 'agent_leave')
  assert.equal(err.code, 'conflict')
  assert.equal(err.detail, 'not a joined participant')
  assert.equal(err.room_id, 'room')
  assert.equal(a.frames.filter((f) => f.op === 'error' && f.ref === 'agent_leave').length, 1)
  a.frames.length = 0

  // Make it a real room, then dissolve it. Now every row is 'left' — but
  // the rows still exist, so a repeat owner-leave stays in the dissolve
  // branch and is a silent success, not a conflict. Proven with a barrier:
  // a deliberately-failing leave on an unknown room — per-connection FIFO
  // means its not_found arriving proves the repeat produced no error frame.
  inviteParticipant(s.db, { convoId: 'room', agentDeviceId: agB.deviceId, initiatorDeviceId: agA.deviceId, justification: 'x' })
  answerInvite(s.db, { convoId: 'room', agentDeviceId: agB.deviceId, accept: true })
  a.send({ op: 'agent_leave', room_id: 'room' })
  await b.waitFor((f) => f.kind === 'invite' && f.event === 'left')

  a.send({ op: 'agent_leave', room_id: 'room' })
  a.send({ op: 'agent_leave', room_id: 'nope' })
  const barrier = await a.waitFor((f) => f.op === 'error' && f.ref === 'agent_leave')
  assert.equal(barrier.code, 'not_found')
  assert.equal(barrier.room_id, 'nope')
  assert.equal(a.frames.filter((f) => f.op === 'error' && f.ref === 'agent_leave').length, 1, 'only the barrier errored')
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

test('room-op error frames carry room_id for correlation', async (t) => {
  const { agA, agB, a, b } = await fleet(t)
  const expectErr = async (w, msg, code) => {
    w.send(msg)
    const err = await w.waitFor((f) => f.op === 'error' && f.ref === msg.op)
    w.frames.length = 0
    assert.equal(err.code, code, `${msg.op} -> ${code}`)
    return err
  }
  // Non-owner invite (forbidden).
  let err = await expectErr(b, { op: 'agent_invite', room_id: 'room', target_device_id: agA.deviceId, justification: 'x' }, 'forbidden')
  assert.equal(err.room_id, 'room')
  // Unknown room (not_found) — the id is well-formed, so it still echoes.
  err = await expectErr(b, { op: 'agent_join', room_id: 'nope', justification: 'x' }, 'not_found')
  assert.equal(err.room_id, 'nope')
  // Double-invite (conflict).
  a.send({ op: 'agent_invite', room_id: 'room', target_device_id: agB.deviceId, justification: 'x' })
  await b.waitFor((f) => f.kind === 'invite' && f.event === 'request')
  err = await expectErr(a, { op: 'agent_invite', room_id: 'room', target_device_id: agB.deviceId, justification: 'x' }, 'conflict')
  assert.equal(err.room_id, 'room')
})

test('even the internal-error backstop carries room_id on a room op', async (t) => {
  const { s, a } = await fleet(t)
  // Fault injection, same brutal-but-honest trick as the HTTP 500 test:
  // agent_leave's is-this-a-room check reads convo_agents, so dropping the
  // table makes handleOp throw something genuinely unexpected — which is
  // exactly what the outermost backstop exists for. An 'internal' is the
  // error a bridge can least afford to leave uncorrelated, so that frame
  // must echo the room id just like fail()'s do.
  s.db.exec('DROP TABLE convo_agents')
  a.send({ op: 'agent_leave', room_id: 'room' })
  const err = await a.waitFor((f) => f.op === 'error' && f.ref === 'agent_leave')
  assert.equal(err.code, 'internal')
  assert.equal(err.room_id, 'room')
})

test('an invalid room_id is never echoed on an error frame, and non-room ops carry none', async (t) => {
  const { a } = await fleet(t)
  const expectErr = async (msg, code) => {
    a.send(msg)
    const err = await a.waitFor((f) => f.op === 'error' && f.ref === msg.op)
    a.frames.length = 0
    assert.equal(err.code, code, `${msg.op} -> ${code}`)
    return err
  }
  // Non-string and oversized ids are raw inbound input — omitted.
  let err = await expectErr({ op: 'agent_leave', room_id: 42 }, 'bad_request')
  assert.equal(err.room_id, undefined)
  err = await expectErr({ op: 'agent_leave', room_id: 'x'.repeat(129) }, 'bad_request')
  assert.equal(err.room_id, undefined)
  // A non-room op's error is unchanged even when the frame smuggles a room_id.
  err = await expectErr({ op: 'ack', cursor: -1, room_id: 'room' }, 'bad_request')
  assert.equal(err.room_id, undefined)
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
  // Unlike the live agent_invite_answer relay, the sweep's synthetic expiry
  // answer has no answering connection behind it, so it carries no
  // from_device_id (documented difference — see docs/protocol.md).
  assert.equal(ans.from_device_id, undefined)
  assert.equal(getParticipant(s.db, 'room', agB.deviceId).state, 'expired')
  // A late answer from B is a clean conflict, not a resurrection.
  b.send({ op: 'agent_invite_answer', room_id: 'room', accept: true })
  const err = await b.waitFor((f) => f.op === 'error' && f.ref === 'agent_invite_answer')
  assert.equal(err.code, 'conflict')
})
