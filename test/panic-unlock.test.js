// Panic lock, the signed unlock (src/panic.js, src/panic-lock.js;
// docs/protocol.md "Panic lock"): a client device with an approval key
// attached is not signed out by a lock but frozen, and it alone can clear
// the lock, with a statement signed by that key.
import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { startTestServer, makeWsClient } from './helpers.js'
import { createUser, createAgent, createClientDevice } from '../src/auth.js'
import { getConsentEnabled, getTransferConsentEnabled } from '../src/consent.js'
import { isPanicLocked } from '../src/panic.js'
import { lockAccount } from '../src/panic-lock.js'
import { runAdmin } from '../bin/matron-admin.js'
import {
  generateApprovalKey, enableTwoFactor, enrolKeyByPassword, signAccount, TEST_PASSWORD, TEST_TOKEN_KEY, TEST_PUBLIC_URL,
} from './approval-helpers.js'

const PANIC_TOKEN = 'panic_' + 'p'.repeat(40)
const FEED_TOKEN = 'feed_' + 'x'.repeat(40)
const WATCHER_IP = '198.51.100.9'
const tick = (ms = 30) => new Promise((r) => setTimeout(r, ms))

function capture() {
  const lines = []
  return { lines, out: (l) => lines.push(l), all: () => lines.map((l) => JSON.parse(l)) }
}
const lockIt = (s, body = { source: 'watcher-1', alert: 'disk wiped on box-a' }) =>
  s.http('/panic', { method: 'POST', token: PANIC_TOKEN, body, headers: { 'cf-connecting-ip': WATCHER_IP } })
const lockedSince = (s) => s.db.prepare('SELECT since FROM panic_locks WHERE cleared_at IS NULL').get()?.since
const LOCKED = (s) => ({ error: 'account_locked', since: lockedSince(s) })
const FROZEN = (s) => ({ ...LOCKED(s), unlock: true })
const deviceExists = (s, id) => !!s.db.prepare('SELECT 1 FROM devices WHERE id=?').get(id)
const clientIds = (s, userId) => s.db.prepare("SELECT id FROM devices WHERE user_id=? AND kind='client' ORDER BY id").all(userId).map((r) => r.id)
const panicFrames = (w) => w.frames.filter((f) => f.kind === 'panic')
const lockFrames = (w) => w.frames.filter((f) => f.kind === 'panic' || (f.kind === 'control' && f.op === 'error'))
function closed(w) {
  return new Promise((resolve) => {
    if (w.ws.readyState === 3) { resolve(w.ws._closeCode); return }
    w.ws.on('close', (code) => resolve(code))
  })
}
async function socket(s, token) {
  const w = await makeWsClient(s.base, { token, cursor: null })
  const hello = await w.waitFor((f) => f.op === 'hello_ok')
  return { w, hello }
}
// A POST whose headers go out at once and whose body follows only after
// `beforeBody` has run: authenticated before, read after.
function delayedPost(s, path, token, body, beforeBody) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body)
    const req = http.request({ host: '127.0.0.1', port: s.port, path, method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } }, (res) => {
      let b = ''
      res.on('data', (c) => { b += c })
      res.on('end', () => resolve({ status: res.statusCode, json: b ? JSON.parse(b) : null }))
    })
    req.on('error', reject)
    req.flushHeaders()
    setTimeout(async () => { try { await beforeBody() } catch (err) { reject(err) } req.end(data) }, 100)
  })
}

// A journal with the panic token and approval keys on; alice with a phone
// that holds an approval key, and bob.
async function journal(t, extra = {}) {
  const cap = capture()
  const s = await startTestServer({
    securityLog: { out: cap.out, file: null }, securityFeed: { token: FEED_TOKEN, account: 'alice' },
    panic: { token: PANIC_TOKEN, account: 'alice' }, tokenKey: TEST_TOKEN_KEY, publicUrl: TEST_PUBLIC_URL, ...extra,
  })
  t.after(() => s.close())
  const alice = await createUser(s.db, 'alice', TEST_PASSWORD)
  const bob = await createUser(s.db, 'bob', 'pw-bob-123')
  const phone = createClientDevice(s.db, alice.id, 'phone')
  const { secret } = await enableTwoFactor(s, phone.token)
  const key = await enrolKeyByPassword(s, { token: phone.token, userId: alice.id, secret })
  // Another client device of alice with a key of its own.
  const keyed = async (name) => {
    const d = createClientDevice(s.db, alice.id, name)
    const k = await enrolKeyByPassword(s, { token: d.token, userId: alice.id, secret, name })
    return { ...d, key: k }
  }
  return { s, cap, alice, bob, phone, key, secret, keyed }
}
const unlockSubject = (s, since = lockedSince(s)) => ({ op: 'clear_panic', since: String(since) })
const signUnlock = (s, device, key, since) => signAccount(s, { token: device.token, key, subject: unlockSubject(s, since) })
const unlock = (s, token, body = {}) => s.http('/panic/unlock', { method: 'POST', token, body })
// A statement that names the right key but is signed by another.
const forgedUnlock = (s, device, key) => signAccount(s, {
  token: device.token, key: { keyId: key.keyId, privateKeyPem: generateApprovalKey().privateKeyPem }, subject: unlockSubject(s),
})

