import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'
import Database from 'better-sqlite3'
import { startTestServer } from './helpers.js'
import { createUser, createAgent } from '../src/auth.js'
import { upsertConversation } from '../src/journal.js'
import { openDb, blobImageDims } from '../src/db.js'
import { backfillImageDims } from '../src/items.js'

// Spec 2026-10-01 (item thread layout shift): the journal stamps each image
// attachment with the displayed width/height it reads from the blob's own
// header, so the apps can reserve the image's box before its bytes load.

const fixtures = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'images')

async function fleet(t) {
  const dbPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'matron-dims-')), 'test.db')
  const s = await startTestServer({ dbPath })
  t.after(() => s.close())
  const alice = await createUser(s.db, 'alice', 'pw')
  const agent = createAgent(s.db, alice.id, 'box-2')
  upsertConversation(s.db, { id: 'c1', ownerUserId: alice.id, title: 'C1', agentDeviceId: agent.deviceId })
  const login = await s.http('/login', { method: 'POST', body: { username: 'alice', password: 'pw', device_name: 'mac' } })
  return { s, alice, agent, client: login.json.token, dbPath }
}

async function upload(s, token, file, contentType) {
  const r = await fetch(s.base + '/media', {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': contentType },
    body: fs.readFileSync(path.join(fixtures, file)),
  })
  assert.equal(r.status, 200)
  return r.json()
}

const att = (up, mime, extra = {}) => ({ blob_ref: up.media_id, mime, name: 'x', size: up.size, ...extra })

test('POST /media answers an image upload with its displayed width/height; a non-image gets none', async (t) => {
  const { s, client } = await fleet(t)
  const jpg = await upload(s, client, 'w40h30-orient6.jpg', 'image/jpeg')
  assert.equal(jpg.width, 30); assert.equal(jpg.height, 40)
  const heic = await upload(s, client, 'w30h40.heic', 'image/heic')
  assert.equal(heic.width, 30); assert.equal(heic.height, 40)
  const audio = await upload(s, client, 'w40h30.png', 'audio/mp4') // labelled audio: never sniffed
  assert.equal(audio.width, undefined); assert.equal(audio.height, undefined)
  const row = s.db.prepare('SELECT width, height FROM blobs WHERE id=?').get(audio.media_id)
  assert.deepEqual({ ...row }, { width: 0, height: 0 }) // read-and-unknown, never re-read
})

test('item and comment image attachments carry the blob\'s real size; a size the client claims is dropped', async (t) => {
  const { s, agent, client } = await fleet(t)
  const png = await upload(s, agent.token, 'w40h30.png', 'image/png')
  const made = await s.http('/items', {
    method: 'POST', token: agent.token,
    body: { kind: 'question', title: 'Look', convo_id: 'c1', attachments: [att(png, 'image/png', { width: 999, height: 1 })] },
  })
  assert.equal(made.status, 201)
  assert.equal(made.json.item.attachments[0].width, 40)
  assert.equal(made.json.item.attachments[0].height, 30)
  const id = made.json.item.id

  const shot = await upload(s, client, 'w40h30-orient6.jpg', 'image/jpeg')
  const voice = await upload(s, client, 'w40h30.gif', 'audio/mp4')
  const c = await s.http(`/items/${id}/comments`, {
    method: 'POST', token: client,
    body: { body: 'see', attachments: [att(shot, 'image/jpeg', { width: 5, height: 5 }), att(voice, 'audio/mp4'), { blob_ref: 'gone', mime: 'image/png', name: 'g', size: 1 }] },
  })
  assert.equal(c.status, 201)
  const [img, audio, gone] = c.json.comment.attachments
  assert.equal(img.width, 30); assert.equal(img.height, 40) // EXIF portrait, not the forged 5 × 5
  assert.equal(audio.width, undefined) // not an image attachment
  assert.equal(gone.width, undefined) // no blob: no size, and no error

  const one = await s.http(`/items/${id}`, { token: client })
  assert.equal(one.json.item.attachments[0].width, 40)
  assert.equal(one.json.comments[0].attachments[0].height, 40)
})

