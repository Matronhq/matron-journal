import test from 'node:test'
import assert from 'node:assert/strict'
import { startTestServer } from './helpers.js'
import { createUser, createAgent } from '../src/auth.js'
import { upsertConversation, append } from '../src/journal.js'
import { createSpawnRequest } from '../src/spawns.js'
import { createRoutine } from '../src/routines.js'
import { setCoordinatorConvoId } from '../src/coordinator.js'
import { inviteParticipant, answerInvite } from '../src/participants.js'
import { WHY_NO_CAUSE } from '../src/ask-cause.js'
import {
  recordCarryOn, recordRoomPublish, originsOf, resolveRelayedAsk, roomHopKey,
  UNCHECKABLE, WHY_RELAY_UNCHECKED, HOP_TTL_MS, ORIGINS_MAX,
} from '../src/cause-hops.js'

const MIN = 60 * 1000
const HOUR = 60 * MIN
const iso = (ms) => new Date(ms).toISOString()

// One server for the file. alice's Coordinator is `coord` on box-c; sessions
// `a` and `b` live on box-a and box-b, and each case makes its own rooms,
// carry-ons and spawns so they never see each other's rows.
let s, alice, bob, boxC, boxA, boxB, who
let n = 0

test.before(async () => {
  s = await startTestServer()
  alice = await createUser(s.db, 'alice', 'pw')
  bob = await createUser(s.db, 'bob', 'pw')
  boxC = createAgent(s.db, alice.id, 'box-c')
  boxA = createAgent(s.db, alice.id, 'box-a')
  boxB = createAgent(s.db, alice.id, 'box-b')
  upsertConversation(s.db, { id: 'coord', ownerUserId: alice.id, title: 'Coordinator', agentDeviceId: boxC.deviceId })
  upsertConversation(s.db, { id: 'a', ownerUserId: alice.id, title: 'A', agentDeviceId: boxA.deviceId })
  upsertConversation(s.db, { id: 'b', ownerUserId: alice.id, title: 'B', agentDeviceId: boxB.deviceId })
  upsertConversation(s.db, { id: 'a2', ownerUserId: alice.id, title: 'A2', agentDeviceId: boxA.deviceId })
  setCoordinatorConvoId(s.db, alice.id, 'coord')
  // The Coordinator approves: its box is the caller.
  who = { kind: 'agent', userId: alice.id, deviceId: boxC.deviceId, name: 'box-c' }
})
test.after(() => s?.close())

// The user's words in a conversation; an agent's line there.
const userSays = (convoId = 'coord', body = 'ask box-a to start a helper') => {
  const { seq } = append(s.db, { userId: alice.id, convoId, sender: 'user:alice', type: 'text', payload: { body } })
  const { ts } = s.db.prepare('SELECT ts FROM events WHERE user_id=? AND seq=?').get(alice.id, seq)
  return { causes: [{ kind: 'user_message', ref: `${convoId}:${seq}` }], ref: `${convoId}:${seq}`, ts }
}
const agentSays = (convoId = 'coord') => {
  const { seq } = append(s.db, { userId: alice.id, convoId, sender: 'agent:box-c', type: 'text', payload: { body: 'The user says: start a helper' } })
  return [{ kind: 'user_message', ref: `${convoId}:${seq}` }]
}
const carryOn = (causes, { to = 'a', now = Date.now() } = {}) => {
  const id = recordCarryOn(s.db, { userId: alice.id, fromConvoId: 'coord', targetConvoId: to, causes, now })
  return [{ kind: 'carry_on', ref: `carry_on:${id}` }]
}
// A room the owner session `owner` (on `ownerDev`) opened with `member`
// (on `memberDev`), both sessions in it.
const room = ({ owner = 'coord', ownerDev = boxC, member = 'b', memberDev = boxB } = {}) => {
  const id = `room-${++n}`
  upsertConversation(s.db, { id, ownerUserId: alice.id, title: 'room', agentDeviceId: ownerDev.deviceId })
  inviteParticipant(s.db, { convoId: id, agentDeviceId: memberDev.deviceId, initiatorDeviceId: ownerDev.deviceId, targetConvoId: member, initiatorConvoId: owner })
  answerInvite(s.db, { convoId: id, agentDeviceId: memberDev.deviceId, accept: true })
  return id
}
// A message `from` (on `dev`) posts into a room, recorded as the publish
// path records it. → the seq.
const post = (roomId, { from, dev, causes, rawCauses }) => {
  const sender = `agent:${dev === boxC ? 'box-c' : dev === boxA ? 'box-a' : 'box-b'}`
  const { seq } = append(s.db, { userId: alice.id, convoId: roomId, sender, type: 'text', payload: { body: 'please ask for a helper' } })
  recordRoomPublish(s.db, { userId: alice.id, deviceId: dev.deviceId, roomId, seq, msg: { from_convo_id: from, ...(rawCauses !== undefined ? { causes: rawCauses } : causes ? { causes } : {}) } })
  return seq
}
const roomCause = (roomId, from, to = from) => [{ kind: 'room_message', ref: from === to ? `room:${roomId}@${from}` : `room:${roomId}@${from}-${to}` }]
const relayed = (causes, { fromConvoId = 'a', createdAt = Date.now() + 1000 } = {}) =>
  resolveRelayedAsk(s.db, { who, userId: alice.id, causes, createdAt, fromConvoId })
