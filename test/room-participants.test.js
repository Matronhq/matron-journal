import test from 'node:test'
import assert from 'node:assert/strict'
import { startTestServer, makeWsClient } from './helpers.js'
import { createUser, createAgent } from '../src/auth.js'
import { inviteParticipant, answerInvite, answerParkedInvite, recordJoined, leaveConvo, getParticipant, participantConvoIds } from '../src/participants.js'
import { createSpawnRequest, claimApprove, markStarted } from '../src/spawns.js'
import { snapshot } from '../src/journal.js'

// Room membership on the wire (spec: multi-agent room tags). Clients render
// a box chip per participating machine, so the journal must say WHO is in a
// room: snapshot rows carry `participants` (recorded owner + joined
// convo_agents device ids), and every membership change fans a convo_meta
// with the updated array so live clients re-chip without a /snapshot.

async function fleet(t) {
  const s = await startTestServer()
  t.after(() => s.close())
  const dan = await createUser(s.db, 'dan', 'pw')
  const agA = createAgent(s.db, dan.id, 'dev-a')
  const agB = createAgent(s.db, dan.id, 'dev-b')
  const login = await s.http('/login', { method: 'POST', body: { username: 'dan', password: 'pw', device_name: 'mac' } })
  const a = await makeWsClient(s.base, { token: agA.token, cursor: null })
  const b = await makeWsClient(s.base, { token: agB.token, cursor: null })
  const client = await makeWsClient(s.base, { token: login.json.token, cursor: 0 })
  for (const w of [a, b, client]) await w.waitFor((f) => f.op === 'hello_ok')
  t.after(() => { a.close(); b.close(); client.close() })
  a.send({ op: 'convo_upsert', convo_id: 'room', title: 'room', session_state: 'running' })
  await a.waitFor((f) => f.kind === 'journal' && f.type === 'session_status')
  return { s, dan, agA, agB, a, b, client }
}

test('snapshot: rooms carry participants (owner + joined), plain convos omit the key', async (t) => {
  const { s, dan, agA, agB, a } = await fleet(t)
  a.send({ op: 'convo_upsert', convo_id: 'solo', title: 'solo', session_state: 'running' })
  await a.waitFor((f) => f.kind === 'journal' && f.convo_id === 'solo')
  inviteParticipant(s.db, { convoId: 'room', agentDeviceId: agB.deviceId, initiatorDeviceId: agA.deviceId, justification: 'x' })

  // Merely invited is not membership — no participants array yet.
  let rows = Object.fromEntries(snapshot(s.db, dan.id).conversations.map((c) => [c.id, c]))
  assert.equal(rows.room.participants, undefined, 'an invited-but-unanswered room is not yet multi-agent')

  answerInvite(s.db, { convoId: 'room', agentDeviceId: agB.deviceId, accept: true })
  rows = Object.fromEntries(snapshot(s.db, dan.id).conversations.map((c) => [c.id, c]))
  assert.deepEqual(rows.room.participants, [agA.deviceId, agB.deviceId].sort((x, y) => x - y))
  assert.equal(rows.solo.participants, undefined, 'a solo convo never grows the key')
})

test('accepting an invite over the socket fans convo_meta with the new participant set', async (t) => {
  const { s, agA, agB, b, client } = await fleet(t)
  inviteParticipant(s.db, { convoId: 'room', agentDeviceId: agB.deviceId, initiatorDeviceId: agA.deviceId, justification: 'x' })
  b.send({ op: 'agent_invite_answer', room_id: 'room', accept: true })
  const meta = await client.waitFor((f) => f.kind === 'journal' && f.type === 'convo_meta'
    && f.convo_id === 'room' && Array.isArray(f.payload.participants))
  assert.deepEqual(meta.payload.participants, [agA.deviceId, agB.deviceId].sort((x, y) => x - y))
})

test('a refusal fans nothing — membership did not change', async (t) => {
  const { s, agA, agB, b, client } = await fleet(t)
  inviteParticipant(s.db, { convoId: 'room', agentDeviceId: agB.deviceId, initiatorDeviceId: agA.deviceId, justification: 'x' })
  b.send({ op: 'agent_invite_answer', room_id: 'room', accept: false })
  await new Promise((r) => setTimeout(r, 200))
  assert.deepEqual(
    client.frames.filter((f) => f.kind === 'journal' && f.type === 'convo_meta' && f.payload.participants),
    [],
  )
})

