import test from 'node:test'
import assert from 'node:assert/strict'
import { upsertDeviceStatus, getDeviceStatus } from '../src/db.js'
import { setBoxDefaults } from '../src/box-defaults.js'
import { isClaudeModel } from '../src/spawn-model.js'
import { spawnConsentItemFields } from '../src/consent-items.js'
import { getSpawn, sanitizeBoxDefaults } from '../src/spawns.js'
import { fleet, pending } from './consent-fleet.js'

// Box defaults in the spawn path (matron-bridge docs/specs/box-defaults.md):
// box_status may carry the bridge's effective `defaults` block; spawn_targets
// lists each box's defaults; spawn_request takes an optional agent; the
// consent card, its tracker item and consent_list say which agent, model
// and effort will actually run and where each came from.

const isSpawnCard = (x) => x.kind === 'journal' && x.type === 'permission_request' && x.payload?.kind === 'agent_spawn'
const CODEX = { agent: 'codex', model: 'gpt-5.1-codex', effort: 'high', source: 'journal' }

const ask = (f, extra = {}, rid = 'q1') => f.asker.send({ op: 'spawn_request', request_id: rid, from_convo_id: 'ask', target_device_id: f.targetDev.deviceId, workdir: '/w', task: 'do work', ...extra })
// Each ask starts from no pending rows: the per-requester cap is 3.
async function card(f, extra = {}) {
  f.s.db.prepare("DELETE FROM agent_spawn_requests WHERE state='awaiting_user'").run()
  f.client.frames.length = 0
  ask(f, extra)
  const ack = await f.asker.waitFor((x) => x.kind === 'spawn' && (x.event === 'pending' || x.op === 'error'))
  f.asker.frames.length = 0
  return { ack, card: (await f.client.waitFor(isSpawnCard)).payload }
}

test('sanitizeBoxDefaults: claude|codex, a plain model token, a short effort and source; junk drops the block', () => {
  assert.deepEqual(sanitizeBoxDefaults(CODEX), CODEX)
  assert.deepEqual(sanitizeBoxDefaults({ agent: 'claude' }), { agent: 'claude', model: null, effort: null })
  assert.deepEqual(sanitizeBoxDefaults({ agent: 'claude', model: 'opus[1m]', effort: null, source: 'env' }), { agent: 'claude', model: 'opus[1m]', effort: null, source: 'env' })
  for (const junk of [null, 'x', [], {}, { agent: 'gpt' }, { agent: 'codex', model: 'a b' }, { agent: 'codex', model: 'm'.repeat(65) },
    { agent: 'codex', effort: 'x'.repeat(17) }, { agent: 'codex', effort: 3 }, { agent: 'codex', source: 'line\nbreak' }]) {
    assert.equal(sanitizeBoxDefaults(junk), null, JSON.stringify(junk))
  }
})

test('box_status: a defaults block is stored, fanned to the apps and may come alone; a junk one is dropped', async (t) => {
  const f = await fleet(t)
  f.target.send({ op: 'box_status', defaults: CODEX })
  const live = await f.client.waitFor((x) => x.kind === 'box_status')
  assert.deepEqual(live.defaults, CODEX)
  assert.deepEqual(getDeviceStatus(f.s.db, f.alice.id, f.targetDev.deviceId).defaults, CODEX)
  f.target.send({ op: 'box_status', disk: { free_bytes: 1, total_bytes: 2 }, defaults: { agent: 'gpt' } })
  const next = await f.client.waitFor((x) => x.kind === 'box_status' && x.disk)
  assert.equal('defaults' in next, false)
})