const spawn = ({ fromConvoId, causes, state = 'started' }) => {
  const id = `sp_${++n}`
  createSpawnRequest(s.db, { id, userId: alice.id, fromDeviceId: boxA.deviceId, fromConvoId, targetDeviceId: boxB.deviceId, workdir: '/w', task: 't', causes, now: Date.now() })
  s.db.prepare('UPDATE agent_spawn_requests SET state=? WHERE id=?').run(state, id)
  return id
}

test('an ask no Coordinator hop reached is not relayed: answered as before', () => {
  // The session's own words, a reminder, a plain room message, nothing at all.
  assert.deepEqual(relayed(userSays('a').causes), { relayed: false })
  assert.deepEqual(relayed([{ kind: 'reminder' }, { kind: 'alert' }, { kind: 'other' }]), { relayed: false })
  assert.deepEqual(relayed(null), { relayed: false })
  // A room between two ordinary sessions: their messages are not even kept.
  const r = room({ owner: 'a', ownerDev: boxA, member: 'b', memberDev: boxB })
  const seq = post(r, { from: 'a', dev: boxA, causes: userSays('a').causes })
  assert.equal(s.db.prepare('SELECT COUNT(*) AS c FROM cause_hops WHERE room_id=?').get(r).c, 0)
  assert.deepEqual(relayed(roomCause(r, seq), { fromConvoId: 'b' }), { relayed: false })
  // ... nor are messages with no seq from such a room.
  assert.deepEqual(relayed([{ kind: 'room_message', ref: `room:${r}` }], { fromConvoId: 'b' }), { relayed: false })
})

test('carry_on: the Coordinator\'s carry-on on the user\'s words resolves to the user', () => {
  const said = userSays()
  const r = relayed(carryOn(said.causes))
  assert.deepEqual(r, { relayed: true, ok: true, root: { kind: 'user', ref: said.ref, at: said.ts } })
})

test('carry_on: a carry-on whose Coordinator turn had no user act is refused', () => {
  // No causes at all on the Coordinator's turn.
  const bare = carryOn(null)
  assert.deepEqual(relayed(bare), { relayed: true, ok: false, why: `relayed from the Coordinator (${bare[0].ref}): ${WHY_NO_CAUSE}` })
  // A turn a peer's room message started, an alert, an agent's words.
  for (const causes of [[{ kind: 'room_message', ref: 'room:x' }], [{ kind: 'alert' }], agentSays()]) {
    const r = relayed(carryOn(causes))
    assert.equal(r.relayed, true)
    assert.equal(r.ok, false)
    assert.match(r.why, /^relayed from the Coordinator \(carry_on:co_[0-9a-f]{16}\): /)
  }
  // The user's words, but more than 48 h before the ask.
  const old = userSays()
  const r = relayed(carryOn(old.causes), { createdAt: old.ts + 49 * HOUR })
  assert.equal(r.ok, false)
  assert.match(r.why, /48 h/)
})

