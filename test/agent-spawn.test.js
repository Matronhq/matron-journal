import test from 'node:test'
import assert from 'node:assert/strict'
import { startTestServer, makeWsClient } from './helpers.js'
import { createUser, createAgent } from '../src/auth.js'
import { getSpawn, createSpawnRequest } from '../src/spawns.js'

// Fleet: one user, a parent agent (dev-6), a target agent (eric), a client.
// Parent owns 'parent-convo' — the conversation the consent card lands in.
async function spawnFleet(t, { connectTarget = true, serverOpts = {} } = {}) {
  const s = await startTestServer(serverOpts)
  t.after(() => s.close())
  const dan = await createUser(s.db, 'dan', 'pw')
  const parentDev = createAgent(s.db, dan.id, 'dev-6')
  const targetDev = createAgent(s.db, dan.id, 'eric')
  const login = await s.http('/login', { method: 'POST', body: { username: 'dan', password: 'pw', device_name: 'mac' } })
  const clientToken = login.json.token
  const parent = await makeWsClient(s.base, { token: parentDev.token, cursor: null })
  const target = connectTarget ? await makeWsClient(s.base, { token: targetDev.token, cursor: null }) : null
  const client = await makeWsClient(s.base, { token: clientToken, cursor: null })
  await parent.waitFor((f) => f.op === 'hello_ok')
  if (target) await target.waitFor((f) => f.op === 'hello_ok')
  await client.waitFor((f) => f.op === 'hello_ok')
  t.after(() => { parent.close(); target?.close(); client.close() })
  parent.send({ op: 'convo_upsert', convo_id: 'parent-convo', title: 'parent session', session_state: 'running' })
  await client.waitFor((f) => f.kind === 'journal' && f.type === 'session_status')
  parent.frames.length = 0
  if (target) target.frames.length = 0
  client.frames.length = 0
  const clientDev = { deviceId: login.json.device_id }
  return { s, dan, parentDev, targetDev, clientToken, clientDev, parent, target, client }
}

test('a bridge reply to a journal-originated request settles the broker, not the client relay', async (t) => {
  const { s, dan, targetDev, target } = await spawnFleet(t)
  const p = s.broker.issue(s.hub, dan.id, targetDev.deviceId, 'start', { workdir: '/w', prompt: 'go', room_id: 'r' }, { timeoutMs: 5000 })
  const req = await target.waitFor((f) => f.kind === 'rpc' && f.request?.method === 'start')
  assert.equal(req.request.from_device_id, 0)
  target.send({ op: 'agent_response', request_id: req.request.request_id, to_device_id: req.request.from_device_id, ok: true, result: { convo_id: 'child-1' } })
  assert.deepEqual(await p, { ok: true, result: { convo_id: 'child-1' } })
})

test('a spoofed reply from a different agent device falls through to not_found', async (t) => {
  const { s, dan, parentDev, targetDev, parent, target } = await spawnFleet(t)
  const p = s.broker.issue(s.hub, dan.id, targetDev.deviceId, 'start', {}, { timeoutMs: 1000 })
  const req = await target.waitFor((f) => f.kind === 'rpc' && f.request?.method === 'start')
  // parent (wrong device) tries to answer the target's request
  parent.send({ op: 'agent_response', request_id: req.request.request_id, to_device_id: 0, ok: true, result: { convo_id: 'evil' } })
  const err = await parent.waitFor((f) => f.kind === 'control' && f.op === 'error')
  assert.equal(err.code, 'not_found') // device 0 is no client device — anti-enumeration shape
  const r = await p // then times out (1s) — the spoof never settled it
  assert.deepEqual(r, { ok: false, error: { code: 'timeout' } })
})

const isSpawnCard = (f) => f.kind === 'journal' && f.type === 'permission_request' && f.payload?.kind === 'agent_spawn'

test('spawn_request parks a row, publishes a client-only card into the parent convo, acks pending', async (t) => {
  const { s, parentDev, targetDev, parent, target, client } = await spawnFleet(t)
  parent.send({
    op: 'spawn_request', request_id: 'q1', from_convo_id: 'parent-convo',
    target_device_id: targetDev.deviceId, workdir: '/home/dan/proj',
    task: 'fix the flaky test\nand report back', topic: 'flaky test',
  })
  const ack = await parent.waitFor((f) => f.kind === 'spawn' && f.event === 'pending')
  assert.equal(ack.request_id, 'q1')
  assert.ok(ack.spawn_id)
  const row = getSpawn(s.db, ack.spawn_id)
  assert.equal(row.state, 'awaiting_user')
  assert.equal(row.from_device_id, parentDev.deviceId)
  assert.equal(row.workdir, '/home/dan/proj')
  const card = await client.waitFor(isSpawnCard)
  assert.equal(card.convo_id, 'parent-convo')
  assert.equal(card.payload.request_id, ack.spawn_id)
  assert.equal(card.payload.from_name, 'dev-6')
  assert.equal(card.payload.target_name, 'eric')
  assert.equal(card.payload.workdir, '/home/dan/proj')
  assert.ok(!card.payload.task.includes('\n')) // peer-text discipline: no forged card lines
  // client-only: neither agent may ever see the card
  await new Promise((r) => setTimeout(r, 150))
  assert.equal(parent.frames.find(isSpawnCard), undefined)
  assert.equal(target.frames.find(isSpawnCard), undefined)
})

