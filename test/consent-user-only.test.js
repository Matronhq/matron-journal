import test from 'node:test'
import assert from 'node:assert/strict'
import { getSpawn } from '../src/spawns.js'
import { getParticipant } from '../src/participants.js'
import { setDeviceConsentUserOnly } from '../src/db.js'
import { fleet, parkSpawn, parkInviteAsk, pending, answer } from './consent-fleet.js'

// User-only boxes (devices.consent_user_only, matron-admin device consent):
// only the user approves requests that involve such a box. The
// Coordinator's approval of any ask such a box takes part in is refused
// with 403 user_only and the ask stays for the user's tap; the Coordinator
// may still decline, and the user's own answer is untouched.

const decisions = (f) => f.s.db.prepare('SELECT COUNT(*) c FROM consent_decisions').get().c

test('user-only spawn target: listed user_only, approval refused 403 user_only and left parked, decline still allowed', async (t) => {
  const f = await fleet(t)
  setDeviceConsentUserOnly(f.s.db, f.targetDev.deviceId, true)
  const id = await parkSpawn(f)
  const row = (await pending(f, f.coordDev.token)).json.pending.find((p) => p.id === id)
  assert.equal(row.user_only, true)
  const r = await answer(f, f.coordDev.token, { kind: 'spawn', id, decision: 'approve', reason: 'routine' })
  assert.equal(r.status, 403); assert.equal(r.json.detail, 'user_only')
  assert.equal(getSpawn(f.s.db, id).state, 'awaiting_user')
  assert.equal(decisions(f), 0)
  assert.equal((await answer(f, f.coordDev.token, { kind: 'spawn', id, decision: 'decline', reason: 'not mine to approve' })).status, 200)
  assert.equal(getSpawn(f.s.db, id).state, 'denied')
})

test('user-only asker of a spawn: approval refused too', async (t) => {
  const f = await fleet(t)
  setDeviceConsentUserOnly(f.s.db, f.askerDev.deviceId, true)
  const id = await parkSpawn(f)
  const r = await answer(f, f.coordDev.token, { kind: 'spawn', id, decision: 'approve', reason: 'routine' })
  assert.equal(r.status, 403); assert.equal(r.json.detail, 'user_only')
})

test('user-only invitee: chat approval refused and the row stays awaiting_user; the user\'s own tap still approves', async (t) => {
  const f = await fleet(t)
  setDeviceConsentUserOnly(f.s.db, f.targetDev.deviceId, true)
  await parkInviteAsk(f)
  const id = `room/${f.targetDev.deviceId}`
  assert.equal((await pending(f, f.coordDev.token)).json.pending.find((p) => p.id === id).user_only, true)
  const r = await answer(f, f.coordDev.token, { kind: 'chat', id, decision: 'approve', reason: 'routine' })
  assert.equal(r.status, 403); assert.equal(r.json.detail, 'user_only')
  assert.equal(getParticipant(f.s.db, 'room', f.targetDev.deviceId).state, 'awaiting_user')
  assert.equal(decisions(f), 0)
  const tap = await f.s.http('/agent-chat/answer', { method: 'POST', token: f.clientToken, body: { room_id: 'room', target_device_id: f.targetDev.deviceId, decision: 'approve' } })
  assert.equal(tap.status, 200)
  assert.equal(getParticipant(f.s.db, 'room', f.targetDev.deviceId).state, 'invited')
})

test('user-only asker and room owner: chat approval refused; decline allowed', async (t) => {
  const f = await fleet(t)
  setDeviceConsentUserOnly(f.s.db, f.askerDev.deviceId, true)
  await parkInviteAsk(f)
  const id = `room/${f.targetDev.deviceId}`
  const r = await answer(f, f.coordDev.token, { kind: 'chat', id, decision: 'approve', reason: 'routine' })
  assert.equal(r.status, 403); assert.equal(r.json.detail, 'user_only')
  assert.equal((await answer(f, f.coordDev.token, { kind: 'chat', id, decision: 'decline', reason: 'leave it for Alice' })).status, 200)
  assert.equal(getParticipant(f.s.db, 'room', f.targetDev.deviceId).state, 'denied')
})

test('no user-only box involved: no user_only field', async (t) => {
  const f = await fleet(t)
  await parkInviteAsk(f)
  const row = (await pending(f, f.coordDev.token)).json.pending[0]
  assert.equal('user_only' in row, false)
})

test('user-only device but no parked ask: an unknown ask stays 404 and an answered one 409, not 403', async (t) => {
  const f = await fleet(t)
  setDeviceConsentUserOnly(f.s.db, f.targetDev.deviceId, true)
  const unknown = await answer(f, f.coordDev.token, { kind: 'chat', id: `nope/${f.targetDev.deviceId}`, decision: 'approve', reason: 'x' })
  assert.equal(unknown.status, 404)
  await parkInviteAsk(f)
  const id = `room/${f.targetDev.deviceId}`
  assert.equal((await answer(f, f.coordDev.token, { kind: 'chat', id, decision: 'decline', reason: 'leave it' })).status, 200)
  assert.equal((await answer(f, f.coordDev.token, { kind: 'chat', id, decision: 'approve', reason: 'x' })).status, 409)
})
