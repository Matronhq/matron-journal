import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Database from 'better-sqlite3'
import { openDb, setApnsRegistration, clientDevicesForPush, listDevices, parsePushPrefs, setPushPrefs } from '../src/db.js'
import { createUser } from '../src/auth.js'

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

test('openDb migrates a pre-apns_env devices table in place (live-DB upgrade path)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'matron-migration-'))
  const dbPath = path.join(dir, 'pre-migration.db')

  const raw = new Database(dbPath)
  raw.exec(`
    CREATE TABLE devices(
      id INTEGER PRIMARY KEY,
      user_id INTEGER NOT NULL,
      kind TEXT NOT NULL,
      name TEXT NOT NULL,
      token_hash TEXT NOT NULL UNIQUE,
      cursor INTEGER NOT NULL DEFAULT 0,
      apns_token TEXT,
      created_at INTEGER NOT NULL,
      last_seen_at INTEGER
    );
  `)
  raw.prepare(
    "INSERT INTO devices(id, user_id, kind, name, token_hash, apns_token, created_at) VALUES(1,1,'client','phone','hash','pre-existing-token',0)"
  ).run()
  raw.close()

  const db = openDb(dbPath)
  const cols = db.prepare('PRAGMA table_info(devices)').all().map((c) => c.name)
  assert.ok(cols.includes('apns_env'), 'apns_env column missing after migration')
  // Pre-existing row survives untouched, with apns_env now NULL rather than
  // the row being wiped or rebuilt.
  const row = db.prepare('SELECT apns_token, apns_env FROM devices WHERE id=1').get()
  assert.equal(row.apns_token, 'pre-existing-token')
  assert.equal(row.apns_env, null)
  db.close()

  // Re-opening again (schema already migrated) must be a no-op, not an error.
  assert.doesNotThrow(() => openDb(dbPath).close())
})

test('openDb adds parent_convo_id (+ its index) to a pre-existing conversations table in place', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'matron-parent-migration-'))
  const dbPath = path.join(dir, 'pre-migration.db')

  const raw = new Database(dbPath)
  raw.exec(`
    CREATE TABLE conversations(
      id TEXT PRIMARY KEY,
      owner_user_id INTEGER NOT NULL,
      title TEXT NOT NULL DEFAULT '',
      session_state TEXT NOT NULL DEFAULT 'running',
      last_seq INTEGER NOT NULL DEFAULT 0,
      unread_count INTEGER NOT NULL DEFAULT 0,
      snippet TEXT NOT NULL DEFAULT '',
      created_at INTEGER NOT NULL
    );
  `)
  raw.prepare(
    "INSERT INTO conversations(id, owner_user_id, title, created_at) VALUES('c1',1,'legacy',0)"
  ).run()
  raw.close()

  const db = openDb(dbPath)
  const cols = db.prepare('PRAGMA table_info(conversations)').all().map((c) => c.name)
  assert.ok(cols.includes('parent_convo_id'), 'parent_convo_id column missing after migration')
  const indexes = db.prepare('PRAGMA index_list(conversations)').all().map((i) => i.name)
  assert.ok(indexes.includes('idx_conversations_parent'), 'parent index missing after migration')
  // Pre-existing row survives untouched, with parent_convo_id now NULL.
  const row = db.prepare("SELECT title, parent_convo_id FROM conversations WHERE id='c1'").get()
  assert.equal(row.title, 'legacy')
  assert.equal(row.parent_convo_id, null)
  db.close()

  // Re-opening (already migrated) is a no-op, not an error.
  assert.doesNotThrow(() => openDb(dbPath).close())
  fs.rmSync(dir, { recursive: true, force: true })
})

