import test from 'node:test'
import assert from 'node:assert/strict'
import { startTestServer, makeWsClient } from './helpers.js'
import { createUser, createAgent } from '../src/auth.js'
import { upsertConversation, append } from '../src/journal.js'

test('hello replays from cursor, then streams live appends', async (t) => {
  const s = await startTestServer()
  t.after(() => s.close())
  const dan = await createUser(s.db, 'dan', 'pw')
  upsertConversation(s.db, { id: 'c1', ownerUserId: dan.id })
  for (let i = 1; i <= 3; i++) {
    append(s.db, { userId: dan.id, convoId: 'c1', sender: 'agent:a', type: 'text', payload: { body: `m${i}` } })
  }
  const login = await s.http('/login', { method: 'POST', body: { username: 'dan', password: 'pw', device_name: 'mac' } })

  const c = await makeWsClient(s.base, { token: login.json.token, cursor: 1 })
  await c.waitFor((f) => f.kind === 'journal' && f.seq === 3)
  assert.deepEqual(c.journal().map((f) => f.seq), [2, 3])

  // a live append (as if from another connection) must be fanned out
  const r = append(s.db, { userId: dan.id, convoId: 'c1', sender: 'agent:a', type: 'text', payload: { body: 'live' } })
  s.hub.broadcastJournal(dan.id, { kind: 'journal', seq: r.seq, convo_id: 'c1', ts: r.ts, sender: 'agent:a', type: 'text', payload: { body: 'live' } })
  await c.waitFor((f) => f.kind === 'journal' && f.seq === 4)
  c.close()
})

test('bad token gets error control frame', async (t) => {
  const s = await startTestServer()
  t.after(() => s.close())
  const c = await makeWsClient(s.base, { token: 'nope', cursor: 0 })
  await c.waitFor((f) => f.kind === 'control' && f.op === 'error' && f.code === 'auth')
  c.close()
})

test('null and non-JSON frames do not crash the server', async (t) => {
  const s = await startTestServer()
  t.after(() => s.close())
  const dan = await createUser(s.db, 'dan', 'pw')
  const login = await s.http('/login', { method: 'POST', body: { username: 'dan', password: 'pw', device_name: 'mac' } })

  // pre-auth: null frame → closed, no crash
  const raw = new (await import('ws')).default(s.base.replace('http', 'ws') + '/ws')
  await new Promise((r) => raw.on('open', r))
  raw.send('null')
  await new Promise((r) => raw.on('close', r))

  // pre-auth: non-JSON frame → closed
  const raw2 = new (await import('ws')).default(s.base.replace('http', 'ws') + '/ws')
  await new Promise((r) => raw2.on('open', r))
  raw2.send('{not json')
  await new Promise((r) => raw2.on('close', r))

  // post-auth: junk frame ignored, connection survives
  const c = await makeWsClient(s.base, { token: login.json.token, cursor: 0 })
  await c.waitFor((f) => f.op === 'hello_ok')
  c.ws.send('null')
  c.ws.send('{bad')
  c.send({ op: 'viewing', convo_id: null })
  await new Promise((r) => setTimeout(r, 100))
  assert.equal(c.ws.readyState, 1)
  // and the server still works end-to-end
  assert.equal((await s.http('/snapshot', { token: login.json.token })).status, 200)
  c.close()
})

test('replay of a multi-batch backlog arrives complete and in order', async (t) => {
  const s = await startTestServer()
  t.after(() => s.close())
  const dan = await createUser(s.db, 'dan', 'pw')
  upsertConversation(s.db, { id: 'big', ownerUserId: dan.id })
  for (let i = 0; i < 1203; i++) {
    append(s.db, { userId: dan.id, convoId: 'big', sender: 'agent:a', type: 'text', payload: { body: `m${i}` } })
  }
  const login = await s.http('/login', { method: 'POST', body: { username: 'dan', password: 'pw', device_name: 'mac' } })
  const c = await makeWsClient(s.base, { token: login.json.token, cursor: 0 })
  await c.waitFor((f) => f.kind === 'journal' && f.seq === 1203, 10000)
  const seqs = c.journal().map((f) => f.seq)
  assert.equal(seqs.length, 1203)
  seqs.forEach((v, i) => assert.equal(v, i + 1))
  c.close()
})
