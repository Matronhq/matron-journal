import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { startTestServer, makeWsClient } from './helpers.js'
import { createUser, createAgent } from '../src/auth.js'
import { upsertConversation } from '../src/journal.js'
import { openDb } from '../src/db.js'
import { makeBlobTranscripts, readBlobTranscript } from '../src/blob-transcripts.js'

// A cloud transcriber whose jobs the test releases by hand, so 'pending' is a
// state the assertions can observe rather than a race.
function gatedCloud({ concurrency = 4 } = {}) {
  const calls = []
  const waiters = []
  return {
    kind: 'cloud',
    concurrency,
    calls,
    transcribeFile(diskPath, { signal, userId } = {}) {
      calls.push({ diskPath, userId })
      return new Promise((resolve, reject) => {
        waiters.push({ resolve, reject })
        signal?.addEventListener('abort', () => reject(new Error('aborted')))
      })
    },
    pending: () => waiters.length,
    release(text) { waiters.shift().resolve(text) },
    fail(msg = 'boom') { waiters.shift().reject(new Error(msg)) },
  }
}

const until = async (pred, ms = 2000) => {
  const t0 = Date.now()
  while (!pred()) {
    if (Date.now() - t0 > ms) throw new Error('timed out')
    await new Promise((r) => setTimeout(r, 5))
  }
}

// Users 1 and 2, for the tests that drive makeBlobTranscripts on a bare DB.
async function users(db) {
  assert.equal((await createUser(db, 'u1', 'pw')).id, 1)
  assert.equal((await createUser(db, 'u2', 'pw')).id, 2)
}

async function setup(t, serverOpts = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'matron-bt-'))
  const s = await startTestServer({ dbPath: path.join(dir, 'test.db'), ...serverOpts })
  t.after(() => s.close())
  const dan = await createUser(s.db, 'dan', 'pw')
  await createUser(s.db, 'pat', 'pw')
  const agent = createAgent(s.db, dan.id, 'dev-2')
  upsertConversation(s.db, { id: 'c1', ownerUserId: dan.id, title: 'C1', agentDeviceId: agent.deviceId })
  const login = async (name) => (await s.http('/login', { method: 'POST', body: { username: name, password: 'pw', device_name: 'phone' } })).json.token
  const upload = async (token, type = 'audio/mp4', bytes = Buffer.from('fake-audio')) => {
    const r = await fetch(s.base + '/media', { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': type }, body: bytes })
    return r.json()
  }
  return { s, dan, agent, danToken: await login('dan'), patToken: await login('pat'), upload }
}

test('a voice note is transcribed at upload; GET transcript waits for it and returns the words', async (t) => {
  const tr = gatedCloud()
  const { s, danToken, upload } = await setup(t, { transcriber: tr })
  const up = await upload(danToken)
  assert.equal(up.transcript_status, 'pending')
  await until(() => tr.calls.length === 1)
  assert.equal(tr.calls[0].userId, s.db.prepare('SELECT owner_user_id FROM blobs WHERE id=?').get(up.media_id).owner_user_id)

  const now = await s.http(`/media/${up.media_id}/transcript`, { token: danToken })
  assert.deepEqual(now.json, { status: 'pending' })

  const waiting = s.http(`/media/${up.media_id}/transcript?wait=10`, { token: danToken })
  await new Promise((r) => setTimeout(r, 30))
  tr.release('  Deploy the journal  ')
  const done = await waiting
  assert.equal(done.status, 200)
  assert.deepEqual(done.json, { status: 'done', transcript: 'Deploy the journal' })
})

test('a failed transcription reads failed (the bridge then falls back to its own whisper)', async (t) => {
  const tr = gatedCloud()
  const { s, danToken, upload } = await setup(t, { transcriber: tr })
  const up = await upload(danToken)
  await until(() => tr.pending() === 1)
  tr.fail('HTTP 500')
  const r = await s.http(`/media/${up.media_id}/transcript?wait=5`, { token: danToken })
  assert.deepEqual(r.json, { status: 'failed' })
})

test('not transcribed: images, agent uploads, and a journal without a cloud transcriber', async (t) => {
  const tr = gatedCloud()
  const { s, agent, danToken, upload } = await setup(t, { transcriber: tr })
  const img = await upload(danToken, 'image/png')
  assert.equal(img.transcript_status, undefined)
  const fromAgent = await upload(agent.token)
  assert.equal(fromAgent.transcript_status, undefined)
  await new Promise((r) => setTimeout(r, 20))
  assert.equal(tr.calls.length, 0)
  assert.deepEqual((await s.http(`/media/${fromAgent.media_id}/transcript`, { token: agent.token })).json, { status: 'none' })

  // Whisper-only (or nothing): chat notes stay the bridge's job.
  const whisperish = { kind: 'whisper', transcribeFile: async () => 'x' }
  const w = await setup(t, { transcriber: whisperish })
  const up = await w.upload(w.danToken)
  assert.equal(up.transcript_status, undefined)
  assert.deepEqual((await w.s.http(`/media/${up.media_id}/transcript?wait=1`, { token: w.danToken })).json, { status: 'none' })
  const none = await setup(t, { transcriber: null })
  const up2 = await none.upload(none.danToken)
  assert.equal(up2.transcript_status, undefined)
})

test("someone else's voice note is a 404, same as the media itself; unknown ids too", async (t) => {
  const tr = gatedCloud()
  const { s, danToken, patToken, upload } = await setup(t, { transcriber: tr })
  const up = await upload(danToken)
  await until(() => tr.pending() === 1)
  tr.release('private words')
  await s.http(`/media/${up.media_id}/transcript?wait=5`, { token: danToken })
  const r = await s.http(`/media/${up.media_id}/transcript`, { token: patToken })
  assert.equal(r.status, 404)
  assert.equal(JSON.stringify(r.json).includes('private'), false)
  assert.equal((await s.http('/media/nope/transcript', { token: danToken })).status, 404)
  assert.equal((await s.http(`/media/${up.media_id}/transcript`)).status, 401)
})

test('backlog is bounded per user: an upload past the cap is left to the bridge', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'matron-bt-'))
  const db = openDb(path.join(dir, 'x.db'))
  t.after(() => db.close())
  await users(db)
  const tr = gatedCloud({ concurrency: 1 })
  const bt = makeBlobTranscripts({ db, transcriber: tr, maxQueuedPerUser: 2 })
  const ins = db.prepare('INSERT INTO blobs(id,owner_user_id,content_type,size,sha256,disk_path,created_at) VALUES(?,?,?,?,?,?,?)')
  for (const id of ['a', 'b', 'c']) ins.run(id, 1, 'audio/ogg', 1, 'x', `/m/${id}`, Date.now())
  assert.equal(bt.start('a', 1, 'audio/ogg'), true)
  assert.equal(bt.start('b', 1, 'audio/ogg'), true)
  assert.equal(bt.start('c', 1, 'audio/ogg'), false)
  assert.equal(bt.start('a', 1, 'audio/ogg'), false) // already pending
  assert.equal(bt.start('c', 2, 'audio/ogg'), false) // not the owner
  assert.deepEqual(readBlobTranscript(db, 'c'), { status: 'none' })
  await until(() => tr.pending() === 1) // concurrency 1: only one running
  tr.release('one')
  await until(() => tr.pending() === 1)
  tr.release('two')
  assert.deepEqual(await bt.wait('b', 1000), { status: 'done', transcript: 'two' })
  assert.equal(bt.start('c', 1, 'audio/ogg'), true) // room again
  await bt.close()
})

