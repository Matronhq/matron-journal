import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Database from 'better-sqlite3'
import { openDb, upsertDeviceStatus, getDeviceStatus } from '../src/db.js'
import { createUser, createAgent } from '../src/auth.js'
import { getBoxDefaults, setBoxDefaults, normaliseAgent, normaliseBoxEffort, effectiveBoxDefaults, boxDefaultsByDevice } from '../src/box-defaults.js'
import { startTestServer, makeWsClient } from './helpers.js'

// Per-box default agent, model and effort (matron-bridge
// docs/specs/box-defaults.md): three nullable columns on an agent device,
// set through PUT /devices/:id/defaults by an app or by any of the user's
// bridges, announced live as {kind:'box_defaults'} and carried on hello_ok,
// GET /devices and GET /roster.

const tick = () => new Promise((res) => setTimeout(res, 50))
const EMPTY = { default_agent: null, default_model: null, default_effort: null }

// Alice with a Mac (client token) and two boxes, opal and jade; Pat with a box
// of her own, to prove one user's box defaults never reach another.
async function fleet(t) {
  const s = await startTestServer()
  t.after(() => s.close())
  const alice = await createUser(s.db, 'alice', 'pw')
  const pat = await createUser(s.db, 'pat', 'pw')
  const opal = createAgent(s.db, alice.id, 'opal')
  const jade = createAgent(s.db, alice.id, 'jade')
  const patBox = createAgent(s.db, pat.id, 'pat-box')
  const login = await s.http('/login', { method: 'POST', body: { username: 'alice', password: 'pw', device_name: 'mac' } })
  return { s, alice, pat, opal, jade, patBox, client: login.json.token, macId: login.json.device_id }
}
const path_ = (id) => `/devices/${id}/defaults`
const get = (s, token, id) => s.http(path_(id), { token })
const put = (s, token, id, body) => s.http(path_(id), { method: 'PUT', token, body })

test('normaliseAgent: claude and codex, trimmed and lowercased; null, "" and "default" clear; anything else is undefined', () => {
  assert.equal(normaliseAgent(' Codex '), 'codex')
  assert.equal(normaliseAgent('CLAUDE'), 'claude')
  for (const v of [null, '', '  ', 'default', ' Default ']) assert.equal(normaliseAgent(v), null, JSON.stringify(v))
  for (const v of ['gpt', 'claude-code', 3, true, {}, []]) assert.equal(normaliseAgent(v), undefined, JSON.stringify(v))
})

test('setBoxDefaults: absent keys kept; a new agent without a model clears the model, effort kept; unchanged writes report changed:false', async () => {
  const db = openDb(':memory:')
  const alice = await createUser(db, 'alice', 'pw')
  const pat = await createUser(db, 'pat', 'pw')
  const opal = createAgent(db, alice.id, 'opal')
  assert.deepEqual(getBoxDefaults(db, alice.id, opal.deviceId), EMPTY)
  assert.deepEqual(setBoxDefaults(db, alice.id, opal.deviceId, {}), { defaults: EMPTY, changed: false })
  let r = setBoxDefaults(db, alice.id, opal.deviceId, { default_agent: 'claude', default_model: 'opus', default_effort: 'high' })
  assert.deepEqual(r, { defaults: { default_agent: 'claude', default_model: 'opus', default_effort: 'high' }, changed: true })
  // The same agent again is no change, so the model stays.
  r = setBoxDefaults(db, alice.id, opal.deviceId, { default_agent: 'claude' })
  assert.deepEqual(r, { defaults: { default_agent: 'claude', default_model: 'opus', default_effort: 'high' }, changed: false })
  // opus means nothing on a Codex box: switching agent drops it.
  r = setBoxDefaults(db, alice.id, opal.deviceId, { default_agent: 'codex' })
  assert.deepEqual(r.defaults, { default_agent: 'codex', default_model: null, default_effort: 'high' })
  // ...unless the same request names the new agent's model.
  r = setBoxDefaults(db, alice.id, opal.deviceId, { default_agent: 'claude', default_model: 'sonnet' })
  assert.deepEqual(r.defaults, { default_agent: 'claude', default_model: 'sonnet', default_effort: 'high' })
  // Not this user's box, or not a box at all: null, nothing written.
  assert.equal(getBoxDefaults(db, pat.id, opal.deviceId), null)
  assert.equal(setBoxDefaults(db, pat.id, opal.deviceId, { default_agent: 'codex' }), null)
  assert.equal(getBoxDefaults(db, alice.id, 9999), null)
  assert.equal(getBoxDefaults(db, alice.id, opal.deviceId).default_agent, 'claude')
})

