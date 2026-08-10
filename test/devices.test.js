import test from 'node:test'
import assert from 'node:assert/strict'
import { startTestServer, makeWsClient } from './helpers.js'
import { createUser, createAgent } from '../src/auth.js'

test('GET /devices lists only the caller user devices, marks is_self, gates agents', async (t) => {
  const s = await startTestServer()
  t.after(() => s.close())
  const dan = await createUser(s.db, 'dan', 'hunter22')
  const agent = createAgent(s.db, dan.id, 'dev-9')
  await createUser(s.db, 'pat', 'password')
  const patLogin = await s.http('/login', { method: 'POST', body: { username: 'pat', password: 'password', device_name: 'pat-phone' } })

  const login = await s.http('/login', { method: 'POST', body: { username: 'dan', password: 'hunter22', device_name: 'dan-mac' } })
  const r = await s.http('/devices', { token: login.json.token })
  assert.equal(r.status, 200)
  // dan has exactly two devices: the agent and this client — never pat's
  assert.equal(r.json.devices.length, 2)
  const kinds = r.json.devices.map((d) => d.kind).sort()
  assert.deepEqual(kinds, ['agent', 'client'])
  const self = r.json.devices.find((d) => d.is_self)
  assert.equal(self.device_id, login.json.device_id)
  assert.equal(self.name, 'dan-mac')
  const agentRow = r.json.devices.find((d) => d.kind === 'agent')
  assert.equal(agentRow.is_self, false)
  assert.equal(agentRow.name, 'dev-9')
  // roster shape: exactly these keys, no token_hash/user_id leakage
  assert.deepEqual(Object.keys(agentRow).sort(),
    ['connected', 'created_at', 'cursor', 'device_id', 'is_self', 'kind', 'lag', 'last_seen_at', 'name', 'push_prefs'])

  // agent bearers are gated like /password: 403 forbidden
  const asAgent = await s.http('/devices', { token: agent.token })
  assert.equal(asAgent.status, 403)
  assert.deepEqual(asAgent.json, { error: 'forbidden' })

  // pat sees only pat's device
  const patR = await s.http('/devices', { token: patLogin.json.token })
  assert.equal(patR.json.devices.length, 1)
  assert.equal(patR.json.devices[0].name, 'pat-phone')

  // unauthenticated: 401
  assert.equal((await s.http('/devices', {})).status, 401)
})

test('POST /devices/:id/revoke: owner-scoped, 404 for not-owned/nonexistent, self-revoke works', async (t) => {
  const s = await startTestServer()
  t.after(() => s.close())
  const dan = await createUser(s.db, 'dan', 'hunter22')
  const agent = createAgent(s.db, dan.id, 'dev-9')
  await createUser(s.db, 'pat', 'password')
  const pat = await s.http('/login', { method: 'POST', body: { username: 'pat', password: 'password', device_name: 'x' } })
  const dan1 = await s.http('/login', { method: 'POST', body: { username: 'dan', password: 'hunter22', device_name: 'mac' } })

  // pat cannot revoke dan's agent — 404, indistinguishable from nonexistent
  const notOwned = await s.http(`/devices/${agent.deviceId}/revoke`, { method: 'POST', token: pat.json.token })
  assert.equal(notOwned.status, 404)
  assert.deepEqual(notOwned.json, { error: 'not_found' })
  const nonexistent = await s.http('/devices/999999/revoke', { method: 'POST', token: dan1.json.token })
  assert.equal(nonexistent.status, 404)
  assert.deepEqual(nonexistent.json, { error: 'not_found' })

  // agents cannot revoke anything: 403 before any lookup
  const asAgent = await s.http(`/devices/${dan1.json.device_id}/revoke`, { method: 'POST', token: agent.token })
  assert.equal(asAgent.status, 403)

  // owner revokes the agent: row gone, token dead on next use
  const ok = await s.http(`/devices/${agent.deviceId}/revoke`, { method: 'POST', token: dan1.json.token })
  assert.equal(ok.status, 200)
  assert.deepEqual(ok.json, { ok: true })
  assert.equal((await s.http('/snapshot', { token: agent.token })).status, 401)
  // idempotence surface: revoking again is 404 (row no longer exists)
  assert.equal((await s.http(`/devices/${agent.deviceId}/revoke`, { method: 'POST', token: dan1.json.token })).status, 404)

  // self-revocation is allowed (it is a logout) — the very token used dies
  const self = await s.http(`/devices/${dan1.json.device_id}/revoke`, { method: 'POST', token: dan1.json.token })
  assert.equal(self.status, 200)
  assert.equal((await s.http('/devices', { token: dan1.json.token })).status, 401)
})

test('GET /devices connected reflects live WS sockets', async (t) => {
  const s = await startTestServer()
  t.after(() => s.close())
  const dan = await createUser(s.db, 'dan', 'pw')
  const ag = createAgent(s.db, dan.id, 'dev-2')
  const login = await s.http('/login', { method: 'POST', body: { username: 'dan', password: 'pw', device_name: 'mac' } })

  let r = await s.http('/devices', { token: login.json.token })
  assert.equal(r.json.devices.find((d) => d.kind === 'agent').connected, false)
  // The HTTP-only caller itself holds no socket either:
  assert.equal(r.json.devices.find((d) => d.is_self).connected, false)

  const agentWs = await makeWsClient(s.base, { token: ag.token, cursor: null })
  await agentWs.waitFor((f) => f.op === 'hello_ok')
  r = await s.http('/devices', { token: login.json.token })
  assert.equal(r.json.devices.find((d) => d.kind === 'agent').connected, true)

  agentWs.close()
  // close propagates asynchronously — poll until the hub unregisters it
  for (let i = 0; i < 100; i++) {
    r = await s.http('/devices', { token: login.json.token })
    if (r.json.devices.find((d) => d.kind === 'agent').connected === false) break
    await new Promise((res) => setTimeout(res, 20))
  }
  assert.equal(r.json.devices.find((d) => d.kind === 'agent').connected, false)
})