// ---- The lock ----------------------------------------------------------------------

test('POST /panic: a device with an approval key is frozen, not signed out; one without is signed out; the counts say which', async (t) => {
  const { s, alice, phone, key } = await journal(t)
  const laptop = createClientDevice(s.db, alice.id, 'laptop')
  const r = await lockIt(s)
  assert.equal(r.status, 200)
  assert.deepEqual(r.json, { ok: true, locked: true, already_locked: false, devices_revoked: 1, devices_frozen: 1, bridges_notified: 0 })
  assert.deepEqual(clientIds(s, alice.id), [phone.deviceId])
  assert.equal((await s.http('/me', { token: laptop.token })).status, 401)
  // The key stays attached to the frozen device.
  assert.equal(s.db.prepare('SELECT device_id FROM approval_keys WHERE key_id=?').get(key.keyId).device_id, phone.deviceId)
  // Again: nothing more signed out, the frozen count as it is now.
  const again = await lockIt(s)
  assert.deepEqual(again.json, { ok: true, locked: true, already_locked: true, devices_revoked: 0, devices_frozen: 1, bridges_notified: 0 })
  // Both consent switches are off.
  assert.equal(getConsentEnabled(s.db, alice.id), false)
  assert.equal(getTransferConsentEnabled(s.db, alice.id), false)
})

test('an account with no approval key: every client device signed out, none frozen, and none can unlock', async (t) => {
  const cap = capture()
  const s = await startTestServer({ securityLog: { out: cap.out, file: null }, panic: { token: PANIC_TOKEN, account: 'alice' }, tokenKey: TEST_TOKEN_KEY, publicUrl: TEST_PUBLIC_URL })
  t.after(() => s.close())
  const alice = await createUser(s.db, 'alice', TEST_PASSWORD)
  const phone = createClientDevice(s.db, alice.id, 'phone')
  const r = await lockIt(s)
  assert.deepEqual(r.json, { ok: true, locked: true, already_locked: false, devices_revoked: 1, devices_frozen: 0, bridges_notified: 0 })
  assert.deepEqual(clientIds(s, alice.id), [])
  assert.equal((await unlock(s, phone.token)).status, 401)
  // A device made by a path the lock missed, no key: signed out on use,
  // on the unlock route as on any other, with no `unlock`.
  const late = createClientDevice(s.db, alice.id, 'late')
  const u = await unlock(s, late.token, { approval: { statement: '{}', signature: 'x' } })
  assert.deepEqual([u.status, u.json], [423, LOCKED(s)])
  assert.equal(deviceExists(s, late.deviceId), false)
  assert.equal((await unlock(s, late.token)).status, 401)
  assert.equal(isPanicLocked(s.db, alice.id), true)
})

test('frozen means a key attached to that device at the check: a key detached by an earlier sign-out does not count', async (t) => {
  const { s, alice, phone, key, keyed } = await journal(t)
  const tablet = await keyed('tablet')
  // The tablet signs itself out: its key stays enrolled, attached to no
  // device. It signs in again and does not re-attach it.
  assert.equal((await s.http(`/devices/${tablet.deviceId}/revoke`, { method: 'POST', token: tablet.token })).status, 200)
  assert.deepEqual(s.db.prepare('SELECT device_id, revoked_at FROM approval_keys WHERE key_id=?').get(tablet.key.keyId), { device_id: null, revoked_at: null })
  const again = createClientDevice(s.db, alice.id, 'tablet')
  const r = await lockIt(s)
  assert.deepEqual([r.json.devices_revoked, r.json.devices_frozen], [1, 1])
  assert.deepEqual(clientIds(s, alice.id), [phone.deviceId])
  assert.equal((await s.http('/me', { token: again.token })).status, 401)
  // Nor does the detached key unlock from the frozen phone.
  const u = await unlock(s, phone.token, { approval: await signUnlock(s, phone, tablet.key) })
  assert.deepEqual([u.status, u.json], [400, { error: 'approval_invalid', reason: 'wrong_device' }])
  assert.equal(isPanicLocked(s.db, alice.id), true)
  assert.equal(key.keyId !== tablet.key.keyId, true)
})