test('GET /devices/:id/defaults: nulls before anything is set, for an app and for a bridge; 401 without a token', async (t) => {
  const { s, opal, jade, client } = await fleet(t)
  for (const token of [client, opal.token, jade.token]) {
    const r = await get(s, token, opal.deviceId)
    assert.equal(r.status, 200)
    assert.deepEqual(r.json, { device_id: opal.deviceId, ...EMPTY })
  }
  assert.equal((await get(s, null, opal.deviceId)).status, 401)
  assert.equal((await put(s, null, opal.deviceId, { default_agent: 'codex' })).status, 401)
})

test('PUT /devices/:id/defaults: an app or any of the user\'s bridges sets any box; stored normalised; null clears', async (t) => {
  const { s, opal, jade, client } = await fleet(t)
  let r = await put(s, client, opal.deviceId, { default_agent: ' Codex ', default_model: 'GPT-5.1-Codex', default_effort: 'XHigh' })
  assert.equal(r.status, 200)
  assert.deepEqual(r.json, { device_id: opal.deviceId, default_agent: 'codex', default_model: 'gpt-5.1-codex', default_effort: 'xhigh' })
  // The Coordinator on jade sets opal from chat.
  r = await put(s, jade.token, opal.deviceId, { default_effort: null })
  assert.deepEqual(r.json, { device_id: opal.deviceId, default_agent: 'codex', default_model: 'gpt-5.1-codex', default_effort: null })
  // A new agent without a model drops the old agent's model.
  r = await put(s, opal.token, opal.deviceId, { default_agent: 'claude' })
  assert.deepEqual(r.json, { device_id: opal.deviceId, default_agent: 'claude', default_model: null, default_effort: null })
  r = await put(s, client, opal.deviceId, {})
  assert.equal(r.status, 200)
  assert.deepEqual(r.json, { device_id: opal.deviceId, default_agent: 'claude', default_model: null, default_effort: null })
  for (const clear of [null, '', 'default']) {
    await put(s, client, opal.deviceId, { default_agent: 'codex' })
    r = await put(s, client, opal.deviceId, { default_agent: clear })
    assert.equal(r.json.default_agent, null, JSON.stringify(clear))
  }
  assert.deepEqual((await get(s, client, jade.deviceId)).json, { device_id: jade.deviceId, ...EMPTY }, 'the other box is untouched')
})

test('PUT /devices/:id/defaults: a bad value writes nothing; unknown keys are bad_request; another user\'s box is 404; a client device is not_agent_device', async (t) => {
  const { s, opal, patBox, client, macId } = await fleet(t)
  await put(s, client, opal.deviceId, { default_agent: 'codex', default_effort: 'high' })
  const want = { device_id: opal.deviceId, default_agent: 'codex', default_model: null, default_effort: 'high' }
  for (const [body, error] of [
    [{ default_agent: 'gpt', default_effort: 'low' }, 'bad_agent'],
    [{ default_agent: 'claude', default_model: 'opus 1m' }, 'bad_model'],
    [{ default_model: 'opus', default_effort: 'ultra' }, 'bad_effort'],
    [{ default_agent: 'claude', model: 'opus' }, 'bad_request'],
    [{ agent: 'claude' }, 'bad_request'],
  ]) {
    const r = await put(s, client, opal.deviceId, body)
    assert.equal(r.status, 400, JSON.stringify(body))
    assert.deepEqual(r.json, { error })
    assert.deepEqual((await get(s, client, opal.deviceId)).json, want, `${error} wrote nothing`)
  }
  for (const id of [patBox.deviceId, 9999]) {
    assert.equal((await put(s, client, id, { default_agent: 'codex' })).status, 404)
    assert.equal((await get(s, client, id)).status, 404)
    assert.equal((await get(s, opal.token, id)).status, 404)
  }
  let r = await put(s, client, macId, { default_agent: 'codex' })
  assert.equal(r.status, 400)
  assert.deepEqual(r.json, { error: 'not_agent_device' })
  r = await get(s, client, macId)
  assert.equal(r.status, 400)
  assert.deepEqual(r.json, { error: 'not_agent_device' })
  assert.equal((await s.http(path_(opal.deviceId), { method: 'POST', token: client, body: {} })).status, 404)
})

