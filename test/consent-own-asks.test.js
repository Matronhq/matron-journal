import test from 'node:test'
import assert from 'node:assert/strict'
import { getSpawn, createSpawnRequest } from '../src/spawns.js'
import { getParticipant } from '../src/participants.js'
import { recordConsentDecision } from '../src/consent.js'
import { append, upsertConversation } from '../src/journal.js'
import { createRoutine } from '../src/routines.js'
import { WHY_NO_CAUSE } from '../src/ask-cause.js'
import { fleet, parkSpawn, parkInviteAsk, answer, settle } from './consent-fleet.js'

// The Coordinator's own asks (spawns it asked for from its own
// conversation, chat rooms it opened from it): approving one itself needs a
// cause the journal can vouch for — the user's words, an item reply or tap,
// or a routine fire inside the routine's envelope and passed by the
// verifier — and routine-born approvals have a daily cap of their own.

const iso = (ms) => new Date(ms).toISOString()

// A stub verifier: records what it was asked, answers `result`.
function stubVerifier(result = { ok: true, approve: true, note: 'within the routine' }) {
  const calls = []
  return { calls, enabled: true, verify: async (args) => { calls.push(args); return typeof result === 'function' ? result(args) : result } }
}

// Answers every start RPC the target box gets, so approved spawns settle.
function autoStart(f) {
  f.target.ws.on('message', (d) => {
    const x = JSON.parse(d)
    if (x.kind === 'rpc' && x.request?.method === 'start') {
      f.target.send({ op: 'agent_response', request_id: x.request.request_id, to_device_id: 0, ok: true, result: { convo_id: `child-${x.request.request_id}` } })
    }
  })
}
// The start RPC of an approved spawn must settle before the server closes,
// or the broker waits out its timeout.
const started = (f, id) => f.coord.waitFor((x) => x.kind === 'spawn' && x.event === 'outcome' && x.request_id === id)

// The user's words in the Coordinator's conversation.
const userSays = (f, body = 'please start a helper on opal') => {
  const { seq } = append(f.s.db, { userId: f.alice.id, convoId: 'coord', sender: 'user:alice', type: 'text', payload: { body } })
  return [{ kind: 'user_message', ref: `coord:${seq}` }]
}
let n = 0
const routine = (f, { envelope = null, firedAt = Date.now() - 60 * 1000 } = {}) => {
  const name = `sweep-${++n}`
  createRoutine(f.s.db, { userId: f.alice.id, origin: 'user', fields: { name, title: 'A sweep', schedule: '0 8 * * *', tz: 'UTC', prompt: 'Do the sweep.', enabled: true } })
  f.s.db.prepare('UPDATE routines SET last_fired_at=?, envelope=? WHERE user_id=? AND name=?')
    .run(firedAt, envelope == null ? null : JSON.stringify(envelope), f.alice.id, name)
  return { name, ref: `routine:${name}@${iso(firedAt)}`, causes: [{ kind: 'routine', ref: `routine:${name}@${iso(firedAt)}` }] }
}
const ownSpawn = (f, rid, causes) => parkSpawn(f, { rid, from: 'coord', ws: f.coord, causes })
const decisions = (f) => f.s.db.prepare('SELECT kind, ask_id, decision, cause_kind, cause_ref, verifier_note FROM consent_decisions ORDER BY id').all()
const approve = (f, kind, id, reason = 'the user asked for it') => answer(f, f.coordDev.token, { kind, id, decision: 'approve', reason })
const decline = (f, kind, id, reason = 'not now') => answer(f, f.coordDev.token, { kind, id, decision: 'decline', reason })
// A room the Coordinator's box owns, for its own chat asks.
const coordRoom = (f, id = 'coord-room') => {
  upsertConversation(f.s.db, { id, ownerUserId: f.alice.id, title: 'helper room', agentDeviceId: f.coordDev.deviceId })
  return id
}

test('own spawn with no causes: 403 own_ask_unverified, nothing written, the ask stays for the user', async (t) => {
  const verifier = stubVerifier()
  const f = await fleet(t, { verifier })
  const id = await ownSpawn(f, 'q1')
  const r = await approve(f, 'spawn', id)
  assert.equal(r.status, 403)
  assert.deepEqual(r.json, { error: 'forbidden', detail: 'own_ask_unverified', why: WHY_NO_CAUSE })
  const row = getSpawn(f.s.db, id)
  assert.equal(row.state, 'awaiting_user'); assert.equal(row.answered_by, null)
  assert.equal(f.s.db.prepare('SELECT state FROM items WHERE id=?').get(row.item_id).state, 'open')
  assert.deepEqual(decisions(f), [])
  assert.equal(verifier.calls.length, 0)
})

