import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { startTestServer, makeWsClient } from './helpers.js'
import { createUser, createAgent } from '../src/auth.js'
import { upsertConversation } from '../src/journal.js'
import { openDb } from '../src/db.js'
import { makeBlobTranscripts, readBlobTranscript, isTranscribableType } from '../src/blob-transcripts.js'
import { makeAzureTranscriber, makeChainedTranscriber } from '../src/cloud-transcribe.js'
import { makeTranscriber } from '../src/transcribe.js'

// A cloud transcriber whose jobs the test releases by hand, so 'pending' is a
// state the assertions can observe rather than a race.
// With `segments`, it also has transcribeFileSegments (what a video job
// calls); each call records which method ran.
function gatedCloud({ concurrency = 4, segments = false } = {}) {
  const calls = []
  const waiters = []
  const gate = (method) => (diskPath, { signal, userId } = {}) => {
    calls.push({ diskPath, userId, method })
    return new Promise((resolve, reject) => {
      waiters.push({ resolve, reject })
      signal?.addEventListener('abort', () => reject(new Error('aborted')))
    })
  }
  return {
    kind: 'cloud',
    concurrency,
    calls,
    transcribeFile: gate('transcribeFile'),
    ...(segments ? { transcribeFileSegments: gate('transcribeFileSegments') } : {}),
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
  const alice = await createUser(s.db, 'alice', 'pw')
  await createUser(s.db, 'pat', 'pw')
  const agent = createAgent(s.db, alice.id, 'box-2')
  upsertConversation(s.db, { id: 'c1', ownerUserId: alice.id, title: 'C1', agentDeviceId: agent.deviceId })
  const login = async (name) => (await s.http('/login', { method: 'POST', body: { username: name, password: 'pw', device_name: 'phone' } })).json.token
  const upload = async (token, type = 'audio/mp4', bytes = Buffer.from('fake-audio')) => {
    const r = await fetch(s.base + '/media', { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': type }, body: bytes })
    return r.json()
  }
  return { s, alice, agent, aliceToken: await login('alice'), patToken: await login('pat'), upload }
}

test('a voice note is transcribed at upload; GET transcript waits for it and returns the words', async (t) => {
  const tr = gatedCloud()
  const { s, aliceToken, upload } = await setup(t, { transcriber: tr })
  const up = await upload(aliceToken)
  assert.equal(up.transcript_status, 'pending')
  await until(() => tr.calls.length === 1)
  assert.equal(tr.calls[0].userId, s.db.prepare('SELECT owner_user_id FROM blobs WHERE id=?').get(up.media_id).owner_user_id)

  const now = await s.http(`/media/${up.media_id}/transcript`, { token: aliceToken })
  assert.deepEqual(now.json, { status: 'pending' })

  const waiting = s.http(`/media/${up.media_id}/transcript?wait=10`, { token: aliceToken })
  await new Promise((r) => setTimeout(r, 30))
  tr.release('  Deploy the journal  ')
  const done = await waiting
  assert.equal(done.status, 200)
  assert.deepEqual(done.json, { status: 'done', transcript: 'Deploy the journal' })
  const stamped = s.db.prepare('SELECT transcribed_at FROM blobs WHERE id=?').get(up.media_id).transcribed_at
  assert.ok(Number.isInteger(stamped) && Date.now() - stamped < 5000, 'done stamps transcribed_at (the 7-day audio clock)')
})

test('a failed transcription reads failed (the bridge then falls back to its own whisper)', async (t) => {
  const tr = gatedCloud()
  const { s, aliceToken, upload } = await setup(t, { transcriber: tr })
  const up = await upload(aliceToken)
  await until(() => tr.pending() === 1)
  tr.fail('HTTP 500')
  const r = await s.http(`/media/${up.media_id}/transcript?wait=5`, { token: aliceToken })
  assert.deepEqual(r.json, { status: 'failed' })
})

test('not transcribed: images, agent uploads, and a journal without a cloud transcriber', async (t) => {
  const tr = gatedCloud()
  const { s, agent, aliceToken, upload } = await setup(t, { transcriber: tr })
  const img = await upload(aliceToken, 'image/png')
  assert.equal(img.transcript_status, undefined)
  const fromAgent = await upload(agent.token)
  assert.equal(fromAgent.transcript_status, undefined)
  await new Promise((r) => setTimeout(r, 20))
  assert.equal(tr.calls.length, 0)
  assert.deepEqual((await s.http(`/media/${fromAgent.media_id}/transcript`, { token: agent.token })).json, { status: 'none' })

  // Whisper-only (or nothing): chat notes stay the bridge's job.
  const whisperish = { kind: 'whisper', transcribeFile: async () => 'x' }
  const w = await setup(t, { transcriber: whisperish })
  const up = await w.upload(w.aliceToken)
  assert.equal(up.transcript_status, undefined)
  assert.deepEqual((await w.s.http(`/media/${up.media_id}/transcript?wait=1`, { token: w.aliceToken })).json, { status: 'none' })
  const none = await setup(t, { transcriber: null })
  const up2 = await none.upload(none.aliceToken)
  assert.equal(up2.transcript_status, undefined)
})

test("someone else's voice note is a 404, same as the media itself; unknown ids too", async (t) => {
  const tr = gatedCloud()
  const { s, aliceToken, patToken, upload } = await setup(t, { transcriber: tr })
  const up = await upload(aliceToken)
  await until(() => tr.pending() === 1)
  tr.release('private words')
  await s.http(`/media/${up.media_id}/transcript?wait=5`, { token: aliceToken })
  const r = await s.http(`/media/${up.media_id}/transcript`, { token: patToken })
  assert.equal(r.status, 404)
  assert.equal(JSON.stringify(r.json).includes('private'), false)
  assert.equal((await s.http('/media/nope/transcript', { token: aliceToken })).status, 404)
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
  const { s, agent, aliceToken, upload } = await setup(t, { transcriber: tr })
  const made = await s.http('/items', { method: 'POST', token: agent.token, body: { kind: 'question', title: 'Which?', convo_id: 'c1' } })
  const up = await upload(aliceToken)
  await until(() => tr.pending() === 1)
  const ws = await makeWsClient(s.base, { token: agent.token, cursor: null })
  await ws.waitFor((f) => f.op === 'hello_ok')
  const r = await s.http(`/items/${made.json.item.id}/comments`, { method: 'POST', token: aliceToken, body: { attachments: [{ blob_ref: up.media_id, mime: 'audio/mp4', name: 'v.m4a', size: 10 }] } })
  assert.equal(r.status, 201)
  assert.equal(r.json.comment.attachments[0].transcript_status, 'pending')
  tr.release('option A please')
  const updated = await ws.waitFor((f) => f.kind === 'journal' && f.type === 'item' && f.payload.action === 'updated')
  assert.equal(updated.payload.comment.attachments[0].transcript, 'option A please')
  assert.equal(tr.calls.length, 1)
  ws.close()
})

const SEGMENTS = [{ start_ms: 0, text: 'a' }, { start_ms: 1200, text: 'b' }]

test('isTranscribableType: audio and video, any case; nothing else', () => {
  for (const ct of ['audio/mp4', 'audio/ogg', 'video/mp4', 'video/quicktime', 'Video/WebM']) assert.equal(isTranscribableType(ct), true, ct)
  for (const ct of ['image/png', 'application/octet-stream', 'text/plain', '', null, undefined]) assert.equal(isTranscribableType(ct), false, String(ct))
})

test('video upload by a user is queued and stores segments', async (t) => {
  const tr = gatedCloud({ segments: true })
  const { s, aliceToken, upload } = await setup(t, { transcriber: tr })
  const up = await upload(aliceToken, 'video/mp4', Buffer.from('fake-video'))
  assert.equal(up.transcript_status, 'pending')
  await until(() => tr.pending() === 1)
  assert.equal(tr.calls[0].method, 'transcribeFileSegments')
  const waiting = s.http(`/media/${up.media_id}/transcript?wait=10`, { token: aliceToken })
  await new Promise((r) => setTimeout(r, 30))
  tr.release({ text: ' a b ', segments: SEGMENTS })
  const done = await waiting
  assert.equal(done.status, 200)
  assert.deepEqual(done.json, { status: 'done', transcript: 'a b', segments: SEGMENTS })
  const row = s.db.prepare('SELECT transcript_segments, transcribed_at FROM blobs WHERE id=?').get(up.media_id)
  assert.equal(typeof row.transcript_segments, 'string')
  assert.deepEqual(JSON.parse(row.transcript_segments), SEGMENTS)
  assert.ok(Number.isInteger(row.transcribed_at))
})

test('audio upload response has no segments key', async (t) => {
  const tr = gatedCloud({ segments: true })
  const { s, aliceToken, upload } = await setup(t, { transcriber: tr })
  const up = await upload(aliceToken, 'audio/mp4')
  await until(() => tr.pending() === 1)
  assert.equal(tr.calls[0].method, 'transcribeFile') // audio jobs stay as they are
  tr.release('just words')
  const done = await s.http(`/media/${up.media_id}/transcript?wait=5`, { token: aliceToken })
  assert.deepEqual(done.json, { status: 'done', transcript: 'just words' })
  assert.equal('segments' in done.json, false)
  assert.equal(s.db.prepare('SELECT transcript_segments FROM blobs WHERE id=?').get(up.media_id).transcript_segments, null)
})

test('video job whose transcriber throws settles failed', async (t) => {
  const tr = gatedCloud({ concurrency: 1, segments: true })
  const { s, aliceToken, upload } = await setup(t, { transcriber: tr })
  const up = await upload(aliceToken, 'video/mp4')
  await until(() => tr.pending() === 1)
  tr.fail('Output file does not contain any stream')
  const r = await s.http(`/media/${up.media_id}/transcript?wait=5`, { token: aliceToken })
  assert.deepEqual(r.json, { status: 'failed' })
  assert.equal(s.db.prepare('SELECT transcript_segments FROM blobs WHERE id=?').get(up.media_id).transcript_segments, null)
  // The one slot is free again: the next upload runs.
  const next = await upload(aliceToken, 'audio/mp4')
  await until(() => tr.pending() === 1)
  tr.release('next')
  assert.deepEqual((await s.http(`/media/${next.media_id}/transcript?wait=5`, { token: aliceToken })).json, { status: 'done', transcript: 'next' })
})

test('a video with no audio stream, through the real Azure-then-whisper chain, settles failed and does not wedge the queue', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'matron-bt-w-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const modelPath = path.join(dir, 'ggml-small.bin'); fs.writeFileSync(modelPath, '')
  const cliPath = path.join(dir, 'whisper-cli'); fs.writeFileSync(cliPath, '')
  // ffmpeg as it behaves on a video with no audio track: it refuses (here,
  // any blob whose bytes say "mute"). Anything else decodes.
  const ffmpegRuns = []
  const ffmpeg = async (args) => {
    const input = args[args.indexOf('-i') + 1]
    const mute = fs.readFileSync(input, 'utf8').startsWith('mute')
    ffmpegRuns.push(mute ? 'mute' : 'ok')
    if (mute) throw new Error('Output file #0 does not contain any stream')
    fs.writeFileSync(args[args.length - 1], 'decoded')
    return { stdout: '' }
  }
  const quiet = { log() {}, error() {} }
  // Azure is down for the whole test, so a video with sound has to go
  // through whisper's one-at-a-time slot.
  let fetched = 0
  const azure = makeAzureTranscriber({
    key: 'k',
    exec: (cmd, args) => ffmpeg(args),
    fetchImpl: async () => { fetched++; return { ok: false, status: 503, text: async () => 'busy' } },
  })
  let whisperRuns = 0
  const whisper = makeTranscriber({ modelPath, cliPath, prompt: '', log: quiet, exec: async (cmd, args) => {
    if (cmd === 'ffmpeg') return ffmpeg(args)
    whisperRuns++
    return { stdout: '[00:00:00.000 --> 00:00:01.200]   a\n[00:00:01.200 --> 00:00:02.000]  b\n' }
  } })
  const tr = makeChainedTranscriber(azure, whisper, { log: quiet })
  assert.equal(typeof tr.transcribeFileSegments, 'function')
  const { s, aliceToken, upload } = await setup(t, { transcriber: tr })

  const up = await upload(aliceToken, 'video/mp4', Buffer.from('mute screen recording'))
  assert.equal(up.transcript_status, 'pending')
  const r = await s.http(`/media/${up.media_id}/transcript?wait=10`, { token: aliceToken })
  assert.deepEqual(r.json, { status: 'failed' })
  // Azure's ffmpeg refused, and the chain did not queue the same decode on
  // whisper: nothing was sent, whisper never ran.
  assert.deepEqual(ffmpegRuns, ['mute'])
  assert.equal(fetched, 0)
  assert.equal(whisperRuns, 0)

  // Both queues are free: a video with sound fails on Azure, goes through
  // whisper's one-at-a-time slot, and lands with its segments.
  const next = await upload(aliceToken, 'video/mp4', Buffer.from('a video with sound'))
  const ok = await s.http(`/media/${next.media_id}/transcript?wait=10`, { token: aliceToken })
  assert.deepEqual(ok.json, { status: 'done', transcript: 'a b', segments: SEGMENTS })
  assert.deepEqual(ffmpegRuns, ['mute', 'ok', 'ok'])
  assert.equal(fetched, 1)
  assert.equal(whisperRuns, 1)
})

test('a video is left to the bridge when the transcriber cannot give segments', async (t) => {
  const tr = gatedCloud() // transcribeFile only
  const { aliceToken, upload } = await setup(t, { transcriber: tr })
  const up = await upload(aliceToken, 'video/mp4')
  assert.equal(up.transcript_status, undefined)
  await new Promise((r) => setTimeout(r, 20))
  assert.equal(tr.calls.length, 0)
})

test('readBlobTranscript: segments only on a done row that has them', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'matron-bt-'))
  const db = openDb(path.join(dir, 'x.db'))
  t.after(() => db.close())
  await users(db)
  const ins = db.prepare('INSERT INTO blobs(id,owner_user_id,content_type,size,sha256,disk_path,created_at,transcript_status,transcript,transcript_segments) VALUES(?,?,?,?,?,?,?,?,?,?)')
  ins.run('v', 1, 'video/mp4', 1, 'x', '/m/v', Date.now(), 'done', 'a b', JSON.stringify(SEGMENTS))
  ins.run('a', 1, 'audio/ogg', 1, 'x', '/m/a', Date.now(), 'done', 'words', null)
  ins.run('p', 1, 'video/mp4', 1, 'x', '/m/p', Date.now(), 'pending', null, null)
  assert.deepEqual(readBlobTranscript(db, 'v'), { status: 'done', transcript: 'a b', segments: SEGMENTS })
  assert.deepEqual(readBlobTranscript(db, 'a'), { status: 'done', transcript: 'words' })
  assert.deepEqual(readBlobTranscript(db, 'p'), { status: 'pending' })
})

