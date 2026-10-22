import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import crypto from 'node:crypto'
import { startTestServer } from './helpers.js'
import { createUser, createAgent } from '../src/auth.js'
import { recordJoined } from '../src/participants.js'
import { getTransfer, transferDir, recordChunk, TRANSFER_DELIVERED_GRACE_MS, TRANSFER_EXPIRE_MS, reservedTransferBytes } from '../src/transfers.js'
import { runExpireTransfers } from '../src/retention.js'

// The retention sweep for agent-to-agent file transfers (Task 4): a
// delivered copy outlives its receipt by one hour, then its bytes go; an
// open or released transfer nobody collected within 7 days of creation is
// marked expired, its bytes go, its card closes and both the sender and
// the room are told; a terminal row's files are swept up as a crash-safety
// net.

const CHUNK = 10
const DATA = Buffer.from('abcdefghijklmnopqrstuvwxy') // 25 bytes, 3 chunks
const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex')

function tmpDbPath() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'matron-transfer-retention-'))
  return path.join(dir, 'test.db')
}

function addConvo(db, id, userId, deviceId, title = id) {
  db.prepare("INSERT INTO conversations(id, owner_user_id, title, session_state, created_at, agent_device_id) VALUES(?,?,?,'running',?,?)")
    .run(id, userId, title, Date.now(), deviceId)
}

// alice: box-a sends from "Notes writer"; box-b is joined (the recipient)
// with its own session "Reviewer"; coord-box runs the Coordinator. A
// client token for the user's taps. Every frame sent to a device, and
// every room text, is recorded.
async function fleet(t, opts = {}) {
  const dbPath = tmpDbPath()
  const s = await startTestServer({ dbPath, transferMaxBytes: 1000, transferUserQuotaBytes: 10000, transferChunkBytes: CHUNK, ...opts })
  t.after(() => s.close())
  const mediaDir = path.join(path.dirname(dbPath), 'media')
  const alice = await createUser(s.db, 'alice', 'pw')
  const a = createAgent(s.db, alice.id, 'box-a')
  const b = createAgent(s.db, alice.id, 'box-b')
  const coord = createAgent(s.db, alice.id, 'coord-box')
  const login = await s.http('/login', { method: 'POST', body: { username: 'alice', password: 'pw', device_name: 'phone' } })
  addConvo(s.db, 'room', alice.id, a.deviceId, 'Design review')
  addConvo(s.db, 'sess-a', alice.id, a.deviceId, 'Notes writer')
  addConvo(s.db, 'sess-b', alice.id, b.deviceId, 'Reviewer')
  addConvo(s.db, 'coord', alice.id, coord.deviceId, 'Coordinator')
  recordJoined(s.db, { convoId: 'room', agentDeviceId: b.deviceId, initiatorDeviceId: a.deviceId })
  const client = login.json.token
  assert.equal((await s.http('/coordinator', { method: 'PUT', token: client, body: { convo_id: 'coord' } })).status, 200)
  const sent = []
  const orig = s.hub.sendToDevice.bind(s.hub)
  s.hub.sendToDevice = (userId, deviceId, frame) => { sent.push({ deviceId, frame }); return orig(userId, deviceId, frame) }
  return { s, mediaDir, alice, a, b, coord, client, sent }
}

async function createTransfer(f, over = {}) {
  const r = await f.s.http('/transfers', {
    method: 'POST', token: f.a.token,
    body: { room_id: 'room', from_convo_id: 'sess-a', name: 'notes.txt', size: DATA.length, sha256: sha(DATA), content_type: 'text/plain', scan: { verdict: 'clean', findings: [] }, ...over },
  })
  assert.equal(r.status, 201, JSON.stringify(r.json))
  return r.json.transfer_id
}

async function putChunk(f, id, n, bytes) {
  const r = await fetch(`${f.s.base}/transfers/${id}/chunks/${n}`, {
    method: 'PUT',
    headers: { authorization: `Bearer ${f.a.token}`, 'content-type': 'application/octet-stream', 'x-chunk-sha256': sha(bytes) },
    body: bytes,
  })
  assert.equal(r.status, 200)
}

async function uploadAll(f, id, data = DATA) {
  for (let n = 0; n * CHUNK < data.length; n++) await putChunk(f, id, n, data.subarray(n * CHUNK, (n + 1) * CHUNK))
}

const itemOf = (f, id) => f.s.db.prepare('SELECT * FROM items WHERE id=?').get(getTransfer(f.s.db, id).item_id)
const tap = (f, id, action) => f.s.http(`/items/${getTransfer(f.s.db, id).item_id}/comments`, { method: 'POST', token: f.client, body: { action } })
const answer = (f, body) => f.s.http('/consent/answer', { method: 'POST', token: f.coord.token, body: { convo_id: 'coord', kind: 'transfer', ...body } })
const received = (f, id, token = f.b.token) => f.s.http(`/transfers/${id}/received`, { method: 'POST', token, body: { sha256: sha(DATA) } })
const lastStatusNote = (f, id) => f.s.db.prepare("SELECT body, author FROM item_comments WHERE item_id=? AND kind='status' ORDER BY created_at DESC, rowid DESC").get(getTransfer(f.s.db, id).item_id)
const roomTexts = (f) => f.s.db.prepare("SELECT sender, payload FROM events WHERE convo_id='room' AND type='text'").all().map((e) => ({ sender: e.sender, body: JSON.parse(e.payload).body }))
const chunkRows = (f, id) => f.s.db.prepare('SELECT COUNT(*) c FROM transfer_chunks WHERE transfer_id=?').get(id).c
const expiredFrames = (f) => f.sent.filter((x) => x.frame.kind === 'transfer' && x.frame.event === 'expired')

