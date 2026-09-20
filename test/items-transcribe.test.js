import test from 'node:test'
import assert from 'node:assert/strict'
import { startTestServer, makeWsClient } from './helpers.js'
import { createUser, createAgent } from '../src/auth.js'
import { upsertConversation } from '../src/journal.js'
import { listComments, listPendingTranscripts } from '../src/items.js'
import { makeTranscriber, cleanWhisperText } from '../src/transcribe.js'

// A transcriber whose jobs the test releases by hand, so "pending" is a state
// the assertions can actually observe rather than a race.
function gatedTranscriber() {
  const calls = []
  const waiters = []
  return {
    calls,
    transcribeFile(diskPath) {
      calls.push(diskPath)
      return new Promise((resolve, reject) => waiters.push({ resolve, reject }))
    },
    release(text) { waiters.shift().resolve(text) },
    fail(msg = 'boom') { waiters.shift().reject(new Error(msg)) },
  }
}

async function fleet(t, serverOpts = {}) {
  const wakeCalls = []
  const waker = { enabled: true, wake: (name) => wakeCalls.push(name) }
  const s = await startTestServer({ waker, ...serverOpts })
  t.after(() => s.close())
  const dan = await createUser(s.db, 'dan', 'pw')
  const pat = await createUser(s.db, 'pat', 'pw')
  const agent = createAgent(s.db, dan.id, 'dev-2')
  upsertConversation(s.db, { id: 'c1', ownerUserId: dan.id, title: 'C1', agentDeviceId: agent.deviceId })
  const login = await s.http('/login', { method: 'POST', body: { username: 'dan', password: 'pw', device_name: 'mac' } })
  const blob = (id, ownerId) => s.db.prepare('INSERT INTO blobs(id,owner_user_id,content_type,size,sha256,disk_path,created_at) VALUES(?,?,?,?,?,?,?)')
    .run(id, ownerId, 'audio/mp4', 3, 'x', `/media/${id}`, Date.now())
  blob('b1', dan.id); blob('b2', dan.id); blob('patblob', pat.id)
  const made = await s.http('/items', { method: 'POST', token: agent.token, body: { kind: 'question', title: 'Which auth?', convo_id: 'c1' } })
  return { s, dan, agent, client: login.json.token, itemId: made.json.item.id, wakeCalls }
}

const voice = (ref) => ({ blob_ref: ref, mime: 'audio/mp4', name: `${ref}.m4a`, size: 3 })
const isItem = (action) => (f) => f.kind === 'journal' && f.type === 'item' && f.payload.action === action

test('voice comment: announced pending, transcribed, then a quiet updated marker carries the words', async (t) => {
  const tr = gatedTranscriber()
  const { s, agent, client, itemId, wakeCalls } = await fleet(t, { transcriber: tr })
  const ws = await makeWsClient(s.base, { token: agent.token, cursor: null })
  await ws.waitFor((f) => f.op === 'hello_ok')
  const r = await s.http(`/items/${itemId}/comments`, { method: 'POST', token: client, body: { attachments: [voice('b1'), { blob_ref: 'img', mime: 'image/png', name: 'a.png', size: 1 }] } })
  assert.equal(r.status, 201)
  assert.equal(r.json.comment.attachments[0].transcript_status, 'pending')
  assert.equal(r.json.comment.attachments[1].transcript_status, undefined) // images are nobody's job
  const first = await ws.waitFor(isItem('commented'))
  assert.equal(first.payload.comment.attachments[0].transcript_status, 'pending')
  assert.equal(first.payload.comment.attachments[0].transcript, null)
  assert.equal(first.payload.transcription, undefined)
  assert.deepEqual(tr.calls, ['/media/b1'])
  const eventsBefore = s.db.prepare('SELECT COUNT(*) AS n FROM events').get().n
  const wakesBefore = wakeCalls.length

  tr.release('  use option A  ')
  const second = await ws.waitFor(isItem('updated'))
  assert.equal(second.sender, 'user:dan'); assert.equal(second.payload.by, 'user')
  assert.equal(second.payload.transcription, 'done'); assert.equal(second.payload.for_action, 'commented')
  assert.equal(second.payload.comment.id, r.json.comment.id)
  assert.equal(second.payload.comment.attachments[0].transcript, 'use option A')
  assert.equal(second.payload.comment.attachments[0].transcript_status, 'done')
  assert.ok(second.seq > first.seq)
  ws.close()
  // Quiet: exactly one event (no fallback text), and no second wake.
  assert.equal(s.db.prepare('SELECT COUNT(*) AS n FROM events').get().n, eventsBefore + 1)
  assert.equal(wakeCalls.length, wakesBefore)
  const stored = listComments(s.db, itemId).find((c) => c.id === r.json.comment.id)
  assert.equal(stored.attachments[0].transcript, 'use option A')
})

test('failure still answers: transcription:failed, status failed, no transcript', async (t) => {
  const tr = gatedTranscriber()
  const { s, agent, client, itemId } = await fleet(t, { transcriber: tr })
  const ws = await makeWsClient(s.base, { token: agent.token, cursor: null })
  await ws.waitFor((f) => f.op === 'hello_ok')
  await s.http(`/items/${itemId}/comments`, { method: 'POST', token: client, body: { attachments: [voice('b1')] } })
  tr.fail()
  const m = await ws.waitFor(isItem('updated'))
  assert.equal(m.payload.transcription, 'failed')
  assert.equal(m.payload.comment.attachments[0].transcript, null)
  assert.equal(m.payload.comment.attachments[0].transcript_status, 'failed')
  ws.close()
})

