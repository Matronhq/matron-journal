// Panic lock: the lock itself (POST /panic) and the routes
// (docs/protocol.md "Panic lock"). Apart from src/panic.js, the state and
// its checks, because locking finishes the account's approved work through
// modules that themselves check the lock.
import { sharedTokenMatches, signOutOwnedDevice } from './auth.js'
import { requestSourceIp, deviceTarget } from './security-log.js'
import { getConsentEnabled, setConsentEnabled, getTransferConsentEnabled, setTransferConsentEnabled } from './consent.js'
import { readBody } from './http-body.js'
import { sanitizeConsentText } from './peer-text.js'
import { refuseLockedInvites } from './invite-delivery.js'
import { failApprovedSpawns } from './spawns.js'
import { declineApprovedTransfers } from './transfer-consent.js'
import {
  PANIC_TEXT_MAX, ACCOUNT_LOCKED, panicLock, isPanicLocked, panicOnFrame, panicAnnounced, sendToAgents, closeDeviceSockets,
} from './panic.js'

// The watcher's text as stored: control characters (C0 and, here only, C1),
// bidi and other format characters stripped and whitespace collapsed by
// the peer-text sieve, then at most PANIC_TEXT_MAX characters (whole code
// points); null when nothing is left. The shared sieve is left as it is: it
// mirrors the bridge's copy.
const clip = (s) => {
  if (s == null) return null
  const clean = Array.from(sanitizeConsentText(String(s).replace(/[\u0080-\u009f]/g, ' '), Infinity)).slice(0, PANIC_TEXT_MAX).join('').trim()
  return clean || null
}

// Lock the account (POST /panic): the state changes in one transaction,
// then the frames and the security events. Idempotent: a call while locked
// keeps the lock as it is, signs out any client device that has appeared
// since, turns a switch that was turned back on off again, and sends the
// frame again. → {alreadyLocked, devicesRevoked, bridgesNotified}.
export function lockAccount({ db, hub, securityLog, signInTickets = null, mediaDir = null, pairs = null, links = null }, userId, { source = null, alert = null, now = Date.now() } = {}) {
  let alreadyLocked = false
  let revoked = []
  const switched = []
  db.transaction(() => {
    alreadyLocked = isPanicLocked(db, userId)
    if (!alreadyLocked) {
      db.prepare(`INSERT INTO panic_locks(user_id, since, source, alert, cleared_at) VALUES(?,?,?,?,NULL)
        ON CONFLICT(user_id) DO UPDATE SET since=excluded.since, source=excluded.source, alert=excluded.alert, cleared_at=NULL`)
        .run(userId, now, source, alert)
    }
    // Every client device, signed out as a device signing itself out is:
    // its approval keys stay enrolled, detached, for the owner to re-attach
    // after signing in again once the lock is cleared. Agent devices stay.
    revoked = db.prepare("SELECT id FROM devices WHERE user_id=? AND kind='client' ORDER BY id").all(userId)
      .map((r) => r.id).filter((id) => signOutOwnedDevice(db, userId, id))
    // Both Coordinator switches off; nothing is remembered, so they stay
    // off after a clear until the owner turns them on again.
    if (getConsentEnabled(db, userId)) { setConsentEnabled(db, userId, false, now); switched.push('spawns') }
    if (getTransferConsentEnabled(db, userId)) { setTransferConsentEnabled(db, userId, false, now); switched.push('transfers') }
  })()
  // Committed: a two-factor sign-in started before the lock cannot finish
  // after it is cleared either.
  signInTickets?.dropUser?.(userId)
  const lock = panicLock(db, userId)
  closeDeviceSockets(hub, userId, revoked, lock)
  // Nothing approved before the lock takes effect, now or after the clear
  // (the asker can ask again): approved invites not delivered are refused,
  // approved spawns not started fail, approved transfers not released are
  // declined. Each pump that meets a locked owner later does the same.
  // Pairs and links approved (or pre-approved) before the lock are dropped
  // too: a box or a claimant that holds back until after the clear gets no
  // device.
  for (const [what, step] of [
    ['pairs', () => pairs?.dropApproved(userId)],
    ['links', () => links?.dropUser(userId)],
    ['invites', () => refuseLockedInvites({ db, hub }, userId)],
    ['spawns', () => failApprovedSpawns(db, hub, userId, ACCOUNT_LOCKED)],
    ['transfers', () => declineApprovedTransfers({ db, hub, mediaDir }, userId)],
  ]) {
    try { step() } catch (err) { console.error(`panic: finishing approved ${what} failed`, err) }
  }
  const bridgesNotified = lock ? sendToAgents(hub, userId, panicOnFrame(lock)) : 0
  if (lock) panicAnnounced(hub).add(userId)
  // `source` is caller text: into the line only as the target, JSON
  // encoded with the rest; `alert` never goes into a line.
  if (!alreadyLocked) securityLog.record(userId, 'panic_locked', { deviceId: null, target: clip(source), decidedBy: 'journal' })
  for (const id of revoked) securityLog.record(userId, 'device_revoked', { deviceId: null, target: deviceTarget(id), decidedBy: 'journal' })
  for (const which of switched) securityLog.record(userId, 'consent_switch_changed', { deviceId: null, target: which, decidedBy: 'journal' })
  return { alreadyLocked, devicesRevoked: revoked.length, bridgesNotified }
}

