import test from 'node:test'
import assert from 'node:assert/strict'
import { openDb, pinDevicePrivate } from '../src/db.js'
import { createUser, createAgent } from '../src/auth.js'
import { upsertConversation } from '../src/journal.js'
import { getCoordinatorConvoId, setCoordinatorConvoId, coordinatorFor } from '../src/coordinator.js'
import { startTestServer, makeWsClient } from './helpers.js'

async function seedDb() {
  const db = openDb(':memory:')
  const dan = await createUser(db, 'dan', 'pw')
  const pat = await createUser(db, 'pat', 'pw')
  const agent = createAgent(db, dan.id, 'dev-2')
  upsertConversation(db, { id: 'c1', ownerUserId: dan.id, title: 'C1', agentDeviceId: agent.deviceId })
  upsertConversation(db, { id: 'c2', ownerUserId: dan.id, title: 'C2', agentDeviceId: agent.deviceId })
  upsertConversation(db, { id: 'p1', ownerUserId: pat.id, title: 'P1' })
  return { db, dan, pat, agent }
}

test('user_settings exists with the contract columns', () => {
  const db = openDb(':memory:')
  const cols = db.prepare('PRAGMA table_info(user_settings)').all().map((c) => c.name)
  assert.deepEqual(cols, ['user_id', 'coordinator_convo_id', 'updated_at'])
})

test('coordinator setting: unset reads null; set, unchanged, switch and clear report previous/current/changed', async () => {
  const { db, dan } = await seedDb()
  assert.equal(getCoordinatorConvoId(db, dan.id), null)
  assert.deepEqual(setCoordinatorConvoId(db, dan.id, 'c1', 1000), { previous: null, current: 'c1', changed: true })
  assert.equal(getCoordinatorConvoId(db, dan.id), 'c1')
  assert.deepEqual(setCoordinatorConvoId(db, dan.id, 'c1', 2000), { previous: 'c1', current: 'c1', changed: false })
  assert.equal(db.prepare('SELECT updated_at FROM user_settings WHERE user_id=?').get(dan.id).updated_at, 1000, 'an unchanged write touches nothing')
  assert.deepEqual(setCoordinatorConvoId(db, dan.id, 'c2', 3000), { previous: 'c1', current: 'c2', changed: true })
  assert.deepEqual(setCoordinatorConvoId(db, dan.id, null, 4000), { previous: 'c2', current: null, changed: true })
  assert.equal(getCoordinatorConvoId(db, dan.id), null)
  assert.deepEqual(setCoordinatorConvoId(db, dan.id, null, 5000), { previous: null, current: null, changed: false })
})

test('coordinator setting: a conversation the user does not own is no_convo and writes nothing', async () => {
  const { db, dan } = await seedDb()
  assert.throws(() => setCoordinatorConvoId(db, dan.id, 'p1'), /no_convo/)
  assert.throws(() => setCoordinatorConvoId(db, dan.id, 'nope'), /no_convo/)
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM user_settings').get().n, 0)
})

test('coordinatorFor hides a private-owned coordinator from a filtered caller only', async () => {
  const { db, dan } = await seedDb()
  const priv = createAgent(db, dan.id, 'secret-box')
  pinDevicePrivate(db, priv.deviceId, true)
  upsertConversation(db, { id: 's1', ownerUserId: dan.id, title: 'S1', agentDeviceId: priv.deviceId })
  setCoordinatorConvoId(db, dan.id, 's1')
  assert.equal(coordinatorFor(db, dan.id), 's1')
  assert.equal(coordinatorFor(db, dan.id, { excludePrivateOwned: true }), null)
  setCoordinatorConvoId(db, dan.id, 'c1')
  assert.equal(coordinatorFor(db, dan.id, { excludePrivateOwned: true }), 'c1')
})

async function fleet(t) {
  const s = await startTestServer({})
  t.after(() => s.close())
  const dan = await createUser(s.db, 'dan', 'pw')
  const pat = await createUser(s.db, 'pat', 'pw')
  const agent = createAgent(s.db, dan.id, 'dev-2')
  upsertConversation(s.db, { id: 'c1', ownerUserId: dan.id, title: 'C1', agentDeviceId: agent.deviceId })
  upsertConversation(s.db, { id: 'c2', ownerUserId: dan.id, title: 'C2', agentDeviceId: agent.deviceId })
  upsertConversation(s.db, { id: 'p1', ownerUserId: pat.id, title: 'P1' })
  const login = await s.http('/login', { method: 'POST', body: { username: 'dan', password: 'pw', device_name: 'mac' } })
  return { s, dan, agent, client: login.json.token }
}
const put = (s, token, convoId) => s.http('/coordinator', { method: 'PUT', token, body: { convo_id: convoId } })
const roleEvents = (s) => s.db.prepare("SELECT convo_id, sender, payload FROM events WHERE type='coordinator' ORDER BY seq").all()
  .map((e) => ({ convo_id: e.convo_id, sender: e.sender, role: JSON.parse(e.payload).role }))