test('a statement over an earlier lock\'s since does not clear a later lock', async (t) => {
  const { s, alice, phone, key } = await journal(t)
  assert.equal((await lockIt(s)).status, 200)
  const first = lockedSince(s)
  await runAdmin(s.db, ['panic', 'clear', 'alice'])
  await tick(5)
  assert.equal((await lockIt(s)).status, 200)
  assert.notEqual(lockedSince(s), first)
  // A fresh nonce and signed_at, the first lock's since.
  const r = await unlock(s, phone.token, { approval: await signUnlock(s, phone, key, first) })
  assert.deepEqual([r.status, r.json], [400, { error: 'approval_invalid', reason: 'mismatch' }])
  assert.equal(isPanicLocked(s.db, alice.id), true)
  assert.equal(deviceExists(s, phone.deviceId), true)
  assert.equal((await unlock(s, phone.token, { approval: await signUnlock(s, phone, key) })).status, 200)
})

// ---- What a frozen device sees --------------------------------------------------------

test('frozen over HTTP: 423 with unlock:true on every route, the token still valid; the nonce route works', async (t) => {
  const { s, alice, phone } = await journal(t)
  assert.equal((await lockIt(s)).status, 200)
  for (const [path, opts] of [['/me', {}], ['/devices', {}], ['/settings', { method: 'PATCH', body: { notices: false } }], ['/approval-keys', {}], ['/no-such-route', {}]]) {
    const r = await s.http(path, { token: phone.token, ...opts })
    assert.deepEqual([r.status, r.json], [423, FROZEN(s)], path)
  }
  assert.equal(deviceExists(s, phone.deviceId), true)
  const n = await s.http('/approvals/nonce', { method: 'POST', token: phone.token })
  assert.equal(n.status, 200)
  assert.equal(typeof n.json.nonce, 'string')
  // Only the POST: any other method on those two paths is refused.
  assert.equal((await s.http('/approvals/nonce', { token: phone.token })).status, 423)
  assert.equal((await s.http('/panic/unlock', { token: phone.token })).status, 423)
  assert.deepEqual(clientIds(s, alice.id), [phone.deviceId])
})

test('frozen: a request authenticated before the lock whose body arrives after it is 423 with unlock:true, writes nothing, and the device stays', async (t) => {
  const { s, phone } = await journal(t)
  const r = await delayedPost(s, '/approval-keys/requests', phone.token, { public_key: generateApprovalKey().publicKey, name: 'tablet' }, () => lockIt(s))
  assert.equal(r.status, 423)
  assert.deepEqual(r.json, FROZEN(s))
  assert.equal(deviceExists(s, phone.deviceId), true)
  assert.equal(s.db.prepare('SELECT COUNT(*) n FROM approval_key_requests').get().n, 0)
  // The same request with the nonce route: let through, frozen or not.
  const n = await delayedPost(s, '/approvals/nonce', phone.token, {}, async () => {})
  assert.equal(n.status, 200)
})

test('frozen sockets: the open one gets the panic frame and account_locked with unlock:true and a normal close; a new hello gets the error; nobody is signed out', async (t) => {
  const { s, alice, phone } = await journal(t)
  const laptop = createClientDevice(s.db, alice.id, 'laptop')
  const p = await socket(s, phone.token)
  const l = await socket(s, laptop.token)
  const pClosed = closed(p.w)
  const lClosed = closed(l.w)
  assert.equal((await lockIt(s)).status, 200)
  const since = lockedSince(s)
  assert.notEqual(await pClosed, 4001)
  assert.deepEqual(lockFrames(p.w), [
    { kind: 'panic', on: true, since, unlock: true },
    { kind: 'control', op: 'error', code: 'account_locked', since, unlock: true },
  ])
  // The keyless device's socket: as before.
  assert.equal(await lClosed, 4001)
  assert.deepEqual(lockFrames(l.w), [{ kind: 'panic', on: true, since }, { kind: 'control', op: 'error', code: 'revoked' }])
  // A new hello from the frozen device.
  const w = await makeWsClient(s.base, { token: phone.token, cursor: null })
  const wClosed = closed(w)
  const err = await w.waitFor((f) => f.op === 'error')
  assert.deepEqual(err, { kind: 'control', op: 'error', code: 'account_locked', since, unlock: true })
  assert.notEqual(await wClosed, 4001)
  assert.equal(w.frames.some((f) => f.op === 'hello_ok'), false)
  assert.deepEqual(clientIds(s, alice.id), [phone.deviceId])
  assert.equal((await s.http('/me', { token: phone.token })).status, 423)
})

