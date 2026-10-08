import test from 'node:test'
import assert from 'node:assert/strict'
import { openDb } from '../src/db.js'
import { createUser, createAgent } from '../src/auth.js'
import { upsertConversation, append, appendAndBroadcast } from '../src/journal.js'
import {
  PIN_LIMIT, listPins, upsertPin, removePin, reorderPins, movePin, dismissSuccessor, isSuccessorOfAPin, pinLabels,
} from '../src/pins.js'
import { startTestServer, makeWsClient } from './helpers.js'

const at = (db, id, createdAt) => db.prepare('UPDATE conversations SET created_at=? WHERE id=?').run(createdAt, id)

// Alice with a help desk ('desk') on help-desk-1, work on alice-mac, and
// one of Pat's conversations.
async function seedDb() {
  const db = openDb(':memory:')
  const alice = await createUser(db, 'alice', 'pw')
  const pat = await createUser(db, 'pat', 'pw')
  const desk = createAgent(db, alice.id, 'help-desk-1')
  const mac = createAgent(db, alice.id, 'alice-mac')
  upsertConversation(db, { id: 'desk', ownerUserId: alice.id, title: '[aa] Yes, I accept', agentDeviceId: desk.deviceId })
  upsertConversation(db, { id: 'work', ownerUserId: alice.id, title: 'Work', agentDeviceId: mac.deviceId })
  upsertConversation(db, { id: 'p1', ownerUserId: pat.id, title: 'P1' })
  at(db, 'desk', 1000); at(db, 'work', 1000)
  return { db, alice, pat, desk, mac }
}

test('convo_pins: pin, edit, list in order, unpin', async () => {
  const { db, alice, desk } = await seedDb()
  assert.deepEqual(listPins(db, alice.id), [])
  upsertPin(db, alice.id, 'desk', { label: 'Help desk', emoji: '📮' }, 2000)
  upsertPin(db, alice.id, 'work', { label: 'Work' }, 2001)
  let pins = listPins(db, alice.id)
  assert.deepEqual(pins.map((p) => [p.convo_id, p.label, p.emoji, p.position, p.device_id]), [
    ['desk', 'Help desk', '📮', 0, desk.deviceId],
    ['work', 'Work', '', 1, pins[1].device_id],
  ])
  upsertPin(db, alice.id, 'desk', { emoji: '🛟' }, 3000)
  pins = listPins(db, alice.id)
  assert.equal(pins[0].label, 'Help desk', 'an edit without a label keeps it')
  assert.equal(pins[0].emoji, '🛟')
  assert.deepEqual([...pinLabels(db, alice.id)].map(([id, v]) => [id, v.label]), [['desk', 'Help desk'], ['work', 'Work']])
  assert.equal(removePin(db, alice.id, 'desk'), true)
  assert.equal(removePin(db, alice.id, 'desk'), false)
  assert.deepEqual(listPins(db, alice.id).map((p) => p.convo_id), ['work'])
})

test('convo_pins: foreign/unknown conversation, a new pin without a label, and the limit', async () => {
  const { db, alice } = await seedDb()
  assert.throws(() => upsertPin(db, alice.id, 'p1', { label: 'X' }), /no_convo/)
  assert.throws(() => upsertPin(db, alice.id, 'nope', { label: 'X' }), /no_convo/)
  assert.throws(() => upsertPin(db, alice.id, 'desk', { emoji: '📮' }), /no_label/)
  for (let i = 0; i < PIN_LIMIT; i++) {
    upsertConversation(db, { id: `x${i}`, ownerUserId: alice.id, title: `X${i}` })
    upsertPin(db, alice.id, `x${i}`, { label: `X${i}` })
  }
  assert.throws(() => upsertPin(db, alice.id, 'desk', { label: 'Help desk' }), /pin_limit/)
  upsertPin(db, alice.id, 'x0', { label: 'Renamed' })
  assert.equal(listPins(db, alice.id)[0].label, 'Renamed', 'editing at the limit is fine')
})

test('convo_pins: reorder must name every pin exactly once', async () => {
  const { db, alice } = await seedDb()
  upsertPin(db, alice.id, 'desk', { label: 'Desk' })
  upsertPin(db, alice.id, 'work', { label: 'Work' })
  assert.throws(() => reorderPins(db, alice.id, ['desk']), /bad_order/)
  assert.throws(() => reorderPins(db, alice.id, ['desk', 'desk']), /bad_order/)
  assert.throws(() => reorderPins(db, alice.id, ['desk', 'p1']), /bad_order/)
  reorderPins(db, alice.id, ['work', 'desk'])
  assert.deepEqual(listPins(db, alice.id).map((p) => p.convo_id), ['work', 'desk'])
})

