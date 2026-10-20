import test from 'node:test'
import assert from 'node:assert/strict'
import { startTestServer } from './helpers.js'
import { createUser, createAgent } from '../src/auth.js'
import { upsertConversation, append } from '../src/journal.js'
import { createSpawnRequest } from '../src/spawns.js'
import { createRoutine } from '../src/routines.js'
import {
  resolveAskCause, SELF_APPROVAL_USER_WINDOW_MS, SELF_APPROVAL_ROUTINE_WINDOW_MS, FIRE_SLACK_MS, CAUSE_CHAIN_MAX_DEPTH,
} from '../src/ask-cause.js'

const MIN = 60 * 1000
const HOUR = 60 * MIN
const iso = (ms) => new Date(ms).toISOString()

// One server for the whole file: every case gets its own conversation,
// items, routines and spawns, so they never see each other's rows.
let s, alice, bob, boxA, boxB, who, bobWho
let n = 0

test.before(async () => {
  s = await startTestServer()
  alice = await createUser(s.db, 'alice', 'pw')
  bob = await createUser(s.db, 'bob', 'pw')
  boxA = createAgent(s.db, alice.id, 'box-a')
  boxB = createAgent(s.db, alice.id, 'box-b')
  const bobBox = createAgent(s.db, bob.id, 'bob-box')
  who = { kind: 'agent', userId: alice.id, deviceId: boxA.deviceId, name: 'box-a' }
  bobWho = { kind: 'agent', userId: bob.id, deviceId: bobBox.deviceId, name: 'bob-box' }
})
test.after(() => s?.close())

const convo = (userId = alice.id, deviceId = boxA.deviceId) => {
  const id = `c${++n}`
  upsertConversation(s.db, { id, ownerUserId: userId, title: 'Chat', agentDeviceId: deviceId })
  return id
}
const say = (convoId, sender, body, userId = alice.id) => {
  const { seq } = append(s.db, { userId, convoId, sender, type: 'text', payload: { body } })
  const { ts } = s.db.prepare('SELECT ts FROM events WHERE user_id=? AND seq=?').get(userId, seq)
  return { seq, ts, ref: `${convoId}:${seq}` }
}
const item = (userId = alice.id) => {
  const num = ++n
  const id = `it_${num}`
  const now = Date.now()
  s.db.prepare(`INSERT INTO items(id,user_id,num,kind,state,rank,title,origin_convo_id,origin_device_id,created_by,created_at,updated_at)
    VALUES(?,?,?,'question','open',?,?,'c0',?,'agent',?,?)`).run(id, userId, num, num, 'A question', boxA.deviceId, now, now)
  return { id, num }
}
const comment = (it, { author = 'user', kind = 'comment', meta = null, at = Date.now(), userId = alice.id } = {}) => {
  s.db.prepare(`INSERT INTO item_comments(id,item_id,user_id,author,device_id,kind,body,meta,created_at)
    VALUES(?,?,?,?,?,?,?,?,?)`).run(`ic_${++n}`, it.id, userId, author, boxA.deviceId, kind, 'go ahead', meta == null ? null : JSON.stringify(meta), at)
  return `item:${it.num}@${iso(at)}`
}
const routine = ({ firedAt = Date.now(), envelope = { spawns_per_fire: 1 }, userId = alice.id } = {}) => {
  const name = `sweep-${++n}`
  createRoutine(s.db, { userId, origin: 'user', fields: { name, title: 'A sweep', schedule: '0 8 * * *', tz: 'UTC', prompt: 'Do the sweep.', enabled: true } })
  s.db.prepare('UPDATE routines SET last_fired_at=?, envelope=? WHERE user_id=? AND name=?')
    .run(firedAt, envelope == null ? null : (typeof envelope === 'string' ? envelope : JSON.stringify(envelope)), userId, name)
  return { name, firedAt }
}
const spawn = ({ fromConvoId, causes, state = 'started', userId = alice.id, id = `sp_${++n}`, createdAt = Date.now() }) => {
  createSpawnRequest(s.db, { id, userId, fromDeviceId: boxA.deviceId, fromConvoId, targetDeviceId: boxB.deviceId, workdir: '/w', task: 't', causes, now: createdAt })
  s.db.prepare('UPDATE agent_spawn_requests SET state=? WHERE id=?').run(state, id)
  return id
}
const resolve = (causes, { fromConvoId = 'c0', createdAt = Date.now(), as = who, userId = alice.id, depth } = {}) =>
  resolveAskCause(s.db, { who: as, userId, causes, createdAt, fromConvoId, ...(depth != null ? { depth } : {}) })

