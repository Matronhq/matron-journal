import test from 'node:test'
import assert from 'node:assert/strict'
import { openDb } from '../src/db.js'
import {
  inviteParticipant, answerInvite, leaveConvo, leaveAllParticipants, hasParticipants,
  removeParticipant, undoInvite, joinedAgentIds, getParticipant, isParticipant, expireInvites,
} from '../src/participants.js'

const db = () => openDb(':memory:')

test('inviteParticipant creates a pending row and reports no prior row', () => {
  const d = db()
  const r = inviteParticipant(d, { convoId: 'room', agentDeviceId: 2, initiatorDeviceId: 1, justification: 'help me' })
  assert.deepEqual(r, { ok: true, prior: null })
  const row = getParticipant(d, 'room', 2)
  assert.equal(row.state, 'invited')
  assert.equal(row.initiator_device_id, 1)
  assert.equal(row.justification, 'help me')
  assert.equal(row.answered_at, null)
})

test('inviteParticipant refuses while invited or joined, renews after refused/left/expired and reports the full prior row', () => {
  const d = db()
  inviteParticipant(d, { convoId: 'room', agentDeviceId: 2, initiatorDeviceId: 1, justification: 'x' })
  assert.deepEqual(inviteParticipant(d, { convoId: 'room', agentDeviceId: 2, initiatorDeviceId: 1, justification: 'y' }), { ok: false, state: 'invited' })
  answerInvite(d, { convoId: 'room', agentDeviceId: 2, accept: true })
  assert.deepEqual(inviteParticipant(d, { convoId: 'room', agentDeviceId: 2, initiatorDeviceId: 1, justification: 'y' }), { ok: false, state: 'joined' })
  leaveConvo(d, { convoId: 'room', agentDeviceId: 2 })
  const leftRow = getParticipant(d, 'room', 2)
  const renewed = inviteParticipant(d, { convoId: 'room', agentDeviceId: 2, initiatorDeviceId: 2, justification: 'again' })
  assert.equal(renewed.ok, true)
  assert.deepEqual(renewed.prior, { convo_id: 'room', agent_device_id: 2, ...leftRow })
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

test('leaveAllParticipants flips the live rows, spares terminal ones, and splits joined from pending', () => {
  const d = db()
  const now = Date.now()
  inviteParticipant(d, { convoId: 'room', agentDeviceId: 2, initiatorDeviceId: 1, justification: 'x' })
  answerInvite(d, { convoId: 'room', agentDeviceId: 2, accept: true })
  // 3 is a pending JOIN REQUEST — it initiated its own row, so it is the
  // side waiting for an answer.
  inviteParticipant(d, { convoId: 'room', agentDeviceId: 3, initiatorDeviceId: 3, justification: 'x' })
  inviteParticipant(d, { convoId: 'room', agentDeviceId: 4, initiatorDeviceId: 1, justification: 'x' })
  answerInvite(d, { convoId: 'room', agentDeviceId: 4, accept: false }) // refused — terminal
  inviteParticipant(d, { convoId: 'room', agentDeviceId: 6, initiatorDeviceId: 1, justification: 'x' })
  d.prepare('UPDATE convo_agents SET created_at=? WHERE convo_id=? AND agent_device_id=?').run(now - 10000, 'room', 6)
  expireInvites(d, 5000, now) // 6 only — every other pending row is fresh
  inviteParticipant(d, { convoId: 'other', agentDeviceId: 5, initiatorDeviceId: 1, justification: 'x' })
  answerInvite(d, { convoId: 'other', agentDeviceId: 5, accept: true })

  assert.deepEqual(leaveAllParticipants(d, 'room'), {
    joined: [2],
    pending: [{ agent_device_id: 3, initiator_device_id: 3 }],
  }, 'joined ids are owed a left frame; pending rows carry the initiator owed an answer')
  assert.equal(getParticipant(d, 'room', 2).state, 'left')
  assert.equal(getParticipant(d, 'room', 3).state, 'left')
  // Terminal outcomes are history: a dissolve must not rewrite them, or a
  // refusal record turns into an indistinguishable 'left'.
  assert.equal(getParticipant(d, 'room', 4).state, 'refused', 'a refusal survives the dissolve')
  assert.equal(getParticipant(d, 'room', 6).state, 'expired', 'an expiry survives the dissolve')
  assert.equal(getParticipant(d, 'other', 5).state, 'joined', 'other convos untouched')
  // Idempotent: a second dissolution finds nothing to flip or report.
  assert.deepEqual(leaveAllParticipants(d, 'room'), { joined: [], pending: [] })
  // And a convo with no rows at all is a clean no-op too.
  assert.deepEqual(leaveAllParticipants(d, 'empty'), { joined: [], pending: [] })
})

test('hasParticipants is true for a convo with any row in any state', () => {
  const d = db()
  assert.equal(hasParticipants(d, 'room'), false, 'a convo nobody was ever drawn into is not a room')
  inviteParticipant(d, { convoId: 'room', agentDeviceId: 2, initiatorDeviceId: 1, justification: 'x' })
  assert.equal(hasParticipants(d, 'room'), true)
  answerInvite(d, { convoId: 'room', agentDeviceId: 2, accept: false })
  assert.equal(hasParticipants(d, 'room'), true, 'a refused row still makes it a room')
  leaveAllParticipants(d, 'room')
  assert.equal(hasParticipants(d, 'room'), true, 'a dissolved room stays a room — that is what keeps re-leaving idempotent')
  assert.equal(hasParticipants(d, 'other'), false)
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

test('undoInvite restores the prior row exactly when one existed, else deletes like removeParticipant', () => {
  const d = db()
  // No prior row at all: undoInvite(..., null) deletes, same as a bare invite-then-remove.
  inviteParticipant(d, { convoId: 'room', agentDeviceId: 2, initiatorDeviceId: 1, justification: 'x' })
  undoInvite(d, 'room', 2, null)
  assert.equal(getParticipant(d, 'room', 2), null)

  // A renewed row: undoInvite must put back the exact prior state/fields,
  // not just flip the state — a refused device must not lose its
  // justification/initiator/timestamps by having a retry fail.
  inviteParticipant(d, { convoId: 'room', agentDeviceId: 3, initiatorDeviceId: 1, justification: 'first' })
  answerInvite(d, { convoId: 'room', agentDeviceId: 3, accept: false })
  const priorRefused = getParticipant(d, 'room', 3)
  const { prior } = inviteParticipant(d, { convoId: 'room', agentDeviceId: 3, initiatorDeviceId: 3, justification: 'retry' })
  assert.equal(getParticipant(d, 'room', 3).state, 'invited', 'sanity: the renew took effect before undo')
  undoInvite(d, 'room', 3, prior)
  const restored = getParticipant(d, 'room', 3)
  assert.deepEqual(restored, priorRefused)
  assert.equal(restored.state, 'refused')
  assert.equal(restored.justification, 'first')
  assert.equal(restored.initiator_device_id, 1)
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
