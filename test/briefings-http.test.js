import test from 'node:test'
import assert from 'node:assert/strict'
import { startTestServer, makeWsClient } from './helpers.js'
import { createUser, createAgent } from '../src/auth.js'
import { setCoordinatorConvoId } from '../src/coordinator.js'
import { upsertConversation } from '../src/journal.js'
import { BRIEFINGS_KEEP, BRIEFING_REFRESH_COOLDOWN_MS, BRIEFING_REFRESH_TIMEOUT_MS } from '../src/briefings.js'

// /briefings (src/briefings-http.js): the Coordinator's publish (a row plus
// an assistant text event in its conversation), the apps' latest view, and
// the user's refresh — delivered as a journal-originated `routine`
// session_control named `briefing`, rate-limited, settled by the next publish.

async function fleet(t, { coordinator = true, connect = true } = {}) {
  const s = await startTestServer({ sessionControlTimeoutMs: 2000, routinesSweepIntervalMs: 3600_000 })
  t.after(() => s.close())
  const alice = await createUser(s.db, 'alice', 'pw')
  const coordDev = createAgent(s.db, alice.id, 'maple')
  const jade = createAgent(s.db, alice.id, 'jade')
  upsertConversation(s.db, { id: 'coord', ownerUserId: alice.id, title: 'Coordinator', agentDeviceId: coordDev.deviceId })
  upsertConversation(s.db, { id: 'g1', ownerUserId: alice.id, title: 'G1', agentDeviceId: jade.deviceId })
  if (coordinator) setCoordinatorConvoId(s.db, alice.id, 'coord')
  const login = await s.http('/login', { method: 'POST', body: { username: 'alice', password: 'pw', device_name: 'mac' } })
  let coord = null
  if (connect) {
    coord = await makeWsClient(s.base, { token: coordDev.token, cursor: null })
    t.after(() => coord.close())
    await coord.waitFor((f) => f.op === 'hello_ok')
  }
  return { s, alice, coordDev, jade, client: login.json.token, coord }
}

async function answerRpc(coord, { ok = true, result = { applied: 'now' }, error = null } = {}) {
  const req = await coord.waitFor((f) => f.kind === 'rpc' && f.request?.method === 'session_control' && !f._answered)
  req._answered = true
  coord.send({ op: 'agent_response', request_id: req.request.request_id, to_device_id: 0, ok, ...(ok ? { result } : { error }) })
  return req.request
}
const settle = async (s) => { const t0 = Date.now(); while (s.broker.pendingCount() > 0 && Date.now() - t0 < 2000) await new Promise((r) => setTimeout(r, 10)) }
const publish = (s, token, over = {}) => s.http('/briefings', { method: 'POST', token, body: { convo_id: 'coord', body: '**Morning.** Two sessions running.', ...over } })
// Age the stored refresh so the clock-dependent rules can be tested without waiting.
const ageRefresh = (s, userId, ms) => s.db.prepare('UPDATE briefing_refresh SET requested_at=requested_at-? WHERE user_id=?').run(ms, userId)

test('GET /briefings/latest: empty to begin with; clients only', async (t) => {
  const { s, client, coordDev } = await fleet(t, { connect: false })
  assert.deepEqual((await s.http('/briefings/latest', { token: client })).json, { briefing: null, refresh: null, next_refresh_at: null, has_coordinator: true })
  assert.equal((await s.http('/briefings/latest', { token: coordDev.token })).status, 403)
})

test('POST /briefings: the Coordinator naming its own conversation; the briefing is a text message there', async (t) => {
  const { s, client, coordDev, jade } = await fleet(t, { connect: false })
  assert.equal((await publish(s, client)).status, 403)
  assert.deepEqual(await publish(s, coordDev.token, { convo_id: undefined }), { status: 403, json: { error: 'forbidden', detail: 'not_coordinator' } })
  assert.equal((await publish(s, jade.token)).status, 404)
  assert.equal((await publish(s, jade.token, { convo_id: 'g1' })).status, 403)
  assert.equal((await publish(s, coordDev.token, { body: '   ' })).status, 400)
  assert.equal((await publish(s, coordDev.token, { body: 'x'.repeat(40000) })).status, 400)

  const r = await publish(s, coordDev.token, { body: '  hello  ' })
  assert.equal(r.status, 201)
  const b = r.json.briefing
  assert.match(b.id, /^br_/)
  assert.equal(b.body, 'hello'); assert.equal(b.convo_id, 'coord')
  const ev = s.db.prepare('SELECT * FROM events WHERE seq=?').get(b.seq)
  assert.equal(ev.type, 'text'); assert.equal(ev.convo_id, 'coord'); assert.equal(ev.sender, 'agent:maple')
  assert.deepEqual(JSON.parse(ev.payload), { body: 'hello', from: 'assistant', briefing_id: b.id })
  assert.equal(s.db.prepare("SELECT snippet FROM conversations WHERE id='coord'").get().snippet, 'hello')
  assert.deepEqual((await s.http('/briefings/latest', { token: client })).json.briefing, b)
})