// POST /panic and GET /panic with the panic token, ahead of device
// authentication (src/http.js), resolved as the security feed is
// (src/security-log.js): off → 404 as any unknown path; a wrong or missing
// token → 401, charged to the per-address budget /login shares, and 429
// once that is spent; compared in constant time. Unlike the feed, the right
// token is checked first and is never refused for the budget, so bad
// guesses from an address cannot keep its watcher from locking. The token is bound to one account and does
// nothing but lock it and read whether it is locked. → true when it answered.
export async function handlePanic({ db, hub, panic, json, rateLimiter = null, securityLog, signInTickets = null, mediaDir = null, pairs = null, links = null }, req, res, url, { rejectEarly }) {
  if (url.pathname !== '/panic' || (req.method !== 'GET' && req.method !== 'POST')) return false
  if (!panic) { rejectEarly(req, res, 404, { error: 'not_found' }); return true }
  // The token first, so the right one is never starved: only a failure is
  // charged to the address's budget, and only failures meet its 429.
  const given = /^Bearer (.+)$/.exec(req.headers.authorization || '')?.[1]
  if (!given || !sharedTokenMatches(panic.token, given)) {
    const ip = requestSourceIp(req) || 'unknown'
    if (rateLimiter?.blocked?.(ip)) { rejectEarly(req, res, 429, { error: 'rate_limited' }); return true }
    rateLimiter?.allow(ip)
    rejectEarly(req, res, 401, { error: 'unauthenticated' })
    return true
  }
  const user = db.prepare('SELECT id FROM users WHERE name=?').get(panic.account)
  if (!user) { rejectEarly(req, res, 404, { error: 'not_found' }); return true }
  if (req.method === 'GET') {
    const lock = panicLock(db, user.id)
    json(res, 200, { locked: !!lock, since: lock?.since ?? null, source: lock?.source ?? null, alert: lock?.alert ?? null })
    return true
  }
  // readBody's 400 (not JSON, not an object) and 413 go to http.js's catch.
  const body = await readBody(req)
  const text = (v) => v === undefined || v === null || typeof v === 'string'
  if (!text(body.source) || !text(body.alert)) { json(res, 400, { error: 'bad_request' }); return true }
  const r = lockAccount({ db, hub, securityLog, signInTickets, mediaDir, pairs, links }, user.id, { source: clip(body.source), alert: clip(body.alert) })
  json(res, 200, { ok: true, locked: true, already_locked: r.alreadyLocked, devices_revoked: r.devicesRevoked, bridges_notified: r.bridgesNotified })
  return true
}
