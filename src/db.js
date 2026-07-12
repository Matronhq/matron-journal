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
  ON events(user_id, convo_id, idem_key) WHERE idem_key IS NOT NULL;
CREATE TABLE IF NOT EXISTS user_seq(
  user_id INTEGER PRIMARY KEY,
  seq INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS blobs(
  id TEXT PRIMARY KEY,
  owner_user_id INTEGER NOT NULL REFERENCES users(id),
  content_type TEXT NOT NULL,
  size INTEGER NOT NULL,
  sha256 TEXT NOT NULL,
  disk_path TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
`

export function openDb(path) {
  const db = new Database(path)
  db.pragma('journal_mode = WAL')
  db.pragma('foreign_keys = ON')
  // WAL-checkpoint tail mitigation — measured, not guessed; full method and
  // numbers in docs/wal-checkpoint-profile.md. With synchronous=NORMAL the
  // auto-checkpoint is the only steady-state fsync, and it runs INLINE in
  // whichever append COMMIT crosses the 1000-page mark: 65/65 profiled
  // event-loop blockages >=20ms carried that fingerprint, worst 1.22s under
  // real disk contention (GC max was 6.2ms — exonerated). Disabling the
  // auto-checkpoint and running PRAGMA wal_checkpoint(PASSIVE) on a 1s timer
  // (scheduleWalCheckpoint in server.js) moves the fsync out of append
  // COMMITs: matched-window A/B runs improved append p99 9.7->3.1ms and max
  // 75->51ms (quiet box) and 1221.7->26.8ms (contended round), zero >100ms
  // stall events in every mitigated run. journal_size_limit keeps the WAL
  // file truncated to <=4MiB on reset instead of holding its high-water size
  // forever (measured bound under sustained load: ~4.8MiB).
  db.pragma('wal_autocheckpoint = 0')
  db.pragma('journal_size_limit = 4194304')
  db.exec(SCHEMA)
  // The live DB on dev-2 predates apns_env (only apns_token existed) — in-place
  // migration, never a destructive rebuild. Sygnal lesson: environment
  // ('sandbox'|'prod') has to be tracked per device, not assumed from topic.
  const deviceCols = db.prepare('PRAGMA table_info(devices)').all()
  if (!deviceCols.some((c) => c.name === 'apns_env')) {
    db.exec('ALTER TABLE devices ADD COLUMN apns_env TEXT')
  }
  return db
}

export function insertBlob(db, { id, ownerUserId, contentType, size, sha256, diskPath }) {
  db.prepare(
    'INSERT INTO blobs(id, owner_user_id, content_type, size, sha256, disk_path, created_at) VALUES(?,?,?,?,?,?,?)'
  ).run(id, ownerUserId, contentType, size, sha256, diskPath, Date.now())
}

export function getBlob(db, id) {
  return db.prepare('SELECT * FROM blobs WHERE id=?').get(id)
}

// `apnsToken: null` unregisters (both columns cleared together — a token
// without a known environment is unsendable, so they're always set/cleared
// as a pair).
export function setApnsRegistration(db, deviceId, { apnsToken, apnsEnv }) {
  db.prepare('UPDATE devices SET apns_token=?, apns_env=? WHERE id=?').run(apnsToken, apnsEnv, deviceId)
}

// Called by the push pipeline on a 410 Unregistered response — the token is
// dead, so stop trying it rather than retrying forever (sygnal lesson).
export function pruneApnsToken(db, deviceId) {
  db.prepare('UPDATE devices SET apns_token=NULL, apns_env=NULL WHERE id=?').run(deviceId)
}

// Client devices (never agent — agents are never pushed to) with a
// registered token, for the push pipeline to fan a journal event out to.
export function clientDevicesForPush(db, userId) {
  return db.prepare(
    "SELECT id, apns_token, apns_env, cursor FROM devices WHERE user_id=? AND kind='client' AND apns_token IS NOT NULL"
  ).all(userId)
}

// The unread badge = SUM(unread_count) over the owner's conversations.
export function unreadBadge(db, userId) {
  return db.prepare('SELECT COALESCE(SUM(unread_count),0) AS n FROM conversations WHERE owner_user_id=?').get(userId).n
}
