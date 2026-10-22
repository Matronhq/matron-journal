// HTTP surface of agent-to-agent file transfers (src/transfers.js):
//   POST   /transfers                  create (the sender)
//   PUT    /transfers/:id/chunks/:n    one chunk, header x-chunk-sha256 (the sender)
//   GET    /transfers/:id              status and received chunks (sender or recipients)
//   DELETE /transfers/:id              cancel (the sender)
// Agent devices only: a client gets 403. A transfer the caller may not see
// is 404, never 403, so its id confirms nothing. A refusal before a chunk
// body is read closes the connection (rejectEarly), so unread bytes never
// desync a keep-alive socket.
import crypto from 'node:crypto'
import { json, readBody } from './http-body.js'
import { sanitizePeerText } from './peer-text.js'
import { receiveToPath } from './media.js'
import {
  TRANSFER_CHUNK_BYTES, TRANSFER_MAX_BYTES_DEFAULT, TRANSFER_USER_QUOTA_BYTES_DEFAULT, SCAN_VERDICTS,
  isTransferId, chunkCount, expectedChunkSize, transferChunkPath, createTransfer, getTransfer, recordChunk,
  receivedChunks, forgetChunks, reservedTransferBytes, recipientDevices, deleteTransferFiles, setTransferState,
  isPersonRoom,
} from './transfers.js'
import { joinedAgentIds } from './participants.js'
import { fileTransferConsentItem, closeTransferConsentItem } from './transfer-consent.js'
import { nudgeCoordinator } from './consent.js'

export const TRANSFER_NAME_MAX = 255
export const TRANSFER_REASON_MAX = 1000
export const TRANSFER_FINDINGS_MAX = 50
const FINDING_KIND_MAX = 64
const FINDING_LINE_MAX = 300
const CONTENT_TYPE_MAX = 255
const ID_MAX = 128
const SHA_RE = /^[0-9a-f]{64}$/

const bad = (res) => { json(res, 400, { error: 'bad_request' }); return true }
const notFound = (res) => { json(res, 404, { error: 'not_found' }); return true }

const isId = (v) => typeof v === 'string' && v.length > 0 && v.length <= ID_MAX

// {kind, line} only: line is a 1-based line number, or `member:line` inside
// an archive. Anything else on a finding (a matched value) is dropped.
function parseScan(scan) {
  if (scan === undefined || scan === null) return { verdict: 'not_scanned', findings: [] }
  if (typeof scan !== 'object' || !SCAN_VERDICTS.includes(scan.verdict)) return null
  const raw = scan.findings ?? []
  if (!Array.isArray(raw) || raw.length > TRANSFER_FINDINGS_MAX) return null
  const findings = []
  for (const f of raw) {
    if (!f || typeof f !== 'object' || typeof f.kind !== 'string') return null
    const kind = sanitizePeerText(f.kind, FINDING_KIND_MAX)
    if (!kind) return null
    let line
    if (Number.isSafeInteger(f.line) && f.line >= 1) line = f.line
    else if (typeof f.line === 'string' && f.line.length <= FINDING_LINE_MAX && /^.+:[1-9]\d*$/.test(f.line)) line = sanitizePeerText(f.line, FINDING_LINE_MAX)
    else return null
    findings.push({ kind, line })
  }
  return { verdict: scan.verdict, findings }
}

// The create body, normalised, or null for a bad shape.
function parseCreate(body) {
  const { room_id: roomId, from_convo_id: fromConvoId, name, size, sha256, content_type: contentType, reason } = body
  if (!isId(roomId) || !isId(fromConvoId)) return null
  if (typeof name !== 'string' || name.length > TRANSFER_NAME_MAX) return null
  const cleanName = sanitizePeerText(name, TRANSFER_NAME_MAX)
  // A file name, never a path: the receiver writes it into its inbox.
  if (!cleanName || cleanName === '.' || cleanName === '..' || /[/\\]/.test(cleanName)) return null
  if (!Number.isSafeInteger(size) || size < 1) return null
  if (typeof sha256 !== 'string' || !SHA_RE.test(sha256)) return null
  if (contentType !== undefined && (typeof contentType !== 'string' || contentType.length > CONTENT_TYPE_MAX)) return null
  if (reason !== undefined && reason !== null && typeof reason !== 'string') return null
  const scan = parseScan(body.scan)
  if (!scan) return null
  return {
    roomId, fromConvoId, name: cleanName, size, sha256,
    contentType: sanitizePeerText(contentType, CONTENT_TYPE_MAX) || 'application/octet-stream',
    reason: sanitizePeerText(reason, TRANSFER_REASON_MAX),
    scan,
  }
}