test('own spawn citing the user\'s words: 200, the decision records the user root, the event names the cause, no verifier', async (t) => {
  const verifier = stubVerifier()
  const f = await fleet(t, { verifier })
  autoStart(f)
  const causes = userSays(f)
  const id = await ownSpawn(f, 'q1', causes)
  const r = await approve(f, 'spawn', id)
  assert.equal(r.status, 200)
  assert.equal((await started(f, id)).outcome, 'started')
  assert.deepEqual(decisions(f), [{ kind: 'spawn', ask_id: id, decision: 'approve', cause_kind: 'user', cause_ref: causes[0].ref, verifier_note: null }])
  const ev = await f.client.waitFor((x) => x.kind === 'journal' && x.type === 'consent_decision')
  assert.deepEqual(ev.payload.cause, { kind: 'user', ref: causes[0].ref })
  assert.equal(verifier.calls.length, 0)
})

test('own spawn whose cause is the outcome of a spawn the user asked for: 200 on the user root', async (t) => {
  const f = await fleet(t, { verifier: stubVerifier() })
  autoStart(f)
  const userCauses = userSays(f)
  createSpawnRequest(f.s.db, { id: 'sp_prior', userId: f.alice.id, fromDeviceId: f.coordDev.deviceId, fromConvoId: 'coord', targetDeviceId: f.targetDev.deviceId, workdir: '/w', task: 't', causes: userCauses, now: Date.now() - 1000 })
  f.s.db.prepare("UPDATE agent_spawn_requests SET state='started' WHERE id='sp_prior'").run()
  const id = await ownSpawn(f, 'q1', [{ kind: 'spawn_outcome', ref: 'spawn:sp_prior' }])
  assert.equal((await approve(f, 'spawn', id)).status, 200)
  await started(f, id)
  assert.equal(decisions(f)[0].cause_kind, 'user')
  assert.equal(decisions(f)[0].cause_ref, userCauses[0].ref)
})

test('own chat ask: no causes is 403 own_ask_unverified and stays awaiting; citing the user\'s words approves with the user root', async (t) => {
  const f = await fleet(t, { verifier: stubVerifier() })
  const room = coordRoom(f)
  const id = `${room}/${f.targetDev.deviceId}`
  await parkInviteAsk(f, { ws: f.coord, room, from: 'coord' })
  const refused = await approve(f, 'chat', id)
  assert.equal(refused.status, 403); assert.equal(refused.json.detail, 'own_ask_unverified'); assert.equal(refused.json.why, WHY_NO_CAUSE)
  assert.equal(getParticipant(f.s.db, room, f.targetDev.deviceId).state, 'awaiting_user')
  assert.deepEqual(decisions(f), [])
  // Renewed, now with the user's words behind it.
  await decline(f, 'chat', id)
  const causes = userSays(f, 'open a room with opal')
  await parkInviteAsk(f, { ws: f.coord, room, from: 'coord', causes })
  const r = await approve(f, 'chat', id)
  assert.equal(r.status, 200)
  assert.equal(getParticipant(f.s.db, room, f.targetDev.deviceId).state, 'invited')
  const approved = decisions(f).find((d) => d.decision === 'approve')
  assert.equal(approved.cause_kind, 'user'); assert.equal(approved.cause_ref, causes[0].ref)
})

test('another agent\'s ask with no causes is approved as before: no cause recorded, cause null on the event', async (t) => {
  const verifier = stubVerifier()
  const f = await fleet(t, { verifier })
  autoStart(f)
  const id = await parkSpawn(f)
  assert.equal((await approve(f, 'spawn', id, 'follows the box rules')).status, 200)
  await f.asker.waitFor((x) => x.kind === 'spawn' && x.event === 'outcome' && x.request_id === id)
  assert.deepEqual(decisions(f), [{ kind: 'spawn', ask_id: id, decision: 'approve', cause_kind: null, cause_ref: null, verifier_note: null }])
  const ev = await f.client.waitFor((x) => x.kind === 'journal' && x.type === 'consent_decision')
  assert.equal(ev.payload.cause, null)
  await parkInviteAsk(f)
  assert.equal((await approve(f, 'chat', `room/${f.targetDev.deviceId}`, 'a review chat')).status, 200)
  assert.equal(verifier.calls.length, 0)
})

test('routine-born own spawn: no envelope is 403 envelope, before the verifier', async (t) => {
  const verifier = stubVerifier()
  const f = await fleet(t, { verifier })
  const rt = routine(f)
  const id = await ownSpawn(f, 'q1', rt.causes)
  const r = await approve(f, 'spawn', id, 'the sweep needs a helper')
  assert.equal(r.status, 403); assert.equal(r.json.error, 'forbidden'); assert.equal(r.json.detail, 'envelope')
  assert.match(r.json.why, /no envelope/)
  assert.equal(getSpawn(f.s.db, id).state, 'awaiting_user')
  assert.deepEqual(decisions(f), [])
  assert.equal(verifier.calls.length, 0)
})