test('guest leave and owner dissolve both fan the shrunken set', async (t) => {
  const { s, agA, agB, a, b, client } = await fleet(t)
  inviteParticipant(s.db, { convoId: 'room', agentDeviceId: agB.deviceId, initiatorDeviceId: agA.deviceId, justification: 'x' })
  b.send({ op: 'agent_invite_answer', room_id: 'room', accept: true })
  await client.waitFor((f) => f.kind === 'journal' && f.type === 'convo_meta' && Array.isArray(f.payload.participants))

  b.send({ op: 'agent_leave', room_id: 'room' })
  await client.waitFor((f) => f.kind === 'journal' && f.type === 'convo_meta'
    && Array.isArray(f.payload.participants) && f.payload.participants.length === 1)

  // Re-join (leaveConvo's 'left' is renewable), then the OWNER leaves —
  // dissolution must fan the same shrunken shape.
  inviteParticipant(s.db, { convoId: 'room', agentDeviceId: agB.deviceId, initiatorDeviceId: agA.deviceId, justification: 'x' })
  b.send({ op: 'agent_invite_answer', room_id: 'room', accept: true })
  await client.waitFor((f) => f.kind === 'journal' && f.type === 'convo_meta'
    && Array.isArray(f.payload.participants) && f.payload.participants.length === 2
    && client.frames.filter((g) => g.type === 'convo_meta' && g.payload.participants?.length === 2).length === 2)
  a.send({ op: 'agent_leave', room_id: 'room' })
  const metas = () => client.frames.filter((f) => f.kind === 'journal' && f.type === 'convo_meta'
    && Array.isArray(f.payload.participants) && f.payload.participants.length === 1)
  await client.waitFor(() => metas().length === 2)
  assert.deepEqual(metas().at(-1).payload.participants, [agA.deviceId])
})

test('snapshot with excludePrivateOwned filters private device ids from participants', async (t) => {
  const { s, dan, agA, agB } = await fleet(t)
  inviteParticipant(s.db, { convoId: 'room', agentDeviceId: agB.deviceId, initiatorDeviceId: agA.deviceId, justification: 'x' })
  answerInvite(s.db, { convoId: 'room', agentDeviceId: agB.deviceId, accept: true })
  s.db.prepare('UPDATE devices SET private=1 WHERE id=?').run(agB.deviceId)
  const rows = Object.fromEntries(
    snapshot(s.db, dan.id, { excludePrivateOwned: true }).conversations.map((c) => [c.id, c]),
  )
  // With its only joined participant sieved out, the room reads as a plain
  // solo convo to the filtered caller — no key at all, so neither the
  // private box's id nor the fact of a hidden member leaks. The unfiltered
  // client snapshot still carries both ids.
  assert.equal(rows.room.participants, undefined,
    'a private participant must not leak through the filtered snapshot')
  const unfiltered = Object.fromEntries(snapshot(s.db, dan.id).conversations.map((c) => [c.id, c]))
  assert.deepEqual(unfiltered.room.participants, [agA.deviceId, agB.deviceId].sort((x, y) => x - y))
})

// participant_convos (spec: 2026-10-01 rooms under missions): alongside the
// devices, the room's participant CONVERSATIONS, so a client can show a room
// under its participants' missions.

const rowsOf = (snap) => Object.fromEntries(snap.conversations.map((c) => [c.id, c]))

// Each agent's own top-level session, as a bridge would have published it.
async function sessions(a, b) {
  a.send({ op: 'convo_upsert', convo_id: 'a-sess', title: 'a session', session_state: 'running' })
  await a.waitFor((f) => f.kind === 'journal' && f.convo_id === 'a-sess')
  b.send({ op: 'convo_upsert', convo_id: 'b-sess', title: 'b session', session_state: 'running' })
  await b.waitFor((f) => f.kind === 'journal' && f.convo_id === 'b-sess')
}

test('participant_convos: an accepted invite room yields both sessions; the fan carries them', async (t) => {
  const { s, dan, agB, a, b, client } = await fleet(t)
  await sessions(a, b)
  a.send({ op: 'agent_invite', room_id: 'room', target_device_id: agB.deviceId, target_convo_id: 'b-sess', from_convo_id: 'a-sess', justification: 'help' })
  await a.waitFor((f) => f.kind === 'invite' && f.event === 'delivered')
  assert.ok(answerParkedInvite(s.db, { convoId: 'room', agentDeviceId: agB.deviceId, approve: true }))
  // Invited is not membership: no key yet, exactly like participants.
  assert.equal(rowsOf(snapshot(s.db, dan.id)).room.participant_convos, undefined)

  b.send({ op: 'agent_invite_answer', room_id: 'room', accept: true })
  const meta = await client.waitFor((f) => f.kind === 'journal' && f.type === 'convo_meta'
    && f.convo_id === 'room' && Array.isArray(f.payload.participants))
  assert.deepEqual(meta.payload.participant_convos, ['a-sess', 'b-sess'], 'owner session leads, then the invited one')
  assert.deepEqual(rowsOf(snapshot(s.db, dan.id)).room.participant_convos, ['a-sess', 'b-sess'])
})