test('carry_on: a forged, unknown, bare or later carry-on is refused as unchecked', () => {
  const said = userSays()
  // Issued to another session: the cause was never this one's to cite.
  const toOther = carryOn(said.causes, { to: 'a2' })
  assert.deepEqual(relayed(toOther, { fromConvoId: 'a' }), { relayed: true, ok: false, why: WHY_RELAY_UNCHECKED })
  assert.equal(relayed(toOther, { fromConvoId: 'a2' }).ok, true)
  // Unknown id, malformed ref, no ref (a bridge that predates the ref).
  for (const cause of [{ kind: 'carry_on', ref: 'carry_on:co_0000000000000000' }, { kind: 'carry_on', ref: 'carry_on:nope' }, { kind: 'carry_on' }]) {
    assert.deepEqual(relayed([cause]), { relayed: true, ok: false, why: WHY_RELAY_UNCHECKED }, JSON.stringify(cause))
  }
  // Recorded after the ask.
  const later = carryOn(said.causes, { now: Date.now() + HOUR })
  assert.deepEqual(relayed(later), { relayed: true, ok: false, why: WHY_RELAY_UNCHECKED })
  // Another user's carry-on of the same shape is not this user's.
  const id = recordCarryOn(s.db, { userId: bob.id, fromConvoId: 'coord', targetConvoId: 'a', causes: said.causes })
  assert.deepEqual(relayed([{ kind: 'carry_on', ref: `carry_on:${id}` }]), { relayed: true, ok: false, why: WHY_RELAY_UNCHECKED })
})

test('carry_on: one unchecked or failing hop refuses the ask, whatever else the turn had', () => {
  const said = userSays()
  const good = carryOn(said.causes)
  assert.equal(relayed([...good, { kind: 'carry_on' }]).ok, false)
  assert.equal(relayed([...good, ...carryOn(null)]).ok, false)
  // The session's own words beside a failing hop do not save it.
  assert.equal(relayed([...userSays('a').causes, ...carryOn(null)]).ok, false)
})

test('room_message: the Coordinator\'s message on the user\'s words resolves to the user, for a member', () => {
  const said = userSays()
  const r = room()
  const seq = post(r, { from: 'coord', dev: boxC, causes: said.causes })
  const hop = s.db.prepare('SELECT * FROM cause_hops WHERE user_id=? AND key=?').get(alice.id, roomHopKey(r, seq))
  assert.equal(hop.coordinator, 1)
  assert.deepEqual(JSON.parse(hop.causes), said.causes)
  assert.deepEqual(relayed(roomCause(r, seq), { fromConvoId: 'b' }), { relayed: true, ok: true, root: { kind: 'user', ref: said.ref, at: said.ts } })
  // A range that takes it in, as a batch of several messages does.
  assert.equal(relayed(roomCause(r, seq - 3, seq + 3), { fromConvoId: 'b' }).ok, true)
  // A session that is not in the room never got it.
  assert.deepEqual(relayed(roomCause(r, seq), { fromConvoId: 'a' }), { relayed: true, ok: false, why: WHY_RELAY_UNCHECKED })
  // A range that misses it is no relay.
  assert.deepEqual(relayed(roomCause(r, seq + 1, seq + 9), { fromConvoId: 'b' }), { relayed: false })
  // A backwards range is malformed and refused.
  assert.deepEqual(relayed([{ kind: 'room_message', ref: `room:${r}@${seq + 2}-${seq}` }], { fromConvoId: 'b' }), { relayed: true, ok: false, why: WHY_RELAY_UNCHECKED })
})

test('room_message: the Coordinator\'s message in a turn with no user act is refused', () => {
  const r = room()
  for (const causes of [undefined, [{ kind: 'room_message', ref: 'room:elsewhere' }], agentSays()]) {
    const seq = post(r, { from: 'coord', dev: boxC, causes })
    const v = relayed(roomCause(r, seq), { fromConvoId: 'b' })
    assert.equal(v.relayed, true)
    assert.equal(v.ok, false)
    assert.match(v.why, new RegExp(`^relayed from the Coordinator \\(room:${r}@${seq}\\): `))
  }
  // An unusable list on the Coordinator's own message is stored as none.
  const seq = post(r, { from: 'coord', dev: boxC, rawCauses: [{ kind: 'nonsense' }] })
  assert.match(relayed(roomCause(r, seq), { fromConvoId: 'b' }).why, /no turn cause/)
})

