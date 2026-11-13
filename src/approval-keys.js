// Approval keys: storage, nonces, and the one guard every dangerous action
// calls (requireApproval). The statement format and the crypto live in
// src/approvals.js; the routes in src/approval-keys-http.js.
//
// An account with no active key behaves exactly as before: requireApproval
// lets everything through with `approval: null`. Once a key is enrolled,
// every guarded action needs a statement signed by one of the account's
// active keys, attached to the calling device, over a journal-issued nonce
// that was handed to that same device and is spent by the check.
import crypto from 'node:crypto'
import { parseStatement, verifySignature } from './approvals.js'

export const ALG = 'ES256'
export const NONCE_TTL_MS = 5 * 60000
export const KEY_REQUEST_TTL_MS = 10 * 60000

export function hasActiveKey(db, userId) {
  return !!db.prepare('SELECT 1 FROM approval_keys WHERE user_id=? AND revoked_at IS NULL').get(userId)
}

// The row of one of the user's keys that is not revoked, or null.
export function activeKeyFor(db, userId, keyId) {
  return db.prepare('SELECT * FROM approval_keys WHERE user_id=? AND key_id=? AND revoked_at IS NULL').get(userId, keyId) ?? null
}

// A device's live keys (for the notices when the device is revoked).
export function activeKeysOfDevice(db, userId, deviceId) {
  return db.prepare('SELECT * FROM approval_keys WHERE user_id=? AND device_id=? AND revoked_at IS NULL ORDER BY id').all(userId, deviceId)
}

// A nonce for the calling device: 32 random bytes, base64url, good for
// five minutes and one statement. Spent and expired nonces are swept here.
export function issueNonce(db, who, now = Date.now()) {
  const nonce = crypto.randomBytes(32).toString('base64url')
  db.transaction(() => {
    db.prepare('DELETE FROM approval_nonces WHERE created_at <= ?').run(now - NONCE_TTL_MS)
    db.prepare('INSERT INTO approval_nonces(nonce, user_id, device_id, created_at) VALUES(?,?,?,?)').run(nonce, who.userId, who.deviceId, now)
  })()
  return { nonce, expires_at: now + NONCE_TTL_MS }
}

// Spend a nonce: true once, for the user and device it was issued to, while
// it is under five minutes old.
export function consumeNonce(db, who, nonce, now = Date.now()) {
  if (typeof nonce !== 'string') return false
  return db.prepare(`UPDATE approval_nonces SET used_at=?
    WHERE nonce=? AND user_id=? AND device_id=? AND used_at IS NULL AND created_at > ?`)
    .run(now, nonce, who.userId, who.deviceId, now - NONCE_TTL_MS).changes > 0
}

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)

// Same keys, same string values. Subjects are flat objects of strings
// (parseStatement has checked the statement's).
function sameSubject(a, b) {
  if (!isObj(a) || !isObj(b)) return false
  const ka = Object.keys(a)
  return ka.length === Object.keys(b).length && ka.every((k) => Object.hasOwn(b, k) && a[k] === b[k])
}

function matchesExpect(st, expect) {
  if (st.type !== expect.type || !sameSubject(st.subject, expect.subject)) return false
  if (st.type !== 'item_tap') return true
  const it = expect.item
  return isObj(it) && st.item.id === it.id && st.item.num === it.num && st.item.reply_to === it.reply_to
    && st.action === expect.action && st.prompt_digest === expect.prompt_digest
}

const required = { ok: false, status: 403, body: { error: 'approval_required' } }
const invalid = (reason) => ({ ok: false, status: 400, body: { error: 'approval_invalid', reason } })

// The checks alone, for a route where a signature is always needed (the key
// routes); requireApproval below is the guard for everything else. `ctx` is
// {db, journalHost, now?}; `approval` the request's {statement, signature}.
// `anyDevice` skips the wrong_device check: only for attaching a key to the
// calling device, where the key's own signature is the proof.
//
// Order: statement parses; journal and user; key known, live, on this
// device; expected fields; signature; the nonce last, so a failed attempt
// does not spend it. On success `approval` is {statement, signature} as
// received, byte for byte, and `keyId` the key that signed.
export function checkApproval(ctx, who, approval, expect, { anyDevice = false } = {}) {
  const { db, journalHost, now = Date.now() } = ctx
  if (approval === undefined || approval === null) return required
  if (!isObj(approval) || Object.keys(approval).length !== 2
    || typeof approval.statement !== 'string' || typeof approval.signature !== 'string') return invalid('bad_statement')
  const st = parseStatement(approval.statement)
  if (!st) return invalid('bad_statement')
  // Without a public URL there is no journal a statement could name: fail
  // closed rather than fall back to unsigned for an account with keys.
  const user = db.prepare('SELECT name FROM users WHERE id=?').get(who.userId)
  if (!journalHost || st.journal !== journalHost || !user || st.user !== user.name) return invalid('mismatch')
  const key = db.prepare('SELECT * FROM approval_keys WHERE user_id=? AND key_id=?').get(who.userId, st.key_id)
  if (!key) return invalid('unknown_key')
  if (key.revoked_at != null) return invalid('revoked_key')
  if (!anyDevice && key.device_id !== who.deviceId) return invalid('wrong_device')
  if (!matchesExpect(st, expect)) return invalid('mismatch')
  if (!verifySignature(key.public_key, approval.statement, approval.signature)) return invalid('signature')
  if (!consumeNonce(db, who, st.nonce, now)) return invalid('nonce')
  return { ok: true, approval: { statement: approval.statement, signature: approval.signature }, keyId: key.key_id }
}

// The guard. `body.approval` is the request's field; `expect` is
// {type, subject, item?, action?, prompt_digest?} (item is {id, num,
// reply_to}), and the statement must match it exactly, subject key for key.
// No active key: {ok:true, approval:null} (today's behaviour). Otherwise
// {ok:true, approval, keyId} or {ok:false, status, body} to send as is.
// Call it once per request and act on its answer: whether the account has a
// key is decided here, once.
export function requireApproval(ctx, who, body, expect) {
  if (!hasActiveKey(ctx.db, who.userId)) return { ok: true, approval: null }
  return checkApproval(ctx, who, body?.approval, expect)
}
