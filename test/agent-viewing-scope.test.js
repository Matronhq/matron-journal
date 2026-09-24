import test from 'node:test'
import assert from 'node:assert/strict'
import { startTestServer, makeWsClient } from './helpers.js'
import { createUser, createAgent } from '../src/auth.js'
import { upsertConversation } from '../src/journal.js'
import { pinDevicePrivate } from '../src/db.js'

// `viewing` is a client op (tracker #2851). No bridge sends it; an agent
// connection that could would receive streaming/activity/status ephemerals
// for any convo of its user — including a private box's convos and
// agent-chat rooms it has not joined, which hello replay and live journal
// fan-out both hide from it.

const settle = (ms = 300) => new Promise((r) => setTimeout(r, ms))
const ephemeralsFor = (c, convoId) => c.frames.filter((f) => f.kind === 'ephemeral' && f.convo_id === convoId)

async function fixture(t) {
  const s = await startTestServer()
  t.after(() => s.close())
  const dan = await createUser(s.db, 'dan', 'pw')
  const kit = createAgent(s.db, dan.id, 'kit')
  const ghost = createAgent(s.db, dan.id, 'ghost')
  const owner = createAgent(s.db, dan.id, 'owner')
  pinDevicePrivate(s.db, ghost.deviceId, true)
  upsertConversation(s.db, { id: 'ghost-work', ownerUserId: dan.id, title: 'Ghost work', sessionState: 'running', agentDeviceId: ghost.deviceId })
  upsertConversation(s.db, { id: 'room-1', ownerUserId: dan.id, title: 'Room', sessionState: 'running', agentDeviceId: owner.deviceId })
  // kit was invited to the room but never joined.
  s.db.prepare(
    "INSERT INTO convo_agents(convo_id, agent_device_id, initiator_device_id, state, created_at) VALUES(?,?,?,'invited',?)"
  ).run('room-1', kit.deviceId, owner.deviceId, Date.now())
  const login = await s.http('/login', { method: 'POST', body: { username: 'dan', password: 'pw', device_name: 'mac' } })
  const conns = {
    kit: await makeWsClient(s.base, { token: kit.token, cursor: null }),
    ghost: await makeWsClient(s.base, { token: ghost.token, cursor: null }),
    owner: await makeWsClient(s.base, { token: owner.token, cursor: null }),
    client: await makeWsClient(s.base, { token: login.json.token, cursor: 0 }),
  }
  for (const c of Object.values(conns)) await c.waitFor((f) => f.op === 'hello_ok')
  t.after(() => { for (const c of Object.values(conns)) c.close() })
  return { s, dan, kit, ghost, owner, ...conns }
}

// Every ephemeral family a producing agent can fan out for its own convo.
function produceEphemerals(agent, convoId) {
  agent.send({ op: 'activity', convo_id: convoId, state: 'thinking' })
  agent.send({ op: 'status', convo_id: convoId, status: { model: 'x' } })
  agent.send({ op: 'stream', convo_id: convoId, message_ref: 'm1', replace_text: 'secret progress' })
  agent.send({ op: 'stream_append', convo_id: convoId, message_ref: 't1', offset: 0, chunk: 'secret output', meta: { tool: 'Bash' } })
}

test('an agent sending `viewing` is refused as forbidden (single and set forms)', async (t) => {
  const { kit } = await fixture(t)
  const refusals = () => kit.frames.filter((f) => f.kind === 'control' && f.op === 'error' && f.code === 'forbidden' && f.ref === 'viewing')
  kit.send({ op: 'viewing', convo_id: 'ghost-work' })
  kit.send({ op: 'viewing', convo_ids: ['ghost-work', 'room-1'] })
  await kit.waitFor(() => refusals().length === 2)
})

test('an agent viewing a private box\'s convo receives none of its ephemerals; the client still does', async (t) => {
  const { kit, ghost, client } = await fixture(t)
  kit.send({ op: 'viewing', convo_id: 'ghost-work' })
  kit.send({ op: 'viewing', convo_ids: ['ghost-work'] })
  client.send({ op: 'viewing', convo_id: 'ghost-work' })
  await settle(100)
  produceEphemerals(ghost, 'ghost-work')
  await client.waitFor((f) => f.kind === 'ephemeral' && f.convo_id === 'ghost-work' && f.tool_stream)
  await client.waitFor((f) => f.kind === 'ephemeral' && f.convo_id === 'ghost-work' && f.activity)
  await client.waitFor((f) => f.kind === 'ephemeral' && f.convo_id === 'ghost-work' && f.status)
  await client.waitFor((f) => f.kind === 'ephemeral' && f.convo_id === 'ghost-work' && f.replace_text === 'secret progress')
  await settle()
  assert.deepEqual(ephemeralsFor(kit, 'ghost-work'), [], 'a non-private agent must not see a private box\'s ephemerals')
})

test('an agent viewing a room it has not joined receives none of its ephemerals', async (t) => {
  const { kit, owner, client } = await fixture(t)
  kit.send({ op: 'viewing', convo_ids: ['room-1'] })
  client.send({ op: 'viewing', convo_ids: ['room-1'] })
  await settle(100)
  produceEphemerals(owner, 'room-1')
  await client.waitFor((f) => f.kind === 'ephemeral' && f.convo_id === 'room-1' && f.activity)
  await settle()
  assert.deepEqual(ephemeralsFor(kit, 'room-1'), [], 'an unjoined agent must not see the room\'s ephemerals')
})