test('two voice notes: one marker, after the LAST settles; a failed one marks the whole failed', async (t) => {
  const tr = gatedTranscriber()
  const { s, client, itemId } = await fleet(t, { transcriber: tr })
  await s.http(`/items/${itemId}/comments`, { method: 'POST', token: client, body: { attachments: [voice('b1'), voice('b2')] } })
  const updated = () => s.db.prepare("SELECT payload FROM events WHERE type='item'").all().map((r) => JSON.parse(r.payload)).filter((p) => p.action === 'updated')
  tr.release('one')
  await new Promise((r) => setTimeout(r, 30))
  assert.equal(updated().length, 0)
  tr.fail()
  await s.itemTranscription.idle()
  const u = updated()
  assert.equal(u.length, 1); assert.equal(u[0].transcription, 'failed')
  assert.deepEqual(u[0].comment.attachments.map((a) => a.transcript), ['one', null])
})

test("another user's blob is never transcribed into this user's comment", async (t) => {
  const tr = gatedTranscriber()
  const { s, client, itemId } = await fleet(t, { transcriber: tr })
  const r = await s.http(`/items/${itemId}/comments`, { method: 'POST', token: client, body: { attachments: [voice('patblob')] } })
  await s.itemTranscription.idle()
  assert.deepEqual(tr.calls, [])
  assert.equal(listComments(s.db, itemId).find((c) => c.id === r.json.comment.id).attachments[0].transcript_status, 'failed')
})

test('agent comments and idempotent replays queue nothing; transcription off leaves markers untouched', async (t) => {
  const tr = gatedTranscriber()
  const { s, agent, client, itemId } = await fleet(t, { transcriber: tr })
  const a = await s.http(`/items/${itemId}/comments`, { method: 'POST', token: agent.token, body: { attachments: [voice('b1')] } })
  assert.equal(a.json.comment.attachments[0].transcript_status, undefined)
  const post = () => s.http(`/items/${itemId}/comments`, { method: 'POST', token: client, headers: { 'idempotency-key': 'k1' }, body: { attachments: [voice('b1')] } })
  assert.equal((await post()).status, 201); assert.equal((await post()).status, 200)
  assert.equal(tr.calls.length, 1)
  tr.release('x'); await s.itemTranscription.idle()

  const off = await fleet(t, { transcriber: null })
  const r = await off.s.http(`/items/${off.itemId}/comments`, { method: 'POST', token: off.client, body: { attachments: [voice('b1')] } })
  assert.equal(r.json.comment.attachments[0].transcript_status, undefined)
  assert.equal(off.s.itemTranscription.enabled, false)
})

test("the bridge's own PATCH wins the race: its words are kept, the marker still goes out as done", async (t) => {
  const tr = gatedTranscriber()
  const { s, agent, client, itemId } = await fleet(t, { transcriber: tr })
  const r = await s.http(`/items/${itemId}/comments`, { method: 'POST', token: client, body: { attachments: [voice('b1')] } })
  const p = await s.http(`/items/${itemId}/comments/${r.json.comment.id}`, { method: 'PATCH', token: agent.token, body: { blob_ref: 'b1', transcript: 'bridge words' } })
  assert.equal(p.json.comment.attachments[0].transcript_status, 'done')
  tr.release('journal words'); await s.itemTranscription.idle()
  assert.equal(listComments(s.db, itemId).find((c) => c.id === r.json.comment.id).attachments[0].transcript, 'bridge words')
})

test('recover(): a comment left pending by a dead process is re-queued at boot', async (t) => {
  const tr = gatedTranscriber()
  const { s, dan, client, itemId } = await fleet(t, { transcriber: tr })
  const r = await s.http(`/items/${itemId}/comments`, { method: 'POST', token: client, body: { attachments: [voice('b1')] } })
  assert.deepEqual(listPendingTranscripts(s.db), [{ commentId: r.json.comment.id, userId: dan.id, blobRef: 'b1' }])
  assert.equal(s.itemTranscription.recover(), 1) // what a fresh process would do
  tr.release('first'); await s.itemTranscription.idle()
  assert.equal(tr.calls.length, 1) // the duplicate job saw it settled and never ran whisper
  assert.deepEqual(listPendingTranscripts(s.db), [])
  // ...and emitted no second marker.
  const n = s.db.prepare("SELECT payload FROM events WHERE type='item'").all().filter((e) => JSON.parse(e.payload).action === 'updated').length
  assert.equal(n, 1)
})

test('makeTranscriber: off without a model, off (loudly) when the model path is missing; whisper text is cleaned', () => {
  assert.equal(makeTranscriber({ modelPath: '' }), null)
  const errs = []
  assert.equal(makeTranscriber({ modelPath: '/nope/models/ggml-base.bin', log: { error: (m) => errs.push(m) } }), null)
  assert.equal(errs.length, 1)
  assert.equal(cleanWhisperText(' [BLANK_AUDIO]\n Use option A.\n'), 'Use option A.')
})