test('box_defaults frame: a change reaches the user\'s apps and that box\'s own sockets; other boxes, other users and no-op writes hear nothing', async (t) => {
  const { s, opal, jade, patBox, client } = await fleet(t)
  const mac = await makeWsClient(s.base, { token: client, cursor: null })
  const opalWs = await makeWsClient(s.base, { token: opal.token, cursor: null })
  const jadeWs = await makeWsClient(s.base, { token: jade.token, cursor: null })
  const patWs = await makeWsClient(s.base, { token: patBox.token, cursor: null })
  const all = [mac, opalWs, jadeWs, patWs]
  t.after(() => { for (const w of all) w.close() })
  for (const w of all) await w.waitFor((f) => f.op === 'hello_ok')
  const frames = (w) => w.frames.filter((f) => f.kind === 'box_defaults')

  await put(s, jade.token, opal.deviceId, { default_agent: 'codex', default_model: 'gpt-5.1-codex' })
  const want = { kind: 'box_defaults', device_id: opal.deviceId, default_agent: 'codex', default_model: 'gpt-5.1-codex', default_effort: null }
  assert.deepEqual(await mac.waitFor((f) => f.kind === 'box_defaults'), want)
  assert.deepEqual(await opalWs.waitFor((f) => f.kind === 'box_defaults'), want)

  // Same values, an empty body and a 400: no frame.
  await put(s, client, opal.deviceId, { default_agent: 'codex', default_model: 'gpt-5.1-codex' })
  await put(s, client, opal.deviceId, {})
  await put(s, client, opal.deviceId, { default_effort: 'ultra' })
  await tick()
  assert.equal(frames(mac).length, 1)
  assert.equal(frames(opalWs).length, 1)
  assert.equal(frames(jadeWs).length, 0, 'jade is not the box that changed')
  assert.equal(frames(patWs).length, 0)

  // Clearing is a change: the frame carries the nulls.
  await put(s, client, opal.deviceId, { default_agent: null })
  assert.deepEqual(await opalWs.waitFor((f) => f.kind === 'box_defaults' && f.default_agent === null), { kind: 'box_defaults', device_id: opal.deviceId, ...EMPTY })
})

test('hello_ok: an agent device gets its own box_defaults (nulls until set); a client gets none', async (t) => {
  const { s, opal, client } = await fleet(t)
  let w = await makeWsClient(s.base, { token: opal.token, cursor: null })
  let hello = await w.waitFor((f) => f.op === 'hello_ok')
  w.close()
  assert.deepEqual(hello.box_defaults, EMPTY)
  await put(s, client, opal.deviceId, { default_agent: 'codex', default_effort: 'high' })
  w = await makeWsClient(s.base, { token: opal.token, cursor: null })
  hello = await w.waitFor((f) => f.op === 'hello_ok')
  w.close()
  assert.deepEqual(hello.box_defaults, { default_agent: 'codex', default_model: null, default_effort: 'high' })
  const mac = await makeWsClient(s.base, { token: client, cursor: null })
  const macHello = await mac.waitFor((f) => f.op === 'hello_ok')
  mac.close()
  assert.equal('box_defaults' in macHello, false)
})