test('successor hint: a newer top-level session on the desk box, after the desk last spoke', async () => {
  const { db, alice, desk } = await seedDb()
  upsertPin(db, alice.id, 'desk', { label: 'Help desk' }, 1500)
  append(db, { userId: alice.id, convoId: 'desk', sender: 'agent:help-desk-1', type: 'text', payload: { text: 'hi' } })
  const spoke = db.prepare("SELECT ts FROM events WHERE convo_id='desk'").get().ts
  assert.equal(listPins(db, alice.id)[0].successor, undefined)

  // Started before the desk last spoke: the desk is still alive, no hint.
  upsertConversation(db, { id: 'early', ownerUserId: alice.id, title: 'Early', agentDeviceId: desk.deviceId })
  at(db, 'early', spoke - 1)
  assert.equal(listPins(db, alice.id)[0].successor, undefined)

  // Not candidates: a sub-chat, an agent room, a session on another box.
  upsertConversation(db, { id: 'sub', ownerUserId: alice.id, title: 'Sub', agentDeviceId: desk.deviceId, parentConvoId: 'desk' })
  upsertConversation(db, { id: 'room', ownerUserId: alice.id, title: 'S:aa ↔️ B:de', agentDeviceId: desk.deviceId })
  db.prepare("INSERT INTO convo_agents(convo_id, agent_device_id, initiator_device_id, state, created_at) VALUES('room', ?, ?, 'joined', 1)").run(desk.deviceId, desk.deviceId)
  for (const id of ['sub', 'room']) at(db, id, spoke + 10)
  assert.equal(listPins(db, alice.id)[0].successor, undefined)

  upsertConversation(db, { id: 'new', ownerUserId: alice.id, title: '[bb] Help desk', agentDeviceId: desk.deviceId })
  at(db, 'new', spoke + 20)
  assert.deepEqual(listPins(db, alice.id)[0].successor, { convo_id: 'new', title: '[bb] Help desk', created_at: spoke + 20 })
  assert.equal(isSuccessorOfAPin(db, alice.id, desk.deviceId, 'new'), true)
  assert.equal(isSuccessorOfAPin(db, alice.id, desk.deviceId, 'early'), false)

  // Dismissed: hidden until a newer one starts.
  dismissSuccessor(db, alice.id, 'desk', 'new')
  assert.equal(listPins(db, alice.id)[0].successor, undefined)
  upsertConversation(db, { id: 'newer', ownerUserId: alice.id, title: 'Newer', agentDeviceId: desk.deviceId })
  at(db, 'newer', spoke + 30)
  assert.equal(listPins(db, alice.id)[0].successor.convo_id, 'newer')
})

test('appendAndBroadcast: a message that retracts a hint sends the apps a fresh list; others send none', async () => {
  const { db, alice, desk } = await seedDb()
  upsertPin(db, alice.id, 'desk', { label: 'Help desk' }, 1500)
  upsertConversation(db, { id: 'new', ownerUserId: alice.id, title: 'New', agentDeviceId: desk.deviceId })
  at(db, 'new', Date.now() - 1000)
  assert.equal(listPins(db, alice.id)[0].successor.convo_id, 'new')
  const sent = []
  const hub = { broadcastJournal() {}, sendToClients: (userId, frame) => sent.push([userId, frame]) }
  // Not a message: the hint stands, nothing sent.
  appendAndBroadcast(db, hub, { userId: alice.id, convoId: 'desk', sender: 'journal', type: 'convo_meta', payload: { title: 'x' } })
  assert.equal(sent.length, 0)
  appendAndBroadcast(db, hub, { userId: alice.id, convoId: 'desk', sender: 'agent:help-desk-1', type: 'text', payload: { text: 'still here' } })
  assert.equal(sent.length, 1)
  assert.equal(sent[0][1].kind, 'pins')
  assert.equal(sent[0][1].pins[0].successor, undefined)
  // No hint left to retract: further messages send nothing.
  appendAndBroadcast(db, hub, { userId: alice.id, convoId: 'desk', sender: 'agent:help-desk-1', type: 'text', payload: { text: 'again' } })
  assert.equal(sent.length, 1)
})