test('POST /briefings: Idempotency-Key replays the same briefing; only the newest are kept', async (t) => {
  const { s, coordDev, alice } = await fleet(t, { connect: false })
  const h = { 'Idempotency-Key': 'k1' }
  const a = await s.http('/briefings', { method: 'POST', token: coordDev.token, headers: h, body: { convo_id: 'coord', body: 'one' } })
  const b = await s.http('/briefings', { method: 'POST', token: coordDev.token, headers: h, body: { convo_id: 'coord', body: 'one' } })
  assert.equal(a.status, 201); assert.equal(b.status, 200)
  assert.deepEqual(b.json.briefing, a.json.briefing)
  for (let i = 0; i < BRIEFINGS_KEEP + 3; i++) await publish(s, coordDev.token, { body: `n${i}` })
  assert.equal(s.db.prepare('SELECT COUNT(*) AS n FROM briefings WHERE user_id=?').get(alice.id).n, BRIEFINGS_KEEP)
})

test('a published briefing reaches open apps live: the text event and a briefing frame', async (t) => {
  const { s, client, coordDev } = await fleet(t, { connect: false })
  const app = await makeWsClient(s.base, { token: client, cursor: null })
  t.after(() => app.close())
  await app.waitFor((f) => f.op === 'hello_ok')
  const r = await publish(s, coordDev.token)
  await app.waitFor((f) => f.kind === 'journal' && f.type === 'text' && f.payload?.briefing_id === r.json.briefing.id)
  await app.waitFor((f) => f.kind === 'briefing' && f.action === 'published' && f.briefing_id === r.json.briefing.id)
})

test('POST /briefings/refresh: fires the built-in briefing routine at the Coordinator; pending until a briefing lands', async (t) => {
  const { s, client, coordDev, coord } = await fleet(t)
  assert.equal((await s.http('/briefings/refresh', { method: 'POST', token: coordDev.token })).status, 403)
  const rpc = answerRpc(coord)
  const r = await s.http('/briefings/refresh', { method: 'POST', token: client })
  assert.equal(r.status, 202)
  assert.equal(r.json.refresh.state, 'pending')
  assert.equal(r.json.refresh.expires_at, r.json.refresh.requested_at + BRIEFING_REFRESH_TIMEOUT_MS)
  assert.ok(r.json.next_refresh_at >= r.json.refresh.expires_at)
  const req = await rpc
  assert.equal(req.params.action, 'routine'); assert.equal(req.params.name, 'briefing'); assert.equal(req.params.convo_id, 'coord')
  assert.match(req.params.message, /Routine: briefing/)
  await settle(s)
  // No routine row, no routine marker: the built-in run is not a routine.
  assert.equal(s.db.prepare("SELECT COUNT(*) AS n FROM events WHERE type='routine'").get().n, 0)
  assert.equal((await s.http('/briefings/latest', { token: client })).json.refresh.state, 'pending')
  // A second ask while pending is refused.
  const again = await s.http('/briefings/refresh', { method: 'POST', token: client })
  assert.equal(again.status, 429); assert.equal(again.json.retry_at, r.json.next_refresh_at)
  // The briefing settles it.
  await publish(s, coordDev.token)
  const after = (await s.http('/briefings/latest', { token: client })).json
  assert.equal(after.refresh, null)
  // Still within the cooldown of the last ask.
  assert.equal(after.next_refresh_at, r.json.refresh.requested_at + BRIEFING_REFRESH_COOLDOWN_MS)
})

test('refresh: a failed delivery shows as failed and only the cooldown blocks the next', async (t) => {
  const { s, client, coord, alice } = await fleet(t)
  const app = await makeWsClient(s.base, { token: client, cursor: null })
  t.after(() => app.close())
  await app.waitFor((f) => f.op === 'hello_ok')
  const rpc = answerRpc(coord, { ok: false, error: { code: 'not_coordinator' } })
  assert.equal((await s.http('/briefings/refresh', { method: 'POST', token: client })).status, 202)
  await app.waitFor((f) => f.kind === 'briefing' && f.action === 'refreshing')
  await rpc
  await app.waitFor((f) => f.kind === 'briefing' && f.action === 'refresh_failed')
  const v = (await s.http('/briefings/latest', { token: client })).json
  assert.equal(v.refresh.state, 'failed'); assert.equal(v.refresh.outcome, 'failed not_coordinator')
  assert.equal(v.next_refresh_at, v.refresh.requested_at + BRIEFING_REFRESH_COOLDOWN_MS)
  ageRefresh(s, alice.id, BRIEFING_REFRESH_COOLDOWN_MS)
  const v2 = (await s.http('/briefings/latest', { token: client })).json
  assert.equal(v2.next_refresh_at, null)
})

test('refresh: times out after ten minutes with no briefing', async (t) => {
  const { s, client, coord, alice } = await fleet(t)
  const rpc = answerRpc(coord)
  await s.http('/briefings/refresh', { method: 'POST', token: client })
  await rpc; await settle(s)
  ageRefresh(s, alice.id, BRIEFING_REFRESH_TIMEOUT_MS)
  const v = (await s.http('/briefings/latest', { token: client })).json
  assert.equal(v.refresh.state, 'timed_out'); assert.equal(v.next_refresh_at, null)
})

test('refresh: 409 with no Coordinator', async (t) => {
  const { s, client } = await fleet(t, { coordinator: false, connect: false })
  assert.deepEqual(await s.http('/briefings/refresh', { method: 'POST', token: client }), { status: 409, json: { error: 'conflict', blocked_by: 'no_coordinator' } })
  assert.equal((await s.http('/briefings/latest', { token: client })).json.has_coordinator, false)
})
