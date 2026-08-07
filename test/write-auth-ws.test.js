import test from 'node:test'
import assert from 'node:assert/strict'
import { startTestServer, makeWsClient } from './helpers.js'
import { createUser, createAgent } from '../src/auth.js'
import { inviteParticipant, answerInvite, leaveConvo } from '../src/participants.js'

const settle = (ms = 150) => new Promise((r) => setTimeout(r, ms))

async function fleet(t) {
  const s = await startTestServer()
  t.after(() => s.close())
  const dan = await createUser(s.db, 'dan', 'pw')
  const agA = createAgent(s.db, dan.id, 'dev-a')
  const agB = createAgent(s.db, dan.id, 'dev-b')
  const a = await makeWsClient(s.base, { token: agA.token, cursor: null })
  const b = await makeWsClient(s.base, { token: agB.token, cursor: null })
  await a.waitFor((f) => f.op === 'hello_ok')
  await b.waitFor((f) => f.op === 'hello_ok')
  t.after(() => { a.close(); b.close() })
  // A owns the room.
  a.send({ op: 'convo_upsert', convo_id: 'room', title: 'room', session_state: 'running' })
  await a.waitFor((f) => f.kind === 'journal' && f.type === 'session_status')
  return { s, dan, agA, agB, a, b }
}

const joinB = (s, agA, agB) => {
  inviteParticipant(s.db, { convoId: 'room', agentDeviceId: agB.deviceId, initiatorDeviceId: agA.deviceId, justification: 'x' })
  answerInvite(s.db, { convoId: 'room', agentDeviceId: agB.deviceId, accept: true })
}

test('publish into a foreign convo is rejected; allowed after join; blocked again after leave', async (t) => {
  const { s, agA, agB, a, b } = await fleet(t)
  b.send({ op: 'publish', convo_id: 'room', type: 'text', payload: { body: 'sneak' } })
  const err = await b.waitFor((f) => f.op === 'error' && f.ref === 'publish')
  assert.equal(err.code, 'forbidden')

  joinB(s, agA, agB)
  b.send({ op: 'publish', convo_id: 'room', type: 'text', payload: { body: 'hello room' } })
  await a.waitFor((f) => f.kind === 'journal' && f.type === 'text' && f.payload.body === 'hello room')

  leaveConvo(s.db, { convoId: 'room', agentDeviceId: agB.deviceId })
  b.send({ op: 'publish', convo_id: 'room', type: 'text', payload: { body: 'sneak2' } })
  const err2 = await b.waitFor((f) => f.op === 'error' && f.ref === 'publish' && f.code === 'forbidden')
  assert.ok(err2)
})

test('finalize, stream, stream_append, activity, status all reject a foreign convo', async (t) => {
  const { b } = await fleet(t)
  const cases = [
    { op: 'finalize', convo_id: 'room', message_ref: 'm1', type: 'text', payload: { body: 'x' } },
    { op: 'stream', convo_id: 'room', message_ref: 'm1', text: 'x' },
    { op: 'stream_append', convo_id: 'room', message_ref: 'm1', offset: 0, chunk: 'x', meta: { command: 'ls' } },
    { op: 'activity', convo_id: 'room', state: 'thinking' },
    { op: 'status', convo_id: 'room', status: { model: 'x' } },
  ]
  for (const msg of cases) {
    b.send(msg)
    const err = await b.waitFor((f) => f.op === 'error' && f.ref === msg.op)
    assert.equal(err.code, 'forbidden', `${msg.op} must be forbidden`)
  }
})

test('joined participant can finalize and stream ephemerals', async (t) => {
  const { s, agA, agB, a, b } = await fleet(t)
  joinB(s, agA, agB)
  b.send({ op: 'finalize', convo_id: 'room', message_ref: 'm1', type: 'text', payload: { body: 'done' } })
  await a.waitFor((f) => f.kind === 'journal' && f.type === 'text' && f.payload.body === 'done')
  // Ephemerals: no error frame back is the pass signal (delivery is
  // viewing-scoped, so nothing arrives anywhere — absence of `forbidden`
  // is what we assert).
  b.send({ op: 'activity', convo_id: 'room', state: 'thinking' })
  await settle()
  assert.deepEqual(b.frames.filter((f) => f.op === 'error' && f.ref === 'activity'), [])
})

test('legacy NULL-owner convo still accepts any agent write', async (t) => {
  const { s, dan, b } = await fleet(t)
  s.db.prepare(
    'INSERT INTO conversations(id, owner_user_id, title, session_state, created_at) VALUES(?,?,?,?,?)'
  ).run('legacy', dan.id, 'old', 'running', Date.now())
  b.send({ op: 'publish', convo_id: 'legacy', type: 'text', payload: { body: 'ok' } })
  await b.waitFor((f) => f.kind === 'journal' && f.type === 'text' && f.payload.body === 'ok')
})
