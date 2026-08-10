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