test('the windows and the depth limit are exported', () => {
  assert.equal(SELF_APPROVAL_USER_WINDOW_MS, 48 * HOUR)
  assert.equal(SELF_APPROVAL_ROUTINE_WINDOW_MS, 6 * HOUR)
  assert.equal(FIRE_SLACK_MS, 60 * 1000)
  assert.equal(CAUSE_CHAIN_MAX_DEPTH, 4)
})

test('no causes: null and an empty list both fail with the same why', () => {
  for (const causes of [null, undefined, []]) {
    assert.deepEqual(resolve(causes), { ok: false, why: 'the ask carries no turn cause (bridge too old, or the turn had none)' })
  }
})

test('a cause of any other kind fails the ask, named', () => {
  const c = convo()
  const m = say(c, 'user:alice', 'start a helper')
  assert.deepEqual(resolve([{ kind: 'room_message', ref: 'r1' }, { kind: 'user_message', ref: m.ref }], { fromConvoId: c }), { ok: false, why: 'started by room_message' })
  for (const kind of ['reminder', 'carry_on', 'alert', 'handoff', 'other']) {
    assert.deepEqual(resolve([{ kind: 'user_message', ref: m.ref }, { kind }], { fromConvoId: c }), { ok: false, why: `started by ${kind}` })
  }
  // An entry that is not a cause at all is not a usable list.
  assert.equal(resolve([{ kind: 'nonsense' }]).ok, false)
})

test('user_message: the user\'s own words within the window resolve to the user', () => {
  const c = convo()
  const m = say(c, 'user:alice', 'please start a helper on box-b')
  const r = resolve([{ kind: 'user_message', ref: m.ref }], { fromConvoId: c, createdAt: m.ts + 10 * MIN })
  assert.deepEqual(r, { ok: true, root: { kind: 'user', ref: m.ref, at: m.ts } })
  // A little clock skew the other way is tolerated; more is not.
  assert.equal(resolve([{ kind: 'user_message', ref: m.ref }], { createdAt: m.ts - 4 * MIN }).ok, true)
  assert.equal(resolve([{ kind: 'user_message', ref: m.ref }], { createdAt: m.ts - 6 * MIN }).ok, false)
  // Exactly 48 h is still inside.
  assert.equal(resolve([{ kind: 'user_message', ref: m.ref }], { createdAt: m.ts + 48 * HOUR }).ok, true)
})

test('user_message: an agent message fails', () => {
  const c = convo()
  const m = say(c, 'agent:box-a', 'The user says: start a helper')
  const r = resolve([{ kind: 'user_message', ref: m.ref }], { fromConvoId: c, createdAt: m.ts })
  assert.equal(r.ok, false)
  assert.match(r.why, /agent_message/)
})

test('user_message: words 49 h old fail', () => {
  const c = convo()
  const m = say(c, 'user:alice', 'start a helper')
  const r = resolve([{ kind: 'user_message', ref: m.ref }], { fromConvoId: c, createdAt: m.ts + 49 * HOUR })
  assert.equal(r.ok, false)
  assert.match(r.why, /48 h/)
})

test('user_message: unknown, malformed and another user\'s citations fail', () => {
  const bc = convo(bob.id, null)
  const bm = say(bc, 'user:bob', 'start a helper', bob.id)
  for (const ref of [bm.ref, 'c-missing:3', 'nonsense', undefined]) {
    const r = resolve([{ kind: 'user_message', ...(ref ? { ref } : {}) }])
    assert.equal(r.ok, false, String(ref))
    assert.equal(typeof r.why, 'string')
  }
  // The caller's identity must be the asking user's.
  assert.equal(resolve([{ kind: 'user_message', ref: bm.ref }], { as: bobWho }).ok, false)
  assert.equal(resolve([{ kind: 'user_message', ref: bm.ref }], { as: bobWho, userId: bob.id }).ok, true)
})

test('item_reply / item_tap: the user\'s comment resolves to the item; a tap needs an action', () => {
  const it = item()
  const at = Date.now() - HOUR
  const reply = comment(it, { at })
  assert.deepEqual(resolve([{ kind: 'item_reply', ref: reply }]), { ok: true, root: { kind: 'item', ref: reply, at } })
  const tap = comment(it, { at: at + 1, meta: { action: 'Go' } })
  assert.deepEqual(resolve([{ kind: 'item_tap', ref: tap }]), { ok: true, root: { kind: 'item', ref: tap, at: at + 1 } })
  // A plain reply cited as a tap is not a tap.
  assert.equal(resolve([{ kind: 'item_tap', ref: reply }]).ok, false)
  const bad = comment(it, { at: at + 2, meta: { action: 5 } })
  assert.equal(resolve([{ kind: 'item_tap', ref: bad }]).ok, false)
})