test('move keeps label, emoji and position; clears the hint; refuses a pinned or foreign target', async () => {
  const { db, alice, desk } = await seedDb()
  upsertPin(db, alice.id, 'work', { label: 'Work' }, 1500)
  upsertPin(db, alice.id, 'desk', { label: 'Help desk', emoji: '📮' }, 1500)
  upsertConversation(db, { id: 'new', ownerUserId: alice.id, title: 'New', agentDeviceId: desk.deviceId })
  at(db, 'new', 5000)
  assert.equal(listPins(db, alice.id)[1].successor.convo_id, 'new')
  assert.throws(() => movePin(db, alice.id, 'desk', 'p1'), /no_convo/)
  assert.throws(() => movePin(db, alice.id, 'desk', 'work'), /already_pinned/)
  assert.throws(() => movePin(db, alice.id, 'nope', 'new'), /no_pin/)
  movePin(db, alice.id, 'desk', 'new', 6000)
  const [, moved] = listPins(db, alice.id)
  assert.deepEqual([moved.convo_id, moved.label, moved.emoji, moved.position, moved.device_id], ['new', 'Help desk', '📮', 1, desk.deviceId])
  assert.equal(moved.successor, undefined)
})

async function fleet(t) {
  const s = await startTestServer({})
  t.after(() => s.close())
  const alice = await createUser(s.db, 'alice', 'pw')
  const pat = await createUser(s.db, 'pat', 'pw')
  const desk = createAgent(s.db, alice.id, 'help-desk-1')
  upsertConversation(s.db, { id: 'desk', ownerUserId: alice.id, title: '[aa] Yes, I accept', agentDeviceId: desk.deviceId })
  upsertConversation(s.db, { id: 'work', ownerUserId: alice.id, title: 'Work', agentDeviceId: desk.deviceId })
  upsertConversation(s.db, { id: 'p1', ownerUserId: pat.id, title: 'P1' })
  at(s.db, 'desk', 1000); at(s.db, 'work', 1000)
  const login = await s.http('/login', { method: 'POST', body: { username: 'alice', password: 'pw', device_name: 'mac' } })
  return { s, alice, desk, client: login.json.token }
}

test('/pins: client only; validation; 404, 409 and the full list back', async (t) => {
  const { s, desk, client } = await fleet(t)
  assert.equal((await s.http('/pins')).status, 401)
  assert.equal((await s.http('/pins', { token: desk.token })).status, 403)
  assert.equal((await s.http('/pins/desk', { method: 'PUT', token: desk.token, body: { label: 'X' } })).status, 403)
  assert.deepEqual((await s.http('/pins', { token: client })).json, { pins: [], limit: PIN_LIMIT })

  const bad = [
    {}, { label: '' }, { label: '   ' }, { label: 'x'.repeat(25) }, { label: 7 },
    { label: 'Desk', emoji: 'two words' }, { label: 'Desk', emoji: 'x'.repeat(17) }, { label: 'Desk', emoji: 3 },
  ]
  for (const body of bad) assert.equal((await s.http('/pins/desk', { method: 'PUT', token: client, body })).status, 400, JSON.stringify(body))
  assert.equal((await s.http('/pins/desk', { method: 'PUT', token: client, body: { emoji: '📮' } })).status, 400, 'a new pin needs a label')
  assert.equal((await s.http('/pins/p1', { method: 'PUT', token: client, body: { label: 'Pat' } })).status, 404)

  const emojiLabel = await s.http('/pins/work', { method: 'PUT', token: client, body: { label: '📮'.repeat(24) } })
  assert.equal(emojiLabel.status, 200, '24 emoji are 24 characters, not 48 UTF-16 units')
  await s.http('/pins/work', { method: 'DELETE', token: client })
  const r = await s.http('/pins/desk', { method: 'PUT', token: client, body: { label: ' Help\ndesk ', emoji: '📮' } })
  assert.equal(r.status, 200)
  assert.equal(r.json.pins[0].label, 'Help desk', 'one clean line')
  assert.equal(r.json.pins[0].device_id, desk.deviceId)

  assert.equal((await s.http('/pins', { method: 'PUT', token: client, body: { order: ['nope'] } })).status, 400)
  assert.equal((await s.http('/pins/work/move', { method: 'POST', token: client, body: { to_convo_id: 'desk' } })).status, 404)
  await s.http('/pins/work', { method: 'PUT', token: client, body: { label: 'Work' } })
  const dup = await s.http('/pins/work/move', { method: 'POST', token: client, body: { to_convo_id: 'desk' } })
  assert.equal(dup.status, 409); assert.equal(dup.json.detail, 'already_pinned')
  const order = await s.http('/pins', { method: 'PUT', token: client, body: { order: ['work', 'desk'] } })
  assert.deepEqual(order.json.pins.map((p) => p.convo_id), ['work', 'desk'])
  assert.equal((await s.http('/pins/work/dismiss', { method: 'POST', token: client, body: {} })).status, 400)
  assert.equal((await s.http('/pins/work', { method: 'DELETE', token: client })).status, 200)
  assert.equal((await s.http('/pins/work', { method: 'DELETE', token: client })).status, 404)
})

