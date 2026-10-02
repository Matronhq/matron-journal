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
  // Old-client fallback (spec: "Old-client fallback"): a flagged mirror of
  // an item marker that new clients hide — a hit here would surface a row
  // that half the fleet never sees.
  if (p.fallback_for) return null
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

// Human input → FTS5 MATCH string. Raw MATCH syntax throws on things people
// actually type (an unbalanced quote, a bare *, a stray NEAR) — so every
// whitespace-separated term is double-quoted (FTS5 escapes an embedded " by
// doubling it), giving an implicit AND over literal terms. Returns null for
// input with no terms; the route maps that to 400.
export function ftsQueryFor(raw) {
  const terms = String(raw).split(/\s+/).filter(Boolean)
  if (terms.length === 0) return null
  return terms.map((t) => `"${t.replace(/"/g, '""')}"`).join(' ')
}

// Ranked, user-scoped search (spec: GET /search). bm25() ascending is
// best-first; ts DESC breaks ties toward recency. `live` is derived from the
// conversation's session_state so the caller can prefer talking to a working
// agent over reading its transcript. The try/catch is belt-and-braces: after
// quoting, a parse failure should be unreachable, but a SQLite error must
// surface as badQuery (→ 400), never a 500 with internals in it.
// excludePrivateOwned (spec: agent visibility & privacy): hits from
// conversations owned by a private device vanish for ordinary agent
// callers. NULL-owner (legacy) conversations are never private-owned.
export function searchMessages(db, userId, { query, limit = 20, convoId = null, excludePrivateOwned = false, excludeSubagents = false } = {}) {
  const match = ftsQueryFor(query)
  if (match == null) return { badQuery: true }
  const sql = `
    SELECT sm.convo_id, c.title, sm.seq, sm.ts, sm.sender, c.session_state,
           snippet(search_fts, 0, '**', '**', '…', 12) AS snippet
    FROM search_fts
    JOIN search_messages sm ON sm.rowid = search_fts.rowid
    JOIN conversations c ON c.id = sm.convo_id
    WHERE search_fts MATCH ? AND sm.user_id = ?${convoId != null ? ' AND sm.convo_id = ?' : ''}
    ${excludeSubagents ? 'AND c.parent_convo_id IS NULL' : ''}
    ${excludePrivateOwned
      ? `AND (c.agent_device_id IS NULL OR NOT EXISTS(
            SELECT 1 FROM devices d WHERE d.id=c.agent_device_id AND d.private=1))`
      : ''}
    ORDER BY bm25(search_fts), sm.ts DESC
    LIMIT ?`
  let rows
  try {
    rows = convoId != null
      ? db.prepare(sql).all(match, userId, convoId, limit)
      : db.prepare(sql).all(match, userId, limit)
  } catch (err) {
    console.error('search query failed', err)
    return { badQuery: true }
  }
  return {
    hits: rows.map((r) => ({
      convo_id: r.convo_id, title: r.title, seq: r.seq, ts: r.ts, sender: r.sender,
      snippet: r.snippet, live: r.session_state === 'running',
    })),
  }
}

// ---------------------------------------------------------------------------
// Typed matching — the apps' search (matron-apple PR 303 brought the same
// rule to the device index; this is its server twin, so iPhone, Mac and the
// journal agree on what a query means).
//
// A message matches when it contains EVERY typed word, as typed. Only the
// word still being typed (the text does not end in whitespace) also matches
// as the start of a longer word, so results don't blink out mid-word. Both
// halves need an unstemmed index, which is what `search_fts_plain` is
// (db.js): on the porter mirror "run" finds "running", and a prefix
// "runn"* finds nothing because the stored token is "run".
export function typedQuery(raw) {
  const text = String(raw)
  const words = text.split(/\s+/).filter(Boolean)
  const terms = words.filter((w) => /[\p{L}\p{N}]/u.test(w))
  if (terms.length === 0) return null
  const lastIsPrefix = !/\s$/.test(text) && words[words.length - 1] === terms[terms.length - 1]
  const quote = (t) => `"${t.replace(/"/g, '""')}"`
  const matchParts = terms.map(quote)
  if (lastIsPrefix) matchParts[matchParts.length - 1] += '*'
  return {
    terms,
    lastIsPrefix,
    allTermsMatch: matchParts.join(' '),
    exactMatch: quote(terms.join(' ')),
    // The exact tier can only differ from the all-terms tier for a phrase
    // or a word still being typed.
    hasDistinctExactTier: terms.length > 1 || lastIsPrefix,
  }
}

