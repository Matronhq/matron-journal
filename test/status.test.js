import test from 'node:test'
import assert from 'node:assert/strict'
import { startTestServer, makeWsClient } from './helpers.js'
import { createUser, createAgent } from '../src/auth.js'
import { upsertConversation } from '../src/journal.js'

// The `status` op: an agent publishes the session's header data (model,
// context gauge, rate limits) as a viewing-scoped ephemeral. Unlike
// activity, the server caches the LAST status per convo and replays it when
// a client starts viewing, so headers populate on open rather than waiting
// for the next turn end.

const STATUS = {
  model: 'claude-fable-5',
  context: { tokens: 253412, window: 1000000, pct: 25 },
  limits: [{ label: 'Session', percent: 39, resets: 'Jul 14, 5:59pm (UTC)' }],
}

async function setup(t, convoId) {
  const s = await startTestServer()
  t.after(() => s.close())
  const dan = await createUser(s.db, 'dan', 'pw')
  const ag = createAgent(s.db, dan.id, 'dev-2')
  const login = await s.http('/login', { method: 'POST', body: { username: 'dan', password: 'pw', device_name: 'mac' } })
  const agent = await makeWsClient(s.base, { token: ag.token, cursor: null })
  const client = await makeWsClient(s.base, { token: login.json.token, cursor: 0 })
  await agent.waitFor((f) => f.op === 'hello_ok')
  await client.waitFor((f) => f.op === 'hello_ok')
  agent.send({ op: 'convo_upsert', convo_id: convoId, session_state: 'running' })
  await client.waitFor((f) => f.kind === 'journal' && f.type === 'session_status')
  return { s, dan, agent, client }
}

test('agent status reaches the viewing client as an ephemeral, verbatim', async (t) => {
  const { agent, client } = await setup(t, 'sess-st')
  client.send({ op: 'viewing', convo_id: 'sess-st' })
  await new Promise((r) => setTimeout(r, 50))

  agent.send({ op: 'status', convo_id: 'sess-st', status: STATUS })
  const frame = await client.waitFor((f) => f.kind === 'ephemeral' && f.convo_id === 'sess-st' && f.status)
  assert.deepEqual(frame.status, STATUS)
  agent.close(); client.close()
})

test('a non-viewing device receives no status ephemeral', async (t) => {
  const { s, agent, client } = await setup(t, 'sess-st-nv')
  // client never sends viewing for this convo.
  agent.send({ op: 'status', convo_id: 'sess-st-nv', status: STATUS })
  await new Promise((r) => setTimeout(r, 300))
  assert.equal(client.frames.some((f) => f.kind === 'ephemeral' && f.status), false)
  agent.close(); client.close()
})

test('the last status is cached and replayed when a client starts viewing', async (t) => {
  const { agent, client } = await setup(t, 'sess-st-cache')

  agent.send({ op: 'status', convo_id: 'sess-st-cache', status: { model: 'old' } })
  agent.send({ op: 'status', convo_id: 'sess-st-cache', status: STATUS })
  await new Promise((r) => setTimeout(r, 50))

  // Only now does the client start viewing — it must get the LATEST status.
  client.send({ op: 'viewing', convo_id: 'sess-st-cache' })
  const frame = await client.waitFor((f) => f.kind === 'ephemeral' && f.convo_id === 'sess-st-cache' && f.status)
  assert.deepEqual(frame.status, STATUS)
  assert.equal(client.frames.filter((f) => f.kind === 'ephemeral' && f.status).length, 1)
  agent.close(); client.close()
})

test('status and activity in the same coalesce window both arrive (distinct pending slots)', async (t) => {
  const { agent, client } = await setup(t, 'sess-st-both')
  client.send({ op: 'viewing', convo_id: 'sess-st-both' })
  await new Promise((r) => setTimeout(r, 50))

  // Both fire back-to-back at turn end on the bridge — neither may clobber
  // the other inside the hub's coalesce window.
  agent.send({ op: 'activity', convo_id: 'sess-st-both', state: 'idle' })
  agent.send({ op: 'status', convo_id: 'sess-st-both', status: STATUS })

  await client.waitFor((f) => f.kind === 'ephemeral' && f.status)
  await client.waitFor((f) => f.kind === 'ephemeral' && f.activity)
  agent.close(); client.close()
})

test('client sending status is forbidden', async (t) => {
  const { client } = await setup(t, 'sess-st-cli')
  client.send({ op: 'status', convo_id: 'sess-st-cli', status: STATUS })
  await client.waitFor((f) => f.kind === 'control' && f.op === 'error' && f.code === 'forbidden' && f.ref === 'status')
  assert.equal(client.ws.readyState, 1)
  client.close()
})

test("status on a convo the agent's user does not own (or that doesn't exist) is forbidden", async (t) => {
  const s = await startTestServer()
  t.after(() => s.close())
  const dan = await createUser(s.db, 'dan', 'pw')
  const pat = await createUser(s.db, 'pat', 'pw')
  const agDan = createAgent(s.db, dan.id, 'dev-2')
  upsertConversation(s.db, { id: 'cp-st', ownerUserId: pat.id })
  const agent = await makeWsClient(s.base, { token: agDan.token, cursor: null })
  await agent.waitFor((f) => f.op === 'hello_ok')

  agent.send({ op: 'status', convo_id: 'cp-st', status: STATUS })
  await agent.waitFor((f) => f.kind === 'control' && f.op === 'error' && f.code === 'forbidden' && f.ref === 'status')

  agent.send({ op: 'status', convo_id: 'does-not-exist', status: STATUS })
  await agent.waitFor((f) =>
    agent.frames.filter((x) => x.kind === 'control' && x.op === 'error' && x.code === 'forbidden' && x.ref === 'status').length >= 2)
  assert.equal(agent.ws.readyState, 1)
  agent.close()
})

test('a missing or non-object status is bad_request; connection survives', async (t) => {
  const { agent } = await setup(t, 'sess-st-bad')
  agent.send({ op: 'status', convo_id: 'sess-st-bad' })
  await agent.waitFor((f) => f.kind === 'control' && f.op === 'error' && f.code === 'bad_request' && f.ref === 'status')
  agent.send({ op: 'status', convo_id: 'sess-st-bad', status: 'not-an-object' })
  await agent.waitFor((f) =>
    agent.frames.filter((x) => x.kind === 'control' && x.op === 'error' && x.code === 'bad_request' && x.ref === 'status').length >= 2)
  assert.equal(agent.ws.readyState, 1)
  agent.close()
})

test('an oversized status is bad_request, not cached', async (t) => {
  const { agent, client } = await setup(t, 'sess-st-big')
  agent.send({ op: 'status', convo_id: 'sess-st-big', status: { blob: 'x'.repeat(5000) } })
  await agent.waitFor((f) => f.kind === 'control' && f.op === 'error' && f.code === 'bad_request' && f.ref === 'status')

  client.send({ op: 'viewing', convo_id: 'sess-st-big' })
  await new Promise((r) => setTimeout(r, 300))
  assert.equal(client.frames.some((f) => f.kind === 'ephemeral' && f.status), false)
  agent.close(); client.close()
})
