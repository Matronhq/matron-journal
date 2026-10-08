import test from 'node:test'
import assert from 'node:assert/strict'
import { upsertDeviceStatus } from '../src/db.js'
import { fleet, parkSpawn } from './consent-fleet.js'

// Fable-limit fallback (src/spawn-model.js), end to end: the card predicts
// it from the target's last box_status (an explicit model wins), and the
// outcome carries what the target's start reply said it did.
const FABLE_SPENT = { limits: { as_of: 1, lines: [
  { id: 'week_all', label: 'Week (all models)', percent: 40 },
  { id: 'week_fable', label: 'Week (Fable)', percent: 100 },
] } }
const isSpawnCard = (x) => x.kind === 'journal' && x.type === 'permission_request' && x.payload?.kind === 'agent_spawn'

test('spawn_request onto a box out of Fable: the no-model card says it will run on Opus; a named model wins', async (t) => {
  const f = await fleet(t)
  upsertDeviceStatus(f.s.db, { userId: f.alice.id, deviceId: f.targetDev.deviceId, status: FABLE_SPENT })
  await parkSpawn(f)
  const card = await f.client.waitFor(isSpawnCard)
  assert.equal(card.payload.fallback_model, 'opus')
  assert.equal(card.payload.fallback_reason, 'fable_limit')
  assert.ok(!('model' in card.payload))
  f.client.frames.length = 0
  f.asker.send({ op: 'spawn_request', request_id: 'q2', from_convo_id: 'ask', target_device_id: f.targetDev.deviceId, workdir: '/w', task: 'do work', model: 'fable' })
  const named = await f.client.waitFor(isSpawnCard)
  assert.equal(named.payload.model, 'fable')
  assert.ok(!('fallback_model' in named.payload))
})

for (const [name, result, expected] of [
  ['the model and reason the bridge named', { convo_id: 'child-1', model: 'opus', model_reason: 'fable_limit' }, { model: 'opus', model_reason: 'fable_limit' }],
  ['nothing for a junk model', { convo_id: 'child-1', model: 'opus\nx', model_reason: 'fable_limit' }, null],
]) {
  test(`started on a fallback: the outcome carries ${name}`, async (t) => {
    const f = await fleet(t)
    const spawnId = await parkSpawn(f)
    f.target.waitFor((x) => x.kind === 'rpc' && x.request?.method === 'start').then((req) => {
      f.target.send({ op: 'agent_response', request_id: req.request.request_id, to_device_id: 0, ok: true, result })
    })
    const r = await f.s.http('/agent-spawn/answer', { method: 'POST', token: f.clientToken, body: { request_id: spawnId, decision: 'approve' } })
    assert.equal(r.status, 200)
    const ephemeral = await f.asker.waitFor((x) => x.kind === 'spawn' && x.event === 'outcome')
    const evt = await f.client.waitFor((x) => x.kind === 'journal' && x.type === 'spawn_outcome')
    assert.equal(ephemeral.outcome, 'started')
    if (expected) {
      assert.equal(ephemeral.model, expected.model); assert.equal(ephemeral.model_reason, expected.model_reason)
      assert.equal(evt.payload.model, expected.model); assert.equal(evt.payload.model_reason, expected.model_reason)
    } else {
      assert.ok(!('model' in ephemeral) && !('model_reason' in evt.payload))
    }
  })
}