test('participant_convos: a participant who left drops out (snapshot and the leave fan)', async (t) => {
  const { s, dan, agA, agB, b, client } = await fleet(t)
  inviteParticipant(s.db, { convoId: 'room', agentDeviceId: agB.deviceId, initiatorDeviceId: agA.deviceId, justification: 'x', targetConvoId: 'b-sess', initiatorConvoId: 'a-sess' })
  answerInvite(s.db, { convoId: 'room', agentDeviceId: agB.deviceId, accept: true })
  assert.deepEqual(participantConvoIds(s.db, 'room'), ['a-sess', 'b-sess'])

  b.send({ op: 'agent_leave', room_id: 'room' })
  const meta = await client.waitFor((f) => f.kind === 'journal' && f.type === 'convo_meta'
    && f.convo_id === 'room' && f.payload.participants?.length === 1)
  assert.deepEqual(meta.payload.participant_convos, [])
  assert.deepEqual(participantConvoIds(s.db, 'room'), [])
  // No joined row left: the room reads as no room, both keys omitted.
  const row = rowsOf(snapshot(s.db, dan.id)).room
  assert.equal(row.participants, undefined)
  assert.equal(row.participant_convos, undefined)
})

test('participant_convos: a started spawn room yields parent and child; a left child takes both out', async (t) => {
  const { s, dan, agA, agB } = await fleet(t)
  // The spawn room shape approveSpawn leaves: parent owns the room, the
  // target is its joined participant, the row is started with the child id.
  createSpawnRequest(s.db, { id: 'sp1', userId: dan.id, fromDeviceId: agA.deviceId, fromConvoId: 'a-sess', targetDeviceId: agB.deviceId, workdir: '/w', task: 't', link: true })
  assert.ok(claimApprove(s.db, 'sp1'))
  recordJoined(s.db, { convoId: 'room', agentDeviceId: agB.deviceId, initiatorDeviceId: agA.deviceId })
  // Approved but not started: the child is not known yet.
  assert.deepEqual(participantConvoIds(s.db, 'room'), [])
  // The child's conversation row need not exist yet — its bridge publishes
  // it after the start reply.
  assert.ok(markStarted(s.db, 'sp1', { roomId: 'room', childConvoId: 'child-1' }))
  assert.deepEqual(participantConvoIds(s.db, 'room'), ['a-sess', 'child-1'])
  assert.deepEqual(rowsOf(snapshot(s.db, dan.id)).room.participant_convos, ['a-sess', 'child-1'])

  leaveConvo(s.db, { convoId: 'room', agentDeviceId: agB.deviceId })
  assert.deepEqual(participantConvoIds(s.db, 'room'), [], 'a spawn row stays started forever; the joined gate drops it')
})

test('participant_convos: the filtered snapshot sieves private-owned sessions', async (t) => {
  const { s, dan, agA, agB } = await fleet(t)
  const agC = createAgent(s.db, dan.id, 'dev-c')
  inviteParticipant(s.db, { convoId: 'room', agentDeviceId: agB.deviceId, initiatorDeviceId: agA.deviceId, justification: 'x', targetConvoId: 'b-sess', initiatorConvoId: 'a-sess' })
  answerInvite(s.db, { convoId: 'room', agentDeviceId: agB.deviceId, accept: true })
  inviteParticipant(s.db, { convoId: 'room', agentDeviceId: agC.deviceId, initiatorDeviceId: agA.deviceId, justification: 'x', targetConvoId: 'c-sess', initiatorConvoId: 'a-sess' })
  answerInvite(s.db, { convoId: 'room', agentDeviceId: agC.deviceId, accept: true })
  s.db.prepare('UPDATE devices SET private=1 WHERE id=?').run(agB.deviceId)

  const filtered = rowsOf(snapshot(s.db, dan.id, { excludePrivateOwned: true })).room
  assert.deepEqual(filtered.participants, [agA.deviceId, agC.deviceId].sort((x, y) => x - y))
  assert.deepEqual(filtered.participant_convos, ['a-sess', 'c-sess'], 'the private box\'s session must not leak')
  assert.deepEqual(rowsOf(snapshot(s.db, dan.id)).room.participant_convos, ['a-sess', 'b-sess', 'c-sess'])

  // Its only joined participant private: both keys go, as for participants.
  s.db.prepare('UPDATE devices SET private=1 WHERE id=?').run(agC.deviceId)
  const solo = rowsOf(snapshot(s.db, dan.id, { excludePrivateOwned: true })).room
  assert.equal(solo.participants, undefined)
  assert.equal(solo.participant_convos, undefined)
})