test('openDb adds session_outcome to a pre-existing conversations table in place', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'matron-outcome-migration-'))
  const dbPath = path.join(dir, 'pre-migration.db')

  const raw = new Database(dbPath)
  raw.exec(`
    CREATE TABLE conversations(
      id TEXT PRIMARY KEY,
      owner_user_id INTEGER NOT NULL,
      title TEXT NOT NULL DEFAULT '',
      session_state TEXT NOT NULL DEFAULT 'running',
      last_seq INTEGER NOT NULL DEFAULT 0,
      unread_count INTEGER NOT NULL DEFAULT 0,
      snippet TEXT NOT NULL DEFAULT '',
      created_at INTEGER NOT NULL
    );
  `)
  raw.prepare(
    "INSERT INTO conversations(id, owner_user_id, title, created_at) VALUES('c1',1,'legacy',0)"
  ).run()
  raw.close()

  const db = openDb(dbPath)
  const cols = db.prepare('PRAGMA table_info(conversations)').all().map((c) => c.name)
  assert.ok(cols.includes('session_outcome'), 'session_outcome column missing after migration')
  // Pre-existing row survives untouched, with session_outcome now NULL —
  // which is exactly what "this conversation has no outcome" means.
  const row = db.prepare("SELECT title, session_outcome FROM conversations WHERE id='c1'").get()
  assert.equal(row.title, 'legacy')
  assert.equal(row.session_outcome, null)
  // No CHECK constraint: the outcome vocabulary belongs to the writing bridge,
  // so a value this server has never heard of must still be storable.
  db.prepare("UPDATE conversations SET session_outcome='some-future-outcome' WHERE id='c1'").run()
  assert.equal(
    db.prepare("SELECT session_outcome FROM conversations WHERE id='c1'").get().session_outcome,
    'some-future-outcome'
  )
  db.close()

  // Re-opening (already migrated) is a no-op, not an error.
  assert.doesNotThrow(() => openDb(dbPath).close())
  fs.rmSync(dir, { recursive: true, force: true })
})

