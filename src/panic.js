// Panic lock (docs/protocol.md "Panic lock"): an external watcher holding a
// panic token bound to one account locks that account with one request.
// The journal signs out every client device of the account, turns the
// Coordinator's consent switches off, refuses new sign-ins and device links
// for it, refuses to deliver new work to its boxes, and tells every bridge
// of the account to lock. The token can only lock (and read whether the
// account is locked); the lock is cleared on the journal host
// (`matron-admin panic clear <user>`).
//
// The state is one row per account in `panic_locks`; locked means a row
// with `cleared_at` NULL. Every check reads the database (a primary-key
// lookup), never memory, so the CLI's clear takes effect at once for the
// refusals and a journal restart cannot forget a lock.
import { sharedTokenMatches, signOutOwnedDevice } from './auth.js'
import { FEED_TOKEN_RE, requestSourceIp, deviceTarget } from './security-log.js'
import { getConsentEnabled, setConsentEnabled, getTransferConsentEnabled, setTransferConsentEnabled } from './consent.js'
import { readBody } from './http-body.js'

export const PANIC_TEXT_MAX = 200
// The same rule as the security feed's token.
export const PANIC_TOKEN_RE = FEED_TOKEN_RE
// The reason every refusal while locked carries.
export const ACCOUNT_LOCKED = 'account_locked'

// The account's open lock, {since, source, alert}, or null.
export function panicLock(db, userId) {
  if (userId == null) return null
  return db.prepare('SELECT since, source, alert FROM panic_locks WHERE user_id=? AND cleared_at IS NULL').get(userId) ?? null
}
export const isPanicLocked = (db, userId) => !!panicLock(db, userId)

// Every account_locked refusal's body (HTTP 423, and the error frames):
// the reason and since when.
export const lockedBody = (lock) => ({ error: ACCOUNT_LOCKED, since: lock?.since ?? null })

// The refusal of an approval (a consent answer) while locked, in the
// shape the answer paths give a user-only refusal: {ok:false, status,
// body}; null when the account is not locked.
export function lockedApprovalRefusal(db, userId) {
  const lock = panicLock(db, userId)
  return lock ? { ok: false, status: 403, body: { error: 'forbidden', detail: ACCOUNT_LOCKED, since: lock.since } } : null
}

// The frames to the account's bridges, and hello_ok's key.
export const panicOnFrame = (lock) => ({ kind: 'panic', on: true, since: lock.since, source: lock.source ?? null })
export const PANIC_OFF_FRAME = Object.freeze({ kind: 'panic', on: false })
// Spread into hello_ok for an agent: {panic: {...}} while locked, nothing
// otherwise (a bridge reads a missing key as "not locked").
export function panicHelloField(lock) {
  return lock ? { panic: { on: true, since: lock.since, source: lock.source ?? null } } : {}
}

// Which accounts this journal process has told its bridges are locked (the
// POST, or an agent's hello while locked). The periodic sweep (src/ws.js)
// sends the clear frame to an account on this list whose lock is gone, then
// drops it. One per hub, so one per server. After a restart the list is
// empty: a bridge reconnecting after a clear gets no key, which is the clear.
const announcedByHub = new WeakMap()
export function panicAnnounced(hub) {
  let s = announcedByHub.get(hub)
  if (!s) { s = new Set(); announcedByHub.set(hub, s) }
  return s
}

// Send `frame` to every open socket of the account's agent devices. → how
// many it went to.
export function sendToAgents(hub, userId, frame) {
  let n = 0
  const text = JSON.stringify(frame)
  for (const c of hub.connsOf(userId)) {
    if (c.kind !== 'agent' || c.ws.readyState !== 1) continue
    try { c.ws.send(text); n += 1 } catch { /* a socket closing under us */ }
  }
  return n
}

// What a client socket of a locked account is told just before it closes.
export const clientPanicFrame = (lock) => ({ kind: 'panic', on: true, since: lock.since })

// Close a signed-out client device's open sockets the way a revoked
// device's are (src/ws.js's revocation sweep: the `revoked` error frame,
// then 4001), each told first that the account is locked.
export function closeDeviceSockets(hub, userId, deviceIds, lock) {
  const ids = new Set(deviceIds)
  for (const c of hub.connsOf(userId)) {
    if (!ids.has(c.deviceId) || c.ws.readyState !== 1) continue
    closeLockedSocket(c.ws, lock)
  }
}
export function closeLockedSocket(ws, lock) {
  try {
    if (lock) ws.send(JSON.stringify(clientPanicFrame(lock)))
    ws.send(JSON.stringify({ kind: 'control', op: 'error', code: 'revoked' }))
    ws.close(4001)
  } catch { /* already closing */ }
}