// WHERE fragment + arguments shared by the typed modes: FTS match, user
// scope, optional conversation / subagent / privacy filters.
function typedWhere({ match, userId, convoId, excludeSubagents, excludePrivateOwned }) {
  const clauses = ['search_fts_plain MATCH ?', 'sm.user_id = ?']
  const args = [match, userId]
  if (convoId != null) { clauses.push('sm.convo_id = ?'); args.push(convoId) }
  if (excludeSubagents) clauses.push('c.parent_convo_id IS NULL')
  if (excludePrivateOwned) {
    clauses.push(`(c.agent_device_id IS NULL OR NOT EXISTS(
      SELECT 1 FROM devices d WHERE d.id=c.agent_device_id AND d.private=1))`)
  }
  return { sql: clauses.join(' AND '), args }
}

// Flat hits newest first under the typed rule — find-in-chat's match list
// (the apps step through it by seq), also usable across conversations.
// No body or snippet: the caller already shows the message.
export function searchRecent(db, userId, { query, limit = 50, convoId = null, excludeSubagents = false, excludePrivateOwned = false } = {}) {
  const typed = typedQuery(query)
  if (typed == null) return { badQuery: true }
  const where = typedWhere({ match: typed.allTermsMatch, userId, convoId, excludeSubagents, excludePrivateOwned })
  let rows
  try {
    rows = db.prepare(`
      SELECT sm.convo_id, sm.seq, sm.ts, sm.sender
      FROM search_fts_plain
      JOIN search_messages sm ON sm.rowid = search_fts_plain.rowid
      JOIN conversations c ON c.id = sm.convo_id
      WHERE ${where.sql}
      ORDER BY sm.seq DESC
      LIMIT ?`).all(...where.args, limit)
  } catch (err) {
    console.error('search (recent) query failed', err)
    return { badQuery: true }
  }
  return { hits: rows.map((r) => ({ convo_id: r.convo_id, seq: r.seq, ts: r.ts, sender: r.sender })) }
}

// One row per conversation under the typed rule: how many messages match,
// and the message the row should preview. Conversations holding the query
// as an exact phrase come first, then those containing every word; newest
// first within each (sorting only by newest put a note from a minute ago
// above the exact phrase from three days earlier — Dan, 2026-10-02).
//
// "Newest" is the highest seq (the user's append order, strictly
// increasing — two messages can share a ts). The bare `sm.rowid` next to
// MAX(sm.seq) rides SQLite's documented single-MAX rule: with exactly one
// MAX() aggregate, bare columns take their values from the row that
// supplied the maximum.
export function searchChats(db, userId, { query, limit = 20, excludeSubagents = false, excludePrivateOwned = false } = {}) {
  const typed = typedQuery(query)
  if (typed == null) return { badQuery: true }
  const groups = (match, convoIds, n) => {
    const where = typedWhere({ match, userId, excludeSubagents, excludePrivateOwned })
    let scope = ''
    if (convoIds) {
      scope = ` AND sm.convo_id IN (${convoIds.map(() => '?').join(',')})`
      where.args.push(...convoIds)
    }
    return db.prepare(`
      SELECT sm.convo_id, COUNT(*) AS hit_count, MAX(sm.seq) AS newest_seq, sm.rowid AS newest_rowid
      FROM search_fts_plain
      JOIN search_messages sm ON sm.rowid = search_fts_plain.rowid
      JOIN conversations c ON c.id = sm.convo_id
      WHERE ${where.sql}${scope}
      GROUP BY sm.convo_id
      ORDER BY newest_seq DESC
      LIMIT ?`).all(...where.args, n)
  }
  let exact = []
  let all
  try {
    if (typed.hasDistinctExactTier) exact = groups(typed.exactMatch, null, limit)
    all = groups(typed.allTermsMatch, null, limit)
    // An exact conversation older than the newest `limit` all-terms ones
    // still needs its total: every exact match is an all-terms match, so
    // the count comes from the same query, scoped.
    const listed = new Set(all.map((g) => g.convo_id))
    const unlisted = exact.map((g) => g.convo_id).filter((id) => !listed.has(id))
    if (unlisted.length) all = all.concat(groups(typed.allTermsMatch, unlisted, unlisted.length))
  } catch (err) {
    console.error('search (chats) query failed', err)
    return { badQuery: true }
  }
  const counts = new Map(all.map((g) => [g.convo_id, g.hit_count]))
  const exactIds = new Set(exact.map((g) => g.convo_id))
  const ranked = exact.map((g) => ({ g, exact: true }))
    .concat(all.filter((g) => !exactIds.has(g.convo_id)).map((g) => ({ g, exact: false })))
    .slice(0, limit)
  if (ranked.length === 0) return { chats: [] }
  // Bodies and names for just the winning rows; the preview is cut from
  // the excerpt by the app, so nothing is computed for matches not shown.
  const rowids = ranked.map(({ g }) => g.newest_rowid)
  const detail = new Map(db.prepare(`
    SELECT sm.rowid, sm.seq, sm.ts, sm.sender, sm.body,
           c.title, c.session_state, c.parent_convo_id, p.title AS parent_title
    FROM search_messages sm
    JOIN conversations c ON c.id = sm.convo_id
    LEFT JOIN conversations p ON p.id = c.parent_convo_id
    WHERE sm.rowid IN (${rowids.map(() => '?').join(',')})`).all(...rowids).map((r) => [r.rowid, r]))
  return {
    chats: ranked.flatMap(({ g, exact: isExact }) => {
      const d = detail.get(g.newest_rowid)
      if (!d) return []
      return [{
        convo_id: g.convo_id, title: d.title, parent_convo_id: d.parent_convo_id, parent_title: d.parent_title,
        count: counts.get(g.convo_id) ?? g.hit_count, exact: isExact, live: d.session_state === 'running',
        top: { seq: d.seq, ts: d.ts, sender: d.sender, excerpt: excerpt(d.body, typed) },
      }]
    }),
  }
}