// WAL mitigation, openDb half (docs/wal-checkpoint-profile.md): the WAL file
// truncates back to <=4MiB on reset for every opener, but the inline
// auto-checkpoint must stay at SQLite's stock default here — only the server
// (which runs the PASSIVE-checkpoint timer) may disable it, otherwise a
// standalone opener like the admin CLI would grow the WAL unbounded during
// long one-shot runs. Asserted on a file-backed DB because :memory:
// databases silently ignore WAL mode.
test('openDb bounds the WAL file but keeps the stock auto-checkpoint', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'matron-walpragma-'))
  const db = openDb(path.join(dir, 'm.db'))
  try {
    assert.equal(db.pragma('journal_mode', { simple: true }), 'wal')
    assert.equal(db.pragma('wal_autocheckpoint', { simple: true }), 1000)
    assert.equal(db.pragma('journal_size_limit', { simple: true }), 4194304)
  } finally {
    db.close()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('push_prefs: NULL and garbage parse as all-on; setPushPrefs merges partial updates', async () => {
  const db = openDb(':memory:')
  const dan = await createUser(db, 'dan', 'pw')
  const dev = db.prepare("INSERT INTO devices(user_id, kind, name, token_hash, created_at) VALUES(?,'client','phone','h1',?)")
    .run(dan.id, Date.now())
  const deviceId = dev.lastInsertRowid

  // Column exists (migration ran) and NULL = defaults: attention/done on,
  // activity off.
  assert.deepEqual(parsePushPrefs(null), { attention: true, done: true, activity: false })
  // Garbage stored by a buggy/older writer must fail open to the defaults, not throw.
  assert.deepEqual(parsePushPrefs('not json'), { attention: true, done: true, activity: false })
  assert.deepEqual(parsePushPrefs('[1,2]'), { attention: true, done: true, activity: false })
  // A garbage value for one key falls back to that key's default alone —
  // the rest of a well-formed blob is still honored.
  assert.deepEqual(parsePushPrefs('{"attention":"nope","done":false}'), { attention: true, done: false, activity: false })

  // Explicit true/false are both honored, including turning the
  // default-off activity key back on.
  const merged1 = setPushPrefs(db, deviceId, { activity: true })
  assert.deepEqual(merged1, { attention: true, done: true, activity: true })
  const merged2 = setPushPrefs(db, deviceId, { done: false })
  assert.deepEqual(merged2, { attention: true, done: false, activity: true })

  // The stored row round-trips through parsePushPrefs — an explicit `true`
  // for a default-off key survives the round-trip, not just `false`.
  const row = db.prepare('SELECT push_prefs FROM devices WHERE id=?').get(deviceId)
  assert.deepEqual(parsePushPrefs(row.push_prefs), { attention: true, done: false, activity: true })
})

test('clientDevicesForPush and listDevices expose push_prefs', async () => {
  const db = openDb(':memory:')
  const dan = await createUser(db, 'dan', 'pw')
  const dev = db.prepare("INSERT INTO devices(user_id, kind, name, token_hash, created_at) VALUES(?,'client','phone','h2',?)")
    .run(dan.id, Date.now())
  const deviceId = dev.lastInsertRowid
  setApnsRegistration(db, deviceId, { apnsToken: 'tok', apnsEnv: 'prod' })
  setPushPrefs(db, deviceId, { attention: false })

  const pushRows = clientDevicesForPush(db, dan.id)
  assert.equal(pushRows.length, 1)
  assert.deepEqual(parsePushPrefs(pushRows[0].push_prefs), { attention: false, done: true, activity: false })

  const roster = listDevices(db, dan.id)
  assert.deepEqual(roster[0].push_prefs, { attention: false, done: true, activity: false })
})

test('convo_agents accepts the consent states and columns', () => {
  const db = openDb(':memory:')
  db.prepare(`INSERT INTO convo_agents(convo_id, agent_device_id, initiator_device_id, state, justification, topic, created_at, delivered_at)
             VALUES('r', 2, 1, 'awaiting_user', 'j', 't', 5, NULL)`).run()
  db.prepare("UPDATE convo_agents SET state='denied' WHERE convo_id='r'").run()
  assert.equal(db.prepare("SELECT state FROM convo_agents WHERE convo_id='r'").get().state, 'denied')
  assert.throws(() => db.prepare("UPDATE convo_agents SET state='bogus' WHERE convo_id='r'").run())
})

test('old-schema convo_agents is rebuilt in place, rows preserved, delivered_at backfilled', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'matron-convo-agents-migration-'))
  const dbPath = path.join(dir, 'pre-migration.db')

  const raw = new Database(dbPath)
  raw.exec(`CREATE TABLE convo_agents(
    convo_id TEXT NOT NULL, agent_device_id INTEGER NOT NULL, initiator_device_id INTEGER NOT NULL,
    state TEXT NOT NULL CHECK(state IN ('invited','joined','refused','left','expired')),
    justification TEXT NOT NULL DEFAULT '', created_at INTEGER NOT NULL, answered_at INTEGER,
    PRIMARY KEY(convo_id, agent_device_id));
    INSERT INTO convo_agents VALUES('r', 2, 1, 'joined', 'why', 111, 222);`)
  raw.close()

  const db = openDb(dbPath)
  const row = db.prepare("SELECT * FROM convo_agents WHERE convo_id='r'").get()
  assert.equal(row.state, 'joined')
  assert.equal(row.justification, 'why')
  assert.equal(row.topic, '')
  assert.equal(row.delivered_at, 111)
  db.close()

  assert.doesNotThrow(() => openDb(dbPath).close())
  fs.rmSync(dir, { recursive: true, force: true })
})

test('openDb: agent_chat_allowances is gone from a fresh database', () => {
  const db = openDb(':memory:')
  const t = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='agent_chat_allowances'").get()
  assert.equal(t, undefined)
})

