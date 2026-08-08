// test/search.test.js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { indexableBody, backfillSearchIndex } from '../src/search.js'

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