test('participant_convos: snapshot omits the key for non-rooms; a room with unknown sessions carries []', async (t) => {
  const { s, dan, agA, agB, a } = await fleet(t)
  a.send({ op: 'convo_upsert', convo_id: 'solo', title: 'solo', session_state: 'running' })
  await a.waitFor((f) => f.kind === 'journal' && f.convo_id === 'solo')
  inviteParticipant(s.db, { convoId: 'room', agentDeviceId: agB.deviceId, initiatorDeviceId: agA.deviceId, justification: 'x' })
  answerInvite(s.db, { convoId: 'room', agentDeviceId: agB.deviceId, accept: true })
  const rows = rowsOf(snapshot(s.db, dan.id))
  assert.equal('participant_convos' in rows.solo, false)
  assert.deepEqual(rows.room.participant_convos, [], 'a pre-3.5 invite named no sessions')
})

test('agent_join with from_convo_id persists it and the joiner\'s session appears once accepted', async (t) => {
  const { s, dan, agB, a, b, client } = await fleet(t)
  await sessions(a, b)
  b.send({ op: 'agent_join', room_id: 'room', justification: 'let me in', from_convo_id: 'b-sess' })
  await b.waitFor((f) => f.kind === 'invite' && f.event === 'delivered')
  assert.equal(getParticipant(s.db, 'room', agB.deviceId).initiator_convo_id, 'b-sess')
  const card = await client.waitFor((f) => f.kind === 'journal' && f.type === 'permission_request' && f.payload.request === 'join')
  assert.equal(card.payload.from_convo_id, 'b-sess')
  assert.equal(card.payload.from_convo_title, 'b session')

  assert.ok(answerParkedInvite(s.db, { convoId: 'room', agentDeviceId: agB.deviceId, approve: true }))
  a.send({ op: 'agent_invite_answer', room_id: 'room', peer_device_id: agB.deviceId, accept: true })
  const meta = await client.waitFor((f) => f.kind === 'journal' && f.type === 'convo_meta'
    && f.convo_id === 'room' && Array.isArray(f.payload.participants))
  assert.deepEqual(meta.payload.participant_convos, ['b-sess'])
  assert.deepEqual(rowsOf(snapshot(s.db, dan.id)).room.participant_convos, ['b-sess'])
})

test('agent_join without from_convo_id is unchanged; a session it does not own is not_found', async (t) => {
  const { s, agB, a, b, client } = await fleet(t)
  await sessions(a, b)
  // Someone else's session: refused with the anti-enumeration code, no row.
  b.send({ op: 'agent_join', room_id: 'room', justification: 'let me in', from_convo_id: 'a-sess' })
  const err = await b.waitFor((f) => f.op === 'error' && f.ref === 'agent_join')
  assert.equal(err.code, 'not_found')
  assert.equal(getParticipant(s.db, 'room', agB.deviceId), null)

  b.send({ op: 'agent_join', room_id: 'room', justification: 'let me in' })
  await b.waitFor((f) => f.kind === 'invite' && f.event === 'delivered')
  const row = getParticipant(s.db, 'room', agB.deviceId)
  assert.equal(row.state, 'awaiting_user')
  assert.equal(row.initiator_convo_id, null)
  const card = await client.waitFor((f) => f.kind === 'journal' && f.type === 'permission_request' && f.payload.request === 'join')
  assert.equal(card.payload.from_convo_id, '')
  assert.equal(card.payload.from_convo_title, '')

  assert.ok(answerParkedInvite(s.db, { convoId: 'room', agentDeviceId: agB.deviceId, approve: true }))
  a.send({ op: 'agent_invite_answer', room_id: 'room', peer_device_id: agB.deviceId, accept: true })
  const meta = await client.waitFor((f) => f.kind === 'journal' && f.type === 'convo_meta'
    && f.convo_id === 'room' && Array.isArray(f.payload.participants))
  assert.deepEqual(meta.payload.participant_convos, [])
})