test('recover: a recent pending row is re-run, a stale one is failed', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'matron-bt-'))
  const db = openDb(path.join(dir, 'x.db'))
  t.after(() => db.close())
  await users(db)
  const ins = db.prepare("INSERT INTO blobs(id,owner_user_id,content_type,size,sha256,disk_path,created_at,transcript_status) VALUES(?,?,?,?,?,?,?,'pending')")
  ins.run('fresh', 1, 'audio/ogg', 1, 'x', '/m/fresh', Date.now())
  ins.run('stale', 1, 'audio/ogg', 1, 'x', '/m/stale', Date.now() - 2 * 60 * 60 * 1000)
  const tr = gatedCloud()
  const bt = makeBlobTranscripts({ db, transcriber: tr, log: { log() {}, error() {} } })
  assert.equal(bt.recover(), 1)
  assert.deepEqual(readBlobTranscript(db, 'stale'), { status: 'failed' })
  await until(() => tr.pending() === 1)
  tr.release('back')
  assert.deepEqual(await bt.wait('fresh', 1000), { status: 'done', transcript: 'back' })
  await bt.close()
})

test('close leaves a running job pending for the next boot, and does not hang', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'matron-bt-'))
  const db = openDb(path.join(dir, 'x.db'))
  t.after(() => db.close())
  await users(db)
  db.prepare('INSERT INTO blobs(id,owner_user_id,content_type,size,sha256,disk_path,created_at) VALUES(?,?,?,?,?,?,?)').run('a', 1, 'audio/ogg', 1, 'x', '/m/a', Date.now())
  const tr = gatedCloud()
  const bt = makeBlobTranscripts({ db, transcriber: tr })
  bt.start('a', 1, 'audio/ogg')
  await until(() => tr.pending() === 1)
  await bt.close()
  assert.deepEqual(readBlobTranscript(db, 'a'), { status: 'pending' })
})

test('an item voice note reuses the upload-time transcript: the audio is sent to the cloud once', async (t) => {
  const tr = gatedCloud()
  const { s, agent, danToken, upload } = await setup(t, { transcriber: tr })
  const made = await s.http('/items', { method: 'POST', token: agent.token, body: { kind: 'question', title: 'Which?', convo_id: 'c1' } })
  const up = await upload(danToken)
  await until(() => tr.pending() === 1)
  const ws = await makeWsClient(s.base, { token: agent.token, cursor: null })
  await ws.waitFor((f) => f.op === 'hello_ok')
  const r = await s.http(`/items/${made.json.item.id}/comments`, { method: 'POST', token: danToken, body: { attachments: [{ blob_ref: up.media_id, mime: 'audio/mp4', name: 'v.m4a', size: 10 }] } })
  assert.equal(r.status, 201)
  assert.equal(r.json.comment.attachments[0].transcript_status, 'pending')
  tr.release('option A please')
  const updated = await ws.waitFor((f) => f.kind === 'journal' && f.type === 'item' && f.payload.action === 'updated')
  assert.equal(updated.payload.comment.attachments[0].transcript, 'option A please')
  assert.equal(tr.calls.length, 1)
  ws.close()
})