// Uploaded, completed and approved: the file is out (phase released).
async function released(f, over) {
  const id = await createTransfer(f, over)
  await uploadAll(f, id)
  assert.equal((await f.s.http(`/transfers/${id}/complete`, { method: 'POST', token: f.a.token })).status, 200)
  assert.equal((await tap(f, id, 'Approve')).status, 200)
  assert.equal(getTransfer(f.s.db, id).phase, 'released')
  return id
}

// One stored chunk on disk, so a leftover directory exists to sweep.
function fakeChunk(f, id) {
  const p = path.join(transferDir(f.mediaDir, id), '0')
  fs.mkdirSync(path.dirname(p), { recursive: true })
  fs.writeFileSync(p, 'x'.repeat(CHUNK))
  recordChunk(f.s.db, id, 0, CHUNK)
}

test('delivered copy: kept at +59 min, deleted (files and chunk rows gone, deleted_at stamped) at +61 min; a repeat run is a no-op', async (t) => {
  const f = await fleet(t)
  const id = await released(f)
  assert.equal((await received(f, id)).status, 200)
  const deliveredAt = getTransfer(f.s.db, id).delivered_at
  assert.ok(deliveredAt)

  const before = runExpireTransfers(f.s.db, { mediaDir: f.mediaDir, hub: f.s.hub, now: deliveredAt + 59 * 60000 })
  assert.deepEqual(before, { deleted: 0, expired: 0 })
  assert.ok(fs.existsSync(transferDir(f.mediaDir, id)), 'bytes still there within the hour')
  assert.equal(getTransfer(f.s.db, id).deleted_at, null)

  const after = runExpireTransfers(f.s.db, { mediaDir: f.mediaDir, hub: f.s.hub, now: deliveredAt + TRANSFER_DELIVERED_GRACE_MS + 60000 })
  assert.deepEqual(after, { deleted: 1, expired: 0 })
  const row = getTransfer(f.s.db, id)
  assert.equal(row.phase, 'delivered', 'phase is untouched — the file was collected')
  assert.ok(row.deleted_at)
  assert.equal(fs.existsSync(transferDir(f.mediaDir, id)), false)
  assert.equal(chunkRows(f, id), 0)

  // Idempotent: nothing left to delete a second time.
  const again = runExpireTransfers(f.s.db, { mediaDir: f.mediaDir, hub: f.s.hub, now: deliveredAt + TRANSFER_DELIVERED_GRACE_MS + 120000 })
  assert.deepEqual(again, { deleted: 0, expired: 0 })
})

test('released but never collected: kept just under 7 days, expires just over; files gone, sender told, room told, the already-closed card is untouched, quota freed', async (t) => {
  const f = await fleet(t)
  const id = await released(f)
  const createdAt = getTransfer(f.s.db, id).created_at
  assert.equal(itemOf(f, id).resolution, 'decided', 'approved earlier: the card is already closed')

  const notYet = runExpireTransfers(f.s.db, { mediaDir: f.mediaDir, hub: f.s.hub, now: createdAt + TRANSFER_EXPIRE_MS - 1 })
  assert.deepEqual(notYet, { deleted: 0, expired: 0 })
  assert.equal(getTransfer(f.s.db, id).phase, 'released')

  const due = runExpireTransfers(f.s.db, { mediaDir: f.mediaDir, hub: f.s.hub, now: createdAt + TRANSFER_EXPIRE_MS + 1 })
  assert.deepEqual(due, { deleted: 0, expired: 1 })
  const row = getTransfer(f.s.db, id)
  assert.equal(row.phase, 'expired')
  assert.ok(row.deleted_at)
  assert.equal(fs.existsSync(transferDir(f.mediaDir, id)), false)
  assert.equal(chunkRows(f, id), 0)
  assert.equal(expiredFrames(f).length, 1)
  assert.equal(expiredFrames(f)[0].deviceId, f.a.deviceId)
  assert.equal(expiredFrames(f)[0].frame.transfer_id, id)
  assert.deepEqual(roomTexts(f), [{ sender: 'journal', body: 'File `notes.txt` expired after 7 days without being collected.' }])
  // The card was already closed on approval: its resolution and comment stand.
  assert.equal(itemOf(f, id).resolution, 'decided')
  assert.equal(itemOf(f, id).state, 'closed')
  assert.equal(reservedTransferBytes(f.s.db, f.alice.id), 0, 'the quota is freed')

  // Idempotent.
  const again = runExpireTransfers(f.s.db, { mediaDir: f.mediaDir, hub: f.s.hub, now: createdAt + TRANSFER_EXPIRE_MS + 2 })
  assert.deepEqual(again, { deleted: 0, expired: 0 })
  assert.equal(expiredFrames(f).length, 1, 'no second frame')
  assert.equal(roomTexts(f).length, 1, 'no second room notice')
})

