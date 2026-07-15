import test from 'node:test'
import assert from 'node:assert/strict'
import { startTestServer } from './helpers.js'
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
    ['created_at', 'cursor', 'device_id', 'is_self', 'kind', 'lag', 'last_seen_at', 'name'])

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
