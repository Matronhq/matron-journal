# matron-journal Server v1 Core — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A working journal server implementing the core Matron protocol — password auth with device tokens, per-user append-only journal, snapshot/pagination HTTP API, resumable WebSocket sync with ephemeral streaming, admin CLI — proven by a chaos resume test.

**Architecture:** Single Node process. SQLite (WAL) holds users/devices/conversations/events; per-user monotonic `seq` allocated transactionally. Clients and bridge agents connect over one WebSocket each; a hub fans journal frames out to a user's devices and coalesces ephemeral streaming frames. Resume = "replay events > cursor"; the server keeps no per-connection sync state.

**Tech Stack:** Node 20+ (ESM), `better-sqlite3`, `ws`, `argon2`, built-in `node:test` runner. No other runtime deps.

**Spec:** `docs/superpowers/specs/2026-07-10-matron-protocol-design.md`. Deferred to the follow-up plan (v1 completion): media upload/download, APNs push, retention/offload job, `/metrics`, golden conformance fixtures.

## Global Constraints

- Node >= 20, ESM (`"type": "module"`); tests via `node --test test/`.
- Runtime deps limited to: `better-sqlite3`, `ws`, `argon2`.
- Bind `127.0.0.1` by default (Cloudflare tunnel fronts it); env config: `MATRON_DB` (default `./matron.db`), `MATRON_PORT` (default `9810`), `MATRON_BIND` (default `127.0.0.1`).
- Password hashes: argon2id. Device/agent tokens: 256-bit random hex, stored as SHA-256 hex.
- Login rate limit: 5 attempts/min per IP (spec §8).
- WS ping every 20 s; ephemeral coalescing window 200 ms (≤ 5 frames/s) (spec §6).
- Ordering is by `seq`, never `ts`; `ts` is display-only (spec §10).
- Every read path calls `authorize(db, userId, convoId)` (spec §7).
- Commit after every task; conventional-commit messages ending with `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.

## File Structure

```
package.json               — module config, test script, deps
src/db.js                  — open DB, schema, pragmas
src/auth.js                — users, login, tokens, authorize, rate limiter
src/journal.js             — append/seq, conversations, snapshot, pagination, replay, read markers
src/hub.js                 — connection registry, journal fan-out, ephemeral coalescing
src/ws.js                  — WS endpoint: hello/resume, upstream ops, agent ops, heartbeats
src/http.js                — /login, /snapshot, /convo/:id/messages + bearer auth
src/server.js              — wiring; startServer() for tests, env entry for prod
bin/matron-admin.js        — admin CLI: user add/passwd, agent add, status
test/helpers.js            — startTestServer(), makeWsClient()
test/{db,auth,journal,http,ws,agent,admin}.test.js
test/chaos.test.js         — the headline resume property test
```

---

### Task 1: Scaffold + database schema

**Files:**
- Create: `package.json`, `.gitignore`, `src/db.js`
- Test: `test/db.test.js`

**Interfaces:**
- Produces: `openDb(path) → Database` — opens/creates SQLite at `path` with WAL + foreign keys, applies idempotent schema. Tables per spec §5: `users`, `devices`, `conversations`, `events`, `user_seq`.

- [ ] **Step 1: Write scaffold files**

`package.json`:
```json
{
  "name": "matron-journal",
  "version": "0.1.0",
  "type": "module",
  "bin": { "matron-admin": "bin/matron-admin.js" },
  "scripts": {
    "start": "node src/server.js",
    "test": "node --test test/"
  },
  "engines": { "node": ">=20" },
  "dependencies": {
    "argon2": "^0.41.0",
    "better-sqlite3": "^11.0.0",
    "ws": "^8.18.0"
  }
}
```

`.gitignore`:
```
node_modules/
*.db
*.db-wal
*.db-shm
```

Run: `cd ~/matron-journal && npm install`
Expected: installs 3 deps without errors.

- [ ] **Step 2: Write the failing test**

`test/db.test.js`:
```js
import test from 'node:test'
import assert from 'node:assert/strict'
import { openDb } from '../src/db.js'

test('openDb creates schema idempotently', () => {
  const db = openDb(':memory:')
  const tables = db.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"
  ).all().map(r => r.name)
  for (const t of ['users', 'devices', 'conversations', 'events', 'user_seq']) {
    assert.ok(tables.includes(t), `missing table ${t}`)
  }
  assert.equal(db.pragma('foreign_keys', { simple: true }), 1)
})

