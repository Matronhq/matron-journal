import test from 'node:test'
import assert from 'node:assert/strict'
import { startTestServer, makeWsClient } from './helpers.js'
import { createUser, createAgent } from '../src/auth.js'

test('agent publishes, streams ephemerally, finalizes durably', async (t) => {
  const s = await startTestServer()
  t.after(() => s.close())
  const dan = await createUser(s.db, 'dan', 'pw')
  const ag = createAgent(s.db, dan.id, 'dev-2')
  const login = await s.http('/login', { method: 'POST', body: { username: 'dan', password: 'pw', device_name: 'mac' } })

  const agent = await makeWsClient(s.base, { token: ag.token, cursor: null })
  const client = await makeWsClient(s.base, { token: login.json.token, cursor: 0 })
  await agent.waitFor((f) => f.op === 'hello_ok')
  await client.waitFor((f) => f.op === 'hello_ok')

  agent.send({ op: 'convo_upsert', convo_id: 'sess-1', title: 'fix bug', session_state: 'running' })
  await client.waitFor((f) => f.kind === 'journal' && f.type === 'session_status')

  client.send({ op: 'viewing', convo_id: 'sess-1' })
  await new Promise((r) => setTimeout(r, 50))

  // 20 rapid stream deltas coalesce to few ephemeral frames, none durable
  for (let i = 0; i < 20; i++) {
    agent.send({ op: 'stream', convo_id: 'sess-1', message_ref: 'm1', replace_text: `progress ${i}` })
  }
  await client.waitFor((f) => f.kind === 'ephemeral' && f.replace_text === 'progress 19', 3000)
  const ephemerals = client.frames.filter((f) => f.kind === 'ephemeral')
  assert.ok(ephemerals.length <= 5, `expected coalescing, got ${ephemerals.length}`)
  assert.equal(s.db.prepare("SELECT COUNT(*) n FROM events WHERE type='text'").get().n, 0)

  agent.send({ op: 'finalize', convo_id: 'sess-1', message_ref: 'm1', payload: { body: 'done: 3 files changed' } })
  const fin = await client.waitFor((f) => f.kind === 'journal' && f.type === 'text')
  assert.equal(fin.payload.body, 'done: 3 files changed')
  assert.equal(fin.sender, 'agent:dev-2')

  // finalize retry is idempotent
  agent.send({ op: 'finalize', convo_id: 'sess-1', message_ref: 'm1', payload: { body: 'done: 3 files changed' } })
  await new Promise((r) => setTimeout(r, 100))
  assert.equal(s.db.prepare("SELECT COUNT(*) n FROM events WHERE type='text'").get().n, 1)

  // clients may not use agent ops
  client.send({ op: 'publish', convo_id: 'sess-1', type: 'text', payload: { body: 'x' } })
  await client.waitFor((f) => f.kind === 'control' && f.op === 'error' && f.code === 'forbidden')
  agent.close(); client.close()
})
