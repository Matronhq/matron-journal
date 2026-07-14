import fs from 'node:fs'
import { writeBlobSync } from './media.js'
import { insertBlob, getBlob } from './db.js'
import { snippetOf } from './journal.js'

const OFFLOAD_TYPE = 'tool_output'

// Returns true for a payload that already has the offloaded shape
// ({type, snippet, blob_ref}) even though its row's `blob_ref` column is
// somehow still NULL. Rows land in that state only via a hand-edited DB or a
// hypothetical bug elsewhere — the `blob_ref IS NULL` scan predicate alone
// can't tell them apart from a genuinely-inline row, so this is a second,
// cheap, in-process guard against ever offloading an already-offloaded
// payload a second time (which would orphan the first blob and rewrite the
// row's payload to point at a fresh one that duplicates it).
function looksAlreadyOffloaded(payload) {
  return !!(payload && typeof payload === 'object' && typeof payload.blob_ref === 'string')
}

// Offloads `tool_output` event payloads older than `days` (by `ts`) that are
// still stored inline (`blob_ref IS NULL`) to blob files under `mediaDir`,
// replacing the row's payload with `{type, snippet, blob_ref}`. Idempotent:
// a row already offloaded (blob_ref set) is excluded by the scan query, and
// `looksAlreadyOffloaded` catches the pathological case above defensively.
//
// Per-row transactionality: the blob file is written to disk *before* the
// DB transaction that inserts its `blobs` row and updates the event row —
// writing to disk can't be folded into the SQLite transaction, so a crash
// between the two leaves an orphan blob file on disk with no DB row
// referencing it. That's acceptable for v1 (disk is cheap, nothing ever
// reads an orphan back) in exchange for the alternative being worse: an
// event row that references a blob_ref no `blobs` row or file backs.
export function runOffload(db, { days = 30, mediaDir }) {
  const cutoff = Date.now() - days * 86400000
  const rows = db.prepare(
    'SELECT user_id, seq, ts, payload FROM events WHERE type=? AND ts<? AND blob_ref IS NULL'
  ).all(OFFLOAD_TYPE, cutoff)

  let offloaded = 0
  const update = db.prepare('UPDATE events SET payload=?, blob_ref=? WHERE user_id=? AND seq=?')

  for (const row of rows) {
    let payload
    try {
      payload = JSON.parse(row.payload)
    } catch {
      payload = null // malformed JSON already in the row — snippetOf tolerates this
    }
    if (looksAlreadyOffloaded(payload)) continue

    // A live-log payload whose blob the TTL pass already deleted: re-blobbing
    // the retained snippet payload would undo blob_expired for zero value.
    if (payload && payload.blob_expired) continue

    const blob = writeBlobSync(mediaDir, Buffer.from(row.payload, 'utf8'))
    const snippet = snippetOf(OFFLOAD_TYPE, payload)
    const newPayload = JSON.stringify({ type: OFFLOAD_TYPE, snippet, blob_ref: blob.id })

    db.transaction(() => {
      insertBlob(db, {
        id: blob.id, ownerUserId: row.user_id, contentType: 'application/json',
        size: blob.size, sha256: blob.sha256, diskPath: blob.diskPath,
      })
      update.run(newPayload, blob.id, row.user_id, row.seq)
    })()
    offloaded += 1
  }
  return { offloaded }
}

// Deletes full-log blobs attached to live-streamed tool_output events older
// than `hours` (spec §7 — retention parity with the old 24h viewer links).
// Only payloads marked live_log:true are touched; offload-created blobs
// never carry that flag. The payload keeps its snippet/command/exit_code and
// gains blob_expired:true; the blob_ref column is NULLed in the same
// transaction so no row ever references a deleted blob. File unlink happens
// after commit — a crash between the two leaves an orphan file (same stance
// as runOffload's write-before-commit, in the opposite direction).
export function runExpireLogs(db, { hours = 24, mediaDir }) {
  const cutoff = Date.now() - hours * 3600000
  const rows = db.prepare(
    "SELECT user_id, seq, payload, blob_ref FROM events WHERE type='tool_output' AND ts<? AND blob_ref IS NOT NULL"
  ).all(cutoff)

  let expired = 0
  const update = db.prepare('UPDATE events SET payload=?, blob_ref=NULL WHERE user_id=? AND seq=?')
  const deleteBlobRow = db.prepare('DELETE FROM blobs WHERE id=?')

  for (const row of rows) {
    let payload
    try { payload = JSON.parse(row.payload) } catch { payload = null }
    if (!payload || payload.live_log !== true) continue
    const blob = getBlob(db, row.blob_ref)
    const newPayload = JSON.stringify({ ...payload, blob_ref: null, blob_expired: true })
    db.transaction(() => {
      deleteBlobRow.run(row.blob_ref)
      update.run(newPayload, row.user_id, row.seq)
    })()
    if (blob) { try { fs.unlinkSync(blob.disk_path) } catch { /* already gone */ } }
    expired += 1
  }
  return { expired }
}
