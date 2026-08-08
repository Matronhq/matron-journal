// test/search.test.js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { indexableBody, backfillSearchIndex } from '../src/search.js'
import { startTestServer } from './helpers.js'
import { createUser } from '../src/auth.js'

test('indexableBody: text events index their body', () => {
  assert.equal(indexableBody('text', { body: 'why did we drop SQLCipher' }), 'why did we drop SQLCipher')
})

test('indexableBody: text with empty/whitespace/missing/non-string body is not indexed', () => {
  assert.equal(indexableBody('text', { body: '' }), null)
  assert.equal(indexableBody('text', { body: '   \n ' }), null)
  assert.equal(indexableBody('text', {}), null)
  assert.equal(indexableBody('text', { body: 42 }), null)
})

test('indexableBody: diff events index payload.diff, falling back to payload.snippet', () => {
  assert.equal(indexableBody('diff', { diff: '-a\n+b' }), '-a\n+b')
  assert.equal(indexableBody('diff', { snippet: 'changed StoragePaths' }), 'changed StoragePaths')
  assert.equal(indexableBody('diff', { diff: 'full', snippet: 'short' }), 'full')
  assert.equal(indexableBody('diff', {}), null)
})

test('indexableBody: tool_output is NEVER indexed — the privacy property', () => {
  assert.equal(indexableBody('tool_output', { command: 'env', body: 'SECRET=hunter2' }), null)
  assert.equal(indexableBody('tool_output', { snippet: 'SECRET=hunter2' }), null)
})

test('indexableBody: every other type returns null', () => {
  for (const type of ['prompt', 'file', 'image', 'permission_request', 'session_status', 'read_marker', 'convo_meta']) {
    assert.equal(indexableBody(type, { body: 'x', question: 'x', description: 'x' }), null, type)
  }
})

test('indexableBody: tolerates malformed payloads', () => {
  assert.equal(indexableBody('text', null), null)
  assert.equal(indexableBody('text', undefined), null)
  assert.equal(indexableBody('text', 'bare string'), null)
  assert.equal(indexableBody('diff', 7), null)
})

import { openDb } from '../src/db.js'
import { append, upsertConversation } from '../src/journal.js'
import { runExpireLogs, runOffload } from '../src/retention.js'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

function seedUserAndConvo(db, { userId = 1, convoId = 'c1' } = {}) {
  db.prepare("INSERT INTO users(id, name, password_hash, created_at) VALUES(?, ?, 'x', 0)")
    .run(userId, `u${userId}`)
  upsertConversation(db, { id: convoId, ownerUserId: userId, title: 'T', sessionState: 'running' })
  return { userId, convoId }
}

const ftsCount = (db, term) =>
  db.prepare('SELECT COUNT(*) n FROM search_fts WHERE search_fts MATCH ?').get(`"${term}"`).n

test('append: text and diff events are indexed in the same transaction', () => {
  const db = openDb(':memory:')
  const { userId, convoId } = seedUserAndConvo(db)
  append(db, { userId, convoId, sender: 'user:dan', type: 'text', payload: { body: 'sqlcipher attempt deferred' } })
  append(db, { userId, convoId, sender: 'agent:kit', type: 'diff', payload: { diff: '+used xchacha instead' } })
  assert.equal(ftsCount(db, 'sqlcipher'), 1)
  assert.equal(ftsCount(db, 'xchacha'), 1)
  const row = db.prepare('SELECT * FROM search_messages WHERE user_id=? ORDER BY seq').get(userId)
  assert.equal(row.convo_id, convoId)
  assert.equal(row.sender, 'user:dan')
  db.close()
})

test('append: tool_output and other non-prose types never reach the index', () => {
  const db = openDb(':memory:')
  const { userId, convoId } = seedUserAndConvo(db)
  append(db, { userId, convoId, sender: 'agent:kit', type: 'tool_output', payload: { command: 'env', snippet: 'SECRET=hunter2' } })
  append(db, { userId, convoId, sender: 'agent:kit', type: 'session_status', payload: { state: 'waiting' } })
  assert.equal(db.prepare('SELECT COUNT(*) n FROM search_messages').get().n, 0)
  db.close()
})