test('spawn_request against an offline box is refused before any card exists', async (t) => {
  const { s, targetDev, parent, client } = await spawnFleet(t, { connectTarget: false })
  parent.send({
    op: 'spawn_request', request_id: 'q1', from_convo_id: 'parent-convo',
    target_device_id: targetDev.deviceId, workdir: '/w', task: 'x',
  })
  const err = await parent.waitFor((f) => f.kind === 'control' && f.op === 'error')
  assert.equal(err.code, 'agent_unreachable')
  assert.equal(s.db.prepare('SELECT COUNT(*) c FROM agent_spawn_requests').get().c, 0)
  await new Promise((r) => setTimeout(r, 150))
  assert.equal(client.frames.find(isSpawnCard), undefined)
})

test('spawn_request authorization: clients are forbidden; unknown/foreign/client targets are not_found; foreign from_convo_id is not_found', async (t) => {
  const { s, dan, targetDev, clientDev, parent, client } = await spawnFleet(t)
  // client kind cannot issue the op
  client.send({ op: 'spawn_request', request_id: 'q1', from_convo_id: 'parent-convo', target_device_id: targetDev.deviceId, workdir: '/w', task: 'x' })
  const e1 = await client.waitFor((f) => f.kind === 'control' && f.op === 'error')
  assert.equal(e1.code, 'forbidden')
  // unknown target device
  parent.send({ op: 'spawn_request', request_id: 'q2', from_convo_id: 'parent-convo', target_device_id: 9999, workdir: '/w', task: 'x' })
  const e2 = await parent.waitFor((f) => f.kind === 'control' && f.op === 'error')
  assert.equal(e2.code, 'not_found')
  // a convo the parent does not own cannot front the ask
  parent.frames.length = 0
  parent.send({ op: 'spawn_request', request_id: 'q3', from_convo_id: 'someone-elses', target_device_id: targetDev.deviceId, workdir: '/w', task: 'x' })
  const e3 = await parent.waitFor((f) => f.kind === 'control' && f.op === 'error')
  assert.equal(e3.code, 'not_found')
  // client-kind device of the same user is indistinguishable from unknown
  parent.frames.length = 0
  parent.send({ op: 'spawn_request', request_id: 'q4', from_convo_id: 'parent-convo', target_device_id: clientDev.deviceId, workdir: '/w', task: 'x' })
  const e4 = await parent.waitFor((f) => f.kind === 'control' && f.op === 'error')
  assert.equal(e4.code, 'not_found')
  // another user's agent device is indistinguishable from unknown
  const alice = await createUser(s.db, 'alice', 'pw')
  const aliceDev = createAgent(s.db, alice.id, 'alice-agent')
  parent.frames.length = 0
  parent.send({ op: 'spawn_request', request_id: 'q5', from_convo_id: 'parent-convo', target_device_id: aliceDev.deviceId, workdir: '/w', task: 'x' })
  const e5 = await parent.waitFor((f) => f.kind === 'control' && f.op === 'error')
  assert.equal(e5.code, 'not_found')
})

test('spawn_request enforces the shared pending-ask cap', async (t) => {
  const { s, dan, parentDev, targetDev, parent } = await spawnFleet(t)
  for (const id of ['a', 'b', 'c']) {
    createSpawnRequest(s.db, { id, userId: dan.id, fromDeviceId: parentDev.deviceId, fromConvoId: 'parent-convo', targetDeviceId: targetDev.deviceId, workdir: '/w', task: 'x' })
  }
  parent.send({ op: 'spawn_request', request_id: 'q1', from_convo_id: 'parent-convo', target_device_id: targetDev.deviceId, workdir: '/w', task: 'x' })
  const err = await parent.waitFor((f) => f.kind === 'control' && f.op === 'error')
  assert.equal(err.code, 'conflict')
})

