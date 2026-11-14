// Security events (docs/protocol.md "Security event feed"): one line per
// event, per account with a sequence number that starts at 1 and never
// skips or repeats, written to the database, to stdout and (when
// MATRON_SECURITY_LOG names a file) appended to that file, and read back
// by an external watcher through GET /security-events (src/http.js).
//
// A line names what happened, never what was said: no message or task
// text, passwords, codes, tokens, statements, signatures or public keys.
// `target` is a short identifier (device:<id>, key:<first 8 of key_id>,
// convo:<id>, spawns, transfers, a two-factor action, a lock length, a
// refusal reason), never free text.
import fs from 'node:fs'
import crypto from 'node:crypto'
import { AsyncLocalStorage } from 'node:async_hooks'

export const SECURITY_EVENTS = Object.freeze([
  'client_signin', 'device_linked', 'bridge_paired', 'device_revoked', 'password_changed', 'two_factor_changed',
  'password_reset_requested', 'coordinator_changed', 'consent_switch_changed', 'device_protection_changed',
  'spawn_approved', 'chat_approved', 'session_started_direct', 'coordinator_carry_on',
  'approval_key_enrolled', 'approval_key_revoked', 'approval_key_attached', 'approval_invalid',
  'device_signed_out_bad_signatures', 'enrolment_locked',
])
const KNOWN = new Set(SECURITY_EVENTS)
export const DECIDERS = Object.freeze(['user', 'coordinator', 'admin', 'admin_cli', 'journal'])
const KNOWN_DECIDERS = new Set(DECIDERS)

// Rows are kept 30 days (swept with the approval nonces,
// src/approval-keys.js); the per-account counter is kept apart from them,
// so a sweep never lets a sequence number be handed out again.
export const SECURITY_EVENT_KEEP_MS = 30 * 24 * 60 * 60000
export const FEED_LIMIT_DEFAULT = 100
export const FEED_LIMIT_MAX = 500
export const FEED_TOKEN_RE = /^[A-Za-z0-9_-]{32,128}$/

export const deviceTarget = (id) => `device:${id}`
export const keyTarget = (keyId) => `key:${String(keyId).slice(0, 8)}`
export const convoTarget = (id) => `convo:${id}`

// The request a recording happens under: its client address, the way
// src/http.js derives it (cf-connecting-ip behind the tunnel, else the
// socket's). Entered once per HTTP request (makeHttpHandler), so a
// recording deep in a guard (an invalid approval) knows it too; a
// WebSocket frame, the admin CLI and the journal's own work run outside
// one, and their lines carry null.
const requestScope = new AsyncLocalStorage()
export const requestSourceIp = (req) => req.headers['cf-connecting-ip'] || req.socket?.remoteAddress || null
export function withRequestScope(req, fn) {
  return requestScope.run({ sourceIp: requestSourceIp(req) }, fn)
}

// The line, the stored row and the feed's object are one shape.
const lineOf = (row, account) => ({
  kind: 'matron_security', seq: row.seq, ts: row.ts, event: row.event, account,
  device_id: row.device_id ?? null, device_name: row.device_name ?? null, source_ip: row.source_ip ?? null,
  target: row.target ?? null, decided_by: row.decided_by ?? null,
})

const strOrNull = (v) => (v == null ? null : String(v))

export function makeSecurityLog({ db, out = (line) => process.stdout.write(line + '\n'), file = process.env.MATRON_SECURITY_LOG, now = Date.now }) {
  const allocate = db.prepare(`INSERT INTO security_event_seqs(user_id, seq) VALUES(?, 1)
    ON CONFLICT(user_id) DO UPDATE SET seq = seq + 1 RETURNING seq`)
  const insert = db.prepare(`INSERT INTO security_events(user_id, seq, ts, event, device_id, device_name, source_ip, target, decided_by)
    VALUES(?,?,?,?,?,?,?,?,?)`)
  const userName = db.prepare('SELECT name FROM users WHERE id=?')
  const deviceName = db.prepare('SELECT name FROM devices WHERE id=?')
  let fileFailed = false

  const write = (userId, event, fields) => {
    let line
    try {
      const account = userName.get(userId)?.name
      if (account == null) return
      const row = {
        ts: now(), event,
        device_id: fields.deviceId ?? null,
        device_name: strOrNull(fields.deviceName),
        source_ip: strOrNull(fields.sourceIp),
        target: strOrNull(fields.target),
        decided_by: KNOWN_DECIDERS.has(fields.decidedBy) ? fields.decidedBy : null,
      }
      // The number and the row in one transaction: the counter is bumped
      // under the write lock, so two writers (the server and the admin
      // CLI on the same file) never get the same one.
      db.transaction(() => {
        row.seq = allocate.get(userId).seq
        insert.run(userId, row.seq, row.ts, row.event, row.device_id, row.device_name, row.source_ip, row.target, row.decided_by)
      })()
      line = JSON.stringify(lineOf(row, account))
    } catch (err) {
      console.error(`security log: ${event} not recorded (${err?.message || err})`)
      return
    }
    try { out(line) } catch (err) { console.error(`security log: writing a line failed (${err?.message || err})`) }
    if (!file) return
    try {
      fs.appendFileSync(file, line + '\n')
      fileFailed = false
    } catch (err) {
      // Once per outage: the event is in the database and on stdout.
      if (!fileFailed) console.error(`security log: appending to MATRON_SECURITY_LOG failed (${err?.code || err?.message || err}); events still go to the database and stdout`)
      fileFailed = true
    }
  }

  return {
    // One event for the account `userId`. Never throws. Called inside a
    // database transaction, the event waits for a microtask: by then the
    // transaction (synchronous, better-sqlite3) has committed or rolled
    // back, and the event is written either way, in its own transaction.
    // So an event describing something that happened even though its
    // request rolled back (an invalid approval) is not lost; an event for
    // a change is recorded by its caller once the change has committed.
    // `deviceName` defaults to the device's current name; `sourceIp` to
    // the request's.
    record(userId, event, fields = {}) {
      try {
        if (!KNOWN.has(event)) throw new Error(`unknown security event ${JSON.stringify(event)}`)
        const resolved = { ...fields }
        // Both resolved now, while the device (which may be on its way
        // out) and the request are still there.
        if (resolved.deviceName === undefined) resolved.deviceName = resolved.deviceId == null ? null : deviceName.get(resolved.deviceId)?.name ?? null
        if (resolved.sourceIp === undefined) resolved.sourceIp = requestScope.getStore()?.sourceIp ?? null
        if (db.inTransaction) queueMicrotask(() => write(userId, event, resolved))
        else write(userId, event, resolved)
      } catch (err) {
        console.error(`security log: ${err?.message || err}`)
      }
    },
    read: (userId, opts) => readSecurityEvents(db, userId, opts),
  }
}