// Sign out one client device of a locked account that still had a working
// token (a race, or a device made by a path the lock missed): the row goes
// as a self sign-out's does (approval keys detached, not revoked), its
// other open sockets close as above, and the security log has it.
export function signOutLockedClient({ db, hub, securityLog }, userId, deviceId, lock) {
  if (!signOutOwnedDevice(db, userId, deviceId)) return false
  if (hub) closeDeviceSockets(hub, userId, [deviceId], lock)
  securityLog?.record(userId, 'device_revoked', { deviceId: null, target: deviceTarget(deviceId), decidedBy: 'journal' })
  return true
}

// At most PANIC_TEXT_MAX characters (whole code points), or null.
const clip = (s) => (s == null ? null : Array.from(s).slice(0, PANIC_TEXT_MAX).join(''))

// Lock the account (POST /panic): the state changes in one transaction,
// then the frames and the security events. Idempotent: a call while locked
// keeps the lock as it is, signs out any client device that has appeared
// since, turns a switch that was turned back on off again, and sends the
// frame again. → {alreadyLocked, devicesRevoked, bridgesNotified}.
export function lockAccount({ db, hub, securityLog, signInTickets = null }, userId, { source = null, alert = null, now = Date.now() } = {}) {
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
  const bridgesNotified = lock ? sendToAgents(hub, userId, panicOnFrame(lock)) : 0
  if (lock) panicAnnounced(hub).add(userId)
  // `source` is caller text: into the line only as the target, JSON
  // encoded with the rest; `alert` never goes into a line.
  if (!alreadyLocked) securityLog.record(userId, 'panic_locked', { deviceId: null, target: clip(source), decidedBy: 'journal' })
  for (const id of revoked) securityLog.record(userId, 'device_revoked', { deviceId: null, target: deviceTarget(id), decidedBy: 'journal' })
  for (const which of switched) securityLog.record(userId, 'consent_switch_changed', { deviceId: null, target: which, decidedBy: 'journal' })
  return { alreadyLocked, devicesRevoked: revoked.length, bridgesNotified }
}

// Clear the account's lock (matron-admin panic clear). Nothing else is
// restored. → true when there was a lock to clear.
export function clearPanic(db, userId, now = Date.now()) {
  return db.prepare('UPDATE panic_locks SET cleared_at=? WHERE user_id=? AND cleared_at IS NULL').run(now, userId).changes > 0
}

// The periodic check (src/ws.js's sweep): for each account this process
// told it was locked whose lock is gone now, the clear frame to its
// connected bridges, once.
export function announcePanicClears(db, hub) {
  const announced = panicAnnounced(hub)
  for (const userId of [...announced]) {
    if (isPanicLocked(db, userId)) continue
    announced.delete(userId)
    sendToAgents(hub, userId, PANIC_OFF_FRAME)
  }
}

// MATRON_PANIC_TOKEN / MATRON_PANIC_ACCOUNT: both set and the token well
// formed, or the routes are off (and a malformed token or a missing half
// says so once, never printing the token). → {token, account} or null.
export function resolvePanic({ token, account } = {}, { warn = console.warn } = {}) {
  if (!token && !account) return null
  if (!token || !account) {
    warn('panic: MATRON_PANIC_TOKEN and MATRON_PANIC_ACCOUNT must both be set; /panic is off')
    return null
  }
  if (!PANIC_TOKEN_RE.test(token)) {
    warn('panic: MATRON_PANIC_TOKEN must be 32 to 128 characters of A-Z a-z 0-9 _ -; /panic is off')
    return null
  }
  return { token, account }
}

// POST /panic and GET /panic with the panic token, ahead of device
// authentication (src/http.js), exactly as the security feed is handled
// (src/security-log.js handleSecurityFeed): off → 404 as any unknown path;
// the per-address budget /login shares spent → 429 for everyone, the right
// token included; a wrong or missing token → 401, charged to that budget;
// compared in constant time. The token is bound to one account and does
// nothing but lock it and read whether it is locked. → true when it answered.
export async function handlePanic({ db, hub, panic, json, rateLimiter = null, securityLog, signInTickets = null }, req, res, url, { rejectEarly }) {
  if (url.pathname !== '/panic' || (req.method !== 'GET' && req.method !== 'POST')) return false
  if (!panic) { rejectEarly(req, res, 404, { error: 'not_found' }); return true }
  const ip = requestSourceIp(req) || 'unknown'
  if (rateLimiter?.blocked?.(ip)) { rejectEarly(req, res, 429, { error: 'rate_limited' }); return true }
  const given = /^Bearer (.+)$/.exec(req.headers.authorization || '')?.[1]
  if (!given || !sharedTokenMatches(panic.token, given)) {
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
  const r = lockAccount({ db, hub, securityLog, signInTickets }, user.id, { source: clip(body.source), alert: clip(body.alert) })
  json(res, 200, { ok: true, locked: true, already_locked: r.alreadyLocked, devices_revoked: r.devicesRevoked, bridges_notified: r.bridgesNotified })
  return true
}
