import test from 'node:test'
import assert from 'node:assert/strict'
import { openDb } from '../src/db.js'
import {
  inviteParticipant, answerInvite, leaveConvo, removeParticipant,
  joinedAgentIds, getParticipant, isParticipant, expireInvites,
} from '../src/participants.js'

const db = () => openDb(':memory:')

test('inviteParticipant creates a pending row', () => {
  const d = db()
  const r = inviteParticipant(d, { convoId: 'room', agentDeviceId: 2, initiatorDeviceId: 1, justification: 'help me' })
  assert.deepEqual(r, { ok: true })
  const row = getParticipant(d, 'room', 2)
  assert.equal(row.state, 'invited')
  assert.equal(row.initiator_device_id, 1)
  assert.equal(row.justification, 'help me')
  assert.equal(row.answered_at, null)
})

test('inviteParticipant refuses while invited or joined, renews after refused/left/expired', () => {
  const d = db()
  inviteParticipant(d, { convoId: 'room', agentDeviceId: 2, initiatorDeviceId: 1, justification: 'x' })
  assert.deepEqual(inviteParticipant(d, { convoId: 'room', agentDeviceId: 2, initiatorDeviceId: 1, justification: 'y' }), { ok: false, state: 'invited' })
  answerInvite(d, { convoId: 'room', agentDeviceId: 2, accept: true })
  assert.deepEqual(inviteParticipant(d, { convoId: 'room', agentDeviceId: 2, initiatorDeviceId: 1, justification: 'y' }), { ok: false, state: 'joined' })
  leaveConvo(d, { convoId: 'room', agentDeviceId: 2 })
  const renewed = inviteParticipant(d, { convoId: 'room', agentDeviceId: 2, initiatorDeviceId: 2, justification: 'again' })
  assert.deepEqual(renewed, { ok: true })
  const row = getParticipant(d, 'room', 2)
  assert.equal(row.state, 'invited')
  assert.equal(row.initiator_device_id, 2)
  assert.equal(row.justification, 'again')
  assert.equal(row.answered_at, null)
})

test('answerInvite flips only a pending row', () => {
  const d = db()
  inviteParticipant(d, { convoId: 'room', agentDeviceId: 2, initiatorDeviceId: 1, justification: 'x' })
  assert.equal(answerInvite(d, { convoId: 'room', agentDeviceId: 2, accept: false }), true)
  assert.equal(getParticipant(d, 'room', 2).state, 'refused')
  assert.ok(getParticipant(d, 'room', 2).answered_at != null)
  // Already answered — a second answer is a no-op false.
  assert.equal(answerInvite(d, { convoId: 'room', agentDeviceId: 2, accept: true }), false)
  // No row at all.
  assert.equal(answerInvite(d, { convoId: 'room', agentDeviceId: 99, accept: true }), false)
})

test('leaveConvo flips only a joined row', () => {
  const d = db()
  inviteParticipant(d, { convoId: 'room', agentDeviceId: 2, initiatorDeviceId: 1, justification: 'x' })
  assert.equal(leaveConvo(d, { convoId: 'room', agentDeviceId: 2 }), false, 'invited is not joined')
  answerInvite(d, { convoId: 'room', agentDeviceId: 2, accept: true })
  assert.equal(leaveConvo(d, { convoId: 'room', agentDeviceId: 2 }), true)
  assert.equal(getParticipant(d, 'room', 2).state, 'left')
})

test('joinedAgentIds returns only joined participants of that convo', () => {
  const d = db()
  inviteParticipant(d, { convoId: 'room', agentDeviceId: 2, initiatorDeviceId: 1, justification: 'x' })
  inviteParticipant(d, { convoId: 'room', agentDeviceId: 3, initiatorDeviceId: 1, justification: 'x' })
  inviteParticipant(d, { convoId: 'other', agentDeviceId: 4, initiatorDeviceId: 1, justification: 'x' })
  answerInvite(d, { convoId: 'room', agentDeviceId: 3, accept: true })
  answerInvite(d, { convoId: 'other', agentDeviceId: 4, accept: true })
  assert.deepEqual(joinedAgentIds(d, 'room'), [3])
})

test('isParticipant is true for any state, removeParticipant deletes the row', () => {
  const d = db()
  inviteParticipant(d, { convoId: 'room', agentDeviceId: 2, initiatorDeviceId: 1, justification: 'x' })
  answerInvite(d, { convoId: 'room', agentDeviceId: 2, accept: false })
  assert.equal(isParticipant(d, 'room', 2), true)
  assert.equal(isParticipant(d, 'room', 3), false)
  removeParticipant(d, 'room', 2)
  assert.equal(isParticipant(d, 'room', 2), false)
  assert.equal(getParticipant(d, 'room', 2), null)
})

test('expireInvites flips only stale pending rows and returns them', () => {
  const d = db()
  const now = Date.now()
  inviteParticipant(d, { convoId: 'stale', agentDeviceId: 2, initiatorDeviceId: 1, justification: 'x' })
  d.prepare('UPDATE convo_agents SET created_at=? WHERE convo_id=?').run(now - 10000, 'stale')
  inviteParticipant(d, { convoId: 'fresh', agentDeviceId: 3, initiatorDeviceId: 1, justification: 'x' })
  inviteParticipant(d, { convoId: 'done', agentDeviceId: 4, initiatorDeviceId: 1, justification: 'x' })
  answerInvite(d, { convoId: 'done', agentDeviceId: 4, accept: true })
  const expired = expireInvites(d, 5000, now)
  assert.deepEqual(expired, [{ convo_id: 'stale', agent_device_id: 2, initiator_device_id: 1 }])
  assert.equal(getParticipant(d, 'stale', 2).state, 'expired')
  assert.equal(getParticipant(d, 'fresh', 3).state, 'invited')
  assert.equal(getParticipant(d, 'done', 4).state, 'joined')
  // Second sweep finds nothing.
  assert.deepEqual(expireInvites(d, 5000, now), [])
})