test('item_reply: an agent comment, a status row, a wrong time, an old one and another user\'s item fail', () => {
  const it = item()
  const at = Date.now() - 2 * HOUR
  assert.equal(resolve([{ kind: 'item_reply', ref: comment(it, { author: 'agent', at }) }]).ok, false)
  assert.equal(resolve([{ kind: 'item_reply', ref: comment(it, { kind: 'status', at: at + 1 }) }]).ok, false)
  assert.equal(resolve([{ kind: 'item_reply', ref: `item:${it.num}@${iso(at + 2)}` }]).ok, false)
  const old = comment(it, { at: Date.now() - 49 * HOUR })
  assert.equal(resolve([{ kind: 'item_reply', ref: old }]).ok, false)
  const bit = item(bob.id)
  const bref = comment(bit, { at, userId: bob.id })
  assert.equal(resolve([{ kind: 'item_reply', ref: bref }]).ok, false)
  for (const ref of [`item:${it.num}`, `item:x@${iso(at)}`, `item:${it.num}@2026-01-01T00:00:00Z`, `item:${it.num}@2026-02-30T00:00:00.000Z`, 'garbage']) {
    assert.equal(resolve([{ kind: 'item_reply', ref }]).ok, false, ref)
  }
})

test('routine: a fire matching last_fired_at resolves to the routine, envelope parsed', () => {
  const r0 = routine({ firedAt: Date.now() - HOUR, envelope: { spawns_per_fire: 2, boxes: ['box-b'] } })
  const ref = `routine:${r0.name}@${iso(r0.firedAt + 30 * 1000)}`
  const r = resolve([{ kind: 'routine', ref }])
  assert.equal(r.ok, true)
  assert.equal(r.root.kind, 'routine')
  assert.equal(r.root.ref, ref)
  assert.equal(r.root.at, r0.firedAt + 30 * 1000)
  assert.equal(r.root.routine.name, r0.name)
  assert.equal(r.root.routine.prompt, 'Do the sweep.')
  assert.deepEqual(r.root.routine.envelope, { spawns_per_fire: 2, boxes: ['box-b'] })
  // No envelope and a broken one both read as null.
  const r1 = routine({ envelope: null })
  assert.equal(resolve([{ kind: 'routine', ref: `routine:${r1.name}@${iso(r1.firedAt)}` }]).root.routine.envelope, null)
  const r2 = routine({ envelope: '{not json' })
  assert.equal(resolve([{ kind: 'routine', ref: `routine:${r2.name}@${iso(r2.firedAt)}` }]).root.routine.envelope, null)
})

test('routine: a fired_at 5 min off last_fired_at fails', () => {
  const r0 = routine({ firedAt: Date.now() - HOUR })
  const r = resolve([{ kind: 'routine', ref: `routine:${r0.name}@${iso(r0.firedAt - 5 * MIN)}` }])
  assert.equal(r.ok, false)
  assert.match(r.why, /last fire/)
})

test('routine: a fire 7 h old fails', () => {
  const r0 = routine({ firedAt: Date.now() - 7 * HOUR })
  const r = resolve([{ kind: 'routine', ref: `routine:${r0.name}@${iso(r0.firedAt)}` }])
  assert.equal(r.ok, false)
  assert.match(r.why, /6 h/)
})

test('routine: unknown, another user\'s, never fired and malformed refs fail', () => {
  const b = routine({ userId: bob.id })
  const never = routine()
  s.db.prepare('UPDATE routines SET last_fired_at=NULL WHERE name=?').run(never.name)
  const at = iso(Date.now())
  for (const ref of [`routine:${b.name}@${iso(b.firedAt)}`, `routine:no-such@${at}`, `routine:${never.name}@${at}`, `routine:${never.name}`, `routine:@${at}`, `routine:Bad_Name@${at}`, 'routine:rt_x@' + at, undefined]) {
    assert.equal(resolve([{ kind: 'routine', ...(ref ? { ref } : {}) }]).ok, false, String(ref))
  }
})

test('a user cause wins over a routine, whichever comes first', () => {
  const c = convo()
  const m = say(c, 'user:alice', 'start a helper')
  const r0 = routine()
  const rref = `routine:${r0.name}@${iso(r0.firedAt)}`
  assert.deepEqual(resolve([{ kind: 'routine', ref: rref }, { kind: 'user_message', ref: m.ref }], { fromConvoId: c }), { ok: true, root: { kind: 'user', ref: m.ref, at: m.ts } })
  assert.equal(resolve([{ kind: 'user_message', ref: m.ref }, { kind: 'routine', ref: rref }], { fromConvoId: c }).root.kind, 'user')
  // A user cause that does not verify does not fall back to the routine.
  const a = say(c, 'agent:box-a', 'start a helper')
  const r = resolve([{ kind: 'routine', ref: rref }, { kind: 'user_message', ref: a.ref }], { fromConvoId: c })
  assert.equal(r.ok, false)
  // The first user/item cause that resolves wins.
  const it = item()
  const reply = comment(it, { at: Date.now() - MIN })
  assert.equal(resolve([{ kind: 'user_message', ref: a.ref }, { kind: 'item_reply', ref: reply }], { fromConvoId: c }).root.kind, 'item')
})