test('a frame on a frozen device\'s socket that was still open is refused with unlock:true and the socket closed; the device stays', async (t) => {
  const { s, alice, phone } = await journal(t)
  const box = createAgent(s.db, alice.id, 'box-a')
  const p = await socket(s, phone.token)
  const pClosed = closed(p.w)
  // A lock this socket was not closed for (written past the journal).
  s.db.prepare('INSERT INTO panic_locks(user_id, since, source, alert, cleared_at) VALUES(?,?,NULL,NULL,NULL)').run(alice.id, 1234)
  p.w.send({ op: 'agent_request', request_id: 'r1', agent_device_id: box.deviceId, method: 'spawn_targets', params: {} })
  const err = await p.w.waitFor((f) => f.op === 'error')
  assert.deepEqual(err, { kind: 'control', op: 'error', code: 'account_locked', ref: 'agent_request', request_id: 'r1', since: 1234, unlock: true })
  assert.notEqual(await pClosed, 4001)
  assert.equal(p.w.frames.some((f) => f.code === 'revoked'), false)
  assert.equal(deviceExists(s, phone.deviceId), true)
})

test('a key revoked while its device is frozen: the next request signs the device out, as a keyless one', async (t) => {
  const { s, phone, key } = await journal(t)
  assert.equal((await lockIt(s)).status, 200)
  assert.deepEqual((await s.http('/me', { token: phone.token })).json, FROZEN(s))
  const approval = await signUnlock(s, phone, key)
  s.db.prepare('UPDATE approval_keys SET revoked_at=? WHERE key_id=?').run(Date.now(), key.keyId)
  const r = await unlock(s, phone.token, { approval })
  assert.deepEqual([r.status, r.json], [423, LOCKED(s)])
  assert.equal(deviceExists(s, phone.deviceId), false)
  assert.equal((await s.http('/me', { token: phone.token })).status, 401)
  assert.equal((await lockIt(s)).json.devices_frozen, 0)
})

// ---- POST /panic/unlock -----------------------------------------------------------------

test('a signed unlock clears the lock, signs out every other client device, tells the bridges once, and is recorded', async (t) => {
  const { s, cap, alice, bob, phone, key, keyed } = await journal(t, { revocationSweepMs: 40 })
  const tablet = await keyed('tablet')
  const box = createAgent(s.db, alice.id, 'box-a')
  const a = await socket(s, box.token)
  const bobPhone = createClientDevice(s.db, bob.id, 'phone')
  t.after(() => a.w.close())
  const locked = await lockIt(s)
  assert.equal(locked.json.devices_frozen, 2)
  await a.w.waitFor((f) => f.kind === 'panic' && f.on === true)
  const since = lockedSince(s)
  const from = cap.lines.length
  const approval = await signUnlock(s, phone, key)
  const r = await unlock(s, phone.token, { approval })
  assert.deepEqual([r.status, r.json], [200, { ok: true, locked: false, devices_revoked: 1 }])
  assert.equal(isPanicLocked(s.db, alice.id), false)
  // The other frozen device is signed out, its key detached, not revoked.
  assert.deepEqual(clientIds(s, alice.id), [phone.deviceId])
  assert.equal((await s.http('/me', { token: tablet.token })).status, 401)
  assert.deepEqual(s.db.prepare('SELECT device_id, revoked_at FROM approval_keys WHERE key_id=?').get(tablet.key.keyId), { device_id: null, revoked_at: null })
  assert.equal(s.db.prepare('SELECT device_id FROM approval_keys WHERE key_id=?').get(key.keyId).device_id, phone.deviceId)
  // The unlocking device works again, sockets too.
  assert.equal((await s.http('/me', { token: phone.token })).status, 200)
  const p = await socket(s, phone.token)
  t.after(() => p.w.close())
  assert.ok(!('panic' in p.hello))
  // The bridge has the clear at once, and the sweep does not send it again.
  await a.w.waitFor((f) => f.kind === 'panic' && f.on === false, 500)
  await tick(200)
  assert.deepEqual(panicFrames(a.w).map((f) => f.on), [true, false])
  // The switches stay off.
  assert.equal(getConsentEnabled(s.db, alice.id), false)
  // Recorded: the clear by the user on that device, the sign-out by the journal.
  await tick(10)
  const evs = cap.all().slice(from).map((e) => [e.event, e.device_id, e.device_name, e.target, e.decided_by])
  assert.deepEqual(evs, [
    ['panic_cleared', phone.deviceId, 'phone', null, 'user'],
    ['device_revoked', null, null, `device:${tablet.deviceId}`, 'journal'],
  ])
  const feed = (await s.http('/security-events?since=0', { token: FEED_TOKEN })).json.events
  assert.deepEqual(feed.filter((e) => e.event === 'panic_cleared').map((e) => [e.device_id, e.decided_by]), [[phone.deviceId, 'user']])
  // bob is untouched; unlocking again is 409.
  assert.equal((await s.http('/me', { token: bobPhone.token })).status, 200)
  const again = await unlock(s, phone.token, { approval: await signAccount(s, { token: phone.token, key, subject: { op: 'clear_panic', since: String(since) } }) })
  assert.deepEqual([again.status, again.json], [409, { error: 'not_locked' }])
})

