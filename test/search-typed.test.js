// test/search-typed.test.js — the apps' typed search modes (`mode=chats`,
// `mode=recent`, `exclude_subagents`). See src/search.js "Typed matching".
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { typedQuery, excerpt } from '../src/search.js'
import { startTestServer } from './helpers.js'
import { createUser, createAgent } from '../src/auth.js'
import { pinDevicePrivate } from '../src/db.js'
import { append, upsertConversation } from '../src/journal.js'

test('typedQuery: words, the last one a prefix while still being typed', () => {
  const q = typedQuery('  time   cris')
  assert.deepEqual(q.terms, ['time', 'cris'])
  assert.equal(q.lastIsPrefix, true)
  assert.equal(q.allTermsMatch, '"time" "cris"*')
  assert.equal(q.exactMatch, '"time cris"')
})

test('typedQuery: a trailing space finishes the last word; syntax is quoted', () => {
  assert.equal(typedQuery('time crisis ').lastIsPrefix, false)
  assert.equal(typedQuery('time crisis ').hasDistinctExactTier, true)
  assert.equal(typedQuery('time ').hasDistinctExactTier, false)
  assert.equal(typedQuery('say "hi" NEAR x*').allTermsMatch, '"say" """hi""" "NEAR" "x*"*')
  assert.equal(typedQuery('++ --'), null)
  assert.equal(typedQuery('   '), null)
  assert.equal(typedQuery('deploy ++').lastIsPrefix, false, 'a dropped trailing word still finished the one before it')
})

test('excerpt: opens before the phrase when the message has it, else the earliest word', () => {
  const pad = 'x'.repeat(300)
  const q = typedQuery('time crisis')
  const e = excerpt(`${pad} time ${pad} the Time Crisis guns ${pad}${pad}${pad}`, q)
  assert.ok(e.startsWith('…') && e.endsWith('…'), e)
  assert.ok(e.includes('the Time Crisis guns'), e)
  assert.ok(e.length <= 1002, e.length)
  const loose = excerpt(`${pad} crisis then time`, q)
  assert.ok(loose.includes('crisis then time'))
  assert.equal(excerpt('nothing literal here', typedQuery('café')), 'nothing literal here')
})

async function seeded() {
  const s = await startTestServer()
  await createUser(s.db, 'alice', 'password-123')
  const login = await s.http('/login', { method: 'POST', body: { username: 'alice', password: 'password-123' } })
  const { token, user_id: userId } = login.json
  const convo = (id, title, extra = {}) => upsertConversation(s.db, { id, ownerUserId: userId, title, sessionState: 'done', ...extra })
  const say = (convoId, body, sender = 'agent:jade') => append(s.db, { userId, convoId, sender, type: 'text', payload: { body } })
  convo('treadmill', 'Treadmill Matron Interface', { sessionState: 'running' })
  convo('ofcom', 'Ofcom research')
  convo('ofcom:sub:a1', 'Ofcom deadlines', { parentConvoId: 'ofcom' })
  convo('run', 'Runs')
  // Oldest first: ts is the append clock, so order of appends is order of time.
  say('treadmill', 'Can you buy guns like time crisis guns and use them as a mouse', 'user:alice')
  say('ofcom', 'several times this year, in a crisis response, each time')
  say('ofcom:sub:a1', 'a crisis of time for firms')
  say('run', 'I run every day')
  say('run', 'Running late, no time for a crisis')
  return { s, token, userId }
}

test('GET /search mode=chats: exact-phrase chats first, then every-word chats, each with count, names and an excerpt', async () => {
  const { s, token } = await seeded()
  const r = await s.http('/search?q=' + encodeURIComponent('time crisis') + '&mode=chats', { token })
  assert.equal(r.status, 200)
  assert.deepEqual(r.json.chats.map((c) => c.convo_id), ['treadmill', 'run', 'ofcom:sub:a1', 'ofcom'])
  assert.deepEqual(r.json.chats.map((c) => c.exact), [true, false, false, false])
  const top = r.json.chats[0]
  assert.equal(top.title, 'Treadmill Matron Interface')
  assert.equal(top.live, true)
  assert.equal(top.count, 1)
  assert.equal(top.top.sender, 'user:alice')
  assert.ok(top.top.excerpt.includes('time crisis guns'), top.top.excerpt)
  assert.equal(top.parent_convo_id, null)
  const sub = r.json.chats[2]
  assert.equal(sub.parent_convo_id, 'ofcom')
  assert.equal(sub.parent_title, 'Ofcom research')
  await s.close()
})