test('openDb: an existing agent_chat_allowances table is dropped on migrate', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'matron-allow-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const dbPath = path.join(dir, 'm.db')
  const raw = new Database(dbPath)
  raw.exec(`CREATE TABLE agent_chat_allowances(
    user_id INTEGER NOT NULL, from_device_id INTEGER NOT NULL,
    target_device_id INTEGER NOT NULL, created_at INTEGER NOT NULL,
    PRIMARY KEY(user_id, from_device_id, target_device_id))`)
  raw.prepare('INSERT INTO agent_chat_allowances VALUES(1,2,3,0)').run()
  raw.close()

  const db = openDb(dbPath)
  const found = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='agent_chat_allowances'").get()
  assert.equal(found, undefined, 'the migration must drop the table, standing consent and all')
})

test('search schema: tables, insert trigger, and NOTHING else', () => {
  const db = openDb(':memory:')
  // content table + fts + backfill state all exist
  db.prepare("INSERT INTO search_messages(user_id, convo_id, seq, ts, sender, body) VALUES(1,'c1',1,1,'user:dan','hello sqlite search')").run()
  const hit = db.prepare("SELECT rowid FROM search_fts WHERE search_fts MATCH 'sqlite'").get()
  assert.ok(hit, 'insert trigger populates the FTS index')
  assert.equal(db.prepare('SELECT COUNT(*) n FROM search_backfill_state').get().n, 0)
  // The append-only invariant, pinned: exactly ONE trigger (after-insert) on
  // search_messages — a future update/delete trigger means someone added a
  // mutation path to events and must revisit the whole design.
  const triggers = db.prepare(
    "SELECT name FROM sqlite_master WHERE type='trigger' AND tbl_name='search_messages'"
  ).all()
  assert.deepEqual(triggers.map((t) => t.name), ['search_messages_ai'])
  db.close()
})

test('search schema: UNIQUE(user_id, seq) makes re-inserts with OR IGNORE no-ops', () => {
  const db = openDb(':memory:')
  const ins = db.prepare("INSERT OR IGNORE INTO search_messages(user_id, convo_id, seq, ts, sender, body) VALUES(1,'c1',1,1,'user:dan','hello')")
  assert.equal(ins.run().changes, 1)
  assert.equal(ins.run().changes, 0)
  assert.equal(db.prepare("SELECT COUNT(*) n FROM search_fts WHERE search_fts MATCH 'hello'").get().n, 1)
  db.close()
})

// An APNs token identifies a physical app install, so at most ONE device row
// may hold it. The bug this pins: every re-pair of the Mac app created a fresh
// device row and left the old rows holding the same live token, so one push
// fanned out to 18 rows — 18 sends to one device, 17 of them 429 rate_limited
// by APNs.
test('registering an APNs token clears it from every other device row', async () => {
  const db = openDb(':memory:')
  const dan = await createUser(db, 'dan', 'pw')
  const mk = (hash) => db.prepare(
    "INSERT INTO devices(user_id, kind, name, token_hash, created_at) VALUES(?,'client','mac',?,0)"
  ).run(dan.id, hash).lastInsertRowid

  const old = mk('h-old')
  const fresh = mk('h-fresh')
  setApnsRegistration(db, old, { apnsToken: 'mac-token', apnsEnv: 'sandbox' })
  setApnsRegistration(db, fresh, { apnsToken: 'mac-token', apnsEnv: 'sandbox' })

  const rows = clientDevicesForPush(db, dan.id)
  assert.deepEqual(rows.map((r) => r.id), [fresh], 'only the newest registration keeps the token')
  const stale = db.prepare('SELECT apns_token, apns_env FROM devices WHERE id=?').get(old)
  assert.equal(stale.apns_token, null)
  assert.equal(stale.apns_env, null, 'token and env are always cleared as a pair')
  db.close()
})

