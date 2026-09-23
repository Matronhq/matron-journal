import test from 'node:test'
import assert from 'node:assert/strict'
import { openDb, pinDevicePrivate } from '../src/db.js'
import { createUser, createAgent } from '../src/auth.js'
import { upsertConversation } from '../src/journal.js'
import { getCoordinatorConvoId, setCoordinatorConvoId, coordinatorFor } from '../src/coordinator.js'

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