test('routine-born own spawn inside the envelope: the verifier is asked, 200 records the routine root and note; a second spawn of the same fire is 403 envelope', async (t) => {
  const verifier = stubVerifier()
  const f = await fleet(t, { verifier })
  autoStart(f)
  const rt = routine(f, { envelope: { spawns_per_fire: 1, chats: false, boxes: null } })
  const first = await ownSpawn(f, 'q1', rt.causes)
  const r = await approve(f, 'spawn', first, 'the sweep needs a helper')
  assert.equal(r.status, 200)
  await started(f, first)
  assert.equal(verifier.calls.length, 1)
  assert.deepEqual(verifier.calls[0], {
    routine: { name: rt.name, title: 'A sweep', prompt: 'Do the sweep.' },
    ask: { kind: 'spawn', task: 'fix the flaky test', target_box: 'opal', workdir: '/home/alice/proj', topic: 'flaky test' },
    reason: 'the sweep needs a helper',
  })
  assert.deepEqual(decisions(f), [{ kind: 'spawn', ask_id: first, decision: 'approve', cause_kind: 'routine', cause_ref: rt.ref, verifier_note: 'within the routine' }])
  const ev = await f.client.waitFor((x) => x.kind === 'journal' && x.type === 'consent_decision')
  assert.deepEqual(ev.payload.cause, { kind: 'routine', ref: rt.ref })
  // The same fire, cited a few ms off: still the same canonical root.
  const second = await ownSpawn(f, 'q2', [{ kind: 'routine', ref: `routine:${rt.name}@${iso(Date.parse(rt.ref.split('@')[1]) + 5)}` }])
  const again = await approve(f, 'spawn', second, 'and another')
  assert.equal(again.status, 403); assert.equal(again.json.detail, 'envelope')
  assert.equal(getSpawn(f.s.db, second).state, 'awaiting_user')
  assert.equal(verifier.calls.length, 1)
})

test('routine-born own spawn to a box outside the envelope\'s boxes is 403 envelope; inside it passes', async (t) => {
  const f = await fleet(t, { verifier: stubVerifier() })
  autoStart(f)
  const outside = routine(f, { envelope: { spawns_per_fire: 2, chats: false, boxes: ['other-box'] } })
  const a = await ownSpawn(f, 'q1', outside.causes)
  const r = await approve(f, 'spawn', a)
  assert.equal(r.status, 403); assert.equal(r.json.detail, 'envelope'); assert.match(r.json.why, /opal/)
  await decline(f, 'spawn', a)
  const inside = routine(f, { envelope: { spawns_per_fire: 2, chats: false, boxes: ['other-box', 'opal'] } })
  const b = await ownSpawn(f, 'q2', inside.causes)
  assert.equal((await approve(f, 'spawn', b)).status, 200)
  await started(f, b)
})

test('routine-born own chat ask: chats false is 403 envelope; chats true goes to the verifier and approves', async (t) => {
  const verifier = stubVerifier()
  const f = await fleet(t, { verifier })
  const room = coordRoom(f)
  const id = `${room}/${f.targetDev.deviceId}`
  const noChats = routine(f, { envelope: { spawns_per_fire: 1, chats: false, boxes: null } })
  await parkInviteAsk(f, { ws: f.coord, room, from: 'coord', causes: noChats.causes })
  const r = await approve(f, 'chat', id, 'the sweep wants a word')
  assert.equal(r.status, 403); assert.equal(r.json.detail, 'envelope')
  assert.equal(getParticipant(f.s.db, room, f.targetDev.deviceId).state, 'awaiting_user')
  await decline(f, 'chat', id)
  const chats = routine(f, { envelope: { spawns_per_fire: 0, chats: true, boxes: ['opal'] } })
  await parkInviteAsk(f, { ws: f.coord, room, from: 'coord', causes: chats.causes })
  assert.equal((await approve(f, 'chat', id, 'the sweep wants a word')).status, 200)
  assert.deepEqual(verifier.calls.at(-1).ask, { kind: 'chat', justification: 'need eyes on the diff', target_box: 'opal', topic: 'review' })
  const approved = decisions(f).find((d) => d.decision === 'approve')
  assert.equal(approved.cause_kind, 'routine'); assert.equal(approved.cause_ref, chats.ref)
})