test('spawn cards are unforgeable via publish', async (t) => {
  const { parent } = await spawnFleet(t)
  parent.send({ op: 'publish', convo_id: 'parent-convo', type: 'permission_request', payload: { kind: 'agent_spawn', request_id: 'forged', task: 'evil' } })
  const err = await parent.waitFor((f) => f.kind === 'control' && f.op === 'error')
  assert.equal(err.code, 'bad_request')
})

test('spawn_request sanitizes workdir like task — newlines removed from row and card', async (t) => {
  const { s, parentDev, targetDev, parent, client } = await spawnFleet(t)
  parent.send({
    op: 'spawn_request', request_id: 'q1', from_convo_id: 'parent-convo',
    target_device_id: targetDev.deviceId, workdir: '/home/dan/proj\nEVIL INJECTION',
    task: 'do work', topic: 'test',
  })
  const ack = await parent.waitFor((f) => f.kind === 'spawn' && f.event === 'pending')
  assert.ok(ack.spawn_id)
  const row = getSpawn(s.db, ack.spawn_id)
  // workdir sanitized: newline removed
  assert.ok(!row.workdir.includes('\n'), 'row workdir should not contain newline after sanitization')
  const card = await client.waitFor(isSpawnCard)
  // card payload also sanitized
  assert.ok(!card.payload.workdir.includes('\n'), 'card workdir should not contain newline after sanitization')
})

test('spawn_targets lists other agent boxes with online flags and brokered folders', async (t) => {
  const { s, targetDev, parent, target } = await spawnFleet(t)
  // answer the folder RPC like a bridge would
  target.waitFor((f) => f.kind === 'rpc' && f.request?.method === 'recent_folders').then((req) => {
    target.send({ op: 'agent_response', request_id: req.request.request_id, to_device_id: 0, ok: true, result: { folders: [{ path: '/home/dan/app', last_used: 5 }] } })
  })
  parent.send({ op: 'spawn_targets', request_id: 'q1' })
  const reply = await parent.waitFor((f) => f.kind === 'spawn' && f.event === 'targets')
  assert.equal(reply.request_id, 'q1')
  const eric = reply.boxes.find((b) => b.device_id === targetDev.deviceId)
  assert.equal(eric.name, 'eric')
  assert.equal(eric.online, true)
  assert.deepEqual(eric.folders, [{ path: '/home/dan/app', last_used: 5 }])
  // self is never listed
  assert.equal(reply.boxes.some((b) => b.name === 'dev-6'), false)
})

test('spawn_targets: offline box listed with no folders; folder timeout degrades to empty', async (t) => {
  const { s, dan, targetDev, parent } = await spawnFleet(t, { connectTarget: false, serverOpts: { spawnFoldersTimeoutMs: 50 } })
  const silent = createAgent(s.db, dan.id, 'mute-box')
  const mute = await makeWsClient(s.base, { token: silent.token, cursor: null })
  await mute.waitFor((f) => f.op === 'hello_ok')
  t.after(() => mute.close())
  parent.send({ op: 'spawn_targets', request_id: 'q1' })
  const reply = await parent.waitFor((f) => f.kind === 'spawn' && f.event === 'targets', 5000)
  const eric = reply.boxes.find((b) => b.device_id === targetDev.deviceId)
  assert.equal(eric.online, false)      // offline: no RPC even attempted
  assert.deepEqual(eric.folders, [])
  const muteBox = reply.boxes.find((b) => b.name === 'mute-box')
  assert.equal(muteBox.online, true)    // online but never answered: timeout → []
  assert.deepEqual(muteBox.folders, [])
})

test('spawn_targets is agent-only and hides private boxes from ordinary agents', async (t) => {
  const { s, dan, parent, client } = await spawnFleet(t)
  client.send({ op: 'spawn_targets', request_id: 'q1' })
  const err = await client.waitFor((f) => f.kind === 'control' && f.op === 'error')
  assert.equal(err.code, 'forbidden')
  const priv = createAgent(s.db, dan.id, 'secret-box')
  s.db.prepare('UPDATE devices SET private=1 WHERE id=?').run(priv.deviceId)
  parent.frames.length = 0
  parent.send({ op: 'spawn_targets', request_id: 'q2' })
  const reply = await parent.waitFor((f) => f.kind === 'spawn' && f.event === 'targets', 5000)
  assert.equal(reply.boxes.some((b) => b.name === 'secret-box'), false)
})