test('an unlock closes the other devices\' sockets as a revoked device\'s are, without the panic frame', async (t) => {
  const { s, alice, phone, key } = await journal(t)
  assert.equal((await lockIt(s)).status, 200)
  // A socket of a device the lock missed, registered past the hello check.
  s.db.prepare('UPDATE panic_locks SET cleared_at=1 WHERE user_id=?').run(alice.id)
  const late = createClientDevice(s.db, alice.id, 'late')
  const l = await socket(s, late.token)
  const lClosed = closed(l.w)
  s.db.prepare('UPDATE panic_locks SET cleared_at=NULL WHERE user_id=?').run(alice.id)
  const r = await unlock(s, phone.token, { approval: await signUnlock(s, phone, key) })
  assert.deepEqual([r.status, r.json], [200, { ok: true, locked: false, devices_revoked: 1 }])
  assert.equal(await lClosed, 4001)
  assert.deepEqual(lockFrames(l.w), [{ kind: 'control', op: 'error', code: 'revoked' }])
  assert.equal(deviceExists(s, late.deviceId), false)
})

test('an unlock with no approval, or from an agent, is refused and the lock stays', async (t) => {
  const { s, alice, phone, key } = await journal(t)
  const box = createAgent(s.db, alice.id, 'box-a')
  // Not locked: 409, signed or not.
  assert.deepEqual((await unlock(s, phone.token)).json, { error: 'not_locked' })
  assert.equal((await unlock(s, phone.token)).status, 409)
  assert.equal((await lockIt(s)).status, 200)
  for (const body of [{}, { approval: null }]) {
    const r = await unlock(s, phone.token, body)
    assert.deepEqual([r.status, r.json], [403, { error: 'approval_required' }])
  }
  const agent = await unlock(s, box.token, { approval: await signUnlock(s, phone, key) })
  assert.deepEqual([agent.status, agent.json], [403, { error: 'forbidden' }])
  assert.equal(isPanicLocked(s.db, alice.id), true)
  assert.deepEqual(clientIds(s, alice.id), [phone.deviceId])
  // The panic token is no way in either.
  assert.equal((await unlock(s, PANIC_TOKEN)).status, 401)
})

test('an unlock signed over another lock\'s since is a mismatch; a statement is good once', async (t) => {
  const { s, alice, phone, key } = await journal(t)
  assert.equal((await lockIt(s)).status, 200)
  const wrong = await unlock(s, phone.token, { approval: await signUnlock(s, phone, key, lockedSince(s) - 1) })
  assert.deepEqual([wrong.status, wrong.json], [400, { error: 'approval_invalid', reason: 'mismatch' }])
  const other = await unlock(s, phone.token, { approval: await signAccount(s, { token: phone.token, key, subject: { op: 'clear_panic' } }) })
  assert.deepEqual(other.json, { error: 'approval_invalid', reason: 'mismatch' })
  assert.equal(isPanicLocked(s.db, alice.id), true)
  // The right one works, and not a second time against a later lock that
  // happens to have the same since.
  const approval = await signUnlock(s, phone, key)
  const since = lockedSince(s)
  assert.equal((await unlock(s, phone.token, { approval })).status, 200)
  lockAccount({ db: s.db, hub: s.hub, securityLog: { record() {} } }, alice.id, { now: since })
  assert.equal(lockedSince(s), since)
  const replay = await unlock(s, phone.token, { approval })
  assert.deepEqual([replay.status, replay.json], [400, { error: 'approval_invalid', reason: 'nonce' }])
  assert.equal(isPanicLocked(s.db, alice.id), true)
  assert.equal(deviceExists(s, phone.deviceId), true)
})