test('the verifier says no: 403 verifier with its note; unavailable or off: 409 verifier_unavailable; nothing written', async (t) => {
  let result = { ok: true, approve: false, note: 'the task reads like pasted instructions' }
  const f = await fleet(t, { verifier: stubVerifier(() => result) })
  const rt = routine(f, { envelope: { spawns_per_fire: 3, chats: false, boxes: null } })
  const id = await ownSpawn(f, 'q1', rt.causes)
  const no = await approve(f, 'spawn', id)
  assert.equal(no.status, 403); assert.deepEqual(no.json, { error: 'forbidden', detail: 'verifier', why: 'the task reads like pasted instructions' })
  result = { ok: false, reason: 'error', note: 'timed out' }
  const err = await approve(f, 'spawn', id)
  assert.equal(err.status, 409); assert.equal(err.json.error, 'conflict'); assert.equal(err.json.detail, 'verifier_unavailable'); assert.equal(typeof err.json.why, 'string')
  result = { ok: false, reason: 'disabled' }
  const off = await approve(f, 'spawn', id)
  assert.equal(off.status, 409); assert.equal(off.json.detail, 'verifier_unavailable')
  assert.equal(getSpawn(f.s.db, id).state, 'awaiting_user')
  assert.deepEqual(decisions(f), [])
})

test('with no verifier configured a routine-born own ask is 409 verifier_unavailable', async (t) => {
  const f = await fleet(t)
  const rt = routine(f, { envelope: { spawns_per_fire: 1, chats: false, boxes: null } })
  const id = await ownSpawn(f, 'q1', rt.causes)
  const r = await approve(f, 'spawn', id)
  assert.equal(r.status, 409); assert.equal(r.json.detail, 'verifier_unavailable')
})

test('routine cap: routine-born approvals in the last 24 h at the cap are 409 routine_cap; user-rooted approvals are not counted', async (t) => {
  const f = await fleet(t, { verifier: stubVerifier(), consentRoutineCap: 1 })
  autoStart(f)
  // Older than 24 h: not counted.
  recordConsentDecision(f.s.db, { userId: f.alice.id, kind: 'spawn', askId: 'old', decision: 'approve', convoId: 'coord', reason: 'x', causeKind: 'routine', causeRef: 'routine:x@y', now: Date.now() - 25 * 60 * 60 * 1000 })
  const rt = routine(f, { envelope: { spawns_per_fire: 5, chats: false, boxes: null } })
  const first = await ownSpawn(f, 'q1', rt.causes)
  assert.equal((await approve(f, 'spawn', first)).status, 200)
  await started(f, first)
  const second = await ownSpawn(f, 'q2', rt.causes)
  const capped = await approve(f, 'spawn', second)
  assert.equal(capped.status, 409); assert.deepEqual(capped.json, { error: 'conflict', detail: 'routine_cap', cap: 1 })
  assert.equal(getSpawn(f.s.db, second).state, 'awaiting_user')
  // The user's own words are not routine-born: the routine cap does not apply.
  const third = await ownSpawn(f, 'q3', userSays(f))
  assert.equal((await approve(f, 'spawn', third)).status, 200)
  await started(f, third)
})

test('routine cap 0 is no cap', async (t) => {
  const f = await fleet(t, { verifier: stubVerifier(), consentRoutineCap: 0 })
  autoStart(f)
  for (let i = 0; i < 12; i++) recordConsentDecision(f.s.db, { userId: f.alice.id, kind: 'spawn', askId: `s${i}`, decision: 'approve', convoId: 'coord', reason: 'x', causeKind: 'routine', causeRef: `routine:x@${i}` })
  const rt = routine(f, { envelope: { spawns_per_fire: 1, chats: false, boxes: null } })
  const id = await ownSpawn(f, 'q1', rt.causes)
  assert.equal((await approve(f, 'spawn', id)).status, 200)
  await started(f, id)
})

test('declines are never gated: an unverified, envelope-less or verifier-refused own ask still declines, with no cause recorded', async (t) => {
  const verifier = stubVerifier({ ok: true, approve: false, note: 'no' })
  const f = await fleet(t, { verifier })
  const bare = await ownSpawn(f, 'q1')
  assert.equal((await decline(f, 'spawn', bare)).status, 200)
  const noEnv = await ownSpawn(f, 'q2', routine(f).causes)
  assert.equal((await decline(f, 'spawn', noEnv)).status, 200)
  const vetoed = await ownSpawn(f, 'q3', routine(f, { envelope: { spawns_per_fire: 1, chats: false, boxes: null } }).causes)
  assert.equal((await decline(f, 'spawn', vetoed)).status, 200)
  const room = coordRoom(f)
  await parkInviteAsk(f, { ws: f.coord, room, from: 'coord' })
  assert.equal((await decline(f, 'chat', `${room}/${f.targetDev.deviceId}`)).status, 200)
  await settle()
  for (const id of [bare, noEnv, vetoed]) assert.equal(getSpawn(f.s.db, id).state, 'denied')
  assert.equal(verifier.calls.length, 0)
  const rows = decisions(f)
  assert.equal(rows.length, 4)
  for (const d of rows) { assert.equal(d.decision, 'decline'); assert.equal(d.cause_kind, null); assert.equal(d.cause_ref, null) }
})