test('append: a failing search insert rolls back the whole append (same transaction, fails loudly)', () => {
  const db = openDb(':memory:')
  const { userId, convoId } = seedUserAndConvo(db)
  // First append to establish seq=1
  append(db, { userId, convoId, sender: 'user:dan', type: 'text', payload: { body: 'first msg' } })
  assert.equal(db.prepare('SELECT COUNT(*) n FROM events').get().n, 1)
  assert.equal(db.prepare('SELECT seq FROM user_seq WHERE user_id=?').get(userId).seq, 1)
  // Pre-insert search_messages row with (user_id, seq=2) to trigger UNIQUE constraint
  // when the next append() tries to insert its search row
  db.prepare('INSERT INTO search_messages(user_id, convo_id, seq, ts, sender, body) VALUES(?,?,?,?,?,?)')
    .run(userId, convoId, 2, Date.now(), 'user:dan', 'blocking')
  // Second append with text (indexable) will try to INSERT into search_messages
  // with the same seq=2, violating the UNIQUE(user_id, seq) constraint
  assert.throws(() => append(db, { userId, convoId, sender: 'user:dan', type: 'text', payload: { body: 'second msg' } }))
  // Verify the events table still has only the first row (append rollback)
  assert.equal(db.prepare('SELECT COUNT(*) n FROM events').get().n, 1)
  // Verify user_seq was rolled back from 2 back to 1
  assert.equal(db.prepare('SELECT seq FROM user_seq WHERE user_id=?').get(userId).seq, 1)
  db.close()
})

test('retention rewriting tool_output leaves the index untouched', () => {
  const db = openDb(':memory:')
  const { userId, convoId } = seedUserAndConvo(db)
  const mediaDir = fs.mkdtempSync(path.join(os.tmpdir(), 'search-retention-'))
  append(db, { userId, convoId, sender: 'user:dan', type: 'text', payload: { body: 'the only indexed row' } })
  append(db, { userId, convoId, sender: 'agent:kit', type: 'tool_output', payload: { command: 'ls', snippet: 'out', live_log: true } })
  append(db, { userId, convoId, sender: 'agent:kit', type: 'tool_output', payload: { command: 'ls', snippet: 'old out' } })
  // Age both tool_output rows past every retention window
  db.prepare("UPDATE events SET ts=1 WHERE type='tool_output'").run()
  runExpireLogs(db, { hours: 24, mediaDir })
  runOffload(db, { days: 30, mediaDir })
  assert.equal(db.prepare('SELECT COUNT(*) n FROM search_messages').get().n, 1)
  assert.equal(ftsCount(db, 'indexed'), 1)
  db.close()
})

// Simulates a pre-search DB: rows written straight into `events`, bypassing
// append() and therefore the live index feed — exactly what history looks
// like when the schema first arrives.
function insertRawEvent(db, { userId, convoId, seq, type, payload, sender = 'user:dan' }) {
  db.prepare('INSERT INTO user_seq(user_id, seq) VALUES(?, ?) ON CONFLICT(user_id) DO UPDATE SET seq=MAX(seq, excluded.seq)').run(userId, seq)
  db.prepare(
    'INSERT INTO events(user_id, seq, convo_id, ts, sender, type, payload) VALUES(?,?,?,?,?,?,?)'
  ).run(userId, seq, convoId, seq, sender, type, JSON.stringify(payload))
}

test('backfill: indexes historical prose, skips everything else, and reports progress', async () => {
  const db = openDb(':memory:')
  seedUserAndConvo(db)
  insertRawEvent(db, { userId: 1, convoId: 'c1', seq: 1, type: 'text', payload: { body: 'ancient decision' } })
  insertRawEvent(db, { userId: 1, convoId: 'c1', seq: 2, type: 'tool_output', payload: { snippet: 'SECRET=hunter2' } })
  insertRawEvent(db, { userId: 1, convoId: 'c1', seq: 3, type: 'diff', payload: { diff: '+ancient change' } })
  const lines = []
  const r = await backfillSearchIndex(db, { batchSize: 2, log: (l) => lines.push(l) })
  assert.equal(r.scanned, 3)
  assert.equal(r.indexed, 2)
  assert.ok(lines.length >= 1, 'progress is logged')
  assert.equal(ftsCount(db, 'ancient'), 2)
  assert.equal(db.prepare("SELECT COUNT(*) n FROM search_messages WHERE body LIKE '%SECRET%'").get().n, 0)
  db.close()
})

