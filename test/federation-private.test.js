import test from 'node:test'
import assert from 'node:assert/strict'
import { createAgent } from '../src/auth.js'
import { upsertConversation } from '../src/journal.js'
import { pinDevicePrivate, applyBridgePrivate } from '../src/db.js'
import { world, post, grantOf, incoming, offer } from './federation-world.js'

// A box that turns private takes back what already crossed: each share to
// another journal gets a fresh snapshot, and the copy over there drops what
// the grantee view no longer shows (or the whole mission, when it was the
// mission's own origin box).

async function shared(t) {
  const w = await world(t)
  await w.aliceBox('/items', post({ convo_id: 'work', kind: 'question', title: 'Tomatoes or beans?' }))
  const box = createAgent(w.a.db, w.users.alice.id, 'shed-box')
  upsertConversation(w.a.db, { id: 'shed', ownerUserId: w.users.alice.id, title: 'Shed', agentDeviceId: box.deviceId })
  await w.a.http(`/missions/${w.mission.id}/join`, { token: box.token, ...post({ convo_id: 'shed' }) })
  await w.a.http('/items', { token: box.token, ...post({ convo_id: 'shed', kind: 'task', title: 'From the shed' }) })
  await w.a.http('/milestones', { token: box.token, ...post({ convo_id: 'shed', kind: 'progress', title: 'Shed cleared' }) })
  const g = await offer(w)
  await w.phones.bob(`/grants/${incoming(w.b)[0].id}/answer`, post({ decision: 'approve' }))
  await w.settle()
  assert.equal(grantOf(w.a, g.id).state, 'active')
  return { w, g, box }
}

const bobItems = async (w) => (await w.phones.bob('/items?scope=shared')).json.items.map((i) => i.title).sort()
const bobMissions = async (w) => (await w.phones.bob('/missions?scope=shared')).json.missions
const bobMilestones = async (w) => {
  const [m] = await bobMissions(w)
  return (await w.phones.bob(`/missions/${m.id}`)).json.milestones.map((l) => l.title)
}

test('a box that turns private takes its records back out of the copy, and they return when it is ordinary again', async (t) => {
  const { w, box } = await shared(t)
  assert.deepEqual(await bobItems(w), ['From the shed', 'Tomatoes or beans?'])
  assert.deepEqual(await bobMilestones(w), ['Shed cleared'])
  // The admin's pin, from another process: only the database changes.
  pinDevicePrivate(w.a.db, box.deviceId, true)
  assert.equal(w.a.db.prepare('SELECT COUNT(*) AS n FROM fed_resnapshot').get().n, 1)
  await w.settle()
  assert.equal(w.a.db.prepare('SELECT COUNT(*) AS n FROM fed_resnapshot').get().n, 0)
  assert.deepEqual(await bobItems(w), ['Tomatoes or beans?'])
  assert.deepEqual(await bobMilestones(w), [])
  pinDevicePrivate(w.a.db, box.deviceId, false)
  await w.settle()
  assert.deepEqual(await bobItems(w), ['From the shed', 'Tomatoes or beans?'])
})

test('the bridge\'s own flag does the same, and an unchanged flag sends nothing', async (t) => {
  const { w, box } = await shared(t)
  const snapshots = () => w.a.db.prepare("SELECT COUNT(*) AS n FROM fed_outbox WHERE op='mission.snapshot'").get().n
  const before = snapshots()
  applyBridgePrivate(w.a.db, box.deviceId, false)
  await w.settle()
  assert.equal(snapshots(), before, 'no change, no snapshot')
  // The box's first hello was without the flag, so it may not raise it:
  // a fresh box is the one that can.
  const quiet = createAgent(w.a.db, w.users.alice.id, 'quiet-box')
  applyBridgePrivate(w.a.db, quiet.deviceId, true)
  await w.settle()
  assert.equal(snapshots(), before + 1)
})

test('when the mission\'s own box turns private the whole copy goes, and the share stands', async (t) => {
  const { w, g } = await shared(t)
  assert.equal((await bobMissions(w)).length, 1)
  const origin = w.a.db.prepare("SELECT id FROM devices WHERE name='alice-box'").get().id
  pinDevicePrivate(w.a.db, origin, true)
  await w.settle()
  assert.equal((await bobMissions(w)).length, 0)
  assert.deepEqual(await bobItems(w), [])
  assert.equal(w.b.db.prepare('SELECT COUNT(*) AS n FROM fed_replica_milestones').get().n, 0)
  assert.equal(incoming(w.b)[0].state, 'active')
  assert.equal(grantOf(w.a, g.id).state, 'active')
  const withheld = w.a.db.prepare("SELECT body FROM fed_outbox WHERE op='mission.snapshot' ORDER BY rowid DESC").get()
  assert.deepEqual(Object.keys(JSON.parse(withheld.body)).sort(), ['grant', 'items', 'milestones', 'mission', 'page', 'pages', 'snap'])
  assert.ok(!withheld.body.includes('Garden Club'), 'not even the title crosses')
  pinDevicePrivate(w.a.db, origin, false)
  await w.settle()
  assert.equal((await bobMissions(w))[0].title, 'Garden Club')
})