// The feed's page for one account: events with seq > `since` (ascending,
// the first `limit`), or with `since` null the newest `limit` (still
// ascending). `last_seq` is the account's latest number, 0 when none.
export function readSecurityEvents(db, userId, { since = null, limit = FEED_LIMIT_DEFAULT } = {}) {
  const account = db.prepare('SELECT name FROM users WHERE id=?').get(userId)?.name ?? null
  const lastSeq = db.prepare('SELECT seq FROM security_event_seqs WHERE user_id=?').get(userId)?.seq ?? 0
  const rows = since == null
    ? db.prepare('SELECT * FROM security_events WHERE user_id=? ORDER BY seq DESC LIMIT ?').all(userId, limit).reverse()
    : db.prepare('SELECT * FROM security_events WHERE user_id=? AND seq > ? ORDER BY seq LIMIT ?').all(userId, since, limit)
  return { account, last_seq: lastSeq, events: rows.map((r) => lineOf(r, account)) }
}

// Rows past their 30 days. The counter rows stay.
export function sweepSecurityEvents(db, now = Date.now()) {
  db.prepare('DELETE FROM security_events WHERE ts <= ?').run(now - SECURITY_EVENT_KEEP_MS)
}

// The journal's one log per database, for code that has the database but
// not the request's context (the approval guard, the lockdown): installed
// by startServer. Without one (a bare handler, a unit test), events are
// dropped.
const installed = new WeakMap()
const NOOP_LOG = Object.freeze({ record() {}, read: () => ({ account: null, last_seq: 0, events: [] }) })
export function installSecurityLog(db, log) { installed.set(db, log) }
export function securityLogFor(db) { return installed.get(db) ?? NOOP_LOG }
// A route's context's log (makeHttpHandler passes its own), else the one
// installed for its database.
export const securityLogOf = (ctx) => ctx.securityLog ?? securityLogFor(ctx.db)

// MATRON_SECURITY_FEED_TOKEN / MATRON_SECURITY_FEED_ACCOUNT: both set and
// the token well formed, or the feed is off (and a malformed token says so
// once, never printing it). → {token, account} or null.
export function resolveSecurityFeed({ token, account } = {}, { warn = console.warn } = {}) {
  if (!token && !account) return null
  if (!token || !account) {
    warn('security feed: MATRON_SECURITY_FEED_TOKEN and MATRON_SECURITY_FEED_ACCOUNT must both be set; GET /security-events is off')
    return null
  }
  if (!FEED_TOKEN_RE.test(token)) {
    warn('security feed: MATRON_SECURITY_FEED_TOKEN must be 32 to 128 characters of A-Z a-z 0-9 _ -; GET /security-events is off')
    return null
  }
  return { token, account }
}

// Constant time, hashed first so a wrong length tells nothing either.
const digest = (s) => crypto.createHash('sha256').update(String(s)).digest()
export const feedTokenMatches = (expected, given) => crypto.timingSafeEqual(digest(expected), digest(given ?? ''))

// GET /security-events?since=&limit= with the feed's own Bearer token,
// ahead of device authentication (src/http.js). Off (feed null): 404, as
// any unknown path. → true when it answered.
export function handleSecurityFeed({ db, feed, json }, req, res, url, { rejectEarly }) {
  if (url.pathname !== '/security-events' || req.method !== 'GET') return false
  if (!feed) { json(res, 404, { error: 'not_found' }); return true }
  const given = /^Bearer (.+)$/.exec(req.headers.authorization || '')?.[1]
  if (!given || !feedTokenMatches(feed.token, given)) { rejectEarly(req, res, 401, { error: 'unauthenticated' }); return true }
  const user = db.prepare('SELECT id FROM users WHERE name=?').get(feed.account)
  if (!user) { json(res, 404, { error: 'not_found' }); return true }
  const int = (name) => {
    if (!url.searchParams.has(name)) return undefined
    const raw = url.searchParams.get(name)
    return /^\d{1,15}$/.test(raw) ? Number(raw) : null
  }
  const since = int('since')
  const limit = int('limit')
  if (since === null || limit === null || limit === 0) { json(res, 400, { error: 'bad_request' }); return true }
  const page = readSecurityEvents(db, user.id, { since: since ?? null, limit: Math.min(limit ?? FEED_LIMIT_DEFAULT, FEED_LIMIT_MAX) })
  json(res, 200, page)
  return true
}