test('events PK is (user_id, seq)', () => {
  const db = openDb(':memory:')
  db.prepare("INSERT INTO users(name, password_hash, created_at) VALUES('a','x',0)").run()
  db.prepare("INSERT INTO conversations(id, owner_user_id, created_at) VALUES('c1',1,0)").run()
  const ins = db.prepare(
    "INSERT INTO events(user_id, seq, convo_id, ts, sender, type, payload) VALUES(1,1,'c1',0,'s','text','{}')"
  )
  ins.run()
  assert.throws(() => ins.run(), /UNIQUE|PRIMARY/)
})
```

- [ ] **Step 3: Run test to verify it fails**

Run: `node --test test/db.test.js`
Expected: FAIL — `Cannot find module '../src/db.js'`

- [ ] **Step 4: Write implementation**

`src/db.js`:
```js
import Database from 'better-sqlite3'

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users(
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS devices(
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  kind TEXT NOT NULL CHECK(kind IN ('client','agent')),
  name TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  cursor INTEGER NOT NULL DEFAULT 0,
  apns_token TEXT,
  created_at INTEGER NOT NULL,
  last_seen_at INTEGER
);
CREATE TABLE IF NOT EXISTS conversations(
  id TEXT PRIMARY KEY,
  owner_user_id INTEGER NOT NULL REFERENCES users(id),
  title TEXT NOT NULL DEFAULT '',
  session_state TEXT NOT NULL DEFAULT 'running'
    CHECK(session_state IN ('running','waiting','done','archived')),
  last_seq INTEGER NOT NULL DEFAULT 0,
  unread_count INTEGER NOT NULL DEFAULT 0,
  snippet TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS events(
  user_id INTEGER NOT NULL,
  seq INTEGER NOT NULL,
  convo_id TEXT NOT NULL,
  ts INTEGER NOT NULL,
  sender TEXT NOT NULL,
  type TEXT NOT NULL,
  payload TEXT NOT NULL,
  blob_ref TEXT,
  idem_key TEXT,
  PRIMARY KEY(user_id, seq)
);
CREATE INDEX IF NOT EXISTS idx_events_convo ON events(convo_id, seq);
CREATE UNIQUE INDEX IF NOT EXISTS idx_events_idem
  ON events(user_id, idem_key) WHERE idem_key IS NOT NULL;
CREATE TABLE IF NOT EXISTS user_seq(
  user_id INTEGER PRIMARY KEY,
  seq INTEGER NOT NULL
);
`

export function openDb(path) {
  const db = new Database(path)
  db.pragma('journal_mode = WAL')
  db.pragma('foreign_keys = ON')
  db.exec(SCHEMA)
  return db
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `node --test test/db.test.js`
Expected: PASS (2 tests)

- [ ] **Step 6: Commit**

```bash
git add package.json package-lock.json .gitignore src/db.js test/db.test.js
git commit -m "feat: scaffold and sqlite schema"
```

---

### Task 2: Auth — users, login, device tokens, authorize

**Files:**
- Create: `src/auth.js`
- Test: `test/auth.test.js`

**Interfaces:**
- Consumes: `openDb` (Task 1).
- Produces:
  - `async createUser(db, name, password) → {id, name}` (throws on duplicate name)
  - `async setPassword(db, name, password)`
  - `async login(db, {username, password, deviceName}) → {token, deviceId, userId} | null` (creates a `client` device)
  - `createAgent(db, userId, name) → {token, deviceId}` (creates an `agent` device, no password involved)
  - `authToken(db, token) → {deviceId, userId, kind, name} | null` (updates `last_seen_at`)
  - `revokeDevice(db, deviceId)`
  - `authorize(db, userId, convoId) → boolean` (v1: owner check — the sharing door)
  - `makeRateLimiter({max = 5, windowMs = 60000}) → {allow(key) → boolean}`

- [ ] **Step 1: Write the failing test**

`test/auth.test.js`:
```js
import test from 'node:test'
import assert from 'node:assert/strict'
import { openDb } from '../src/db.js'
import {
  createUser, login, createAgent, authToken, revokeDevice,
  authorize, makeRateLimiter,
} from '../src/auth.js'

test('login issues a device token; authToken resolves it', async () => {
  const db = openDb(':memory:')
  await createUser(db, 'dan', 'hunter22')
  assert.equal(await login(db, { username: 'dan', password: 'wrong', deviceName: 'x' }), null)
  const s = await login(db, { username: 'dan', password: 'hunter22', deviceName: 'phone' })
  assert.match(s.token, /^[0-9a-f]{64}$/)
  const who = authToken(db, s.token)
  assert.equal(who.kind, 'client')
  assert.equal(who.userId, s.userId)
  revokeDevice(db, s.deviceId)
  assert.equal(authToken(db, s.token), null)
})

test('agent tokens and authorize owner check', async () => {
  const db = openDb(':memory:')
  const dan = await createUser(db, 'dan', 'pw1')
  const pat = await createUser(db, 'pat', 'pw2')
  const a = createAgent(db, dan.id, 'dev-2')
  assert.equal(authToken(db, a.token).kind, 'agent')
  db.prepare("INSERT INTO conversations(id, owner_user_id, created_at) VALUES('c1',?,0)").run(dan.id)
  assert.equal(authorize(db, dan.id, 'c1'), true)
  assert.equal(authorize(db, pat.id, 'c1'), false)
})

test('rate limiter blocks 6th attempt in window', () => {
  const rl = makeRateLimiter({ max: 5, windowMs: 60000 })
  for (let i = 0; i < 5; i++) assert.equal(rl.allow('1.2.3.4'), true)
  assert.equal(rl.allow('1.2.3.4'), false)
  assert.equal(rl.allow('5.6.7.8'), true)
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/auth.test.js`
Expected: FAIL — `Cannot find module '../src/auth.js'`

- [ ] **Step 3: Write implementation**

`src/auth.js`:
```js
import crypto from 'node:crypto'
import argon2 from 'argon2'

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex')
const newToken = () => crypto.randomBytes(32).toString('hex')

export async function createUser(db, name, password) {
  const hash = await argon2.hash(password, { type: argon2.argon2id })
  const r = db.prepare(
    'INSERT INTO users(name, password_hash, created_at) VALUES(?,?,?)'
  ).run(name, hash, Date.now())
  return { id: r.lastInsertRowid, name }
}

export async function setPassword(db, name, password) {
  const hash = await argon2.hash(password, { type: argon2.argon2id })
  const r = db.prepare('UPDATE users SET password_hash=? WHERE name=?').run(hash, name)
  if (r.changes === 0) throw new Error(`no such user: ${name}`)
}

function issueDevice(db, userId, kind, name) {
  const token = newToken()
  const r = db.prepare(
    'INSERT INTO devices(user_id, kind, name, token_hash, created_at) VALUES(?,?,?,?,?)'
  ).run(userId, kind, name, sha256(token), Date.now())
  return { token, deviceId: r.lastInsertRowid }
}

export async function login(db, { username, password, deviceName }) {
  const user = db.prepare('SELECT id, password_hash FROM users WHERE name=?').get(username)
  if (!user) return null
  if (!(await argon2.verify(user.password_hash, password))) return null
  const d = issueDevice(db, user.id, 'client', deviceName || 'unnamed')
  return { ...d, userId: user.id }
}

export function createAgent(db, userId, name) {
  return issueDevice(db, userId, 'agent', name)
}

export function authToken(db, token) {
  const row = db.prepare(
    'SELECT id, user_id, kind, name FROM devices WHERE token_hash=?'
  ).get(sha256(token))
  if (!row) return null
  db.prepare('UPDATE devices SET last_seen_at=? WHERE id=?').run(Date.now(), row.id)
  return { deviceId: row.id, userId: row.user_id, kind: row.kind, name: row.name }
}

export function revokeDevice(db, deviceId) {
  db.prepare('DELETE FROM devices WHERE id=?').run(deviceId)
}

// v1 owner check. Sharing later = extend this + a grants table (spec §7).
export function authorize(db, userId, convoId) {
  const row = db.prepare('SELECT owner_user_id FROM conversations WHERE id=?').get(convoId)
  return !!row && row.owner_user_id === userId
}

export function makeRateLimiter({ max = 5, windowMs = 60000 } = {}) {
  const hits = new Map()
  return {
    allow(key) {
      const now = Date.now()
      const list = (hits.get(key) || []).filter((t) => now - t < windowMs)
      if (list.length >= max) { hits.set(key, list); return false }
      list.push(now)
      hits.set(key, list)
      return true
    },
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test test/auth.test.js`
Expected: PASS (3 tests)

- [ ] **Step 5: Commit**

```bash
git add src/auth.js test/auth.test.js
git commit -m "feat: password auth, device/agent tokens, authorize, rate limiter"
```

---

### Task 3: Journal — append, seq allocation, conversation summaries

**Files:**
- Create: `src/journal.js`
- Test: `test/journal.test.js`

**Interfaces:**
- Consumes: `openDb` (Task 1).
- Produces:
  - `MESSAGE_TYPES` — `['text','tool_output','diff','prompt','permission_request','file','image']`
  - `upsertConversation(db, {id, ownerUserId, title?, sessionState?}) → row` (insert or update title/state; only the owner may update — throws otherwise)
  - `append(db, {userId, convoId, sender, type, payload, blobRef?, idemKey?}) → {seq, ts, duplicate}` — transactional: allocates per-user seq, inserts event, updates conversation summary (`last_seq`, `snippet`, `unread_count`, `session_state` for `session_status` events). Duplicate `idemKey` returns the original event's `{seq, ts, duplicate: true}` without inserting. Throws if convo missing or not owned by `userId`.

- [ ] **Step 1: Write the failing test**

`test/journal.test.js`:
```js
import test from 'node:test'
import assert from 'node:assert/strict'
import { openDb } from '../src/db.js'
import { createUser } from '../src/auth.js'
import { append, upsertConversation } from '../src/journal.js'

async function setup() {
  const db = openDb(':memory:')
  const dan = await createUser(db, 'dan', 'pw')
  upsertConversation(db, { id: 'c1', ownerUserId: dan.id, title: 'fix tests' })
  return { db, dan }
}

test('append allocates contiguous per-user seq and updates summary', async () => {
  const { db, dan } = await setup()
  upsertConversation(db, { id: 'c2', ownerUserId: dan.id })
  const a = append(db, { userId: dan.id, convoId: 'c1', sender: 'agent:dev-2', type: 'text', payload: { body: 'hello' } })
  const b = append(db, { userId: dan.id, convoId: 'c2', sender: 'agent:dev-2', type: 'text', payload: { body: 'world' } })
  assert.equal(a.seq, 1)
  assert.equal(b.seq, 2)
  const c1 = db.prepare("SELECT * FROM conversations WHERE id='c1'").get()
  assert.equal(c1.last_seq, 1)
  assert.equal(c1.unread_count, 1)
  assert.equal(c1.snippet, 'hello')
})

test('session_status updates state without bumping unread', async () => {
  const { db, dan } = await setup()
  append(db, { userId: dan.id, convoId: 'c1', sender: 'agent:dev-2', type: 'session_status', payload: { state: 'waiting' } })
  const c1 = db.prepare("SELECT * FROM conversations WHERE id='c1'").get()
  assert.equal(c1.session_state, 'waiting')
  assert.equal(c1.unread_count, 0)
})

test('idempotency key dedupes', async () => {
  const { db, dan } = await setup()
  const p = { userId: dan.id, convoId: 'c1', sender: 'agent:dev-2', type: 'text', payload: { body: 'x' }, idemKey: 'a1:m1' }
  const first = append(db, p)
  const again = append(db, p)
  assert.equal(again.seq, first.seq)
  assert.equal(again.duplicate, true)
  assert.equal(db.prepare('SELECT COUNT(*) n FROM events').get().n, 1)
})

test('append to unowned convo throws', async () => {
  const { db } = await setup()
  const pat = await createUser(db, 'pat', 'pw')
  assert.throws(
    () => append(db, { userId: pat.id, convoId: 'c1', sender: 'user:pat', type: 'text', payload: {} }),
    /not authorized/
  )
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/journal.test.js`
Expected: FAIL — `Cannot find module '../src/journal.js'`

- [ ] **Step 3: Write implementation**

`src/journal.js`:
```js
export const MESSAGE_TYPES = [
  'text', 'tool_output', 'diff', 'prompt', 'permission_request', 'file', 'image',
]

function snippetOf(type, payload) {
  if (type === 'text') return String(payload.body || '').slice(0, 120)
  if (type === 'prompt') return `? ${String(payload.question || '').slice(0, 110)}`
  if (type === 'permission_request') return `permission: ${String(payload.description || '').slice(0, 100)}`
  if (payload && payload.snippet) return String(payload.snippet).slice(0, 120)
  return `[${type}]`
}

export function upsertConversation(db, { id, ownerUserId, title, sessionState }) {
  const existing = db.prepare('SELECT * FROM conversations WHERE id=?').get(id)
  if (existing) {
    if (existing.owner_user_id !== ownerUserId) throw new Error('not authorized: convo owned by another user')
    db.prepare(
      'UPDATE conversations SET title=COALESCE(?, title), session_state=COALESCE(?, session_state) WHERE id=?'
    ).run(title ?? null, sessionState ?? null, id)
  } else {
    db.prepare(
      'INSERT INTO conversations(id, owner_user_id, title, session_state, created_at) VALUES(?,?,?,?,?)'
    ).run(id, ownerUserId, title || '', sessionState || 'running', Date.now())
  }
  return db.prepare('SELECT * FROM conversations WHERE id=?').get(id)
}

const nextSeq = (db, userId) =>
  db.prepare(
    'INSERT INTO user_seq(user_id, seq) VALUES(?,1) ON CONFLICT(user_id) DO UPDATE SET seq=seq+1 RETURNING seq'
  ).get(userId).seq

export function append(db, { userId, convoId, sender, type, payload, blobRef = null, idemKey = null }) {
  return db.transaction(() => {
    const convo = db.prepare('SELECT owner_user_id FROM conversations WHERE id=?').get(convoId)
    if (!convo || convo.owner_user_id !== userId) throw new Error('not authorized: convo missing or not owned')
    if (idemKey) {
      const dup = db.prepare('SELECT seq, ts FROM events WHERE user_id=? AND idem_key=?').get(userId, idemKey)
      if (dup) return { seq: dup.seq, ts: dup.ts, duplicate: true }
    }
    const seq = nextSeq(db, userId)
    const ts = Date.now()
    db.prepare(
      'INSERT INTO events(user_id, seq, convo_id, ts, sender, type, payload, blob_ref, idem_key) VALUES(?,?,?,?,?,?,?,?,?)'
    ).run(userId, seq, convoId, ts, sender, type, JSON.stringify(payload), blobRef, idemKey)
    if (type === 'session_status') {
      db.prepare('UPDATE conversations SET last_seq=?, session_state=? WHERE id=?')
        .run(seq, payload.state, convoId)
    } else if (MESSAGE_TYPES.includes(type)) {
      db.prepare('UPDATE conversations SET last_seq=?, unread_count=unread_count+1, snippet=? WHERE id=?')
        .run(seq, snippetOf(type, payload), convoId)
    } else {
      db.prepare('UPDATE conversations SET last_seq=? WHERE id=?').run(seq, convoId)
    }
    return { seq, ts, duplicate: false }
  })()
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test test/journal.test.js`
Expected: PASS (4 tests)

- [ ] **Step 5: Commit**

```bash
git add src/journal.js test/journal.test.js
git commit -m "feat: journal append with per-user seq and conversation summaries"
```

---

### Task 4: Read model — snapshot, pagination, replay, read markers

**Files:**
- Modify: `src/journal.js` (append to end of file)
- Test: `test/journal.test.js` (append new tests)

**Interfaces:**
- Consumes: Task 3's `append`, `MESSAGE_TYPES`; Task 2's `authorize`.
- Produces (all enforce `authorize` where a convoId is given; rows return `payload` parsed to an object):
  - `snapshot(db, userId) → {conversations: [...], seq}` — all convos owned by user (id, title, session_state, last_seq, unread_count, snippet), plus current journal head seq
  - `eventsAfter(db, userId, cursor, limit = 500) → rows` (ascending seq)
  - `messagesBefore(db, userId, convoId, {beforeSeq = null, limit = 50}) → rows` (ascending; the `limit` newest events with `seq < beforeSeq`; throws `not authorized` on foreign convo)
  - `markRead(db, userId, convoId, upToSeq) → {seq, ts}` — appends a `read_marker` journal event and recomputes `unread_count` as the count of message-class events with `seq > upToSeq`

- [ ] **Step 1: Write the failing tests (append to `test/journal.test.js`)**

```js
import { snapshot, eventsAfter, messagesBefore, markRead } from '../src/journal.js'

test('snapshot, replay, pagination, read markers', async () => {
  const { db, dan } = await setup()
  for (let i = 1; i <= 5; i++) {
    append(db, { userId: dan.id, convoId: 'c1', sender: 'agent:dev-2', type: 'text', payload: { body: `m${i}` } })
  }
  const snap = snapshot(db, dan.id)
  assert.equal(snap.seq, 5)
  assert.equal(snap.conversations[0].unread_count, 5)

  const replay = eventsAfter(db, dan.id, 2)
  assert.deepEqual(replay.map((e) => e.seq), [3, 4, 5])
  assert.equal(replay[0].payload.body, 'm3')

  const page = messagesBefore(db, dan.id, 'c1', { beforeSeq: 5, limit: 2 })
  assert.deepEqual(page.map((e) => e.seq), [3, 4])

  const rm = markRead(db, dan.id, 'c1', 4)
  assert.equal(rm.seq, 6) // read_marker is itself a journal event
  assert.equal(db.prepare("SELECT unread_count FROM conversations WHERE id='c1'").get().unread_count, 1)
})

test('messagesBefore rejects foreign convo', async () => {
  const { db } = await setup()
  const pat = await createUser(db, 'pat2', 'pw')
  assert.throws(() => messagesBefore(db, pat.id, 'c1', {}), /not authorized/)
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/journal.test.js`
Expected: FAIL — `snapshot` is not exported

- [ ] **Step 3: Write implementation (append to `src/journal.js`)**

```js
import { authorize } from './auth.js'

const parseRow = (r) => ({ ...r, payload: JSON.parse(r.payload) })

export function snapshot(db, userId) {
  const conversations = db.prepare(
    `SELECT id, title, session_state, last_seq, unread_count, snippet, created_at
     FROM conversations WHERE owner_user_id=? ORDER BY last_seq DESC`
  ).all(userId)
  const head = db.prepare('SELECT seq FROM user_seq WHERE user_id=?').get(userId)
  return { conversations, seq: head ? head.seq : 0 }
}

export function eventsAfter(db, userId, cursor, limit = 500) {
  return db.prepare(
    'SELECT * FROM events WHERE user_id=? AND seq>? ORDER BY seq LIMIT ?'
  ).all(userId, cursor, limit).map(parseRow)
}

export function messagesBefore(db, userId, convoId, { beforeSeq = null, limit = 50 } = {}) {
  if (!authorize(db, userId, convoId)) throw new Error('not authorized')
  const rows = beforeSeq == null
    ? db.prepare('SELECT * FROM events WHERE convo_id=? ORDER BY seq DESC LIMIT ?').all(convoId, limit)
    : db.prepare('SELECT * FROM events WHERE convo_id=? AND seq<? ORDER BY seq DESC LIMIT ?').all(convoId, beforeSeq, limit)
  return rows.reverse().map(parseRow)
}

export function markRead(db, userId, convoId, upToSeq) {
  return db.transaction(() => {
    const r = append(db, {
      userId, convoId, sender: `user:${userId}`, type: 'read_marker',
      payload: { convo_id: convoId, up_to_seq: upToSeq },
    })
    const placeholders = MESSAGE_TYPES.map(() => '?').join(',')
    db.prepare(
      `UPDATE conversations SET unread_count=(
         SELECT COUNT(*) FROM events e WHERE e.convo_id=? AND e.seq>? AND e.type IN (${placeholders})
       ) WHERE id=?`
    ).run(convoId, upToSeq, ...MESSAGE_TYPES, convoId)
    return r
  })()
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test test/journal.test.js`
Expected: PASS (6 tests)

- [ ] **Step 5: Commit**

```bash
git add src/journal.js test/journal.test.js
git commit -m "feat: snapshot, replay, pagination, read markers"
```

---

### Task 5: HTTP API — /login, /snapshot, /convo/:id/messages

**Files:**
- Create: `src/http.js`, `src/server.js`, `test/helpers.js`
- Test: `test/http.test.js`

**Interfaces:**
- Consumes: Tasks 2–4 (`login`, `authToken`, `makeRateLimiter`, `snapshot`, `messagesBefore`).
- Produces:
  - `makeHttpHandler({db, rateLimiter}) → (req, res)` — routes: `POST /login` (JSON `{username,password,device_name}` → `{token, device_id, user_id}` | 403; 429 when rate-limited), `GET /snapshot` and `GET /convo/:id/messages?before_seq&limit` (Bearer token → 401 unauthenticated, 403 unauthorized convo). Unknown path → 404 JSON.
  - `startServer({dbPath, port = 0, bind = '127.0.0.1'}) → Promise<{port, db, close()}>` — http server with handler attached (WS attaches in Task 6).
  - `test/helpers.js`: `startTestServer() → {base, db, close, http(path, {method, token, body})}` — thin fetch wrapper returning `{status, json}`.

- [ ] **Step 1: Write the failing test**

`test/http.test.js`:
```js
import test from 'node:test'
import assert from 'node:assert/strict'
import { startTestServer } from './helpers.js'
import { createUser } from '../src/auth.js'
import { upsertConversation, append } from '../src/journal.js'

test('login → snapshot → pagination over HTTP', async (t) => {
  const s = await startTestServer()
  t.after(() => s.close())
  const dan = await createUser(s.db, 'dan', 'hunter22')
  upsertConversation(s.db, { id: 'c1', ownerUserId: dan.id, title: 'T' })
  append(s.db, { userId: dan.id, convoId: 'c1', sender: 'agent:a', type: 'text', payload: { body: 'hi' } })

  const bad = await s.http('/login', { method: 'POST', body: { username: 'dan', password: 'no', device_name: 'x' } })
  assert.equal(bad.status, 403)
  const ok = await s.http('/login', { method: 'POST', body: { username: 'dan', password: 'hunter22', device_name: 'mac' } })
  assert.equal(ok.status, 200)

  assert.equal((await s.http('/snapshot', {})).status, 401)
  const snap = await s.http('/snapshot', { token: ok.json.token })
  assert.equal(snap.json.seq, 1)
  assert.equal(snap.json.conversations.length, 1)

  const page = await s.http('/convo/c1/messages?limit=10', { token: ok.json.token })
  assert.equal(page.json.events[0].payload.body, 'hi')

  await createUser(s.db, 'pat', 'pw')
  const pat = await s.http('/login', { method: 'POST', body: { username: 'pat', password: 'pw', device_name: 'x' } })
  assert.equal((await s.http('/convo/c1/messages', { token: pat.json.token })).status, 403)
})

test('login rate limit returns 429', async (t) => {
  const s = await startTestServer()
  t.after(() => s.close())
  await createUser(s.db, 'dan', 'pw')
  for (let i = 0; i < 5; i++) {
    await s.http('/login', { method: 'POST', body: { username: 'dan', password: 'wrong', device_name: 'x' } })
  }
  const r = await s.http('/login', { method: 'POST', body: { username: 'dan', password: 'pw', device_name: 'x' } })
  assert.equal(r.status, 429)
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/http.test.js`
Expected: FAIL — `Cannot find module './helpers.js'`

- [ ] **Step 3: Write implementation**

`src/http.js`:
```js
import { login, authToken } from './auth.js'
import { snapshot, messagesBefore } from './journal.js'

const json = (res, status, obj) => {
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify(obj))
}

const readBody = (req) => new Promise((resolve, reject) => {
  let data = ''
  req.on('data', (c) => { data += c; if (data.length > 1e6) req.destroy() })
  req.on('end', () => { try { resolve(data ? JSON.parse(data) : {}) } catch (e) { reject(e) } })
  req.on('error', reject)
})

const bearer = (req) => (req.headers.authorization || '').replace(/^Bearer /, '') || null

export function makeHttpHandler({ db, rateLimiter }) {
  return async (req, res) => {
    try {
      const url = new URL(req.url, 'http://x')
      if (req.method === 'POST' && url.pathname === '/login') {
        const ip = req.socket.remoteAddress || 'unknown'
        if (!rateLimiter.allow(ip)) return json(res, 429, { error: 'rate_limited' })
        const { username, password, device_name } = await readBody(req)
        const s = await login(db, { username, password, deviceName: device_name })
        if (!s) return json(res, 403, { error: 'bad_credentials' })
        return json(res, 200, { token: s.token, device_id: s.deviceId, user_id: s.userId })
      }
      const who = bearer(req) && authToken(db, bearer(req))
      if (!who) return json(res, 401, { error: 'unauthenticated' })
      if (req.method === 'GET' && url.pathname === '/snapshot') {
        return json(res, 200, snapshot(db, who.userId))
      }
      const m = url.pathname.match(/^\/convo\/([^/]+)\/messages$/)
      if (req.method === 'GET' && m) {
        const beforeSeq = url.searchParams.has('before_seq') ? Number(url.searchParams.get('before_seq')) : null
        const limit = Math.min(Number(url.searchParams.get('limit') || 50), 200)
        try {
          return json(res, 200, { events: messagesBefore(db, who.userId, decodeURIComponent(m[1]), { beforeSeq, limit }) })
        } catch (e) {
          if (/not authorized/.test(e.message)) return json(res, 403, { error: 'forbidden' })
          throw e
        }
      }
      return json(res, 404, { error: 'not_found' })
    } catch (e) {
      return json(res, 500, { error: 'internal', message: e.message })
    }
  }
}
```

`src/server.js`:
```js
import http from 'node:http'
import { openDb } from './db.js'
import { makeRateLimiter } from './auth.js'
import { makeHttpHandler } from './http.js'

export function startServer({ dbPath, port = 0, bind = '127.0.0.1' } = {}) {
  const db = openDb(dbPath || process.env.MATRON_DB || './matron.db')
  const rateLimiter = makeRateLimiter()
  const server = http.createServer(makeHttpHandler({ db, rateLimiter }))
  return new Promise((resolve) => {
    server.listen(port, bind, () => {
      resolve({
        port: server.address().port,
        db,
        server,
        close: () => new Promise((r) => { server.close(() => { db.close(); r() }) }),
      })
    })
  })
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const port = Number(process.env.MATRON_PORT || 9810)
  const bind = process.env.MATRON_BIND || '127.0.0.1'
  startServer({ port, bind }).then((s) => console.log(`matron-journal listening on ${bind}:${s.port}`))
}
```

`test/helpers.js`:
```js
import { startServer } from '../src/server.js'

export async function startTestServer() {
  const s = await startServer({ dbPath: ':memory:', port: 0 })
  const base = `http://127.0.0.1:${s.port}`
  return {
    ...s,
    base,
    async http(path, { method = 'GET', token = null, body = null } = {}) {
      const r = await fetch(base + path, {
        method,
        headers: {
          ...(token ? { authorization: `Bearer ${token}` } : {}),
          ...(body ? { 'content-type': 'application/json' } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
      })
      let j = null
      try { j = await r.json() } catch { /* empty body */ }
      return { status: r.status, json: j }
    },
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test test/http.test.js`
Expected: PASS (2 tests)

- [ ] **Step 5: Run full suite, then commit**

Run: `npm test`
Expected: all tests pass.

```bash
git add src/http.js src/server.js test/helpers.js test/http.test.js
git commit -m "feat: http api - login, snapshot, pagination"
```

---

### Task 6: WebSocket — hello/resume/replay + live journal fan-out

**Files:**
- Create: `src/hub.js`, `src/ws.js`
- Modify: `src/server.js` (attach WS), `test/helpers.js` (add `makeWsClient`)
- Test: `test/ws.test.js`

**Interfaces:**
- Consumes: Tasks 2–5.
- Produces:
  - `makeHub() → {register(conn), unregister(conn), broadcastJournal(userId, frame), sendEphemeral(userId, convoId, frame), connsOf(userId)}` — `conn = {ws, deviceId, userId, kind, name, viewingConvoId}`. `broadcastJournal` sends to every conn of the user. `sendEphemeral` sends only to conns with `viewingConvoId === convoId`, coalesced per `(conn, convo_id, message_ref)` on a 200 ms window (latest frame wins).
  - `attachWs({server, db, hub})` — `ws` server on the http server. First client frame MUST be `{op:'hello', token, cursor}` (`cursor: null` → live-only, used by agents). Server replies `{kind:'control', op:'hello_ok', seq}` then replays `eventsAfter` in batches of 500 as `{kind:'journal', seq, convo_id, ts, sender, type, payload}` frames, then registers for live. Invalid token/first frame → `{kind:'control', op:'error', code:'auth'}` + close. Ping every 20 s (`ws.ping()`), terminate on missed pong. All journal appends made through WS handlers fan out via the hub.
  - Journal-frame shape (used by every later task): `{kind:'journal', seq, convo_id, ts, sender, type, payload}`.
  - `makeWsClient(base, {token, cursor}) → Promise<{frames, journal(), send(obj), close(), waitFor(pred, ms=2000)}>` in helpers — collects parsed frames; `journal()` returns only journal frames; `waitFor` polls for a frame matching `pred`.

- [ ] **Step 1: Write the failing test**

`test/ws.test.js`:
```js
import test from 'node:test'
import assert from 'node:assert/strict'
import { startTestServer, makeWsClient } from './helpers.js'
import { createUser, createAgent } from '../src/auth.js'
import { upsertConversation, append } from '../src/journal.js'

test('hello replays from cursor, then streams live appends', async (t) => {
  const s = await startTestServer()
  t.after(() => s.close())
  const dan = await createUser(s.db, 'dan', 'pw')
  upsertConversation(s.db, { id: 'c1', ownerUserId: dan.id })
  for (let i = 1; i <= 3; i++) {
    append(s.db, { userId: dan.id, convoId: 'c1', sender: 'agent:a', type: 'text', payload: { body: `m${i}` } })
  }
  const login = await s.http('/login', { method: 'POST', body: { username: 'dan', password: 'pw', device_name: 'mac' } })

  const c = await makeWsClient(s.base, { token: login.json.token, cursor: 1 })
  await c.waitFor((f) => f.kind === 'journal' && f.seq === 3)
  assert.deepEqual(c.journal().map((f) => f.seq), [2, 3])

  // a live append (as if from another connection) must be fanned out
  const r = append(s.db, { userId: dan.id, convoId: 'c1', sender: 'agent:a', type: 'text', payload: { body: 'live' } })
  s.hub.broadcastJournal(dan.id, { kind: 'journal', seq: r.seq, convo_id: 'c1', ts: r.ts, sender: 'agent:a', type: 'text', payload: { body: 'live' } })
  await c.waitFor((f) => f.kind === 'journal' && f.seq === 4)
  c.close()
})

test('bad token gets error control frame', async (t) => {
  const s = await startTestServer()
  t.after(() => s.close())
  const c = await makeWsClient(s.base, { token: 'nope', cursor: 0 })
  await c.waitFor((f) => f.kind === 'control' && f.op === 'error' && f.code === 'auth')
  c.close()
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/ws.test.js`
Expected: FAIL — `makeWsClient` is not exported / `s.hub` undefined

- [ ] **Step 3: Write implementation**

`src/hub.js`:
```js
export function makeHub({ coalesceMs = 200 } = {}) {
  const byUser = new Map() // userId -> Set<conn>
  return {
    register(conn) {
      if (!byUser.has(conn.userId)) byUser.set(conn.userId, new Set())
      byUser.get(conn.userId).add(conn)
      conn._pending = new Map() // ephemeral coalescing: key -> frame
      conn._flushTimer = null
    },
    unregister(conn) {
      byUser.get(conn.userId)?.delete(conn)
      if (conn._flushTimer) clearTimeout(conn._flushTimer)
    },
    connsOf(userId) {
      return [...(byUser.get(userId) || [])]
    },
    broadcastJournal(userId, frame) {
      for (const c of byUser.get(userId) || []) {
        if (c.ws.readyState === 1) c.ws.send(JSON.stringify(frame))
      }
    },
    sendEphemeral(userId, convoId, frame) {
      for (const c of byUser.get(userId) || []) {
        if (c.viewingConvoId !== convoId || c.ws.readyState !== 1) continue
        const key = `${frame.convo_id}:${frame.message_ref}`
        c._pending.set(key, frame) // latest wins
        if (!c._flushTimer) {
          c._flushTimer = setTimeout(() => {
            c._flushTimer = null
            for (const f of c._pending.values()) {
              if (c.ws.readyState === 1) c.ws.send(JSON.stringify(f))
            }
            c._pending.clear()
          }, coalesceMs)
        }
      }
    },
  }
}
```

`src/ws.js`:
```js
import { WebSocketServer } from 'ws'
import { authToken } from './auth.js'
import { eventsAfter } from './journal.js'

const journalFrame = (e) => ({
  kind: 'journal', seq: e.seq, convo_id: e.convo_id, ts: e.ts,
  sender: e.sender, type: e.type, payload: e.payload,
})

export function attachWs({ server, db, hub, pingMs = 20000 }) {
  const wss = new WebSocketServer({ server, path: '/ws' })
  const interval = setInterval(() => {
    for (const ws of wss.clients) {
      if (ws._alive === false) { ws.terminate(); continue }
      ws._alive = false
      ws.ping()
    }
  }, pingMs)
  wss.on('close', () => clearInterval(interval))

  wss.on('connection', (ws) => {
    ws._alive = true
    ws.on('pong', () => { ws._alive = true })
    let conn = null

    ws.on('message', (data) => {
      let msg
      try { msg = JSON.parse(data) } catch { return }
      if (!conn) {
        if (msg.op !== 'hello') { ws.close(); return }
        const who = msg.token && authToken(db, msg.token)
        if (!who) {
          ws.send(JSON.stringify({ kind: 'control', op: 'error', code: 'auth' }))
          ws.close()
          return
        }
        conn = { ws, ...who, viewingConvoId: null }
        const head = db.prepare('SELECT seq FROM user_seq WHERE user_id=?').get(who.userId)
        ws.send(JSON.stringify({ kind: 'control', op: 'hello_ok', seq: head ? head.seq : 0 }))
        if (msg.cursor != null) {
          let cursor = msg.cursor
          for (;;) {
            const batch = eventsAfter(db, who.userId, cursor, 500)
            for (const e of batch) ws.send(JSON.stringify(journalFrame(e)))
            if (batch.length < 500) break
            cursor = batch[batch.length - 1].seq
          }
        }
        hub.register(conn)
        return
      }
      handleOp({ db, hub, conn, msg })
    })

    ws.on('close', () => { if (conn) hub.unregister(conn) })
  })
  return wss
}

// Extended by Tasks 7-8 with client and agent operations.
export function handleOp({ db, hub, conn, msg }) {
  if (msg.op === 'viewing') {
    conn.viewingConvoId = msg.convo_id ?? null
  }
}

export { journalFrame }
```

Modify `src/server.js` — add imports and hub/ws wiring inside `startServer` (after `server` is created, before `return`):
```js
import { makeHub } from './hub.js'
import { attachWs } from './ws.js'
```
```js
  const hub = makeHub()
  const wss = attachWs({ server, db, hub })
```
and include `hub` in the resolved object, and `wss.close()` before `server.close` in `close()`:
```js
      resolve({
        port: server.address().port,
        db,
        server,
        hub,
        close: () => new Promise((r) => { wss.close(); server.close(() => { db.close(); r() }) }),
      })
```

Append to `test/helpers.js`:
```js
import WebSocket from 'ws'

export function makeWsClient(base, { token, cursor }) {
  const ws = new WebSocket(base.replace('http', 'ws') + '/ws')
  const frames = []
  ws.on('message', (d) => frames.push(JSON.parse(d)))
  return new Promise((resolve, reject) => {
    ws.on('error', reject)
    ws.on('open', () => {
      ws.send(JSON.stringify({ op: 'hello', token, cursor }))
      resolve({
        ws,
        frames,
        journal: () => frames.filter((f) => f.kind === 'journal'),
        send: (obj) => ws.send(JSON.stringify(obj)),
        close: () => ws.close(),
        waitFor(pred, ms = 2000) {
          return new Promise((res, rej) => {
            const t0 = Date.now()
            const iv = setInterval(() => {
              const hit = frames.find(pred)
              if (hit) { clearInterval(iv); res(hit) }
              else if (Date.now() - t0 > ms) { clearInterval(iv); rej(new Error('waitFor timeout')) }
            }, 10)
          })
        },
      })
    })
  })
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test test/ws.test.js && npm test`
Expected: PASS, full suite green.

- [ ] **Step 5: Commit**

```bash
git add src/hub.js src/ws.js src/server.js test/helpers.js test/ws.test.js
git commit -m "feat: websocket resume protocol with journal fan-out"
```

---

### Task 7: Client upstream ops — send, prompt_reply, read_marker, ack

**Files:**
- Modify: `src/ws.js` (extend `handleOp`)
- Test: `test/ws.test.js` (append)

**Interfaces:**
- Consumes: Task 6's `handleOp`, `journalFrame`, hub; Task 3-4 journal functions.
- Produces `handleOp` support for (all only when `conn.kind === 'client'` except `ack`):
  - `{op:'send', convo_id, type = 'text', payload, local_id?}` → `append` with `sender: 'user:<username>'` (resolve username once at hello: `conn.username` from `SELECT name FROM users WHERE id=?`). Idem key `client:<deviceId>:<local_id>` when `local_id` present. Fan out via `broadcastJournal`.
  - `{op:'prompt_reply', convo_id, target_seq, choice?, text?}` → append type `prompt_reply`, payload `{target_seq, choice, text}`; fan out.
  - `{op:'read_marker', convo_id, up_to_seq}` → `markRead`; fan out the resulting journal event.
  - `{op:'ack', cursor}` → `UPDATE devices SET cursor=? WHERE id=?` (any kind).
  - Any append error → `{kind:'control', op:'error', code:'forbidden', ref: msg.op}` to that conn only.

- [ ] **Step 1: Write the failing test (append to `test/ws.test.js`)**

```js
test('send, prompt_reply, read_marker round-trip to a second device', async (t) => {
  const s = await startTestServer()
  t.after(() => s.close())
  const dan = await createUser(s.db, 'dan', 'pw')
  upsertConversation(s.db, { id: 'c1', ownerUserId: dan.id })
  const l1 = await s.http('/login', { method: 'POST', body: { username: 'dan', password: 'pw', device_name: 'mac' } })
  const l2 = await s.http('/login', { method: 'POST', body: { username: 'dan', password: 'pw', device_name: 'phone' } })
  const mac = await makeWsClient(s.base, { token: l1.json.token, cursor: 0 })
  const phone = await makeWsClient(s.base, { token: l2.json.token, cursor: 0 })

  mac.send({ op: 'send', convo_id: 'c1', payload: { body: 'do it' }, local_id: 'x1' })
  const f = await phone.waitFor((x) => x.kind === 'journal' && x.type === 'text')
  assert.equal(f.payload.body, 'do it')
  assert.equal(f.sender, 'user:dan')

  mac.send({ op: 'read_marker', convo_id: 'c1', up_to_seq: f.seq })
  await phone.waitFor((x) => x.kind === 'journal' && x.type === 'read_marker')

  mac.send({ op: 'ack', cursor: f.seq })
  await new Promise((r) => setTimeout(r, 50))
  assert.equal(s.db.prepare('SELECT cursor FROM devices WHERE id=?').get(l1.json.device_id).cursor, f.seq)

  // foreign convo rejected
  const pat = await createUser(s.db, 'pat', 'pw')
  upsertConversation(s.db, { id: 'cp', ownerUserId: pat.id })
  mac.send({ op: 'send', convo_id: 'cp', payload: { body: 'nope' } })
  await mac.waitFor((x) => x.kind === 'control' && x.op === 'error' && x.code === 'forbidden')
  mac.close(); phone.close()
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/ws.test.js`
Expected: FAIL — waitFor timeout (ops not handled)

- [ ] **Step 3: Extend implementation**

In `src/ws.js`, add imports:
```js
import { append, markRead } from './journal.js'
```

In the hello branch, after `conn = { ws, ...who, viewingConvoId: null }`, add:
```js
        conn.username = db.prepare('SELECT name FROM users WHERE id=?').get(who.userId).name
```

Replace `handleOp` with:
```js
export function handleOp({ db, hub, conn, msg }) {
  const fail = (code) =>
    conn.ws.send(JSON.stringify({ kind: 'control', op: 'error', code, ref: msg.op }))
  const appendAndFan = (args) => {
    const r = append(db, args)
    if (!r.duplicate) {
      hub.broadcastJournal(conn.userId, journalFrame({
        seq: r.seq, convo_id: args.convoId, ts: r.ts,
        sender: args.sender, type: args.type, payload: args.payload,
      }))
    }
    return r
  }
  try {
    switch (msg.op) {
      case 'viewing':
        conn.viewingConvoId = msg.convo_id ?? null
        break
      case 'ack':
        db.prepare('UPDATE devices SET cursor=? WHERE id=?').run(msg.cursor, conn.deviceId)
        break
      case 'send': {
        if (conn.kind !== 'client') return fail('forbidden')
        appendAndFan({
          userId: conn.userId, convoId: msg.convo_id,
          sender: `user:${conn.username}`, type: msg.type || 'text',
          payload: msg.payload,
          idemKey: msg.local_id ? `client:${conn.deviceId}:${msg.local_id}` : null,
        })
        break
      }
      case 'prompt_reply': {
        if (conn.kind !== 'client') return fail('forbidden')
        appendAndFan({
          userId: conn.userId, convoId: msg.convo_id,
          sender: `user:${conn.username}`, type: 'prompt_reply',
          payload: { target_seq: msg.target_seq, choice: msg.choice ?? null, text: msg.text ?? null },
        })
        break
      }
      case 'read_marker': {
        if (conn.kind !== 'client') return fail('forbidden')
        const r = markRead(db, conn.userId, msg.convo_id, msg.up_to_seq)
        hub.broadcastJournal(conn.userId, journalFrame({
          seq: r.seq, convo_id: msg.convo_id, ts: r.ts,
          sender: `user:${conn.userId}`, type: 'read_marker',
          payload: { convo_id: msg.convo_id, up_to_seq: msg.up_to_seq },
        }))
        break
      }
      default:
        break
    }
  } catch (e) {
    if (/not authorized/.test(e.message)) return fail('forbidden')
    throw e
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test test/ws.test.js`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/ws.js test/ws.test.js
git commit -m "feat: client ops - send, prompt_reply, read_marker, ack"
```

---

### Task 8: Agent ops — convo_upsert, publish, stream ephemerals, finalize

**Files:**
- Modify: `src/ws.js` (extend `handleOp`)
- Test: `test/agent.test.js`

**Interfaces:**
- Consumes: Tasks 6-7; `upsertConversation`, `createAgent`.
- Produces `handleOp` support for (all require `conn.kind === 'agent'`, else `error/forbidden`):
  - `{op:'convo_upsert', convo_id, title?, session_state?}` → `upsertConversation` for `conn.userId`. If `session_state` given, also `append` a `session_status` event (payload `{state}`) and fan out.
  - `{op:'publish', convo_id, type, payload, idem_key?, blob_ref?}` → append with `sender: 'agent:' + conn.name`, idemKey `agent:<deviceId>:<idem_key>` when present; fan out.
  - `{op:'stream', convo_id, message_ref, text?, replace_text?}` → NO journal write; `hub.sendEphemeral(userId, convo_id, {kind:'ephemeral', convo_id, message_ref, text, replace_text})`.
  - `{op:'finalize', convo_id, message_ref, type = 'text', payload}` → append with idemKey `agent:<deviceId>:fin:<message_ref>`; fan out. (Stream then finalize = spec §6: deltas ephemeral, final message durable.)

- [ ] **Step 1: Write the failing test**

`test/agent.test.js`:
```js
import test from 'node:test'
import assert from 'node:assert/strict'
import { startTestServer, makeWsClient } from './helpers.js'
import { createUser, createAgent } from '../src/auth.js'

test('agent publishes, streams ephemerally, finalizes durably', async (t) => {
  const s = await startTestServer()
  t.after(() => s.close())
  const dan = await createUser(s.db, 'dan', 'pw')
  const ag = createAgent(s.db, dan.id, 'dev-2')
  const login = await s.http('/login', { method: 'POST', body: { username: 'dan', password: 'pw', device_name: 'mac' } })

  const agent = await makeWsClient(s.base, { token: ag.token, cursor: null })
  const client = await makeWsClient(s.base, { token: login.json.token, cursor: 0 })
  await agent.waitFor((f) => f.op === 'hello_ok')
  await client.waitFor((f) => f.op === 'hello_ok')

  agent.send({ op: 'convo_upsert', convo_id: 'sess-1', title: 'fix bug', session_state: 'running' })
  await client.waitFor((f) => f.kind === 'journal' && f.type === 'session_status')

  client.send({ op: 'viewing', convo_id: 'sess-1' })
  await new Promise((r) => setTimeout(r, 50))

  // 20 rapid stream deltas coalesce to few ephemeral frames, none durable
  for (let i = 0; i < 20; i++) {
    agent.send({ op: 'stream', convo_id: 'sess-1', message_ref: 'm1', replace_text: `progress ${i}` })
  }
  await client.waitFor((f) => f.kind === 'ephemeral' && f.replace_text === 'progress 19', 3000)
  const ephemerals = client.frames.filter((f) => f.kind === 'ephemeral')
  assert.ok(ephemerals.length <= 5, `expected coalescing, got ${ephemerals.length}`)
  assert.equal(s.db.prepare("SELECT COUNT(*) n FROM events WHERE type='text'").get().n, 0)

  agent.send({ op: 'finalize', convo_id: 'sess-1', message_ref: 'm1', payload: { body: 'done: 3 files changed' } })
  const fin = await client.waitFor((f) => f.kind === 'journal' && f.type === 'text')
  assert.equal(fin.payload.body, 'done: 3 files changed')
  assert.equal(fin.sender, 'agent:dev-2')

  // finalize retry is idempotent
  agent.send({ op: 'finalize', convo_id: 'sess-1', message_ref: 'm1', payload: { body: 'done: 3 files changed' } })
  await new Promise((r) => setTimeout(r, 100))
  assert.equal(s.db.prepare("SELECT COUNT(*) n FROM events WHERE type='text'").get().n, 1)

  // clients may not use agent ops
  client.send({ op: 'publish', convo_id: 'sess-1', type: 'text', payload: { body: 'x' } })
  await client.waitFor((f) => f.kind === 'control' && f.op === 'error' && f.code === 'forbidden')
  agent.close(); client.close()
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/agent.test.js`
Expected: FAIL — waitFor timeout on `session_status`

- [ ] **Step 3: Extend implementation**

In `src/ws.js`, add import:
```js
import { upsertConversation } from './journal.js'
```

Add cases to the `switch` in `handleOp` (before `default`):
```js
      case 'convo_upsert': {
        if (conn.kind !== 'agent') return fail('forbidden')
        upsertConversation(db, {
          id: msg.convo_id, ownerUserId: conn.userId,
          title: msg.title, sessionState: msg.session_state,
        })
        if (msg.session_state) {
          appendAndFan({
            userId: conn.userId, convoId: msg.convo_id,
            sender: `agent:${conn.name}`, type: 'session_status',
            payload: { state: msg.session_state },
          })
        }
        break
      }
      case 'publish': {
        if (conn.kind !== 'agent') return fail('forbidden')
        appendAndFan({
          userId: conn.userId, convoId: msg.convo_id,
          sender: `agent:${conn.name}`, type: msg.type, payload: msg.payload,
          blobRef: msg.blob_ref ?? null,
          idemKey: msg.idem_key ? `agent:${conn.deviceId}:${msg.idem_key}` : null,
        })
        break
      }
      case 'stream': {
        if (conn.kind !== 'agent') return fail('forbidden')
        hub.sendEphemeral(conn.userId, msg.convo_id, {
          kind: 'ephemeral', convo_id: msg.convo_id, message_ref: msg.message_ref,
          text: msg.text, replace_text: msg.replace_text,
        })
        break
      }
      case 'finalize': {
        if (conn.kind !== 'agent') return fail('forbidden')
        appendAndFan({
          userId: conn.userId, convoId: msg.convo_id,
          sender: `agent:${conn.name}`, type: msg.type || 'text', payload: msg.payload,
          idemKey: `agent:${conn.deviceId}:fin:${msg.message_ref}`,
        })
        break
      }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test test/agent.test.js && npm test`
Expected: PASS, full suite green.

- [ ] **Step 5: Commit**

```bash
git add src/ws.js test/agent.test.js
git commit -m "feat: agent ops - publish, ephemeral streaming with coalescing, finalize"
```

---

### Task 9: Admin CLI

**Files:**
- Create: `bin/matron-admin.js`
- Test: `test/admin.test.js`

**Interfaces:**
- Consumes: Tasks 1-2 (`openDb`, `createUser`, `setPassword`, `createAgent`).
- Produces: `runAdmin(db, argv) → Promise<string>` (exported for tests) and a CLI entry reading `MATRON_DB`:
  - `matron-admin user add <name> --password <pw>` → "user <name> created (id N)"
  - `matron-admin user passwd <name> --password <pw>` → "password updated for <name>"
  - `matron-admin agent add <username> <agent-name>` → prints the agent token ONCE: "agent <agent-name> token: <hex>"
  - `matron-admin status` → one line per user: `<name> devices=<n> agents=<n> head_seq=<n>`, plus totals.

- [ ] **Step 1: Write the failing test**

`test/admin.test.js`:
```js
import test from 'node:test'
import assert from 'node:assert/strict'
import { openDb } from '../src/db.js'
import { authToken } from '../src/auth.js'
import { runAdmin } from '../bin/matron-admin.js'

test('admin CLI: user add, agent add, status', async () => {
  const db = openDb(':memory:')
  const out1 = await runAdmin(db, ['user', 'add', 'dan', '--password', 'pw123'])
  assert.match(out1, /user dan created/)
  await assert.rejects(runAdmin(db, ['user', 'add', 'dan', '--password', 'pw123']), /UNIQUE/)

  const out2 = await runAdmin(db, ['agent', 'add', 'dan', 'dev-2'])
  const token = out2.match(/token: ([0-9a-f]{64})/)[1]
  assert.equal(authToken(db, token).kind, 'agent')

  const out3 = await runAdmin(db, ['user', 'passwd', 'dan', '--password', 'newpw'])
  assert.match(out3, /password updated/)

  const status = await runAdmin(db, ['status'])
  assert.match(status, /dan devices=0 agents=1 head_seq=0/)

  await assert.rejects(runAdmin(db, ['bogus']), /usage/i)
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/admin.test.js`
Expected: FAIL — `Cannot find module '../bin/matron-admin.js'`

- [ ] **Step 3: Write implementation**

`bin/matron-admin.js`:
```js
#!/usr/bin/env node
import { openDb } from '../src/db.js'
import { createUser, setPassword, createAgent } from '../src/auth.js'

const USAGE = `usage:
  matron-admin user add <name> --password <pw>
  matron-admin user passwd <name> --password <pw>
  matron-admin agent add <username> <agent-name>
  matron-admin status`

function flag(argv, name) {
  const i = argv.indexOf(name)
  return i >= 0 ? argv[i + 1] : null
}

export async function runAdmin(db, argv) {
  const [a, b] = argv
  if (a === 'user' && b === 'add') {
    const name = argv[2]
    const pw = flag(argv, '--password')
    if (!name || !pw) throw new Error(USAGE)
    const u = await createUser(db, name, pw)
    return `user ${name} created (id ${u.id})`
  }
  if (a === 'user' && b === 'passwd') {
    const name = argv[2]
    const pw = flag(argv, '--password')
    if (!name || !pw) throw new Error(USAGE)
    await setPassword(db, name, pw)
    return `password updated for ${name}`
  }
  if (a === 'agent' && b === 'add') {
    const [, , username, agentName] = argv
    if (!username || !agentName) throw new Error(USAGE)
    const user = db.prepare('SELECT id FROM users WHERE name=?').get(username)
    if (!user) throw new Error(`no such user: ${username}`)
    const { token } = createAgent(db, user.id, agentName)
    return `agent ${agentName} token: ${token}\n(store in the bridge credentials file; it is not shown again)`
  }
  if (a === 'status') {
    const rows = db.prepare(
      `SELECT u.name,
         (SELECT COUNT(*) FROM devices d WHERE d.user_id=u.id AND d.kind='client') AS devices,
         (SELECT COUNT(*) FROM devices d WHERE d.user_id=u.id AND d.kind='agent') AS agents,
         COALESCE((SELECT seq FROM user_seq s WHERE s.user_id=u.id), 0) AS head_seq
       FROM users u ORDER BY u.name`
    ).all()
    const total = db.prepare('SELECT COUNT(*) n FROM events').get().n
    return rows.map((r) => `${r.name} devices=${r.devices} agents=${r.agents} head_seq=${r.head_seq}`)
      .concat(`total events: ${total}`).join('\n')
  }
  throw new Error(USAGE)
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const db = openDb(process.env.MATRON_DB || './matron.db')
  runAdmin(db, process.argv.slice(2))
    .then((out) => { console.log(out); db.close() })
    .catch((e) => { console.error(e.message); db.close(); process.exit(1) })
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test test/admin.test.js`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add bin/matron-admin.js test/admin.test.js
git commit -m "feat: matron-admin cli"
```

---

### Task 10: Chaos resume property test

**Files:**
- Test: `test/chaos.test.js` (uses a real on-disk temp DB — WAL + reconnects need it)

**Interfaces:**
- Consumes: everything. This is the headline spec §12 test: connections killed at random points must always converge.

- [ ] **Step 1: Write the test**

`test/chaos.test.js`:
```js
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { startTestServer, makeWsClient } from './helpers.js'
import { createUser, createAgent } from '../src/auth.js'

// deterministic PRNG (mulberry32) so failures reproduce
function rng(seed) {
  return () => {
    seed |= 0; seed = (seed + 0x6D2B79F5) | 0
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

test('client store converges despite random disconnects', { timeout: 60000 }, async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'matron-chaos-'))
  const s = await startTestServer({ dbPath: path.join(dir, 'chaos.db') })
  t.after(() => { s.close(); fs.rmSync(dir, { recursive: true, force: true }) })

  const dan = await createUser(s.db, 'dan', 'pw')
  const ag = createAgent(s.db, dan.id, 'chaos-agent')
  const login = await s.http('/login', { method: 'POST', body: { username: 'dan', password: 'pw', device_name: 'chaos' } })
  const rand = rng(1337)
  const TOTAL = 300
  const CONVOS = ['s1', 's2', 's3']

  // agent: steady publish stream
  const agent = await makeWsClient(s.base, { token: ag.token, cursor: null })
  await agent.waitFor((f) => f.op === 'hello_ok')
  for (const c of CONVOS) agent.send({ op: 'convo_upsert', convo_id: c, title: c })
  const publishAll = (async () => {
    for (let i = 0; i < TOTAL; i++) {
      agent.send({
        op: 'publish', convo_id: CONVOS[i % 3], type: 'text',
        payload: { body: `msg-${i}` }, idem_key: `k${i}`,
      })
      if (rand() < 0.3) await new Promise((r) => setTimeout(r, 5))
    }
  })()

  // client: apply frames to a local store, killing the socket randomly
  const store = new Map() // seq -> frame
  let cursor = 0
  // journal will hold exactly TOTAL events: convo_upsert without session_state appends nothing
  while (store.size < TOTAL) {
    const c = await makeWsClient(s.base, { token: login.json.token, cursor })
    const killAfter = 1 + Math.floor(rand() * 40)
    try {
      await c.waitFor((f) => {
        for (const fr of c.journal()) {
          if (!store.has(fr.seq)) store.set(fr.seq, fr)
          if (fr.seq > cursor) cursor = fr.seq
        }
        return c.journal().length >= killAfter || store.size >= TOTAL
      }, 5000)
    } catch { /* quiet period - reconnect */ }
    c.ws.terminate() // simulate abrupt network death, not clean close
  }
  await publishAll

  // convergence: local store must be an exact copy of the journal
  const rows = s.db.prepare('SELECT seq, type, payload FROM events WHERE user_id=? ORDER BY seq').all(dan.id)
  assert.equal(store.size, rows.length)
  for (const r of rows) {
    const local = store.get(r.seq)
    assert.ok(local, `missing seq ${r.seq}`)
    assert.equal(local.type, r.type)
    assert.deepEqual(local.payload, JSON.parse(r.payload))
  }
  // no duplicates, no gaps
  const seqs = [...store.keys()].sort((a, b) => a - b)
  seqs.forEach((v, i) => assert.equal(v, i + 1))
  agent.close()
})
```

Note: `startTestServer` must accept an options override — modify `test/helpers.js` signature to `startTestServer(opts = {})` and pass through: `startServer({ dbPath: ':memory:', port: 0, ...opts })`.

- [ ] **Step 2: Run the test**

Run: `node --test test/chaos.test.js`
Expected: PASS in well under the 60 s timeout. If it fails, this is a REAL protocol bug — debug it (systematic-debugging skill), do not weaken the assertions.

- [ ] **Step 3: Run the whole suite, commit**

Run: `npm test`
Expected: all green.

```bash
git add test/chaos.test.js test/helpers.js
git commit -m "test: chaos resume property test - convergence under random disconnects"
```

---

### Task 11: Ops — README, systemd unit, deploy notes

**Files:**
- Create: `README.md`, `deploy/matron-journal.service`

**Interfaces:**
- Consumes: everything; documents env vars from Global Constraints.

- [ ] **Step 1: Write the files**

`README.md`:
```markdown
# matron-journal

Journal server for the Matron chat system: a thin, server-authoritative
replacement for the Matrix stack used by the Claude bridge.
Spec: docs/superpowers/specs/2026-07-10-matron-protocol-design.md

## Run

    npm install
    MATRON_DB=./matron.db MATRON_PORT=9810 npm start

## Admin

    MATRON_DB=./matron.db npx matron-admin user add dan --password '...'
    MATRON_DB=./matron.db npx matron-admin agent add dan dev-2
    MATRON_DB=./matron.db npx matron-admin status

## Protocol (v1 core)

- `POST /login {username, password, device_name}` -> `{token, device_id, user_id}`
- `GET /snapshot` (Bearer) -> `{conversations, seq}`
- `GET /convo/:id/messages?before_seq&limit` (Bearer) -> `{events}`
- `WS /ws`: first frame `{op:'hello', token, cursor}` (cursor null = live-only).
  Server: `hello_ok {seq}`, then journal frames `> cursor`, then live.
  Client ops: send, prompt_reply, read_marker, ack, viewing.
  Agent ops: convo_upsert, publish, stream (ephemeral), finalize.

## Test

    npm test

Deferred to v1 completion: media, APNs push, retention offload, /metrics,
conformance fixtures (see the spec, §15 and plan docs).
```

`deploy/matron-journal.service`:
```ini
[Unit]
Description=Matron journal server
After=network.target

[Service]
Type=simple
User=matron
WorkingDirectory=/home/youruser/matron-journal
Environment=MATRON_DB=/home/youruser/matron-journal/data/matron.db
Environment=MATRON_PORT=9810
Environment=MATRON_BIND=127.0.0.1
ExecStart=/usr/bin/node src/server.js
Restart=always
RestartSec=2

[Install]
WantedBy=multi-user.target
```

- [ ] **Step 2: Smoke-test the real entrypoint**

Run:
```bash
mkdir -p data && MATRON_DB=./data/smoke.db MATRON_PORT=9810 node src/server.js &
sleep 1
curl -s -X POST http://127.0.0.1:9810/login -d '{"username":"x","password":"y"}' -H 'content-type: application/json'
kill %1 && rm -rf data
```
Expected: `{"error":"bad_credentials"}` (server boots, routes work).

- [ ] **Step 3: Commit**

```bash
git add README.md deploy/matron-journal.service
git commit -m "docs: readme, systemd unit"
```

---

## Self-Review Notes

- **Spec coverage (v1-core scope):** §5 schema → T1; §8 auth/rate-limit/revocation → T2/T5; §5-§6 journal/seq/summaries → T3; snapshot/pagination/replay/read-markers → T4; HTTP surface (minus media) → T5; §6 WS resume + fan-out + ping → T6; client ops → T7; agent ops + ephemeral coalescing + idempotency → T8; admin CLI → T9; §12 chaos test → T10; deploy → T11. Deferred (follow-up plan, matching spec §15 + §14): media, APNs, retention offload, /metrics, conformance fixtures, `snapshot_required` valve (harmless to defer: v1 replays any gap; the valve is an optimization — add with retention).
- **Type consistency check done:** journal-frame shape fixed in T6 and reused verbatim in T7/T8; `authorize` name consistent T2→T4→T5; `startTestServer(opts)` override noted in T10.
- **Known simplification:** unread recompute in `markRead` counts all message-class events (including the user's own sends) — acceptable for v1; bridge traffic is overwhelmingly agent-side.
