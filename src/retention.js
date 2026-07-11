import { writeBlobSync } from './media.js'
import { insertBlob } from './db.js'
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