test('spawn_targets: defaults from the live reply, else the stored report, else the journal values; omitted when nothing is known', async (t) => {
  const f = await fleet(t, { spawnFoldersTimeoutMs: 300 })
  // opal (target) answers live with its effective block.
  f.target.waitFor((x) => x.kind === 'rpc' && x.request?.method === 'recent_folders').then((req) => {
    f.target.send({ op: 'agent_response', request_id: req.request.request_id, to_device_id: 0, ok: true, result: { folders: [], defaults: { agent: 'claude', model: 'opus', effort: null, source: 'env' } } })
  })
  // coord-box answers with folders only; it has a stored report.
  upsertDeviceStatus(f.s.db, { userId: f.alice.id, deviceId: f.coordDev.deviceId, status: { defaults: CODEX } })
  f.coord.waitFor((x) => x.kind === 'rpc' && x.request?.method === 'recent_folders').then((req) => {
    f.coord.send({ op: 'agent_response', request_id: req.request.request_id, to_device_id: 0, ok: true, result: { folders: [] } })
  })
  // asker-box answers with nothing and has journal values only.
  setBoxDefaults(f.s.db, f.alice.id, f.askerDev.deviceId, { default_agent: 'codex', default_effort: 'low' })
  f.asker.waitFor((x) => x.kind === 'rpc' && x.request?.method === 'recent_folders').then((req) => {
    f.asker.send({ op: 'agent_response', request_id: req.request.request_id, to_device_id: 0, ok: true, result: { folders: [] } })
  })
  f.asker.send({ op: 'spawn_targets', request_id: 't1' })
  let reply = await f.asker.waitFor((x) => x.kind === 'spawn' && x.event === 'targets')
  const box = (id) => reply.boxes.find((b) => b.device_id === id)
  assert.deepEqual(box(f.targetDev.deviceId).defaults, { agent: 'claude', model: 'opus', effort: null })
  assert.deepEqual(box(f.coordDev.deviceId).defaults, { agent: 'codex', model: 'gpt-5.1-codex', effort: 'high' })
  assert.deepEqual(box(f.askerDev.deviceId).defaults, { agent: 'codex', model: null, effort: 'low' })
  // The live block was kept for the next reader.
  assert.deepEqual(getDeviceStatus(f.s.db, f.alice.id, f.targetDev.deviceId).defaults, { agent: 'claude', model: 'opus', effort: null, source: 'env' })

  // Nothing reported, nothing stored: no key at all.
  f.s.db.prepare('DELETE FROM device_status').run()
  setBoxDefaults(f.s.db, f.alice.id, f.askerDev.deviceId, { default_agent: null, default_effort: null })
  f.asker.frames.length = 0
  f.asker.send({ op: 'spawn_targets', request_id: 't2' })
  reply = await f.asker.waitFor((x) => x.kind === 'spawn' && x.event === 'targets')
  assert.equal('defaults' in box(f.askerDev.deviceId), false)
})

test('spawn_request: agent is optional, claude or codex, stored, forwarded to start, and marked explicit on the card', async (t) => {
  const f = await fleet(t)
  for (const [rid, agent] of [['b1', 'gpt'], ['b2', 3], ['b3', { a: 1 }]]) {
    ask(f, { agent }, rid)
    const e = await f.asker.waitFor((x) => x.kind === 'control' && x.op === 'error')
    assert.equal(e.code, 'bad_request')
    assert.equal(e.detail, 'bad agent')
    f.asker.frames.length = 0
  }
  assert.equal(f.s.db.prepare('SELECT COUNT(*) c FROM agent_spawn_requests').get().c, 0)
  const { ack, card: c } = await card(f, { agent: ' Codex ', model: 'gpt-5.1-codex', effort: 'high' })
  assert.equal(getSpawn(f.s.db, ack.spawn_id).agent, 'codex')
  assert.equal(c.agent, 'codex'); assert.equal(c.agent_source, 'explicit')
  assert.equal(c.model, 'gpt-5.1-codex'); assert.equal(c.model_source, 'explicit')
  assert.equal(c.effort, 'high'); assert.equal(c.effort_source, 'explicit')
  f.target.waitFor((x) => x.kind === 'rpc' && x.request?.method === 'start').then((req) => {
    f.target.send({ op: 'agent_response', request_id: req.request.request_id, to_device_id: 0, ok: true, result: { convo_id: 'child-1' } })
  })
  const start = f.target.waitFor((x) => x.kind === 'rpc' && x.request?.method === 'start')
  assert.equal((await f.s.http('/agent-spawn/answer', { method: 'POST', token: f.clientToken, body: { request_id: ack.spawn_id, decision: 'approve' } })).status, 200)
  const params = (await start).request.params
  assert.equal(params.agent, 'codex')
  assert.equal(params.model, 'gpt-5.1-codex')
  assert.equal(params.effort, 'high')
  // Let the started outcome land before the server closes under it.
  assert.equal((await f.asker.waitFor((x) => x.kind === 'spawn' && x.event === 'outcome')).outcome, 'started')
})

