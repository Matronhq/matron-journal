import test from 'node:test'
import assert from 'node:assert/strict'
import { openDb } from '../src/db.js'
import { createUser, createAgent } from '../src/auth.js'
import {
  createSpawnRequest, getSpawn, denySpawn, claimApprove,
  markStarted, markFailed, expireSpawns,
} from '../src/spawns.js'

async function seed() {
  const db = openDb(':memory:')
  const dan = await createUser(db, 'dan', 'pw')
  const parent = createAgent(db, dan.id, 'dev-6')
  const target = createAgent(db, dan.id, 'eric')
  return { db, dan, parent, target }
}

function makeRow(db, dan, parent, target, id = 'spawn-1', now = 1000) {
  createSpawnRequest(db, {
    id, userId: dan.id, fromDeviceId: parent.deviceId, fromConvoId: 'parent-convo',
    targetDeviceId: target.deviceId, workdir: '/home/dan/proj', task: 'do the thing', topic: 'thing', now,
  })
}

test('createSpawnRequest lands in awaiting_user with every field', async () => {
  const { db, dan, parent, target } = await seed()
  makeRow(db, dan, parent, target)
  const row = getSpawn(db, 'spawn-1')
  assert.equal(row.state, 'awaiting_user')
  assert.equal(row.user_id, dan.id)
  assert.equal(row.from_device_id, parent.deviceId)
  assert.equal(row.from_convo_id, 'parent-convo')
  assert.equal(row.target_device_id, target.deviceId)
  assert.equal(row.workdir, '/home/dan/proj')
  assert.equal(row.task, 'do the thing')
  assert.equal(row.topic, 'thing')
  assert.equal(row.created_at, 1000)
  assert.equal(row.answered_at, null)
  assert.equal(row.resolved_at, null)
})

test('claimApprove wins exactly once; denySpawn cannot follow a claim', async () => {
  const { db, dan, parent, target } = await seed()
  makeRow(db, dan, parent, target)
  assert.equal(claimApprove(db, 'spawn-1', 2000), true)
  assert.equal(getSpawn(db, 'spawn-1').state, 'approved')
  assert.equal(getSpawn(db, 'spawn-1').answered_at, 2000)
  assert.equal(claimApprove(db, 'spawn-1', 2001), false) // second tap loses
  assert.equal(denySpawn(db, 'spawn-1', 2002), false)    // deny after claim loses too
})

test('denySpawn resolves an awaiting row; approve cannot follow', async () => {
  const { db, dan, parent, target } = await seed()
  makeRow(db, dan, parent, target)
  assert.equal(denySpawn(db, 'spawn-1', 2000), true)
  const row = getSpawn(db, 'spawn-1')
  assert.equal(row.state, 'denied')
  assert.equal(row.answered_at, 2000)
  assert.equal(row.resolved_at, 2000)
  assert.equal(claimApprove(db, 'spawn-1', 2001), false)
})

test('markStarted/markFailed only fire from approved, and record the terminal facts', async () => {
  const { db, dan, parent, target } = await seed()
  makeRow(db, dan, parent, target)
  assert.equal(markStarted(db, 'spawn-1', { roomId: 'r', childConvoId: 'c', now: 3000 }), false) // not approved yet
  claimApprove(db, 'spawn-1', 2000)
  assert.equal(markStarted(db, 'spawn-1', { roomId: 'room-1', childConvoId: 'child-1', now: 3000 }), true)
  const row = getSpawn(db, 'spawn-1')
  assert.equal(row.state, 'started')
  assert.equal(row.room_id, 'room-1')
  assert.equal(row.child_convo_id, 'child-1')
  assert.equal(row.resolved_at, 3000)
  assert.equal(markFailed(db, 'spawn-1', 3001), false) // already terminal

  makeRow(db, dan, parent, target, 'spawn-2')
  claimApprove(db, 'spawn-2', 2000)
  assert.equal(markFailed(db, 'spawn-2', 3000), true)
  assert.equal(getSpawn(db, 'spawn-2').state, 'failed')
})

test('expireSpawns flips only stale awaiting rows and reports who to tell', async () => {
  const { db, dan, parent, target } = await seed()
  makeRow(db, dan, parent, target, 'old', 1000)
  makeRow(db, dan, parent, target, 'fresh', 900000)
  makeRow(db, dan, parent, target, 'claimed', 1000)
  claimApprove(db, 'claimed', 2000)
  const expired = expireSpawns(db, 100000, 500000) // ttl 100s at t=500s: only 'old' is stale
  assert.deepEqual(expired.map((r) => r.id), ['old'])
  assert.equal(expired[0].user_id, dan.id)
  assert.equal(expired[0].from_device_id, parent.deviceId)
  assert.equal(getSpawn(db, 'old').state, 'expired')
  assert.equal(getSpawn(db, 'fresh').state, 'awaiting_user')
  assert.equal(getSpawn(db, 'claimed').state, 'approved') // never expires a claimed row
})

test('an unknown state can never be written (CHECK constraint)', async () => {
  const { db, dan, parent, target } = await seed()
  makeRow(db, dan, parent, target)
  assert.throws(() => db.prepare("UPDATE agent_spawn_requests SET state='ended' WHERE id='spawn-1'").run())
})