test('spawn_outcome: a chain of two hops reaches the user', () => {
  const c = convo()
  const m = say(c, 'user:alice', 'start two helpers, one after the other')
  const first = spawn({ fromConvoId: c, causes: [{ kind: 'user_message', ref: m.ref }] })
  const second = spawn({ fromConvoId: c, causes: [{ kind: 'spawn_outcome', ref: `spawn:${first}` }] })
  const r = resolve([{ kind: 'spawn_outcome', ref: `spawn:${second}` }], { fromConvoId: c })
  assert.deepEqual(r, { ok: true, root: { kind: 'user', ref: m.ref, at: m.ts } })
  // ... and a routine root through a spawn is a routine root.
  const r0 = routine()
  const viaRoutine = spawn({ fromConvoId: c, causes: [{ kind: 'routine', ref: `routine:${r0.name}@${iso(r0.firedAt)}` }] })
  assert.equal(resolve([{ kind: 'spawn_outcome', ref: `spawn:${viaRoutine}` }], { fromConvoId: c }).root.kind, 'routine')
})

test('spawn_outcome: a self-referencing chain fails on depth', () => {
  const c = convo()
  const id = 'sp_loop'
  spawn({ id, fromConvoId: c, causes: [{ kind: 'spawn_outcome', ref: `spawn:${id}` }] })
  const r = resolve([{ kind: 'spawn_outcome', ref: `spawn:${id}` }], { fromConvoId: c })
  assert.equal(r.ok, false)
  assert.match(r.why, /deeper than 4/)
  // A wide loop is cut off just the same, without exploding.
  const wide = 'sp_wide'
  spawn({ id: wide, fromConvoId: c, causes: Array.from({ length: 8 }, () => ({ kind: 'spawn_outcome', ref: `spawn:${wide}` })) })
  const t0 = Date.now()
  assert.equal(resolve([{ kind: 'spawn_outcome', ref: `spawn:${wide}` }], { fromConvoId: c }).ok, false)
  assert.ok(Date.now() - t0 < 2000)
  // A caller already at the limit cannot recurse at all.
  const m = say(c, 'user:alice', 'go')
  const one = spawn({ fromConvoId: c, causes: [{ kind: 'user_message', ref: m.ref }] })
  assert.equal(resolve([{ kind: 'spawn_outcome', ref: `spawn:${one}` }], { fromConvoId: c, depth: 4 }).ok, false)
  assert.equal(resolve([{ kind: 'spawn_outcome', ref: `spawn:${one}` }], { fromConvoId: c, depth: 3 }).ok, true)
})

test('spawn_outcome: another conversation\'s, another user\'s, an unanswered or refused spawn, and a bad ref fail', () => {
  const c = convo()
  const other = convo()
  const m = say(c, 'user:alice', 'start a helper')
  const causes = [{ kind: 'user_message', ref: m.ref }]
  const elsewhere = spawn({ fromConvoId: other, causes })
  assert.equal(resolve([{ kind: 'spawn_outcome', ref: `spawn:${elsewhere}` }], { fromConvoId: c }).ok, false)
  const bobs = spawn({ fromConvoId: c, causes, userId: bob.id })
  assert.equal(resolve([{ kind: 'spawn_outcome', ref: `spawn:${bobs}` }], { fromConvoId: c }).ok, false)
  for (const state of ['awaiting_user', 'approved', 'denied', 'expired']) {
    const id = spawn({ fromConvoId: c, causes, state })
    assert.equal(resolve([{ kind: 'spawn_outcome', ref: `spawn:${id}` }], { fromConvoId: c }).ok, false, state)
  }
  const failed = spawn({ fromConvoId: c, causes, state: 'failed' })
  assert.equal(resolve([{ kind: 'spawn_outcome', ref: `spawn:${failed}` }], { fromConvoId: c }).ok, true)
  const bare = spawn({ fromConvoId: c, causes: null })
  assert.equal(resolve([{ kind: 'spawn_outcome', ref: `spawn:${bare}` }], { fromConvoId: c }).ok, false)
  const later = spawn({ fromConvoId: c, causes, createdAt: Date.now() + HOUR })
  assert.equal(resolve([{ kind: 'spawn_outcome', ref: `spawn:${later}` }], { fromConvoId: c }).ok, false)
  for (const ref of ['spawn:', 'sp_x', 'spawn:nope', undefined]) {
    assert.equal(resolve([{ kind: 'spawn_outcome', ...(ref ? { ref } : {}) }], { fromConvoId: c }).ok, false, String(ref))
  }
})