test('room_message: no seq from a room the Coordinator spoke in is refused as unchecked', () => {
  const r = room()
  post(r, { from: 'coord', dev: boxC, causes: userSays().causes })
  assert.deepEqual(relayed([{ kind: 'room_message', ref: `room:${r}` }], { fromConvoId: 'b' }), { relayed: true, ok: false, why: WHY_RELAY_UNCHECKED })
  // ... but only lately: two days on, the room reads as quiet again.
  assert.deepEqual(relayed([{ kind: 'room_message', ref: `room:${r}` }], { fromConvoId: 'b', createdAt: Date.now() + 49 * HOUR }), { relayed: false })
})

test('room_message: a publish naming another device\'s session, or the room itself, is not a hop', () => {
  const r = room()
  const { seq } = append(s.db, { userId: alice.id, convoId: r, sender: 'agent:box-b', type: 'text', payload: { body: 'hi' } })
  // box-b claims the Coordinator's conversation as its author.
  assert.equal(recordRoomPublish(s.db, { userId: alice.id, deviceId: boxB.deviceId, roomId: r, seq, msg: { from_convo_id: 'coord', causes: userSays().causes } }), false)
  assert.equal(recordRoomPublish(s.db, { userId: alice.id, deviceId: boxC.deviceId, roomId: r, seq, msg: { from_convo_id: r } }), false)
  assert.equal(recordRoomPublish(s.db, { userId: alice.id, deviceId: boxC.deviceId, roomId: r, seq, msg: { from_convo_id: 5 } }), false)
  assert.equal(recordRoomPublish(s.db, { userId: bob.id, deviceId: boxC.deviceId, roomId: r, seq, msg: { from_convo_id: 'coord' } }), false)
  assert.equal(s.db.prepare('SELECT COUNT(*) AS c FROM cause_hops WHERE room_id=?').get(r).c, 0)
})

