import test from 'node:test'
import assert from 'node:assert/strict'
import { startTestServer, makeWsClient } from './helpers.js'
import { createUser, createAgent } from '../src/auth.js'

// Harness pattern copied from the top of test/invites.test.js: one user, one
// client device, one agent device — both connected, both hello_ok'd, and a
// room the agent owns (so the recorded owner IS the device the card must be
// hidden from — the worst case a naive fan-out would deliver to first, not
// just some other agent).
async function fleet(t) {
  const s = await startTestServer()
  t.after(() => s.close())
  const dan = await createUser(s.db, 'dan', 'pw')
  const agentDev = createAgent(s.db, dan.id, 'bridge')
  const login = await s.http('/login', { method: 'POST', body: { username: 'dan', password: 'pw', device_name: 'mac' } })
  const clientToken = login.json.token
  const agent = await makeWsClient(s.base, { token: agentDev.token, cursor: null })
  const client = await makeWsClient(s.base, { token: clientToken, cursor: null })
  await agent.waitFor((f) => f.op === 'hello_ok')
  await client.waitFor((f) => f.op === 'hello_ok')
  t.after(() => { agent.close(); client.close() })
  agent.send({ op: 'convo_upsert', convo_id: 'room', title: 'room', session_state: 'running' })
  await agent.waitFor((f) => f.kind === 'journal' && f.type === 'session_status')
  await client.waitFor((f) => f.kind === 'journal' && f.type === 'session_status')
  // Drain the session_status frames both sides just got — everything after
  // this point in a test is signal, not setup noise.
  agent.frames.length = 0
  client.frames.length = 0
  return { s, dan, agentDev, clientToken, agent, client }
}

const isCard = (f) => f.kind === 'journal' && f.type === 'permission_request' && f.payload?.kind === 'agent_chat'

// Publishes the card via the existing generic `publish` op — permission_request
// is already in ws.js's AGENT_PUBLISH_TYPES, so this drives a real trip through
// appendAndFan/fanOut (the exact choke point Task 7's dedicated op will also
// use), not a simulation of one.
function publishCard(agent) {
  agent.send({ op: 'publish', convo_id: 'room', type: 'permission_request', payload: { kind: 'agent_chat', justification: 'SECRET' } })
}

test('client-only agent-chat card: live fan-out reaches the client, never the owning agent', async (t) => {
  const { agent, client } = await fleet(t)
  // The publishing agent is also the room's recorded owner — exactly the
  // device broadcastJournal's default targets (owner + joined participants)
  // would otherwise deliver to first.
  publishCard(agent)
  const seen = await client.waitFor(isCard)
  assert.equal(seen.payload.justification, 'SECRET')

  // The live frame is delivered synchronously inside the same handleOp call
  // that delivers the client's copy, so there's no real race to wait out —
  // this is just a courtesy beat before asserting the negative.
  await new Promise((r) => setTimeout(r, 50))
  assert.ok(!agent.frames.some(isCard), 'the agent that manages the room must not see the card live')
  assert.ok(!JSON.stringify(agent.frames).includes('SECRET'), 'no trace of the justification text reached the agent live')
})

test('client-only agent-chat card: hello replay from cursor 0 excludes it for the agent, includes it for the client', async (t) => {
  const { s, agentDev, clientToken, agent, client } = await fleet(t)
  publishCard(agent)
  await client.waitFor(isCard)
  // A benign follow-up event both devices are entitled to, appended after
  // the card — once it shows up in a fresh replay, the card (an earlier
  // seq) is guaranteed to have already been processed by that same replay
  // loop, since eventsAfter delivers in seq order and each batch is sent
  // synchronously before the next is fetched.
  client.send({ op: 'send', convo_id: 'room', type: 'text', payload: { body: 'marker' } })
  await agent.waitFor((f) => f.kind === 'journal' && f.type === 'text' && f.payload?.body === 'marker')

  const agentReplay = await makeWsClient(s.base, { token: agentDev.token, cursor: 0 })
  const clientReplay = await makeWsClient(s.base, { token: clientToken, cursor: 0 })
  t.after(() => { agentReplay.close(); clientReplay.close() })
  await agentReplay.waitFor((f) => f.kind === 'journal' && f.type === 'text' && f.payload?.body === 'marker')
  await clientReplay.waitFor((f) => f.kind === 'journal' && f.type === 'text' && f.payload?.body === 'marker')

  assert.ok(!agentReplay.journal().some(isCard), 'the agent must not receive the card as replayed history')
  assert.ok(clientReplay.journal().some(isCard), 'the client must still receive the card as replayed history')
  assert.ok(!JSON.stringify(agentReplay.frames).includes('SECRET'), 'no trace of the justification text reached the agent via replay')
})

test('client-only agent-chat card: HTTP GET /convo/:id/messages omits it for the agent, includes it for the client', async (t) => {
  const { s, agentDev, clientToken, agent, client } = await fleet(t)
  publishCard(agent)
  await client.waitFor(isCard)

  const asAgent = await s.http('/convo/room/messages', { token: agentDev.token })
  const asClient = await s.http('/convo/room/messages', { token: clientToken })
  assert.equal(asAgent.status, 200)
  assert.equal(asClient.status, 200)
  assert.ok(!asAgent.json.events.some((e) => e.type === 'permission_request' && e.payload?.kind === 'agent_chat'),
    'the agent-token page must not include the card')
  assert.ok(asClient.json.events.some((e) => e.type === 'permission_request' && e.payload?.kind === 'agent_chat'),
    'the client-token page must include the card')
  assert.ok(!JSON.stringify(asAgent.json).includes('SECRET'), 'no trace of the justification text reached the agent via HTTP')
})