test('spawn_request with no agent: the card predicts the box default agent, model and effort, marked box_default; nothing known says nothing', async (t) => {
  const f = await fleet(t)
  // Nothing set anywhere: the card shape is what it always was.
  let { ack, card: c } = await card(f)
  assert.equal(getSpawn(f.s.db, ack.spawn_id).agent, null)
  for (const k of ['agent', 'agent_source', 'model', 'model_source', 'effort', 'effort_source']) assert.equal(k in c, false, k)
  // Journal values only.
  setBoxDefaults(f.s.db, f.alice.id, f.targetDev.deviceId, { default_agent: 'codex', default_model: 'gpt-5.1-codex' })
  ;({ card: c } = await card(f))
  assert.equal(c.agent, 'codex'); assert.equal(c.agent_source, 'box_default')
  assert.equal(c.model, 'gpt-5.1-codex'); assert.equal(c.model_source, 'box_default')
  assert.equal('effort' in c, false)
  // The bridge's reported block wins over the stored values.
  upsertDeviceStatus(f.s.db, { userId: f.alice.id, deviceId: f.targetDev.deviceId, status: { defaults: { agent: 'codex', model: 'gpt-5.2-codex', effort: 'xhigh', source: 'journal' } } })
  ;({ card: c } = await card(f))
  assert.equal(c.model, 'gpt-5.2-codex'); assert.equal(c.effort, 'xhigh'); assert.equal(c.effort_source, 'box_default')
  // A named model stays explicit; the agent is still the box's.
  ;({ card: c } = await card(f, { model: 'gpt-5' }))
  assert.equal(c.agent_source, 'box_default'); assert.equal(c.model, 'gpt-5'); assert.equal(c.model_source, 'explicit')
  // A named agent other than the box default: the box's model and effort
  // belong to the other agent, so neither is predicted.
  ;({ card: c } = await card(f, { agent: 'claude' }))
  assert.equal(c.agent, 'claude'); assert.equal(c.agent_source, 'explicit')
  assert.equal('model' in c, false); assert.equal('effort' in c, false)
  // Naming the box's own agent keeps its model.
  ;({ card: c } = await card(f, { agent: 'codex' }))
  assert.equal(c.agent_source, 'explicit'); assert.equal(c.model, 'gpt-5.2-codex'); assert.equal(c.model_source, 'box_default')
})

test('a Codex box out of Fable predicts no Opus fallback; a Claude box with no model still does', async (t) => {
  const f = await fleet(t)
  const spent = { limits: { as_of: 1, lines: [{ id: 'week_all', label: 'all', percent: 40 }, { id: 'week_fable', label: 'fable', percent: 100 }] } }
  upsertDeviceStatus(f.s.db, { userId: f.alice.id, deviceId: f.targetDev.deviceId, status: { ...spent, defaults: { agent: 'codex', model: null, effort: null } } })
  let { card: c } = await card(f)
  assert.equal('fallback_model' in c, false)
  upsertDeviceStatus(f.s.db, { userId: f.alice.id, deviceId: f.targetDev.deviceId, status: { ...spent, defaults: { agent: 'claude', model: null, effort: null } } })
  ;({ card: c } = await card(f))
  assert.equal(c.fallback_model, 'opus')
  assert.equal(c.agent, 'claude')
})

test('consent item body names the agent, model and effort and says which came from the box', () => {
  const base = { request_id: 'r', from_name: 'jade', target_name: 'opal', workdir: '/w', task: 't', from_convo_title: 'x' }
  let body = spawnConsentItemFields({ ...base, agent: 'codex', agent_source: 'box_default', model: 'gpt-5.1-codex', model_source: 'box_default', effort: 'high', effort_source: 'box_default' }).body
  assert.ok(body.includes('- **Agent:** Codex (box default)'), body)
  assert.ok(body.includes('- **Model:** `gpt-5.1-codex` (box default)'), body)
  assert.ok(body.includes('- **Effort:** `high` (box default)'), body)
  body = spawnConsentItemFields({ ...base, agent: 'claude', agent_source: 'explicit', model: 'opus', model_source: 'explicit' }).body
  assert.ok(body.includes('- **Agent:** Claude\n'), body)
  assert.ok(body.includes('- **Model:** `opus`\n'), body)
  assert.ok(!spawnConsentItemFields(base).body.includes('Agent'))
})