// The caller's device is the room's recorded owner or a joined participant.
function isRoomMember(db, room, roomId, deviceId) {
  return room.agent_device_id === deviceId || joinedAgentIds(db, roomId).includes(deviceId)
}

// The row, when the caller may see it: the sender's device, or (unless
// senderOnly) one of the room's recipient devices — always of the row's
// own user.
function visibleTransfer(db, who, id, { senderOnly = false } = {}) {
  if (!isTransferId(id)) return null
  const row = getTransfer(db, id)
  if (!row || row.user_id !== who.userId) return null
  if (row.sender_device_id === who.deviceId) return row
  if (senderOnly) return null
  return recipientDevices(db, row.room_id, row.sender_device_id).includes(who.deviceId) ? row : null
}

const statusView = (db, row, chunkBytes) => ({
  id: row.id, phase: row.phase, consent: row.consent, upload: row.upload, size: row.size,
  chunk_bytes: chunkBytes, chunks: chunkCount(row.size, chunkBytes), received: receivedChunks(db, row.id),
})

async function create(ctx, req, res, who) {
  const { db, transferMaxBytes, transferUserQuotaBytes, chunkBytes } = ctx
  const t = parseCreate(await readBody(req))
  if (!t) return bad(res)
  const room = db.prepare('SELECT owner_user_id, agent_device_id, system FROM conversations WHERE id=?').get(t.roomId)
  if (!room || room.owner_user_id !== who.userId || room.system != null || !isRoomMember(db, room, t.roomId, who.deviceId)) return notFound(res)
  const from = db.prepare('SELECT owner_user_id, agent_device_id FROM conversations WHERE id=?').get(t.fromConvoId)
  if (!from || from.owner_user_id !== who.userId || from.agent_device_id !== who.deviceId) return notFound(res)
  if (isPersonRoom(db, t.roomId)) { json(res, 403, { error: 'person_room' }); return true }
  if (t.size > transferMaxBytes) { json(res, 413, { error: 'too_large' }); return true }
  // Check and insert with no await between them: the quota read and the
  // reservation are one synchronous step, so two creates cannot both pass.
  if (reservedTransferBytes(db, who.userId) + t.size > transferUserQuotaBytes) { json(res, 413, { error: 'quota_exceeded' }); return true }
  const row = createTransfer(db, {
    userId: who.userId, roomId: t.roomId, senderDeviceId: who.deviceId, fromConvoId: t.fromConvoId,
    name: t.name, size: t.size, sha256: t.sha256, contentType: t.contentType, reason: t.reason, scan: t.scan,
  })
  console.log(`journal: transfer created id=${row.id} room=${row.room_id} device=${who.deviceId} size=${row.size} scan=${row.scan_verdict}`)
  // The user's card, then a nudge to the Coordinator (skipped when it is
  // the sender). Both best-effort: the transfer stands without them.
  fileTransferConsentItem(ctx, row)
  nudgeCoordinator(ctx, who.userId, { kind: 'transfer', id: row.id }, { askerConvoId: row.from_convo_id })
  json(res, 201, { transfer_id: row.id, chunk_bytes: chunkBytes, chunks: chunkCount(row.size, chunkBytes) })
  return true
}

const writable = (row) => row && row.phase === 'open' && row.upload === 'uploading'

