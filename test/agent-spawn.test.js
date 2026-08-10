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
  return { s, dan, parentDev, targetDev, clientToken, parent, target, client }
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
  const { s, dan, targetDev, parent, client } = await spawnFleet(t)
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