test('GET/PUT /coordinator gates: both kinds read; agent PUT 403; foreign/unknown 404; junk 400; nothing written', async (t) => {
  const { s, agent, client } = await fleet(t)
  assert.deepEqual((await s.http('/coordinator', { token: client })).json, { convo_id: null })
  const asAgentGet = await s.http('/coordinator', { token: agent.token })
  assert.equal(asAgentGet.status, 200); assert.deepEqual(asAgentGet.json, { convo_id: null })
  assert.equal((await s.http('/coordinator')).status, 401)
  const asAgent = await put(s, agent.token, 'c1')
  assert.equal(asAgent.status, 403); assert.deepEqual(asAgent.json, { error: 'forbidden' })
  assert.equal((await put(s, client, 'p1')).status, 404, "another user's conversation is not_found")
  assert.equal((await put(s, client, 'nope')).status, 404)
  assert.equal((await s.http('/coordinator', { method: 'PUT', token: client, body: {} })).status, 400)
  assert.equal((await put(s, client, 42)).status, 400)
  assert.equal((await put(s, client, '')).status, 400)
  assert.equal((await put(s, client, 'x'.repeat(10_000))).status, 400)
  assert.deepEqual(roleEvents(s), [])
  assert.equal(s.db.prepare('SELECT COUNT(*) AS n FROM user_settings').get().n, 0)
})

test('PUT /coordinator: assign emits assigned live to the owning bridge; unchanged emits nothing; switch releases then assigns; clear emits released only', async (t) => {
  const { s, agent, client } = await fleet(t)
  const bridge = await makeWsClient(s.base, { token: agent.token, cursor: null })
  await bridge.waitFor((f) => f.op === 'hello_ok')
  let r = await put(s, client, 'c1')
  assert.equal(r.status, 200); assert.deepEqual(r.json, { convo_id: 'c1' })
  const live = await bridge.waitFor((f) => f.kind === 'journal' && f.type === 'coordinator')
  assert.equal(live.convo_id, 'c1'); assert.deepEqual(live.payload, { role: 'assigned' }); assert.equal(live.sender, 'user:dan')
  bridge.close()
  assert.deepEqual(roleEvents(s), [{ convo_id: 'c1', sender: 'user:dan', role: 'assigned' }])

  r = await put(s, client, 'c1')
  assert.equal(r.status, 200); assert.deepEqual(r.json, { convo_id: 'c1' })
  assert.equal(roleEvents(s).length, 1, 'an unchanged PUT emits no events')

  r = await put(s, client, 'c2')
  assert.deepEqual(r.json, { convo_id: 'c2' })
  assert.deepEqual(roleEvents(s).slice(1), [
    { convo_id: 'c1', sender: 'user:dan', role: 'released' },
    { convo_id: 'c2', sender: 'user:dan', role: 'assigned' },
  ])

  r = await put(s, client, null)
  assert.equal(r.status, 200); assert.deepEqual(r.json, { convo_id: null })
  assert.deepEqual(roleEvents(s).slice(3), [{ convo_id: 'c2', sender: 'user:dan', role: 'released' }], 'clearing emits released only')
  await put(s, client, null)
  assert.equal(roleEvents(s).length, 4, 'clearing twice emits nothing the second time')
  assert.deepEqual((await s.http('/coordinator', { token: agent.token })).json, { convo_id: null })
})

test('a coordinator event cannot be forged through an agent publish', async (t) => {
  const { s, agent } = await fleet(t)
  const bridge = await makeWsClient(s.base, { token: agent.token, cursor: null })
  await bridge.waitFor((f) => f.op === 'hello_ok')
  t.after(() => bridge.close())
  bridge.send({ op: 'publish', convo_id: 'c1', type: 'coordinator', payload: { role: 'assigned' } })
  const err = await bridge.waitFor((f) => f.kind === 'control' && f.op === 'error')
  assert.equal(err.code, 'bad_request')
  assert.deepEqual(roleEvents(s), [])
})

test('GET /coordinator hides a private-owned coordinator from an ordinary agent, not from a private one', async (t) => {
  const { s, dan, agent, client } = await fleet(t)
  const priv = createAgent(s.db, dan.id, 'secret-box')
  pinDevicePrivate(s.db, priv.deviceId, true)
  upsertConversation(s.db, { id: 's1', ownerUserId: dan.id, title: 'S1', agentDeviceId: priv.deviceId })
  assert.equal((await put(s, client, 's1')).status, 200)
  assert.deepEqual((await s.http('/coordinator', { token: client })).json, { convo_id: 's1' })
  assert.deepEqual((await s.http('/coordinator', { token: priv.token })).json, { convo_id: 's1' })
  assert.deepEqual((await s.http('/coordinator', { token: agent.token })).json, { convo_id: null })
})