test('a key attached to another device does not unlock from this one', async (t) => {
  const { s, alice, phone, keyed } = await journal(t)
  const tablet = await keyed('tablet')
  assert.equal((await lockIt(s)).status, 200)
  const r = await unlock(s, phone.token, { approval: await signUnlock(s, phone, tablet.key) })
  assert.deepEqual([r.status, r.json], [400, { error: 'approval_invalid', reason: 'wrong_device' }])
  assert.equal(isPanicLocked(s.db, alice.id), true)
})

test('two invalid signatures on the unlock sign the frozen device out; the lock stays', async (t) => {
  const { s, cap, alice, phone, key } = await journal(t)
  assert.equal((await lockIt(s)).status, 200)
  for (let i = 0; i < 2; i += 1) {
    const r = await unlock(s, phone.token, { approval: await forgedUnlock(s, phone, key) })
    assert.deepEqual([r.status, r.json], [400, { error: 'approval_invalid', reason: 'signature' }])
    await tick(10)
  }
  assert.equal(deviceExists(s, phone.deviceId), false)
  assert.equal((await s.http('/me', { token: phone.token })).status, 401)
  assert.equal((await unlock(s, phone.token)).status, 401)
  assert.equal(isPanicLocked(s.db, alice.id), true)
  assert.equal(cap.all().filter((e) => e.event === 'device_signed_out_bad_signatures').length, 1)
  // The key is detached, not revoked.
  assert.deepEqual(s.db.prepare('SELECT device_id, revoked_at FROM approval_keys WHERE key_id=?').get(key.keyId), { device_id: null, revoked_at: null })
})

test('the unlock route is there with no panic token configured', async (t) => {
  const { s, alice, phone, key } = await journal(t, { panic: null })
  assert.equal((await lockIt(s)).status, 404)
  assert.equal((await unlock(s, phone.token)).status, 409)
  lockAccount({ db: s.db, hub: s.hub, securityLog: { record() {} } }, alice.id, {})
  assert.deepEqual((await s.http('/me', { token: phone.token })).json, FROZEN(s))
  const r = await unlock(s, phone.token, { approval: await signUnlock(s, phone, key) })
  assert.deepEqual([r.status, r.json], [200, { ok: true, locked: false, devices_revoked: 0 }])
  assert.equal((await s.http('/me', { token: phone.token })).status, 200)
})

test('a lock that commits while the unlock\'s body is on its way: the signed unlock still goes through', async (t) => {
  const { s, alice, phone, key } = await journal(t)
  assert.equal((await lockIt(s)).status, 200)
  const approval = await signUnlock(s, phone, key)
  const r = await delayedPost(s, '/panic/unlock', phone.token, { approval }, async () => {})
  assert.equal(r.status, 200)
  assert.equal(isPanicLocked(s.db, alice.id), false)
})

// ---- The host's clear ------------------------------------------------------------------

test('matron-admin panic clear with a frozen device: it works again, nobody is signed out', async (t) => {
  const { s, alice, phone, keyed } = await journal(t)
  const tablet = await keyed('tablet')
  assert.equal((await lockIt(s)).json.devices_frozen, 2)
  const out = await runAdmin(s.db, ['panic', 'clear', 'alice'])
  assert.match(out, /panic lock cleared/)
  assert.equal(isPanicLocked(s.db, alice.id), false)
  assert.deepEqual(clientIds(s, alice.id), [phone.deviceId, tablet.deviceId])
  assert.equal((await s.http('/me', { token: phone.token })).status, 200)
  assert.equal((await s.http('/me', { token: tablet.token })).status, 200)
  const p = await socket(s, phone.token)
  p.w.close()
  assert.deepEqual((await unlock(s, phone.token)).json, { error: 'not_locked' })
})