test('POST /devices/:id/rename: renames, sanitises, caps, owner-scoped, client-gated', async (t) => {
  const s = await startTestServer()
  t.after(() => s.close())
  const dan = await createUser(s.db, 'dan', 'hunter22')
  const agent = createAgent(s.db, dan.id, 'dev-9')
  await createUser(s.db, 'pat', 'password')
  const pat = await s.http('/login', { method: 'POST', body: { username: 'pat', password: 'password', device_name: 'x' } })
  const login = await s.http('/login', { method: 'POST', body: { username: 'dan', password: 'hunter22', device_name: 'dan-mac' } })
  const token = login.json.token

  // happy path
  const ok = await s.http(`/devices/${agent.deviceId}/rename`, { method: 'POST', token, body: { name: 'dev-y' } })
  assert.equal(ok.status, 200)
  assert.deepEqual(ok.json, { ok: true, device: { device_id: agent.deviceId, name: 'dev-y' } })
  const roster = await s.http('/devices', { token })
  assert.equal(roster.json.devices.find((d) => d.device_id === agent.deviceId).name, 'dev-y')

  // a client device (including self) may be renamed too
  const self = await s.http(`/devices/${login.json.device_id}/rename`, { method: 'POST', token, body: { name: 'Dan Mac' } })
  assert.equal(self.status, 200)
  assert.equal(self.json.device.name, 'Dan Mac')

  // control characters and newlines are flattened, surrounding space trimmed
  const dirty = await s.http(`/devices/${agent.deviceId}/rename`, { method: 'POST', token, body: { name: '  dev\n\ty  ' } })
  assert.equal(dirty.status, 200)
  assert.equal(dirty.json.device.name, 'dev y')

  // duplicate names are allowed (pairing only warns)
  const dup = await s.http(`/devices/${agent.deviceId}/rename`, { method: 'POST', token, body: { name: 'dan-mac' } })
  assert.equal(dup.status, 200)

  // empty / whitespace-only / non-string / >40 chars -> 400
  for (const name of ['', '   ', 42, null, undefined, 'x'.repeat(41)]) {
    const r = await s.http(`/devices/${agent.deviceId}/rename`, { method: 'POST', token, body: { name } })
    assert.equal(r.status, 400, `expected 400 for ${JSON.stringify(name)}`)
    assert.deepEqual(r.json, { error: 'bad_request' })
  }
  // exactly 40 is accepted
  const at40 = await s.http(`/devices/${agent.deviceId}/rename`, { method: 'POST', token, body: { name: 'y'.repeat(40) } })
  assert.equal(at40.status, 200)

  // not owned / nonexistent -> 404, indistinguishable
  const notOwned = await s.http(`/devices/${agent.deviceId}/rename`, { method: 'POST', token: pat.json.token, body: { name: 'mine now' } })
  assert.equal(notOwned.status, 404)
  assert.deepEqual(notOwned.json, { error: 'not_found' })
  const missing = await s.http('/devices/999999/rename', { method: 'POST', token, body: { name: 'ghost' } })
  assert.equal(missing.status, 404)

  // agent bearers are gated like /password
  const asAgent = await s.http(`/devices/${agent.deviceId}/rename`, { method: 'POST', token: agent.token, body: { name: 'self-serve' } })
  assert.equal(asAgent.status, 403)
  assert.deepEqual(asAgent.json, { error: 'forbidden' })

  // unauthenticated -> 401
  assert.equal((await s.http(`/devices/${agent.deviceId}/rename`, { method: 'POST', body: { name: 'x' } })).status, 401)
})

test('rename fans out device_meta to client sockets only', async (t) => {
  const s = await startTestServer()
  t.after(() => s.close())
  const dan = await createUser(s.db, 'dan', 'hunter22')
  const agent = createAgent(s.db, dan.id, 'dev-9')
  await createUser(s.db, 'pat', 'password')
  const patLogin = await s.http('/login', { method: 'POST', body: { username: 'pat', password: 'password', device_name: 'pat-phone' } })
  const login = await s.http('/login', { method: 'POST', body: { username: 'dan', password: 'hunter22', device_name: 'mac' } })

  const client = await makeWsClient(s.base, { token: login.json.token, cursor: 0 })
  t.after(() => client.close())
  const box = await makeWsClient(s.base, { token: agent.token, cursor: 0 })
  t.after(() => box.close())
  const stranger = await makeWsClient(s.base, { token: patLogin.json.token, cursor: 0 })
  t.after(() => stranger.close())

  const r = await s.http(`/devices/${agent.deviceId}/rename`, { method: 'POST', token: login.json.token, body: { name: 'dev-y' } })
  assert.equal(r.status, 200)

  const frame = await client.waitFor((f) => f.kind === 'device_meta')
  assert.deepEqual(frame, { kind: 'device_meta', device_id: agent.deviceId, name: 'dev-y' })
  // agents never receive it (a box has no roster to update), and another
  // user's socket never sees it at all
  await new Promise((res) => setTimeout(res, 150))
  assert.equal(box.frames.filter((f) => f.kind === 'device_meta').length, 0)
  assert.equal(stranger.frames.filter((f) => f.kind === 'device_meta').length, 0)
})