test('migration: an existing blobs table gains transcript_segments, NULL on old rows', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'matron-bt-'))
  const file = path.join(dir, 'x.db')
  const db = openDb(file)
  await users(db)
  db.prepare("INSERT INTO blobs(id,owner_user_id,content_type,size,sha256,disk_path,created_at,transcript_status,transcript) VALUES('old',1,'audio/ogg',1,'x','/m/old',1,'done','w')").run()
  db.exec('ALTER TABLE blobs DROP COLUMN transcript_segments')
  db.close()
  const again = openDb(file)
  t.after(() => again.close())
  const cols = again.prepare('PRAGMA table_info(blobs)').all()
  const col = cols.find((c) => c.name === 'transcript_segments')
  assert.ok(col, 'column added')
  assert.equal(col.type, 'TEXT')
  assert.equal(col.notnull, 0)
  assert.equal(again.prepare("SELECT transcript_segments FROM blobs WHERE id='old'").get().transcript_segments, null)
  assert.deepEqual(readBlobTranscript(again, 'old'), { status: 'done', transcript: 'w' })
})

test('a video job stores segments as [{start_ms: integer, text: string}], whatever shape the transcriber returned', async (t) => {
  const tr = gatedCloud({ segments: true })
  const { s, aliceToken, upload } = await setup(t, { transcriber: tr })
  const up = await upload(aliceToken, 'video/mp4')
  await until(() => tr.pending() === 1)
  tr.release({ text: 'a b c', segments: [{ start_ms: '1200.7', text: '  b ', extra: 'x' }, null, { start_ms: -5, text: 'a' }, { start_ms: 3000, text: '   ' }, { start_ms: 'nope', text: 42 }] })
  const done = await s.http(`/media/${up.media_id}/transcript?wait=5`, { token: aliceToken })
  assert.deepEqual(done.json.segments, [{ start_ms: 1201, text: 'b' }, { start_ms: 0, text: 'a' }, { start_ms: 0, text: '42' }])
})