test('GET /devices and GET /roster: every agent box carries defaults {agent, model, effort}; client devices do not', async (t) => {
  const { s, opal, jade, client } = await fleet(t)
  await put(s, client, opal.deviceId, { default_agent: 'codex', default_model: 'gpt-5.1-codex', default_effort: 'high' })
  const devs = (await s.http('/devices', { token: client })).json.devices
  assert.deepEqual(devs.find((d) => d.device_id === opal.deviceId).defaults, { agent: 'codex', model: 'gpt-5.1-codex', effort: 'high' })
  assert.deepEqual(devs.find((d) => d.device_id === jade.deviceId).defaults, { agent: null, model: null, effort: null })
  assert.equal('defaults' in devs.find((d) => d.kind === 'client'), false)
  for (const token of [client, jade.token]) {
    const agents = (await s.http('/roster', { token })).json.agents
    assert.deepEqual(agents.find((d) => d.device_id === opal.deviceId).defaults, { agent: 'codex', model: 'gpt-5.1-codex', effort: 'high' })
    assert.deepEqual(agents.find((d) => d.device_id === jade.deviceId).defaults, { agent: null, model: null, effort: null })
  }
})

test('migration: a devices table from before the columns gains all three; existing boxes read as null', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'matron-box-defaults-migration-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const dbPath = path.join(dir, 'j.db')
  let db = openDb(dbPath)
  const alice = await createUser(db, 'alice', 'pw')
  const opal = createAgent(db, alice.id, 'opal')
  db.close()
  const raw = new Database(dbPath)
  for (const c of ['default_agent', 'default_model', 'default_effort']) raw.exec(`ALTER TABLE devices DROP COLUMN ${c}`)
  raw.close()
  db = openDb(dbPath)
  t.after(() => db.close())
  const cols = db.prepare('PRAGMA table_info(devices)').all().map((c) => c.name)
  for (const c of ['default_agent', 'default_model', 'default_effort']) assert.ok(cols.includes(c), c)
  assert.deepEqual(getBoxDefaults(db, alice.id, opal.deviceId), EMPTY)
  assert.equal(setBoxDefaults(db, alice.id, opal.deviceId, { default_agent: 'codex' }).changed, true)
  assert.equal(db.prepare('SELECT name FROM devices WHERE id=?').get(opal.deviceId).name, 'opal', 'the existing row survives')
})

test('normaliseBoxEffort: the five levels plus Codex minimal; default and empty clear', () => {
  assert.equal(normaliseBoxEffort(' Minimal '), 'minimal')
  assert.equal(normaliseBoxEffort('max'), 'max')
  assert.equal(normaliseBoxEffort('default'), null)
  assert.equal(normaliseBoxEffort(''), null)
  assert.equal(normaliseBoxEffort('ultra'), undefined)
  assert.equal(normaliseBoxEffort(3), undefined)
})

test('setBoxDefaults drops the box\'s stale reported defaults block so the new values show while it sleeps', async () => {
  const db = openDb(':memory:')
  const alice = await createUser(db, 'alice', 'pw')
  const opal = createAgent(db, alice.id, 'opal')
  upsertDeviceStatus(db, { userId: alice.id, deviceId: opal.deviceId, status: { disk: { free_bytes: 1, total_bytes: 2 }, defaults: { agent: 'claude', model: 'opus', effort: null } } })
  setBoxDefaults(db, alice.id, opal.deviceId, { default_agent: 'codex' })
  const status = getDeviceStatus(db, alice.id, opal.deviceId)
  assert.equal('defaults' in status, false)
  assert.deepEqual(status.disk, { free_bytes: 1, total_bytes: 2 })
  assert.deepEqual(effectiveBoxDefaults(status.defaults, boxDefaultsByDevice(db, alice.id).get(opal.deviceId)), { agent: 'codex', model: null, effort: null })
  // An unchanged write leaves a fresh report alone.
  upsertDeviceStatus(db, { userId: alice.id, deviceId: opal.deviceId, status: { defaults: { agent: 'codex', model: 'gpt-5', effort: null } } })
  setBoxDefaults(db, alice.id, opal.deviceId, { default_agent: 'codex' })
  assert.deepEqual(getDeviceStatus(db, alice.id, opal.deviceId).defaults, { agent: 'codex', model: 'gpt-5', effort: null })
})