test('backfill: running twice changes nothing (idempotent)', async () => {
  const db = openDb(':memory:')
  seedUserAndConvo(db)
  insertRawEvent(db, { userId: 1, convoId: 'c1', seq: 1, type: 'text', payload: { body: 'once only' } })
  await backfillSearchIndex(db)
  const r2 = await backfillSearchIndex(db)
  assert.equal(r2.indexed, 0)
  assert.equal(ftsCount(db, 'once'), 1)
  db.close()
})

test('backfill: interrupt and re-run reaches the same state (resumable)', async () => {
  const db = openDb(':memory:')
  seedUserAndConvo(db)
  for (let i = 1; i <= 10; i++) insertRawEvent(db, { userId: 1, convoId: 'c1', seq: i, type: 'text', payload: { body: `note ${i}` } })
  let batches = 0
  const r1 = await backfillSearchIndex(db, { batchSize: 3, shouldStop: () => ++batches > 1 })
  assert.ok(r1.scanned < 10, 'stopped early')
  const r2 = await backfillSearchIndex(db, { batchSize: 3 })
  assert.equal(r1.scanned + r2.scanned, 10, 'resume starts where the interrupt left off, no re-scan')
  assert.equal(db.prepare('SELECT COUNT(*) n FROM search_messages').get().n, 10)
  db.close()
})

test('backfill: rows the live path already indexed are not duplicated', async () => {
  const db = openDb(':memory:')
  const { userId, convoId } = seedUserAndConvo(db)
  append(db, { userId, convoId, sender: 'user:dan', type: 'text', payload: { body: 'live row' } })
  const r = await backfillSearchIndex(db)
  assert.equal(r.indexed, 0)
  assert.equal(ftsCount(db, 'live'), 1)
  db.close()
})

test('startServer kicks off the backfill and exposes its promise', async () => {
  const { startTestServer } = await import('./helpers.js')
  const s = await startTestServer()
  assert.ok(s.searchBackfill instanceof Promise)
  await s.searchBackfill
  await s.close()
})

test('GET /search: ranked hits with title, snippet, and live flag', async () => {
  const s = await startTestServer()
  await createUser(s.db, 'dan', 'password-123')
  const login = await s.http('/login', { method: 'POST', body: { username: 'dan', password: 'password-123' } })
  const { token } = login.json
  const userId = login.json.user_id
  upsertConversation(s.db, { id: 'battery', ownerUserId: userId, title: 'Battery pass', sessionState: 'running' })
  upsertConversation(s.db, { id: 'old', ownerUserId: userId, title: 'Old work', sessionState: 'done' })
  append(s.db, { userId, convoId: 'battery', sender: 'agent:kit', type: 'text', payload: { body: 'cut the websocket ping cadence for battery' } })
  append(s.db, { userId, convoId: 'old', sender: 'user:dan', type: 'text', payload: { body: 'battery mentioned once in passing' } })

  const r = await s.http('/search?q=battery', { token })
  assert.equal(r.status, 200)
  assert.equal(r.json.hits.length, 2)
  const hit = r.json.hits.find((h) => h.convo_id === 'battery')
  assert.equal(hit.title, 'Battery pass')
  assert.equal(hit.live, true)
  assert.ok(hit.snippet.includes('**battery**'), `snippet highlights the match: ${hit.snippet}`)
  assert.equal(r.json.hits.find((h) => h.convo_id === 'old').live, false)
  await s.close()
})

test('GET /search: cross-user isolation — A cannot match B text', async () => {
  const s = await startTestServer()
  for (const name of ['alice', 'bob']) {
    await createUser(s.db, name, 'password-123')
  }
  const a = (await s.http('/login', { method: 'POST', body: { username: 'alice', password: 'password-123' } })).json
  const b = (await s.http('/login', { method: 'POST', body: { username: 'bob', password: 'password-123' } })).json
  upsertConversation(s.db, { id: 'bc', ownerUserId: b.user_id, title: 'B', sessionState: 'done' })
  append(s.db, { userId: b.user_id, convoId: 'bc', sender: 'user:bob', type: 'text', payload: { body: 'wombat sighting confirmed' } })

  const r = await s.http('/search?q=wombat', { token: a.token })
  assert.equal(r.status, 200)
  assert.deepEqual(r.json.hits, [])
  const rb = await s.http('/search?q=wombat', { token: b.token })
  assert.equal(rb.json.hits.length, 1)
  await s.close()
})