async function parkedSpawn(t, opts = {}) {
  const fleet = await spawnFleet(t, opts)
  const { targetDev, parent, client } = fleet
  parent.send({
    op: 'spawn_request', request_id: 'q1', from_convo_id: 'parent-convo',
    target_device_id: targetDev.deviceId, workdir: '/w', task: 'do it', topic: 'job',
  })
  const ack = await parent.waitFor((f) => f.kind === 'spawn' && f.event === 'pending')
  await client.waitFor(isSpawnCard)
  parent.frames.length = 0
  client.frames.length = 0
  return { ...fleet, spawnId: ack.spawn_id }
}

test('deny resolves the row and tells the parent plainly: declined', async (t) => {
  const { s, clientToken, parent, spawnId } = await parkedSpawn(t)
  const r = await s.http('/agent-spawn/answer', { method: 'POST', token: clientToken, body: { request_id: spawnId, decision: 'deny' } })
  assert.equal(r.status, 200)
  assert.equal(getSpawn(s.db, spawnId).state, 'denied')
  const out = await parent.waitFor((f) => f.kind === 'spawn' && f.event === 'outcome')
  assert.equal(out.request_id, spawnId)
  assert.equal(out.outcome, 'declined') // spec: no peer to hide behind — a plain no
  // second answer of any kind conflicts
  const again = await s.http('/agent-spawn/answer', { method: 'POST', token: clientToken, body: { request_id: spawnId, decision: 'approve' } })
  assert.equal(again.status, 409)
})

test('answer endpoint gates: agent tokens 403 (even the parent), unknown id 404, always_allow 400', async (t) => {
  const { s, parentDev, clientToken, spawnId } = await parkedSpawn(t)
  const asAgent = await s.http('/agent-spawn/answer', { method: 'POST', token: parentDev.token, body: { request_id: spawnId, decision: 'approve' } })
  assert.equal(asAgent.status, 403)
  const unknown = await s.http('/agent-spawn/answer', { method: 'POST', token: clientToken, body: { request_id: 'no-such-row', decision: 'deny' } })
  assert.equal(unknown.status, 404)
  const standing = await s.http('/agent-spawn/answer', { method: 'POST', token: clientToken, body: { request_id: spawnId, decision: 'approve', always_allow: true } })
  assert.equal(standing.status, 400)
  assert.equal(getSpawn(s.db, spawnId).state, 'awaiting_user') // untouched by the three rejections
})

test("another user's client cannot see or answer the row (404, anti-enumeration)", async (t) => {
  const { s, spawnId } = await parkedSpawn(t)
  const eve = await createUser(s.db, 'eve', 'pw2')
  const evilLogin = await s.http('/login', { method: 'POST', body: { username: 'eve', password: 'pw2', device_name: 'phone' } })
  const r = await s.http('/agent-spawn/answer', { method: 'POST', token: evilLogin.json.token, body: { request_id: spawnId, decision: 'approve' } })
  assert.equal(r.status, 404)
  assert.equal(getSpawn(s.db, spawnId).state, 'awaiting_user')
})

test('approve: room exists BEFORE start rpc; started outcome carries room and child ids', async (t) => {
  const { s, dan, parentDev, targetDev, clientToken, parent, target, client, spawnId } = await parkedSpawn(t)
  // Bridge side of the start rpc: assert the room already exists when the
  // rpc arrives (ordering is load-bearing), then answer like journal-rpc.js
  const bridgeTurn = target.waitFor((f) => f.kind === 'rpc' && f.request?.method === 'start').then((req) => {
    assert.equal(req.request.params.prompt, 'do it')
    assert.equal(req.request.params.workdir, '/w')
    const room = s.db.prepare('SELECT * FROM conversations WHERE id=?').get(req.request.params.room_id)
    assert.ok(room, 'room row must exist before the bridge is asked to spawn')
    assert.equal(room.agent_device_id, parentDev.deviceId) // parent owns the room
    target.send({ op: 'agent_response', request_id: req.request.request_id, to_device_id: 0, ok: true, result: { convo_id: 'child-convo-1' } })
    return req.request.params.room_id
  })
  const r = await s.http('/agent-spawn/answer', { method: 'POST', token: clientToken, body: { request_id: spawnId, decision: 'approve' } })
  assert.equal(r.status, 200)
  const roomId = await bridgeTurn
  const out = await parent.waitFor((f) => f.kind === 'spawn' && f.event === 'outcome')
  assert.equal(out.outcome, 'started')
  assert.equal(out.room_id, roomId)
  assert.equal(out.child_convo_id, 'child-convo-1')
  const row = getSpawn(s.db, spawnId)
  assert.equal(row.state, 'started')
  assert.equal(row.room_id, roomId)
  assert.equal(row.child_convo_id, 'child-convo-1')
  // both ends of the pair are in: parent as recorded owner, target joined
  const joined = s.db.prepare('SELECT agent_device_id, state FROM convo_agents WHERE convo_id=?').all(roomId)
  assert.deepEqual(joined, [{ agent_device_id: targetDev.deviceId, state: 'joined' }])
})