test('consent_list: a pending spawn shows its agent and effort, explicit or from the box', async (t) => {
  const f = await fleet(t)
  setBoxDefaults(f.s.db, f.alice.id, f.targetDev.deviceId, { default_agent: 'codex', default_model: 'gpt-5.1-codex', default_effort: 'high' })
  await card(f)
  let sp = (await pending(f, f.coordDev.token)).json.pending[0]
  assert.equal(sp.agent, 'codex'); assert.equal(sp.agent_source, 'box_default')
  assert.equal(sp.model, 'gpt-5.1-codex'); assert.equal(sp.model_source, 'box_default')
  assert.equal(sp.effort, 'high'); assert.equal(sp.effort_source, 'box_default')
  f.s.db.prepare('DELETE FROM agent_spawn_requests').run()
  await card(f, { agent: 'claude', effort: 'low' })
  sp = (await pending(f, f.coordDev.token)).json.pending[0]
  assert.equal(sp.agent, 'claude'); assert.equal(sp.agent_source, 'explicit')
  assert.equal(sp.effort, 'low'); assert.equal(sp.effort_source, 'explicit')
  assert.equal('model' in sp, false)
})

test('isClaudeModel: aliases with or without [1m], "default" and claude-* ids; Codex ids are not', () => {
  for (const m of ['opus', 'opus[1m]', 'Sonnet[1M]', 'haiku', 'opusplan', 'fable', 'default', 'claude-opus-5-5']) assert.equal(isClaudeModel(m), true, m)
  for (const m of ['gpt-5.1-codex', 'o3', 'opus-ish', 'fable2']) assert.equal(isClaudeModel(m), false, m)
})

test('a Claude model named for a Codex box with no agent: dropped, the box model and effort run instead, and the card and item say so', async (t) => {
  const f = await fleet(t)
  setBoxDefaults(f.s.db, f.alice.id, f.targetDev.deviceId, { default_agent: 'codex', default_model: 'gpt-5.1-codex', default_effort: 'high' })
  let { card: c } = await card(f, { model: 'opus[1m]', effort: 'max' })
  assert.equal(c.agent, 'codex'); assert.equal(c.agent_source, 'box_default')
  assert.equal(c.model, 'gpt-5.1-codex'); assert.equal(c.model_source, 'box_default')
  assert.equal(c.effort, 'high'); assert.equal(c.effort_source, 'box_default')
  assert.equal(c.dropped_model, 'opus[1m]'); assert.equal(c.dropped_effort, 'max')
  const body = spawnConsentItemFields(c).body
  assert.ok(body.includes('- Model `opus[1m]` is ignored: this box runs Codex'), body)
  assert.ok(body.includes('- Effort `max` is ignored: this box runs Codex'), body)
  assert.ok(body.includes('- **Model:** `gpt-5.1-codex` (box default)'), body)
  // A shared effort is kept; a Codex model is not dropped.
  ;({ card: c } = await card(f, { model: 'claude-opus-5-5', effort: 'low' }))
  assert.equal(c.dropped_model, 'claude-opus-5-5'); assert.equal('dropped_effort' in c, false)
  assert.equal(c.effort, 'low'); assert.equal(c.effort_source, 'explicit')
  ;({ card: c } = await card(f, { model: 'gpt-5' }))
  assert.equal(c.model, 'gpt-5'); assert.equal(c.model_source, 'explicit'); assert.equal('dropped_model' in c, false)
  // Naming the agent keeps the model: the ask said what it wanted.
  ;({ card: c } = await card(f, { agent: 'claude', model: 'opus' }))
  assert.equal(c.model, 'opus'); assert.equal('dropped_model' in c, false)
  // consent_list says the same.
  await card(f, { model: 'sonnet' })
  const sp = (await pending(f, f.coordDev.token)).json.pending[0]
  assert.equal(sp.dropped_model, 'sonnet'); assert.equal(sp.model, 'gpt-5.1-codex'); assert.equal(sp.model_source, 'box_default')
})