test('GET /search: human-typed FTS syntax is treated as literal terms, never a 500', async () => {
  const s = await startTestServer()
  await createUser(s.db, 'dan', 'password-123')
  const { token, user_id } = (await s.http('/login', { method: 'POST', body: { username: 'dan', password: 'password-123' } })).json
  upsertConversation(s.db, { id: 'c', ownerUserId: user_id, title: 'C', sessionState: 'done' })
  append(s.db, { userId: user_id, convoId: 'c', sender: 'user:dan', type: 'text', payload: { body: "don't use NEAR the edge *" } })
  for (const q of ['don"t', '*', 'NEAR(', '"unbalanced', 'a AND OR']) {
    const r = await s.http(`/search?q=${encodeURIComponent(q)}`, { token })
    assert.notEqual(r.status, 500, `q=${q} must never 500`)
    assert.ok([200, 400].includes(r.status), `q=${q} → ${r.status}`)
  }
  // Quoting makes syntax characters literal: NEAR matches the stored text as a word
  const near = await s.http('/search?q=NEAR', { token })
  assert.equal(near.status, 200)
  assert.equal(near.json.hits.length, 1)
  await s.close()
})

test('GET /search: bad inputs → 400; limit is clamped to 50', async () => {
  const s = await startTestServer()
  await createUser(s.db, 'dan', 'password-123')
  const { token } = (await s.http('/login', { method: 'POST', body: { username: 'dan', password: 'password-123' } })).json
  assert.equal((await s.http('/search', { token })).status, 400)
  assert.equal((await s.http('/search?q=%20%20', { token })).status, 400)
  assert.equal((await s.http(`/search?q=${'x'.repeat(300)}`, { token })).status, 400)
  assert.equal((await s.http('/search?q=a&limit=0', { token })).status, 400)
  assert.equal((await s.http('/search?q=a&limit=nope', { token })).status, 400)
  assert.equal((await s.http('/search?q=a&limit=100000', { token })).status, 200)
  await s.close()
})

test('GET /search: convo_id narrows to one conversation; unknown/foreign convo_id is just zero hits', async () => {
  const s = await startTestServer()
  await createUser(s.db, 'dan', 'password-123')
  const { token, user_id } = (await s.http('/login', { method: 'POST', body: { username: 'dan', password: 'password-123' } })).json
  upsertConversation(s.db, { id: 'c1', ownerUserId: user_id, title: 'One', sessionState: 'done' })
  upsertConversation(s.db, { id: 'c2', ownerUserId: user_id, title: 'Two', sessionState: 'done' })
  append(s.db, { userId: user_id, convoId: 'c1', sender: 'user:dan', type: 'text', payload: { body: 'shared keyword' } })
  append(s.db, { userId: user_id, convoId: 'c2', sender: 'user:dan', type: 'text', payload: { body: 'shared keyword' } })
  const r = await s.http('/search?q=shared&convo_id=c1', { token })
  assert.equal(r.json.hits.length, 1)
  assert.equal(r.json.hits[0].convo_id, 'c1')
  // No existence oracle: a convo_id the user cannot see returns the same
  // empty set an unmatched query does (results are user-scoped regardless).
  const foreign = await s.http('/search?q=shared&convo_id=someone-elses', { token })
  assert.equal(foreign.status, 200)
  assert.deepEqual(foreign.json.hits, [])
  await s.close()
})

test('GET /search: porter stemming finds morphological variants', async () => {
  const s = await startTestServer()
  await createUser(s.db, 'dan', 'password-123')
  const { token, user_id } = (await s.http('/login', { method: 'POST', body: { username: 'dan', password: 'password-123' } })).json
  upsertConversation(s.db, { id: 'c', ownerUserId: user_id, title: 'C', sessionState: 'done' })
  append(s.db, { userId: user_id, convoId: 'c', sender: 'user:dan', type: 'text', payload: { body: 'we dropped the sqlcipher plan' } })
  const r = await s.http('/search?q=dropping', { token })
  assert.equal(r.json.hits.length, 1)
  await s.close()
})