// Up to ~1 KB of the body around the first place the query appears (the
// phrase if it is there, else the earliest word), so the app can cut and
// highlight its preview without the whole message crossing the wire. The
// tokenizer folds diacritics and punctuation that this plain text search
// does not, so a match may show no literal occurrence; the head of the
// body is sent then.
export const EXCERPT_BEFORE = 200
export const EXCERPT_LENGTH = 1000
export function excerpt(body, typed) {
  const lower = body.toLowerCase()
  const candidates = [typed.terms.join(' '), ...typed.terms].map((t) => lower.indexOf(t.toLowerCase())).filter((i) => i >= 0)
  const anchor = candidates.length ? (lower.indexOf(typed.terms.join(' ').toLowerCase()) >= 0 ? candidates[0] : Math.min(...candidates)) : 0
  const start = Math.max(0, anchor - EXCERPT_BEFORE)
  const end = Math.min(body.length, start + EXCERPT_LENGTH)
  return (start > 0 ? '…' : '') + body.slice(start, end) + (end < body.length ? '…' : '')
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
  // Batch rowids are selected index-only first (no payload column touched):
  // most history is tool_output, which indexableBody always rejects, so
  // reading and JSON.parse-ing its payload is pure waste at backfill scale.
  // The second query re-fetches only the rows whose type can ever index.
  const selectBatchIds = db.prepare(
    'SELECT rowid FROM events WHERE rowid>? ORDER BY rowid LIMIT ?'
  )
  const selectIndexable = db.prepare(
    `SELECT rowid, user_id, convo_id, seq, ts, sender, type, payload FROM events
     WHERE rowid>? AND rowid<=? AND type IN ('text','diff') ORDER BY rowid`
  )
  const insert = db.prepare(
    'INSERT OR IGNORE INTO search_messages(user_id, convo_id, seq, ts, sender, body) VALUES(?,?,?,?,?,?)'
  )
  let scanned = 0
  let indexed = 0
  for (;;) {
    if (shouldStop()) break
    const ids = selectBatchIds.all(cursor, batchSize)
    if (ids.length === 0) break
    const floor = cursor
    const ceiling = ids[ids.length - 1].rowid
    db.transaction(() => {
      const rows = selectIndexable.all(floor, ceiling)
      for (const row of rows) {
        let payload
        try { payload = JSON.parse(row.payload) } catch { payload = null }
        const body = indexableBody(row.type, payload)
        if (body != null) indexed += insert.run(row.user_id, row.convo_id, row.seq, row.ts, row.sender, body).changes
      }
      cursor = ceiling
      saveCursor.run(cursor)
    })()
    scanned += ids.length
    log(`search backfill: scanned ${scanned} events, indexed ${indexed}`)
    await new Promise((r) => setImmediate(r))
  }
  log(`search backfill complete: scanned ${scanned}, indexed ${indexed}`)
  return { scanned, indexed }
}