test('awaiting the user\'s answer, never answered: expires at 7 days, the card closes cancelled; a tap and a Coordinator answer after are both 409 and change nothing', async (t) => {
  const f = await fleet(t)
  const id = await createTransfer(f)
  fakeChunk(f, id)
  const createdAt = getTransfer(f.s.db, id).created_at

  const r = runExpireTransfers(f.s.db, { mediaDir: f.mediaDir, hub: f.s.hub, now: createdAt + TRANSFER_EXPIRE_MS + 1 })
  assert.deepEqual(r, { deleted: 0, expired: 1 })
  const row = getTransfer(f.s.db, id)
  assert.equal(row.phase, 'expired')
  assert.ok(row.deleted_at)
  assert.equal(fs.existsSync(transferDir(f.mediaDir, id)), false)
  assert.equal(chunkRows(f, id), 0)
  assert.equal(expiredFrames(f).length, 1)
  assert.equal(expiredFrames(f)[0].deviceId, f.a.deviceId)
  assert.deepEqual(roomTexts(f), [{ sender: 'journal', body: 'File `notes.txt` expired after 7 days without being collected.' }])
  const item = itemOf(f, id)
  assert.equal(item.state, 'closed')
  assert.equal(item.resolution, 'cancelled')
  assert.equal(lastStatusNote(f, id).body, 'Expired after 7 days.')
  assert.equal(reservedTransferBytes(f.s.db, f.alice.id), 0, 'the quota is freed')

  // A tap on the now-expired card: 409, nothing changes.
  const tapped = await tap(f, id, 'Approve')
  assert.equal(tapped.status, 409)
  assert.equal(getTransfer(f.s.db, id).phase, 'expired')
  assert.equal(itemOf(f, id).state, 'closed')

  // The Coordinator's answer on it: 409, nothing changes, no decision recorded.
  const answered = await answer(f, { id, decision: 'approve', reason: 'late, but fine' })
  assert.equal(answered.status, 409)
  assert.equal(getTransfer(f.s.db, id).phase, 'expired')
  assert.equal(f.s.db.prepare('SELECT COUNT(*) c FROM consent_decisions').get().c, 0)
})

test('quota frees once an open or released transfer expires: a create that was over quota succeeds afterwards', async (t) => {
  const f = await fleet(t, { transferUserQuotaBytes: DATA.length })
  const open = await createTransfer(f) // awaiting_user, reserves DATA.length
  const blocked = await f.s.http('/transfers', {
    method: 'POST', token: f.a.token,
    body: { room_id: 'room', from_convo_id: 'sess-a', name: 'other.txt', size: DATA.length, sha256: sha(DATA), content_type: 'text/plain', scan: { verdict: 'clean', findings: [] } },
  })
  assert.equal(blocked.status, 413)
  assert.equal(blocked.json.error, 'quota_exceeded')

  const createdAt = getTransfer(f.s.db, open).created_at
  const r = runExpireTransfers(f.s.db, { mediaDir: f.mediaDir, hub: f.s.hub, now: createdAt + TRANSFER_EXPIRE_MS + 1 })
  assert.equal(r.expired, 1)
  assert.equal(reservedTransferBytes(f.s.db, f.alice.id), 0)

  const now = await f.s.http('/transfers', {
    method: 'POST', token: f.a.token,
    body: { room_id: 'room', from_convo_id: 'sess-a', name: 'other.txt', size: DATA.length, sha256: sha(DATA), content_type: 'text/plain', scan: { verdict: 'clean', findings: [] } },
  })
  assert.equal(now.status, 201, 'quota freed by the expiry')
})

test('leftover chunk dir of a declined transfer is swept up (crash safety): not counted as a second expiry', async (t) => {
  const f = await fleet(t)
  const id = await createTransfer(f)
  fakeChunk(f, id)
  assert.equal((await tap(f, id, 'Decline')).status, 200)
  assert.equal(getTransfer(f.s.db, id).phase, 'declined')
  assert.equal(fs.existsSync(transferDir(f.mediaDir, id)), false, 'the decline itself already cleaned up')

  // Simulate a crash that left bytes behind after the decline.
  fakeChunk(f, id)
  assert.ok(fs.existsSync(transferDir(f.mediaDir, id)))

  const r = runExpireTransfers(f.s.db, { mediaDir: f.mediaDir, hub: f.s.hub, now: Date.now() })
  assert.equal(r.expired, 0, 'a declined row is terminal, never expired')
  assert.equal(r.deleted, 1, 'the leftover directory was swept')
  assert.equal(fs.existsSync(transferDir(f.mediaDir, id)), false)
  assert.equal(chunkRows(f, id), 0)
  assert.equal(getTransfer(f.s.db, id).phase, 'declined', 'the phase is untouched')
})