test('GET /search: exclude_subagents=1 drops child conversations in every mode', async () => {
  const { s, token } = await seeded()
  const chats = await s.http('/search?q=crisis&mode=chats&exclude_subagents=1', { token })
  assert.ok(!chats.json.chats.some((c) => c.convo_id.includes(':sub:')))
  assert.equal(chats.json.chats.length, 3)
  const recent = await s.http('/search?q=crisis&mode=recent&exclude_subagents=1', { token })
  assert.ok(!recent.json.hits.some((h) => h.convo_id.includes(':sub:')))
  const ranked = await s.http('/search?q=crisis&exclude_subagents=1', { token })
  assert.ok(!ranked.json.hits.some((h) => h.convo_id.includes(':sub:')))
  const withSubs = await s.http('/search?q=crisis', { token })
  assert.ok(withSubs.json.hits.some((h) => h.convo_id.includes(':sub:')), 'default keeps them')
  await s.close()
})

test('GET /search mode=chats: words must appear as typed — whole words, no other forms; the last word is a prefix only while being typed', async () => {
  const { s, token } = await seeded()
  const running = await s.http('/search?q=' + encodeURIComponent('running ') + '&mode=chats', { token })
  assert.deepEqual(running.json.chats.map((c) => c.convo_id), ['run'])
  assert.equal(running.json.chats[0].count, 1, '"I run every day" is a stem match only')
  // A finished word matches only itself: "run " does not find "Running"
  // (CodeRabbit on PR 127).
  const run = await s.http('/search?q=' + encodeURIComponent('run ') + '&mode=recent&convo_id=run', { token })
  assert.equal(run.json.hits.length, 1)
  // Every prefix of a word being typed keeps matching it, including the
  // ones longer than the word's stem (Bugbot on PR 127).
  for (const prefix of ['ru', 'run', 'runn', 'runni', 'runnin', 'running']) {
    const r = await s.http(`/search?q=${prefix}&mode=recent&convo_id=run`, { token })
    assert.ok(r.json.hits.some((h) => h.seq), `${prefix} must still match "Running late"`)
  }
  const finished = await s.http('/search?q=' + encodeURIComponent('tim ') + '&mode=chats', { token })
  assert.equal(finished.json.chats.length, 0)
  const typing = await s.http('/search?q=tim&mode=chats', { token })
  assert.ok(typing.json.chats.length >= 3)
  // Diacritics fold both ways; punctuation inside a word is not a barrier.
  await s.close()
})

test('GET /search typed modes: an existing database gains the unstemmed mirror with every row indexed', async () => {
  const { openDb } = await import('../src/db.js')
  const fs = await import('node:fs')
  const os = await import('node:os')
  const path = await import('node:path')
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'journal-plain-'))
  const dbPath = path.join(dir, 'j.db')
  // A database from before the mirror existed: create it, then drop the mirror.
  const db = openDb(dbPath)
  db.prepare("INSERT INTO users(id, name, password_hash, created_at) VALUES(1, 'u', 'x', 0)").run()
  upsertConversation(db, { id: 'c', ownerUserId: 1, title: 'T', sessionState: 'done' })
  for (const body of ['a crisis', 'another crisis', 'no match']) {
    append(db, { userId: 1, convoId: 'c', sender: 'agent:x', type: 'text', payload: { body } })
  }
  db.exec('DROP TRIGGER search_messages_ai_plain; DROP TABLE search_fts_plain')
  db.close()
  const reopened = openDb(dbPath)
  const n = reopened.prepare('SELECT COUNT(*) n FROM search_fts_plain WHERE search_fts_plain MATCH ?').get('"crisis"').n
  assert.equal(n, 2)
  reopened.close()
  fs.rmSync(dir, { recursive: true, force: true })
})