async function putChunk(ctx, req, res, who, id, nRaw, rejectEarly) {
  const { db, mediaDir, chunkBytes } = ctx
  const early = (status, error) => { rejectEarly(req, res, status, { error }); return true }
  const row = visibleTransfer(db, who, id, { senderOnly: true })
  if (!row) return early(404, 'not_found')
  const n = /^\d{1,9}$/.test(nRaw) ? Number(nRaw) : -1
  const digest = String(req.headers['x-chunk-sha256'] ?? '').toLowerCase()
  if (n < 0 || n >= chunkCount(row.size, chunkBytes) || !SHA_RE.test(digest)) return early(400, 'bad_request')
  if (!writable(row)) return early(409, 'closed')
  const expected = expectedChunkSize(row.size, n, chunkBytes)
  const declared = req.headers['content-length']
  if (declared !== undefined && Number(declared) !== expected) return early(400, 'chunk_mismatch')

  const finalPath = transferChunkPath(mediaDir, id, n)
  // A temp name of its own per request, so two retries of one chunk in
  // flight at once never write into the same file.
  const tmpPath = `${finalPath}.${crypto.randomBytes(6).toString('hex')}.tmp`
  const mismatch = () => Object.assign(new Error('chunk mismatch'), { code: 'chunk_mismatch' })
  try {
    await receiveToPath(req, {
      tmpPath, finalPath, maxBytes: expected,
      accept: ({ size, sha256 }) => { if (size !== expected || sha256 !== digest) throw mismatch() },
    })
  } catch (e) {
    // Cancelled while this chunk was in flight: the directory is gone (or
    // about to be); whatever this request wrote goes with it.
    if (!writable(getTransfer(db, id))) {
      deleteTransferFiles(mediaDir, id)
      return early(409, 'closed')
    }
    if (e.code === 'too_large') return early(400, 'chunk_mismatch')
    if (e.code === 'chunk_mismatch') { json(res, 400, { error: 'chunk_mismatch' }); return true }
    throw e
  }
  if (!writable(getTransfer(db, id))) {
    deleteTransferFiles(mediaDir, id)
    json(res, 409, { error: 'closed' })
    return true
  }
  recordChunk(db, id, n, expected)
  json(res, 200, { n })
  return true
}

function cancel(ctx, res, who, id) {
  const { db, mediaDir } = ctx
  const row = visibleTransfer(db, who, id, { senderOnly: true })
  if (!row) return notFound(res)
  if (row.phase === 'cancelled') { json(res, 200, { id, phase: 'cancelled' }); return true }
  if (!setTransferState(db, id, { phase: 'cancelled', deleted_at: Date.now() })) { json(res, 409, { error: 'closed' }); return true }
  deleteTransferFiles(mediaDir, id)
  forgetChunks(db, id)
  closeTransferConsentItem(ctx, id, { outcome: 'cancelled' })
  console.log(`journal: transfer cancelled id=${id} device=${who.deviceId}`)
  json(res, 200, { id, phase: 'cancelled' })
  return true
}

export async function handleTransferRoute(ctx, req, res, url, who, { rejectEarly }) {
  const m = url.pathname.match(/^\/transfers(?:\/([^/]+)(?:\/chunks\/([^/]+))?)?$/)
  if (!m) return false
  const full = {
    ...ctx,
    transferMaxBytes: ctx.transferMaxBytes ?? TRANSFER_MAX_BYTES_DEFAULT,
    transferUserQuotaBytes: ctx.transferUserQuotaBytes ?? TRANSFER_USER_QUOTA_BYTES_DEFAULT,
    chunkBytes: ctx.transferChunkBytes ?? TRANSFER_CHUNK_BYTES,
  }
  const [, id, n] = m
  if (who.kind !== 'agent') { rejectEarly(req, res, 403, { error: 'forbidden' }); return true }
  if (!id && req.method === 'POST') return create(full, req, res, who)
  if (id && n !== undefined && req.method === 'PUT') return putChunk(full, req, res, who, id, n, rejectEarly)
  if (id && n === undefined && req.method === 'GET') {
    const row = visibleTransfer(full.db, who, id)
    if (!row) return notFound(res)
    json(res, 200, statusView(full.db, row, full.chunkBytes))
    return true
  }
  if (id && n === undefined && req.method === 'DELETE') return cancel(full, res, who, id)
  return false
}