// Cross-user, because a re-paired device that now belongs to someone else must
// stop receiving the previous owner's notifications — the same exclusivity
// rule, with a privacy consequence rather than a rate-limit one.
test('registering an APNs token claims it from another user_id device row', async () => {
  const db = openDb(':memory:')
  const dan = await createUser(db, 'dan', 'pw')
  const sam = await createUser(db, 'sam', 'pw')
  const danMac = db.prepare("INSERT INTO devices(user_id, kind, name, token_hash, created_at) VALUES(?,'client','mac','h-dan',0)").run(dan.id).lastInsertRowid
  const samMac = db.prepare("INSERT INTO devices(user_id, kind, name, token_hash, created_at) VALUES(?,'client','mac','h-sam',0)").run(sam.id).lastInsertRowid

  setApnsRegistration(db, danMac, { apnsToken: 'shared-hardware', apnsEnv: 'prod' })
  setApnsRegistration(db, samMac, { apnsToken: 'shared-hardware', apnsEnv: 'prod' })

  assert.equal(clientDevicesForPush(db, dan.id).length, 0, 'the previous owner keeps no claim on the token')
  assert.deepEqual(clientDevicesForPush(db, sam.id).map((r) => r.id), [samMac])
  db.close()
})

// Unregistering must not scavenge: `apnsToken: null` clears only the caller's
// own row, and can never null out a token some other row legitimately holds.
test('unregistering clears only the calling device row', async () => {
  const db = openDb(':memory:')
  const dan = await createUser(db, 'dan', 'pw')
  const phone = db.prepare("INSERT INTO devices(user_id, kind, name, token_hash, created_at) VALUES(?,'client','phone','h-p',0)").run(dan.id).lastInsertRowid
  const mac = db.prepare("INSERT INTO devices(user_id, kind, name, token_hash, created_at) VALUES(?,'client','mac','h-m',0)").run(dan.id).lastInsertRowid
  setApnsRegistration(db, phone, { apnsToken: 'phone-token', apnsEnv: 'prod' })
  setApnsRegistration(db, mac, { apnsToken: 'mac-token', apnsEnv: 'prod' })

  setApnsRegistration(db, mac, { apnsToken: null, apnsEnv: null })

  assert.deepEqual(clientDevicesForPush(db, dan.id).map((r) => r.id), [phone])
  db.close()
})

// The live dev-2 DB already carries 18 rows sharing one token; the fix above
// only stops NEW duplicates, so openDb collapses the existing ones on start.
test('openDb collapses duplicate APNs tokens, keeping the newest device row', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'matron-apns-dedupe-'))
  const dbPath = path.join(dir, 'dupes.db')

  // Seeded through a raw handle, because openDb is exactly what refuses to
  // hold duplicates: the pre-fix schema had no unique index to violate.
  const raw = new Database(dbPath)
  raw.exec(`
    CREATE TABLE devices(
      id INTEGER PRIMARY KEY,
      user_id INTEGER NOT NULL,
      kind TEXT NOT NULL,
      name TEXT NOT NULL,
      token_hash TEXT NOT NULL UNIQUE,
      cursor INTEGER NOT NULL DEFAULT 0,
      apns_token TEXT,
      created_at INTEGER NOT NULL,
      last_seen_at INTEGER
    );
  `)
  const ins = raw.prepare(
    "INSERT INTO devices(id, user_id, kind, name, token_hash, apns_token, created_at) VALUES(?,1,'client','mac',?,?,0)"
  )
  for (const [id, hash] of [[1, 'h1'], [2, 'h2'], [3, 'h3']]) ins.run(id, hash, 'mac-token')
  // A different token on a fourth row is untouched by the collapse.
  ins.run(4, 'h4', 'phone-token')
  raw.close()

  const db = openDb(dbPath)
  assert.deepEqual(
    db.prepare('SELECT id FROM devices WHERE apns_token IS NOT NULL ORDER BY id').all().map((r) => r.id),
    [3, 4]
  )
  assert.equal(db.prepare('SELECT apns_env FROM devices WHERE id=1').get().apns_env, null)
  db.close()
  fs.rmSync(dir, { recursive: true, force: true })
})
