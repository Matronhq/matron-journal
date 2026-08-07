import test from 'node:test'
import assert from 'node:assert/strict'
import { openDb } from '../src/db.js'
import {
  inviteParticipant, answerInvite, leaveConvo, leaveAllParticipants, hasParticipants,
  removeParticipant, undoInvite, joinedAgentIds, getParticipant, isParticipant, expireInvites,
  parkInvite, answerParkedInvite, markDelivered, undeliveredInvites, awaitingCount,
  listAwaiting, expireAwaiting,
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
  // New contract: expireInvites clocks off delivered_at, not created_at.
  markDelivered(d, { convoId: 'room', agentDeviceId: 6, now: now - 10000 })
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
  // New contract: the 30-minute answer clock starts at delivered_at, not
  // created_at — stamp delivery, then backdate it to simulate staleness.
  markDelivered(d, { convoId: 'stale', agentDeviceId: 2, now: now - 10000 })
  inviteParticipant(d, { convoId: 'fresh', agentDeviceId: 3, initiatorDeviceId: 1, justification: 'x' })
  markDelivered(d, { convoId: 'fresh', agentDeviceId: 3, now })
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

test('parkInvite creates awaiting_user with topic, no delivery stamp', () => {
  const d = db()
  const r = parkInvite(d, { convoId: 'room', agentDeviceId: 2, initiatorDeviceId: 1, justification: 'help', topic: 'ci' })
  assert.deepEqual(r, { ok: true, prior: null })
  const row = getParticipant(d, 'room', 2)
  assert.equal(row.state, 'awaiting_user')
  assert.equal(row.topic, 'ci')
  assert.equal(row.delivered_at, null)
})

test('awaiting_user is not renewable; denied is', () => {
  const d = db()
  parkInvite(d, { convoId: 'room', agentDeviceId: 2, initiatorDeviceId: 1, justification: 'x', topic: '' })
  assert.deepEqual(parkInvite(d, { convoId: 'room', agentDeviceId: 2, initiatorDeviceId: 1, justification: 'y', topic: '' }),
    { ok: false, state: 'awaiting_user' })
  answerParkedInvite(d, { convoId: 'room', agentDeviceId: 2, approve: false })
  assert.equal(getParticipant(d, 'room', 2).state, 'denied')
  assert.equal(parkInvite(d, { convoId: 'room', agentDeviceId: 2, initiatorDeviceId: 1, justification: 'z', topic: '' }).ok, true)
})

test('approve flips to invited and restarts created_at; deny stamps answered_at', () => {
  const d = db()
  parkInvite(d, { convoId: 'room', agentDeviceId: 2, initiatorDeviceId: 1, justification: 'x', topic: '' })
  assert.equal(answerParkedInvite(d, { convoId: 'room', agentDeviceId: 2, approve: true, now: 999 }), true)
  const row = getParticipant(d, 'room', 2)
  assert.equal(row.state, 'invited')
  assert.equal(row.created_at, 999)
  assert.equal(row.delivered_at, null)
  // answering a non-parked row is a no-op
  assert.equal(answerParkedInvite(d, { convoId: 'room', agentDeviceId: 2, approve: false }), false)
})

test('expireInvites only reaps DELIVERED invited rows, clocked by delivered_at', () => {
  const d = db()
  parkInvite(d, { convoId: 'a', agentDeviceId: 2, initiatorDeviceId: 1, justification: 'x', topic: '' })
  answerParkedInvite(d, { convoId: 'a', agentDeviceId: 2, approve: true, now: 0 })
  // undelivered and ancient: must survive
  assert.deepEqual(expireInvites(d, 1000, 1_000_000), [])
  markDelivered(d, { convoId: 'a', agentDeviceId: 2, now: 1_000_000 })
  assert.deepEqual(expireInvites(d, 1000, 1_000_500), [])            // inside window
  assert.equal(expireInvites(d, 1000, 1_002_000).length, 1)          // past window from delivered_at
})

test('expireAwaiting reaps parked rows by created_at', () => {
  const d = db()
  parkInvite(d, { convoId: 'a', agentDeviceId: 2, initiatorDeviceId: 1, justification: 'x', topic: '' })
  assert.deepEqual(expireAwaiting(d, 24 * 3600_000, Date.now()), [])
  const rows = expireAwaiting(d, 0, Date.now() + 1)
  assert.equal(rows.length, 1)
  assert.equal(getParticipant(d, 'a', 2).state, 'expired')
})

test('awaitingCount counts across convos by initiator', () => {
  const d = db()
  parkInvite(d, { convoId: 'a', agentDeviceId: 2, initiatorDeviceId: 1, justification: 'x', topic: '' })
  parkInvite(d, { convoId: 'b', agentDeviceId: 3, initiatorDeviceId: 1, justification: 'x', topic: '' })
  parkInvite(d, { convoId: 'c', agentDeviceId: 4, initiatorDeviceId: 9, justification: 'x', topic: '' })
  assert.equal(awaitingCount(d, 1), 2)
  assert.equal(awaitingCount(d, 9), 1)
})

test('undeliveredInvites lists approved-but-undelivered rows joined to their conversation, and drops rows out after delivery', () => {
  const d = db()
  // Seed a conversations row the way the FK (owner_user_id REFERENCES
  // users(id)) requires — raw INSERT, same style as db.test.js's user seed.
  d.prepare("INSERT INTO users(name, password_hash, created_at) VALUES('u','x',0)").run()
  const userId = d.prepare("SELECT id FROM users WHERE name='u'").get().id
  d.prepare(
    'INSERT INTO conversations(id, owner_user_id, title, session_state, agent_device_id, created_at) VALUES(?,?,?,?,?,?)'
  ).run('room', userId, 'room', 'running', 1, 0)

  // Owner-invite: the room's owning device (1) invites device 2.
  parkInvite(d, { convoId: 'room', agentDeviceId: 2, initiatorDeviceId: 1, justification: 'owner asks', topic: 't1' })
  answerParkedInvite(d, { convoId: 'room', agentDeviceId: 2, approve: true, now: 1 })
  // Self-initiated join request: device 3 is its own row's initiator.
  parkInvite(d, { convoId: 'room', agentDeviceId: 3, initiatorDeviceId: 3, justification: 'let me in', topic: 't2' })
  answerParkedInvite(d, { convoId: 'room', agentDeviceId: 3, approve: true, now: 1 })

  const rows = undeliveredInvites(d)
  assert.equal(rows.length, 2)
  const ownerInvite = rows.find((r) => r.agent_device_id === 2)
  const joinRequest = rows.find((r) => r.agent_device_id === 3)
  assert.equal(ownerInvite.owner_user_id, userId)
  assert.equal(ownerInvite.room_agent_device_id, 1)
  assert.equal(ownerInvite.initiator_device_id, 1)
  assert.equal(joinRequest.owner_user_id, userId)
  assert.equal(joinRequest.room_agent_device_id, 1)
  assert.equal(joinRequest.initiator_device_id, 3, 'self-initiated: initiator === agent_device_id')

  markDelivered(d, { convoId: 'room', agentDeviceId: 2, now: 2 })
  assert.deepEqual(undeliveredInvites(d).map((r) => r.agent_device_id), [3])
  markDelivered(d, { convoId: 'room', agentDeviceId: 3, now: 2 })
  assert.deepEqual(undeliveredInvites(d), [])
})
