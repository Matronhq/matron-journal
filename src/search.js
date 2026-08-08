// Single source of truth for what the search index can see (spec: prose
// only — docs/superpowers/specs/2026-08-07-agent-journal-search-design.md).
// Called by BOTH the live append path (journal.js, inside the append
// transaction) and the startup backfill, and by the agent context filter in
// http.js — one function, three consumers, zero drift. This copies the app
// side's searchableBody discipline for the same reason the apps needed it.
//
// tool_output is deliberately null: command output is retrieval noise for
// "why did we do this" questions, and it is where credentials land. If a
// new prose-bearing event type is ever added, extend HERE and nowhere else.
export function indexableBody(type, payload) {
  const p = payload && typeof payload === 'object' ? payload : {}
  if (type === 'text') {
    const body = typeof p.body === 'string' ? p.body : ''
    return body.trim() ? body : null
  }
  if (type === 'diff') {
    const text = typeof p.diff === 'string' && p.diff
      ? p.diff
      : (typeof p.snippet === 'string' ? p.snippet : '')
    return text.trim() ? text : null
  }
  return null
}

// Startup backfill (spec: agent journal search, "Backfill"). Walks `events`
// by rowid in batches, indexing every row indexableBody accepts. Three
// safety properties, each load-bearing:
//   - INSERT OR IGNORE on UNIQUE(user_id, seq) — never OR REPLACE (the
//     external-content corruption trap, matron-apple #106) — so overlap
//     with the live append path or a re-run is a no-op, not a duplicate.
//   - The cursor row (search_backfill_state) advances per committed batch,
//     so an interrupted run resumes where it stopped and a completed one
//     costs a single row read at next boot. Rows appended after the schema
//     exists are indexed live by append(), so the cursor can never miss.
//   - One batch per event-loop turn (the await below): better-sqlite3 is
//     synchronous, and a multi-GB history must not starve the server's
//     sockets while it indexes. Search returns partial results until the
//     walk finishes — acceptable and self-healing (spec).
export async function backfillSearchIndex(db, { batchSize = 1000, log = () => {}, shouldStop = () => false } = {}) {
  const state = db.prepare('SELECT last_events_rowid FROM search_backfill_state WHERE id=1').get()
  let cursor = state ? state.last_events_rowid : 0
  const saveCursor = db.prepare(
    'INSERT INTO search_backfill_state(id, last_events_rowid) VALUES(1, ?) ' +
    'ON CONFLICT(id) DO UPDATE SET last_events_rowid=excluded.last_events_rowid'
  )
  const selectBatch = db.prepare(
    'SELECT rowid, user_id, convo_id, seq, ts, sender, type, payload FROM events WHERE rowid>? ORDER BY rowid LIMIT ?'
  )
  const insert = db.prepare(
    'INSERT OR IGNORE INTO search_messages(user_id, convo_id, seq, ts, sender, body) VALUES(?,?,?,?,?,?)'
  )
  let scanned = 0
  let indexed = 0
  for (;;) {
    if (shouldStop()) break
    const rows = selectBatch.all(cursor, batchSize)
    if (rows.length === 0) break
    db.transaction(() => {
      for (const row of rows) {
        let payload
        try { payload = JSON.parse(row.payload) } catch { payload = null }
        const body = indexableBody(row.type, payload)
        if (body != null) indexed += insert.run(row.user_id, row.convo_id, row.seq, row.ts, row.sender, body).changes
      }
      cursor = rows[rows.length - 1].rowid
      saveCursor.run(cursor)
    })()
    scanned += rows.length
    log(`search backfill: scanned ${scanned} events, indexed ${indexed}`)
    await new Promise((r) => setImmediate(r))
  }
  return { scanned, indexed }
}