test('/pins: the limit answers 409 with detail and limit', async (t) => {
  const { s, alice, client } = await fleet(t)
  for (let i = 0; i < PIN_LIMIT; i++) {
    upsertConversation(s.db, { id: `x${i}`, ownerUserId: alice.id, title: `X${i}` })
    assert.equal((await s.http(`/pins/x${i}`, { method: 'PUT', token: client, body: { label: `X${i}` } })).status, 200)
  }
  const r = await s.http('/pins/desk', { method: 'PUT', token: client, body: { label: 'Desk' } })
  assert.equal(r.status, 409)
  assert.deepEqual(r.json, { error: 'conflict', detail: 'pin_limit', limit: PIN_LIMIT })
})

test('pins ride /snapshot and hello_ok for clients only, and labels ride /roster', async (t) => {
  const { s, desk, client } = await fleet(t)
  await s.http('/pins/desk', { method: 'PUT', token: client, body: { label: 'Help desk', emoji: '📮' } })
  const snap = (await s.http('/snapshot', { token: client })).json
  assert.deepEqual(snap.pins.map((p) => p.label), ['Help desk'])
  assert.equal('pins' in (await s.http('/snapshot', { token: desk.token })).json, false)
  const roster = (await s.http('/roster', { token: desk.token })).json
  const row = roster.conversations.find((c) => c.id === 'desk')
  assert.deepEqual(row.pin, { label: 'Help desk', emoji: '📮' })
  assert.equal('pin' in roster.conversations.find((c) => c.id === 'work'), false)

  const app = await makeWsClient(s.base, { token: client })
  t.after(() => app.close())
  const hello = await app.waitFor((f) => f.op === 'hello_ok')
  assert.deepEqual(hello.pins.map((p) => p.convo_id), ['desk'])
  const bridge = await makeWsClient(s.base, { token: desk.token })
  t.after(() => bridge.close())
  assert.equal('pins' in (await bridge.waitFor((f) => f.op === 'hello_ok')), false)
})

test('live: every change and a new session on the desk box send {kind:"pins"} to the apps', async (t) => {
  const { s, desk, client } = await fleet(t)
  const app = await makeWsClient(s.base, { token: client })
  t.after(() => app.close())
  await app.waitFor((f) => f.op === 'hello_ok')
  await s.http('/pins/desk', { method: 'PUT', token: client, body: { label: 'Help desk' } })
  const first = await app.waitFor((f) => f.kind === 'pins')
  assert.deepEqual(first.pins.map((p) => p.label), ['Help desk'])

  const bridge = await makeWsClient(s.base, { token: desk.token })
  t.after(() => bridge.close())
  await bridge.waitFor((f) => f.op === 'hello_ok')
  const before = app.frames.filter((f) => f.kind === 'pins').length
  await new Promise((r) => setTimeout(r, 5)) // the new session starts after the pin, never in the same ms
  bridge.send({ op: 'convo_upsert', convo_id: 'fresh', title: '[bb] New help desk', session_state: 'running' })
  const hint = await app.waitFor((f) => f.kind === 'pins' && f.pins[0].successor)
  assert.equal(hint.pins[0].successor.convo_id, 'fresh')
  assert.equal(app.frames.filter((f) => f.kind === 'pins').length, before + 1)

  // The old desk speaks again: the hint no longer holds, and the apps hear so.
  // Further messages there, with no hint left to retract, send nothing.
  await new Promise((r) => setTimeout(r, 5))
  const hinted = app.frames.length
  bridge.send({ op: 'publish', convo_id: 'desk', type: 'text', payload: { text: 'still here' } })
  const cleared = await app.waitFor((f) => app.frames.indexOf(f) >= hinted && f.kind === 'pins')
  assert.equal(cleared.pins[0].successor, undefined)
  assert.equal(cleared.pins[0].convo_id, 'desk')
  const settled = app.frames.filter((f) => f.kind === 'pins').length
  bridge.send({ op: 'publish', convo_id: 'desk', type: 'text', payload: { text: 'and again' } })
  await app.waitFor((f) => f.kind === 'journal' && f.payload?.text === 'and again')
  assert.equal(app.frames.filter((f) => f.kind === 'pins').length, settled)

  await s.http('/pins/desk/move', { method: 'POST', token: client, body: { to_convo_id: 'fresh' } })
  const moved = await app.waitFor((f) => f.kind === 'pins' && f.pins[0].convo_id === 'fresh')
  assert.equal(moved.pins[0].label, 'Help desk')
})