test('GET /search mode=chats: an exact chat beyond the newest `limit` keeps its full count', async () => {
  const { s, token, userId } = await seeded()
  for (let i = 0; i < 3; i++) {
    upsertConversation(s.db, { id: `new${i}`, ownerUserId: userId, title: `New ${i}`, sessionState: 'done' })
    append(s.db, { userId, convoId: `new${i}`, sender: 'agent:x', type: 'text', payload: { body: 'time for a crisis' } })
  }
  const r = await s.http('/search?q=' + encodeURIComponent('time crisis ') + '&mode=chats&limit=2', { token })
  assert.deepEqual(r.json.chats.map((c) => c.convo_id), ['treadmill', 'new2'])
  assert.equal(r.json.chats[0].count, 1)
  await s.close()
})

test('GET /search mode=recent: newest-first seqs, scoped to a conversation with a wider clamp', async () => {
  const { s, token } = await seeded()
  const r = await s.http('/search?q=time&mode=recent&convo_id=run&limit=300', { token })
  assert.equal(r.status, 200)
  assert.equal(r.json.hits.length, 1)
  assert.equal(r.json.hits[0].convo_id, 'run')
  assert.ok(Number.isInteger(r.json.hits[0].seq))
  assert.equal(r.json.hits[0].body, undefined, 'no body: the app already shows the message')
  const all = await s.http('/search?q=time&mode=recent', { token })
  const ts = all.json.hits.map((h) => h.ts)
  assert.deepEqual(ts, [...ts].sort((a, b) => b - a))
  assert.ok(all.json.hits.length >= 3)
  await s.close()
})

test('GET /search: typed modes treat FTS syntax as text and reject an unknown mode', async () => {
  const { s, token } = await seeded()
  for (const q of ['"', '*', 'NEAR(', 'a OR', '%', '_']) {
    for (const mode of ['chats', 'recent']) {
      const r = await s.http(`/search?q=${encodeURIComponent(q)}&mode=${mode}`, { token })
      assert.ok(r.status === 200 || r.status === 400, `${mode} ${q}: ${r.status}`)
    }
  }
  const bad = await s.http('/search?q=time&mode=nope', { token })
  assert.equal(bad.status, 400)
  await s.close()
})

test('GET /search typed modes: cross-user isolation and the private-owned filter for ordinary agents', async () => {
  const { s, token, userId } = await seeded()
  await createUser(s.db, 'bob', 'password-123')
  const bob = await s.http('/login', { method: 'POST', body: { username: 'bob', password: 'password-123' } })
  const other = await s.http('/search?q=crisis&mode=chats', { token: bob.json.token })
  assert.equal(other.json.chats.length, 0)
  // An ordinary agent of Alice's sees nothing from a private-owned conversation.
  const priv = createAgent(s.db, userId, 'secret-box')
  pinDevicePrivate(s.db, priv.deviceId, true)
  upsertConversation(s.db, { id: 'hidden', ownerUserId: userId, title: 'Hidden', sessionState: 'done', agentDeviceId: priv.deviceId })
  append(s.db, { userId, convoId: 'hidden', sender: 'agent:secret', type: 'text', payload: { body: 'time crisis in private' } })
  const ordinary = createAgent(s.db, userId, 'plain-box')
  const asAgent = await s.http('/search?q=' + encodeURIComponent('time crisis') + '&mode=chats', { token: ordinary.token })
  assert.ok(!asAgent.json.chats.some((c) => c.convo_id === 'hidden'))
  const asClient = await s.http('/search?q=' + encodeURIComponent('time crisis') + '&mode=chats', { token })
  assert.ok(asClient.json.chats.some((c) => c.convo_id === 'hidden'))
  await s.close()
})