test('approve with the target gone by approval time: failed outcome, room gets the epitaph', async (t) => {
  const { s, clientToken, parent, target, spawnId } = await parkedSpawn(t, { serverOpts: { spawnStartTimeoutMs: 30000 } })
  target.close() // box dies between the card and the tap
  await new Promise((r) => setTimeout(r, 50))
  const r = await s.http('/agent-spawn/answer', { method: 'POST', token: clientToken, body: { request_id: spawnId, decision: 'approve' } })
  assert.equal(r.status, 200)
  const out = await parent.waitFor((f) => f.kind === 'spawn' && f.event === 'outcome', 5000)
  assert.equal(out.outcome, 'failed')
  assert.equal(out.error_code, 'agent_unreachable')
  const row = getSpawn(s.db, spawnId)
  assert.equal(row.state, 'failed')
  // the epitaph line landed in the room (room_id stays null on the FAILED
  // row — it never started — so find the room via the epitaph event itself)
  const epitaph = s.db.prepare("SELECT payload FROM events WHERE type='text' AND sender='journal'").all()
    .map((e) => JSON.parse(e.payload))
  assert.ok(epitaph.some((p) => p.body.includes('spawn failed')))
})

test('start timeout resolves failed — never left hanging', async (t) => {
  const { s, clientToken, parent, spawnId } = await parkedSpawn(t, { serverOpts: { spawnStartTimeoutMs: 100 } })
  // target stays connected but never answers the start rpc
  await s.http('/agent-spawn/answer', { method: 'POST', token: clientToken, body: { request_id: spawnId, decision: 'approve' } })
  const out = await parent.waitFor((f) => f.kind === 'spawn' && f.event === 'outcome', 5000)
  assert.equal(out.outcome, 'failed')
  assert.equal(out.error_code, 'timeout')
  assert.equal(getSpawn(s.db, spawnId).state, 'failed')
})

test('two approve taps spawn once: the loser gets 409 and no second room appears', async (t) => {
  const { s, clientToken, target, spawnId } = await parkedSpawn(t)
  target.waitFor((f) => f.kind === 'rpc' && f.request?.method === 'start').then((req) => {
    target.send({ op: 'agent_response', request_id: req.request.request_id, to_device_id: 0, ok: true, result: { convo_id: 'child-1' } })
  })
  const [a, b] = await Promise.all([
    s.http('/agent-spawn/answer', { method: 'POST', token: clientToken, body: { request_id: spawnId, decision: 'approve' } }),
    s.http('/agent-spawn/answer', { method: 'POST', token: clientToken, body: { request_id: spawnId, decision: 'approve' } }),
  ])
  assert.deepEqual([a.status, b.status].sort(), [200, 409])
  // exactly one room: the parked row's convo plus ONE new conversation
  await new Promise((r) => setTimeout(r, 200))
  const convos = s.db.prepare("SELECT COUNT(*) c FROM conversations WHERE id != 'parent-convo'").get().c
  assert.equal(convos, 1)
})

test('approve claims the row atomically; second approve conflicts', async (t) => {
  // spawnStartTimeoutMs kept short: this test only asserts on the claim
  // (the row's 'approved' state and the second tap's 409), not on the
  // orchestration outcome — nothing here answers the 'start' rpc, so the
  // background approveSpawn() the route fires would otherwise sit on the
  // default 30s timeout well past this test's own teardown.
  const { s, dan, parentDev, targetDev, clientToken } = await spawnFleet(t, { serverOpts: { spawnStartTimeoutMs: 100 } })
  const spawnId = 'test-spawn-id'
  createSpawnRequest(s.db, {
    id: spawnId, userId: dan.id, fromDeviceId: parentDev.deviceId,
    fromConvoId: 'parent-convo', targetDeviceId: targetDev.deviceId,
    workdir: '/w', task: 'test', topic: 'test',
  })
  // First approve claim succeeds
  const r1 = await s.http('/agent-spawn/answer', { method: 'POST', token: clientToken, body: { request_id: spawnId, decision: 'approve' } })
  assert.equal(r1.status, 200)
  const row = getSpawn(s.db, spawnId)
  assert.equal(row.state, 'approved')
  assert.ok(row.answered_at) // timestamp set
  // Second approve attempt conflicts
  const r2 = await s.http('/agent-spawn/answer', { method: 'POST', token: clientToken, body: { request_id: spawnId, decision: 'approve' } })
  assert.equal(r2.status, 409)
})