test('a blob from before the width/height columns is sized lazily on first use, then cached', async (t) => {
  const { s, agent, client } = await fleet(t)
  const png = await upload(s, client, 'w40h30.png', 'image/png')
  s.db.prepare('UPDATE blobs SET width=NULL, height=NULL WHERE id=?').run(png.media_id)
  const made = await s.http('/items', { method: 'POST', token: agent.token, body: { kind: 'task', title: 'T', convo_id: 'c1', attachments: [att(png, 'image/png')] } })
  assert.equal(made.json.item.attachments[0].width, 40)
  const row = s.db.prepare('SELECT width, height FROM blobs WHERE id=?').get(png.media_id)
  assert.deepEqual({ ...row }, { width: 40, height: 30 })
  // Cached: the file can go and the size is still known.
  fs.rmSync(s.db.prepare('SELECT disk_path FROM blobs WHERE id=?').get(png.media_id).disk_path)
  assert.deepEqual(blobImageDims(s.db, png.media_id), { width: 40, height: 30 })
})

test('backfillImageDims stamps sizes onto comments written before the journal recorded them, and is idempotent', async (t) => {
  const { s, agent, client } = await fleet(t)
  const png = await upload(s, client, 'w40h30.png', 'image/png')
  const heic = await upload(s, client, 'w30h40.heic', 'image/heic')
  const made = await s.http('/items', { method: 'POST', token: agent.token, body: { kind: 'task', title: 'T', convo_id: 'c1', attachments: [att(png, 'image/png')] } })
  const id = made.json.item.id
  const c = await s.http(`/items/${id}/comments`, { method: 'POST', token: client, body: { body: 'x', attachments: [att(heic, 'image/heic'), { blob_ref: 'gone', mime: 'image/png', name: 'g', size: 1 }] } })
  const plain = await s.http(`/items/${id}/comments`, { method: 'POST', token: client, body: { body: 'no images' } })
  // Rewind to the pre-feature shape: no sizes on the attachments or the blobs.
  for (const row of s.db.prepare('SELECT id, attachments FROM item_comments').all()) {
    const stripped = JSON.parse(row.attachments).map(({ width, height, ...a }) => a)
    s.db.prepare('UPDATE item_comments SET attachments=? WHERE id=?').run(JSON.stringify(stripped), row.id)
  }
  s.db.prepare('UPDATE blobs SET width=NULL, height=NULL').run()
  const before = s.db.prepare('SELECT attachments FROM item_comments WHERE id=?').get(plain.json.comment.id).attachments

  const logs = []
  const r = await backfillImageDims(s.db, { batchSize: 1, log: (l) => logs.push(l) })
  assert.equal(r.updated, 2)
  assert.match(logs[0], /2 comment/)
  const one = await s.http(`/items/${id}`, { token: client })
  assert.deepEqual([one.json.item.attachments[0].width, one.json.item.attachments[0].height], [40, 30])
  const thread = one.json.comments.find((x) => x.id === c.json.comment.id)
  assert.deepEqual([thread.attachments[0].width, thread.attachments[0].height], [30, 40])
  assert.equal(thread.attachments[1].width, undefined)
  assert.equal(s.db.prepare('SELECT attachments FROM item_comments WHERE id=?').get(plain.json.comment.id).attachments, before)

  assert.equal((await backfillImageDims(s.db)).updated, 0) // nothing left to do
  let stops = 0
  assert.equal((await backfillImageDims(s.db, { shouldStop: () => ++stops > 0 })).updated, 0)
})

test('openDb adds width/height to an existing blobs table without them', () => {
  const dbPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'matron-dims-mig-')), 'old.db')
  const old = new Database(dbPath)
  old.exec(`CREATE TABLE users(id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE, password_hash TEXT NOT NULL, created_at INTEGER NOT NULL);
    CREATE TABLE blobs(id TEXT PRIMARY KEY, owner_user_id INTEGER NOT NULL REFERENCES users(id), content_type TEXT NOT NULL,
      size INTEGER NOT NULL, sha256 TEXT NOT NULL, disk_path TEXT NOT NULL, created_at INTEGER NOT NULL);
    INSERT INTO users VALUES(1,'alice','x',0);
    INSERT INTO blobs VALUES('b1',1,'image/png',1,'s','${path.join(fixtures, 'w40h30.png')}',0);`)
  old.close()
  const db = openDb(dbPath)
  try {
    const cols = db.prepare('PRAGMA table_info(blobs)').all().map((c) => c.name)
    assert.ok(cols.includes('width') && cols.includes('height'))
    assert.deepEqual(blobImageDims(db, 'b1'), { width: 40, height: 30 })
  } finally {
    db.close()
  }
})