test('multi-hop: the Coordinator → session A → session B leads back to the Coordinator', () => {
  const said = userSays()
  // The Coordinator carries A on; A, in that turn, asks B in their room.
  const r = room({ owner: 'a', ownerDev: boxA, member: 'b', memberDev: boxB })
  const co = carryOn(said.causes, { to: 'a' })
  const seq = post(r, { from: 'a', dev: boxA, causes: co })
  const hop = s.db.prepare('SELECT * FROM cause_hops WHERE user_id=? AND key=?').get(alice.id, roomHopKey(r, seq))
  assert.equal(hop.coordinator, 0)
  assert.deepEqual(JSON.parse(hop.origins), [co[0].ref])
  assert.deepEqual(relayed(roomCause(r, seq), { fromConvoId: 'b' }), { relayed: true, ok: true, root: { kind: 'user', ref: said.ref, at: said.ts } })
  // A carry-on with no user act behind it refuses B's ask just the same.
  const bad = post(r, { from: 'a', dev: boxA, causes: carryOn(null, { to: 'a' }) })
  assert.match(relayed(roomCause(r, bad), { fromConvoId: 'b' }).why, /^relayed from the Coordinator \(carry_on:/)
  // A citing a carry-on it was never sent: its message is unchecked.
  const forged = post(r, { from: 'a', dev: boxA, causes: carryOn(said.causes, { to: 'a2' }) })
  assert.deepEqual(JSON.parse(s.db.prepare('SELECT origins FROM cause_hops WHERE key=?').get(roomHopKey(r, forged)).origins), [UNCHECKABLE])
  assert.deepEqual(relayed(roomCause(r, forged), { fromConvoId: 'b' }), { relayed: true, ok: false, why: WHY_RELAY_UNCHECKED })
})

test('multi-hop: a long exchange between two sessions keeps the Coordinator\'s origin without growing', () => {
  const said = userSays()
  const r = room({ owner: 'a', ownerDev: boxA, member: 'b', memberDev: boxB })
  let causes = carryOn(said.causes, { to: 'a' })
  let from = 'a'
  let dev = boxA
  let seq = 0
  // Ten messages back and forth, each in the turn the last one started.
  for (let i = 0; i < 10; i++) {
    seq = post(r, { from, dev, causes })
    causes = roomCause(r, seq)
    ;[from, dev] = from === 'a' ? ['b', boxB] : ['a', boxA]
  }
  assert.equal(relayed(causes, { fromConvoId: from }).ok, true)
  assert.equal(originsOf(s.db, { userId: alice.id, convoId: from, causes, at: Date.now() + 1000 }).length, 1)
})

test('multi-hop: a spawn outcome stands for the causes of the ask it answered', () => {
  const said = userSays()
  const first = spawn({ fromConvoId: 'a', causes: carryOn(said.causes, { to: 'a' }) })
  const r = relayed([{ kind: 'spawn_outcome', ref: `spawn:${first}` }])
  assert.deepEqual(r, { relayed: true, ok: true, root: { kind: 'user', ref: said.ref, at: said.ts } })
  // Another session's spawn is no relay of this one's.
  assert.deepEqual(relayed([{ kind: 'spawn_outcome', ref: `spawn:${first}` }], { fromConvoId: 'b' }), { relayed: false })
  // A chain past the depth limit is unchecked.
  let id = first
  for (let i = 0; i < 4; i++) id = spawn({ fromConvoId: 'a', causes: [{ kind: 'spawn_outcome', ref: `spawn:${id}` }] })
  assert.deepEqual(relayed([{ kind: 'spawn_outcome', ref: `spawn:${id}` }]), { relayed: true, ok: false, why: WHY_RELAY_UNCHECKED })
})

test('a routine root through a relay is a routine root; the user\'s words beside it win', () => {
  const name = `sweep-${++n}`
  const firedAt = Date.now() - MIN
  createRoutine(s.db, { userId: alice.id, origin: 'user', fields: { name, title: 'A sweep', schedule: '0 8 * * *', tz: 'UTC', prompt: 'Do the sweep.', enabled: true } })
  s.db.prepare('UPDATE routines SET last_fired_at=?, envelope=? WHERE user_id=? AND name=?').run(firedAt, JSON.stringify({ spawns_per_fire: 1, chats: false, boxes: null }), alice.id, name)
  const fire = [{ kind: 'routine', ref: `routine:${name}@${iso(firedAt)}` }]
  const viaRoutine = relayed(carryOn(fire))
  assert.equal(viaRoutine.ok, true)
  assert.equal(viaRoutine.root.kind, 'routine')
  assert.equal(viaRoutine.root.routine.name, name)
  const said = userSays()
  assert.equal(relayed([...carryOn(fire), ...carryOn(said.causes)]).root.kind, 'user')
})

test('a list the bridge cut short, or too many Coordinator hops, is unchecked', () => {
  assert.deepEqual(relayed([{ kind: 'other', ref: 'truncated' }]), { relayed: true, ok: false, why: WHY_RELAY_UNCHECKED })
  // ORIGINS_MAX + 1 distinct Coordinator messages in one range.
  const said = userSays()
  const r = room()
  const seqs = Array.from({ length: ORIGINS_MAX + 1 }, () => post(r, { from: 'coord', dev: boxC, causes: said.causes }))
  assert.deepEqual(relayed(roomCause(r, seqs[0], seqs.at(-1)), { fromConvoId: 'b' }), { relayed: true, ok: false, why: WHY_RELAY_UNCHECKED })
  assert.equal(relayed(roomCause(r, seqs[0], seqs[ORIGINS_MAX - 1]), { fromConvoId: 'b' }).ok, true)
})

test('a span of many relays leading back to one Coordinator hop is one origin', () => {
  const said = userSays()
  const r = room({ owner: 'a', ownerDev: boxA, member: 'b', memberDev: boxB })
  const co = carryOn(said.causes, { to: 'a' })
  // A has a long say in one turn the carry-on started: twelve relays.
  const seqs = Array.from({ length: ORIGINS_MAX + 4 }, () => post(r, { from: 'a', dev: boxA, causes: co }))
  assert.deepEqual(relayed(roomCause(r, seqs[0], seqs.at(-1)), { fromConvoId: 'b' }), { relayed: true, ok: true, root: { kind: 'user', ref: said.ref, at: said.ts } })
})

test('hops older than the keep window are pruned on the next write', () => {
  const old = Date.now() - HOP_TTL_MS - HOUR
  const id = recordCarryOn(s.db, { userId: alice.id, fromConvoId: 'coord', targetConvoId: 'a', causes: null, now: old })
  assert.ok(s.db.prepare('SELECT 1 FROM cause_hops WHERE key=?').get(`carry_on:${id}`))
  recordCarryOn(s.db, { userId: alice.id, fromConvoId: 'coord', targetConvoId: 'a', causes: null })
  assert.equal(s.db.prepare('SELECT 1 FROM cause_hops WHERE key=?').get(`carry_on:${id}`), undefined)
})
