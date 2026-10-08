import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Database from 'better-sqlite3'
import { openDb } from '../src/db.js'
import { createUser, createAgent } from '../src/auth.js'
import { getConsentEnabled, setConsentEnabled } from '../src/consent.js'
import { getDefaults, setDefaults, normaliseModel, normaliseEffort } from '../src/defaults.js'
import { startTestServer, makeWsClient } from './helpers.js'

const tick = () => new Promise((res) => setTimeout(res, 50))

// Alice with a Mac (client token) and a box (agent token); Pat with a box of
// her own, to prove one user's defaults never reach another.
async function fleet(t) {
  const s = await startTestServer()
  t.after(() => s.close())
  const alice = await createUser(s.db, 'alice', 'pw')
  const pat = await createUser(s.db, 'pat', 'pw')
  const agent = createAgent(s.db, alice.id, 'box-2')
  const patAgent = createAgent(s.db, pat.id, 'pat-box')
  const login = await s.http('/login', { method: 'POST', body: { username: 'alice', password: 'pw', device_name: 'mac' } })
  return { s, alice, pat, agent, patAgent, client: login.json.token }
}
const get = (s, token) => s.http('/defaults', { token })
const put = (s, token, body) => s.http('/defaults', { method: 'PUT', token, body })
const EMPTY = { default_model: null, default_effort: null }

test('normalise: trims and lowercases; null, "" and (model only) "default" clear; junk is undefined', () => {
  assert.equal(normaliseModel(' Opus[1M] '), 'opus[1m]')
  assert.equal(normaliseModel('claude-opus-5-5'), 'claude-opus-5-5')
  assert.equal(normaliseModel('claude-sonnet-4.5'), 'claude-sonnet-4.5')
  for (const v of [null, '', '  ', 'default', ' DEFAULT ']) assert.equal(normaliseModel(v), null, JSON.stringify(v))
  for (const v of [42, true, {}, [], '-opus', '.opus', 'opus 1m', 'opus[2m]', 'opus[1m]x', 'opus_x', 'a'.repeat(65)]) {
    assert.equal(normaliseModel(v), undefined, JSON.stringify(v))
  }
  assert.equal(normaliseModel('a'.repeat(64)), 'a'.repeat(64))
  assert.equal(normaliseEffort(' XHigh '), 'xhigh')
  for (const v of [null, '', ' ']) assert.equal(normaliseEffort(v), null, JSON.stringify(v))
  for (const v of ['default', 'ultra', 3, false]) assert.equal(normaliseEffort(v), undefined, JSON.stringify(v))
})

test('setDefaults: absent key kept; an unchanged write reports changed:false and writes no row', async () => {
  const db = openDb(':memory:')
  const alice = await createUser(db, 'alice', 'pw')
  assert.deepEqual(getDefaults(db, alice.id), EMPTY)
  assert.deepEqual(setDefaults(db, alice.id, { default_model: null }), { defaults: EMPTY, changed: false })
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM user_settings').get().n, 0)
  assert.equal(setDefaults(db, alice.id, { default_model: 'opus' }).changed, true)
  assert.deepEqual(setDefaults(db, alice.id, { default_effort: 'high' }).defaults, { default_model: 'opus', default_effort: 'high' })
  assert.equal(setDefaults(db, alice.id, { default_model: 'opus', default_effort: 'high' }).changed, false)
})

test('GET /defaults: both null before anything is set; 401 without a token', async (t) => {
  const { s, agent, client } = await fleet(t)
  for (const token of [client, agent.token]) {
    const r = await get(s, token)
    assert.equal(r.status, 200)
    assert.deepEqual(r.json, EMPTY)
  }
  assert.equal((await get(s, null)).status, 401)
  assert.equal((await put(s, null, { default_effort: 'high' })).status, 401)
})

test('PUT /defaults: each field alone, the other left as is; stored normalised; null, "" and "default" clear', async (t) => {
  const { s, client } = await fleet(t)
  let r = await put(s, client, { default_model: ' Opus[1M] ' })
  assert.equal(r.status, 200)
  assert.deepEqual(r.json, { default_model: 'opus[1m]', default_effort: null })
  r = await put(s, client, { default_effort: 'XHIGH' })
  assert.deepEqual(r.json, { default_model: 'opus[1m]', default_effort: 'xhigh' })
  assert.deepEqual((await get(s, client)).json, { default_model: 'opus[1m]', default_effort: 'xhigh' })
  r = await put(s, client, { default_model: 'claude-opus-5-5' })
  assert.deepEqual(r.json, { default_model: 'claude-opus-5-5', default_effort: 'xhigh' })
  r = await put(s, client, {})
  assert.equal(r.status, 200)
  assert.deepEqual(r.json, { default_model: 'claude-opus-5-5', default_effort: 'xhigh' })
  for (const clear of [null, '', 'default', ' Default ']) {
    await put(s, client, { default_model: 'sonnet' })
    r = await put(s, client, { default_model: clear })
    assert.equal(r.status, 200)
    assert.equal(r.json.default_model, null, JSON.stringify(clear))
    assert.equal(r.json.default_effort, 'xhigh')
  }
  for (const clear of [null, '']) {
    await put(s, client, { default_effort: 'low' })
    r = await put(s, client, { default_effort: clear })
    assert.equal(r.json.default_effort, null, JSON.stringify(clear))
  }
  assert.deepEqual((await get(s, client)).json, EMPTY)
})

test('PUT /defaults: bad_model, bad_effort and unknown keys are 400 and write nothing', async (t) => {
  const { s, client } = await fleet(t)
  await put(s, client, { default_model: 'haiku', default_effort: 'low' })
  for (const v of ['Opus 4', 'opus[2m]', '-x', 'a'.repeat(65), 7, true, ['opus'], { m: 'opus' }]) {
    const r = await put(s, client, { default_model: v })
    assert.equal(r.status, 400, JSON.stringify(v))
    assert.deepEqual(r.json, { error: 'bad_model' })
  }
  for (const v of ['ultra', 'default', 3, false, ['high']]) {
    const r = await put(s, client, { default_effort: v })
    assert.equal(r.status, 400, JSON.stringify(v))
    assert.deepEqual(r.json, { error: 'bad_effort' })
  }
  // One bad field fails the whole PUT: the valid one is not written either.
  assert.equal((await put(s, client, { default_model: 'opus', default_effort: 'ultra' })).status, 400)
  assert.equal((await put(s, client, { default_model: 'nope!', default_effort: 'max' })).status, 400)
  for (const body of [{ model: 'opus' }, { default_model: 'opus', extra: 1 }]) {
    const r = await put(s, client, body)
    assert.equal(r.status, 400, JSON.stringify(body))
    assert.deepEqual(r.json, { error: 'bad_request' })
  }
  assert.equal((await s.http('/defaults', { method: 'PUT', token: client, body: ['opus'] })).status, 400)
  assert.deepEqual((await get(s, client)).json, { default_model: 'haiku', default_effort: 'low' })
  assert.equal((await s.http('/defaults', { method: 'POST', token: client, body: { default_model: 'opus' } })).status, 404)
})

test('PUT /defaults: an agent token may write, and the user\'s client reads it back', async (t) => {
  const { s, agent, client } = await fleet(t)
  const r = await put(s, agent.token, { default_effort: 'high' })
  assert.equal(r.status, 200)
  assert.deepEqual(r.json, { default_model: null, default_effort: 'high' })
  assert.deepEqual((await get(s, client)).json, { default_model: null, default_effort: 'high' })
})

test('defaults are per user: one user\'s write never shows to another', async (t) => {
  const { s, agent, patAgent } = await fleet(t)
  await put(s, agent.token, { default_model: 'opus', default_effort: 'max' })
  assert.deepEqual((await get(s, patAgent.token)).json, EMPTY)
  await put(s, patAgent.token, { default_model: 'fable' })
  assert.deepEqual((await get(s, agent.token)).json, { default_model: 'opus', default_effort: 'max' })
  assert.deepEqual((await get(s, patAgent.token)).json, { default_model: 'fable', default_effort: null })
})

test('a change sends {kind:"defaults"} to the user\'s client AND agent sockets, never to another user; no change, no frame', async (t) => {
  const { s, agent, patAgent, client } = await fleet(t)
  const mac = await makeWsClient(s.base, { token: client, cursor: null })
  const box = await makeWsClient(s.base, { token: agent.token, cursor: null })
  const patBox = await makeWsClient(s.base, { token: patAgent.token, cursor: null })
  t.after(() => { mac.close(); box.close(); patBox.close() })
  for (const ws of [mac, box, patBox]) await ws.waitFor((f) => f.op === 'hello_ok')
  const defaultsFrames = (ws) => ws.frames.filter((f) => f.kind === 'defaults')

  await put(s, client, { default_model: 'Opus', default_effort: 'high' })
  const want = { kind: 'defaults', default_model: 'opus', default_effort: 'high' }
  assert.deepEqual(await mac.waitFor((f) => f.kind === 'defaults'), want)
  assert.deepEqual(await box.waitFor((f) => f.kind === 'defaults'), want)

  // The agent's own write reaches its own socket too (and the app).
  await put(s, agent.token, { default_effort: 'low' })
  await box.waitFor((f) => f.kind === 'defaults' && f.default_effort === 'low')
  await mac.waitFor((f) => f.kind === 'defaults' && f.default_effort === 'low')

  // Same values again, an empty body and a 400: nothing changed, no frame.
  await put(s, client, { default_model: 'opus', default_effort: 'low' })
  await put(s, agent.token, { default_model: ' OPUS ' })
  await put(s, client, {})
  await put(s, client, { default_effort: 'ultra' })
  await tick()
  assert.equal(defaultsFrames(mac).length, 2)
  assert.equal(defaultsFrames(box).length, 2)
  assert.equal(defaultsFrames(patBox).length, 0)

  // Clearing is a change: the frame carries the nulls.
  await put(s, client, { default_model: null })
  assert.deepEqual(await box.waitFor((f) => f.kind === 'defaults' && f.default_model === null), { kind: 'defaults', default_model: null, default_effort: 'low' })
})

test('migration: a user_settings table from before the columns gains both; its rows read as null', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'matron-defaults-migration-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const dbPath = path.join(dir, 'j.db')
  let db = openDb(dbPath)
  const alice = await createUser(db, 'alice', 'pw')
  setConsentEnabled(db, alice.id, false)
  db.close()
  const raw = new Database(dbPath)
  raw.exec('ALTER TABLE user_settings DROP COLUMN default_model')
  raw.exec('ALTER TABLE user_settings DROP COLUMN default_effort')
  raw.close()
  db = openDb(dbPath)
  t.after(() => db.close())
  const cols = db.prepare('PRAGMA table_info(user_settings)').all().map((c) => c.name)
  assert.ok(cols.includes('default_model') && cols.includes('default_effort'))
  assert.deepEqual(getDefaults(db, alice.id), EMPTY)
  assert.equal(getConsentEnabled(db, alice.id), false, 'the existing row survives')
  assert.equal(setDefaults(db, alice.id, { default_effort: 'max' }).changed, true)
  assert.equal(getConsentEnabled(db, alice.id), false, 'the upsert leaves the other settings alone')
})
