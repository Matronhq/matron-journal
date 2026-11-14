// Panic lock (src/panic.js; docs/protocol.md "Panic lock"): an external
// watcher holding a panic token bound to one account locks that account
// with one request. The journal signs out its client devices, refuses new
// sign-ins, links and pairs, refuses new work for its boxes, and tells
// every bridge of the account to lock; the lock is cleared on the host.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { startTestServer, makeWsClient } from './helpers.js'
import { openDb } from '../src/db.js'
import { createUser, createAgent, createClientDevice } from '../src/auth.js'
import { upsertConversation } from '../src/journal.js'
import { hasActiveKey } from '../src/approval-keys.js'
import { getConsentEnabled, getTransferConsentEnabled, setTransferConsentEnabled } from '../src/consent.js'
import { resolvePanic, isPanicLocked } from '../src/panic.js'
import { answerSpawnAsk, answerChatAsk } from '../src/consent-answer.js'
import { approveSpawn, getSpawn } from '../src/spawns.js'
import { startTarget } from '../src/handover-session.js'
import { issueTalkStart } from '../src/talk-requests-events.js'
import { inviteGuest } from '../src/person-rooms.js'
import { deliverPendingInvites } from '../src/invite-delivery.js'
import { runAdmin } from '../bin/matron-admin.js'
import { generateApprovalKey, enableTwoFactor, enrolKeyByPassword, totpCode, TEST_PASSWORD } from './approval-helpers.js'
import { fleet, parkSpawn, parkInviteAsk, answer } from './consent-fleet.js'

const PANIC_TOKEN = 'panic_' + 'p'.repeat(40)
const FEED_TOKEN = 'feed_' + 'x'.repeat(40)
const WATCHER_IP = '198.51.100.9'
const tick = (ms = 30) => new Promise((r) => setTimeout(r, ms))
let ipSeq = 0
// A fresh caller address, so the /login budget (5 a minute per address)
// never gets in the way of what a test checks.
const freshIp = () => `192.0.2.${++ipSeq % 250 + 1}`

function capture() {
  const lines = []
  return {
    lines,
    out: (l) => lines.push(l),
    all: () => lines.map((l) => JSON.parse(l)),
    of: (event) => lines.map((l) => JSON.parse(l)).filter((e) => e.event === event),
  }
}
const panicOpts = (cap, extra = {}) => ({
  securityLog: { out: cap.out, file: null }, securityFeed: { token: FEED_TOKEN, account: 'alice' },
  panic: { token: PANIC_TOKEN, account: 'alice' }, ...extra,
})
const lockIt = (s, body = { source: 'watcher-1', alert: 'disk wiped on box-a' }, token = PANIC_TOKEN, headers = {}) =>
  s.http('/panic', { method: 'POST', token, body, headers: { 'cf-connecting-ip': WATCHER_IP, ...headers } })
const panicStatus = (s, token = PANIC_TOKEN) => s.http('/panic', { token, headers: { 'cf-connecting-ip': WATCHER_IP } })
const login = (s, username, password, device_name = 'laptop') =>
  s.http('/login', { method: 'POST', body: { username, password, device_name }, headers: { 'cf-connecting-ip': freshIp() } })
// Every account_locked body names since when.
const lockedSince = (s) => s.db.prepare('SELECT since FROM panic_locks WHERE cleared_at IS NULL').get()?.since
const LOCKED = (s) => ({ error: 'account_locked', since: lockedSince(s) })

async function journal(t, extra = {}) {
  const cap = capture()
  const s = await startTestServer(panicOpts(cap, extra))
  t.after(() => s.close())
  const alice = await createUser(s.db, 'alice', TEST_PASSWORD)
  const bob = await createUser(s.db, 'bob', 'pw-bob-123')
  return { s, cap, alice, bob }
}
const panicFrames = (w) => w.frames.filter((f) => f.kind === 'panic')
const clientCount = (s, userId) => s.db.prepare("SELECT COUNT(*) n FROM devices WHERE user_id=? AND kind='client'").get(userId).n
async function agentSocket(s, token) {
  const w = await makeWsClient(s.base, { token, cursor: null })
  const hello = await w.waitFor((f) => f.op === 'hello_ok')
  return { w, hello }
}
function closed(w) {
  return new Promise((resolve) => {
    if (w.ws.readyState === 3) { resolve(w.ws._closeCode); return }
    w.ws.on('close', (code) => resolve(code))
  })
}

// ---- Configuration and the token -------------------------------------------------

test('panic env: both set and a well-formed token, or off with one warning that never prints the token', () => {
  const warns = []
  const warn = (m) => warns.push(m)
  assert.equal(resolvePanic({}, { warn }), null)
  assert.deepEqual(resolvePanic({ token: PANIC_TOKEN, account: 'alice' }, { warn }), { token: PANIC_TOKEN, account: 'alice' })
  assert.equal(warns.length, 0)
  for (const token of ['short-secret', 'q'.repeat(129), 'has space'.padEnd(40, 'q'), 'q'.repeat(31)]) {
    assert.equal(resolvePanic({ token, account: 'alice' }, { warn }), null)
  }
  assert.equal(resolvePanic({ token: PANIC_TOKEN }, { warn }), null)
  assert.equal(resolvePanic({ account: 'alice' }, { warn }), null)
  assert.equal(warns.length, 6)
  assert.ok(warns.every((w) => !w.includes('qqqq') && !w.includes('short-secret') && !w.includes(PANIC_TOKEN)))
})

test('panic off (unset, or a malformed token with one warning): both routes 404 whatever the token, and nothing else changes', async (t) => {
  const cap = capture()
  const s = await startTestServer({ securityLog: { out: cap.out, file: null }, panic: null })
  t.after(() => s.close())
  const alice = await createUser(s.db, 'alice', TEST_PASSWORD)
  const phone = createClientDevice(s.db, alice.id, 'phone')
  const box = createAgent(s.db, alice.id, 'box-a')
  assert.equal((await lockIt(s)).status, 404)
  assert.equal((await panicStatus(s)).status, 404)
  assert.equal((await lockIt(s, {}, null)).status, 404)
  assert.equal((await lockIt(s, {}, phone.token)).status, 404)
  // An agent's hello has no panic key; sign-in works.
  const { hello } = await agentSocket(s, box.token)
  assert.ok(!('panic' in hello))
  assert.equal((await login(s, 'alice', TEST_PASSWORD)).status, 200)

  const warns = []
  const warn = t.mock.method(console, 'warn', (m) => warns.push(String(m)))
  const bad = await startTestServer({ panic: { token: 'too-short-to-be-a-token', account: 'alice' } })
  warn.mock.restore()
  t.after(() => bad.close())
  await createUser(bad.db, 'alice', TEST_PASSWORD)
  assert.equal((await bad.http('/panic', { method: 'POST', token: 'too-short-to-be-a-token', body: {} })).status, 404)
  assert.equal((await bad.http('/panic', { token: 'too-short-to-be-a-token' })).status, 404)
  assert.equal(warns.filter((w) => w.startsWith('panic:')).length, 1)
  assert.ok(warns.every((w) => !w.includes('too-short-to-be-a-token')))
})

test('the panic token: a missing or wrong one is 401; device, feed and admin tokens are 401; it opens no other route', async (t) => {
  const { s, alice } = await journal(t)
  s.db.prepare('UPDATE users SET is_admin=1 WHERE id=?').run(alice.id)
  const bob = s.db.prepare("SELECT id FROM users WHERE name='bob'").get()
  s.db.prepare('UPDATE users SET is_admin=1 WHERE id=?').run(bob.id)
  const phone = createClientDevice(s.db, alice.id, 'phone')
  const box = createAgent(s.db, alice.id, 'box-a')
  const bobPhone = createClientDevice(s.db, bob.id, 'phone')
  const from = () => ({ 'cf-connecting-ip': freshIp() })
  for (const token of [null, PANIC_TOKEN + 'q', phone.token, box.token, FEED_TOKEN, bobPhone.token]) {
    assert.equal((await s.http('/panic', { method: 'POST', token, body: {}, headers: from() })).status, 401, String(token))
    assert.equal((await s.http('/panic', { token, headers: from() })).status, 401, String(token))
  }
  assert.equal(isPanicLocked(s.db, alice.id), false)
  // The panic token is not a device token, an admin's or the feed's.
  for (const p of ['/me', '/devices', '/snapshot', '/roster', '/users', '/coordinator']) {
    assert.equal((await s.http(p, { token: PANIC_TOKEN })).status, 401, p)
  }
  assert.equal((await s.http('/security-events', { token: PANIC_TOKEN, headers: from() })).status, 401)
  assert.equal((await s.http('/devices/1/revoke', { method: 'POST', token: PANIC_TOKEN, body: {} })).status, 401)
  const w = await makeWsClient(s.base, { token: PANIC_TOKEN, cursor: null })
  const err = await w.waitFor((f) => f.op === 'error')
  assert.equal(err.code, 'auth')
  // Other methods on the path are no route of its own.
  assert.equal((await s.http('/panic', { method: 'PUT', token: PANIC_TOKEN, body: {} })).status, 401)
  assert.equal(isPanicLocked(s.db, alice.id), false)
})

test('bad panic tokens spend the per-address budget /login shares; once spent, the right token is refused too', async (t) => {
  const { s, alice } = await journal(t)
  for (let i = 0; i < 5; i++) assert.equal((await lockIt(s, {}, 'wrong-' + 'q'.repeat(40))).status, 401)
  assert.equal((await lockIt(s, {}, 'wrong-' + 'q'.repeat(40))).status, 429)
  assert.equal((await lockIt(s)).status, 429)
  assert.equal((await panicStatus(s)).status, 429)
  assert.equal(isPanicLocked(s.db, alice.id), false)
  // Another address: untouched, and the right token never spends it.
  for (let i = 0; i < 7; i++) assert.equal((await lockIt(s, {}, PANIC_TOKEN, { 'cf-connecting-ip': '203.0.113.50' })).status, 200)
})

test('the body: optional strings, stored and read back; a wrong type or a malformed body is 400 and locks nothing', async (t) => {
  const { s, alice } = await journal(t)
  assert.deepEqual((await panicStatus(s)).json, { locked: false, since: null, source: null, alert: null })
  for (const body of [{ source: 5 }, { alert: { x: 1 } }, { source: ['a'] }, { alert: true }]) {
    assert.equal((await lockIt(s, body)).status, 400, JSON.stringify(body))
  }
  const raw = await fetch(`${s.base}/panic`, { method: 'POST', headers: { authorization: `Bearer ${PANIC_TOKEN}`, 'content-type': 'application/json' }, body: '{not json' })
  assert.equal(raw.status, 400)
  const arr = await fetch(`${s.base}/panic`, { method: 'POST', headers: { authorization: `Bearer ${PANIC_TOKEN}`, 'content-type': 'application/json' }, body: '[1]' })
  assert.equal(arr.status, 400)
  assert.equal(isPanicLocked(s.db, alice.id), false)
  // No body at all locks, with nulls; extra keys are ignored.
  const before = Date.now()
  const r = await s.http('/panic', { method: 'POST', token: PANIC_TOKEN })
  assert.equal(r.status, 200)
  assert.deepEqual(r.json, { ok: true, locked: true, already_locked: false, devices_revoked: 0, bridges_notified: 0 })
  const st = (await panicStatus(s)).json
  assert.equal(st.locked, true)
  assert.ok(st.since >= before && st.since <= Date.now())
  assert.equal(st.source, null)
  assert.equal(st.alert, null)
  // A second call keeps the first lock's since, source and alert.
  const again = await lockIt(s, { source: 'other', alert: 'other', extra: 1 })
  assert.equal(again.json.already_locked, true)
  assert.deepEqual((await panicStatus(s)).json, st)
})

test('the stored source and alert are at most 200 characters each', async (t) => {
  const { s } = await journal(t)
  assert.equal((await lockIt(s, { source: 's'.repeat(300), alert: '😀'.repeat(250) })).status, 200)
  const st = (await panicStatus(s)).json
  assert.equal(st.source, 's'.repeat(200))
  assert.equal(st.alert, '😀'.repeat(200))
})

// ---- The lock -----------------------------------------------------------------------

test('POST /panic: client devices signed out (keys detached), their sockets closed, agents told, switches off; idempotent; another account untouched', async (t) => {
  const { s, alice, bob, cap } = await journal(t, { tokenKey: 'ab'.repeat(32), publicUrl: 'https://journal.example' })
  // alice: a phone with an approval key, a laptop with an open socket, two
  // connected boxes and one that is not connected.
  const phone = createClientDevice(s.db, alice.id, 'phone')
  const { secret } = await enableTwoFactor(s, phone.token)
  const key = await enrolKeyByPassword(s, { token: phone.token, userId: alice.id, secret, key: generateApprovalKey() })
  const laptop = createClientDevice(s.db, alice.id, 'laptop')
  const boxA = createAgent(s.db, alice.id, 'box-a')
  const boxB = createAgent(s.db, alice.id, 'box-b')
  createAgent(s.db, alice.id, 'box-c')
  setTransferConsentEnabled(s.db, alice.id, true)
  assert.equal(getConsentEnabled(s.db, alice.id), true)
  const laptopWs = await makeWsClient(s.base, { token: laptop.token, cursor: null })
  await laptopWs.waitFor((f) => f.op === 'hello_ok')
  const a = await agentSocket(s, boxA.token)
  const b = await agentSocket(s, boxB.token)
  assert.ok(!('panic' in a.hello))
  // bob: a client, a box with a socket.
  const bobPhone = createClientDevice(s.db, bob.id, 'phone')
  const bobBox = createAgent(s.db, bob.id, 'box-a')
  const bb = await agentSocket(s, bobBox.token)
  t.after(() => { for (const w of [laptopWs, a.w, b.w, bb.w]) { try { w.close() } catch { /* closed */ } } })

  const laptopClosed = closed(laptopWs)
  const before = Date.now()
  const r = await lockIt(s, { source: 'watcher-1', alert: 'disk wiped on box-a' })
  assert.equal(r.status, 200)
  assert.deepEqual(r.json, { ok: true, locked: true, already_locked: false, devices_revoked: 2, bridges_notified: 2 })
  assert.deepEqual(Object.keys(r.json), ['ok', 'locked', 'already_locked', 'devices_revoked', 'bridges_notified'])
  // Client devices gone, the open socket closed as a revoked one is.
  assert.equal(clientCount(s, alice.id), 0)
  assert.equal(await laptopClosed, 4001)
  // Told first that the account is locked (no source), then closed as a
  // revoked device's socket is.
  const lf = laptopWs.frames.filter((f) => f.kind === 'panic' || (f.kind === 'control' && f.op === 'error'))
  assert.deepEqual(lf, [{ kind: 'panic', on: true, since: lockedSince(s) }, { kind: 'control', op: 'error', code: 'revoked' }])
  assert.equal((await s.http('/me', { token: phone.token })).status, 401)
  // The approval key stays enrolled, detached.
  const k = s.db.prepare('SELECT device_id, revoked_at FROM approval_keys WHERE key_id=?').get(key.keyId)
  assert.deepEqual(k, { device_id: null, revoked_at: null })
  assert.equal(hasActiveKey(s.db, alice.id), true)
  // Agents stay; each connected one got exactly the frame.
  assert.equal(s.db.prepare("SELECT COUNT(*) n FROM devices WHERE user_id=? AND kind='agent'").get(alice.id).n, 3)
  for (const w of [a.w, b.w]) {
    await w.waitFor((f) => f.kind === 'panic')
    const frames = panicFrames(w)
    assert.equal(frames.length, 1)
    assert.deepEqual(Object.keys(frames[0]), ['kind', 'on', 'since', 'source'])
    assert.equal(frames[0].on, true)
    assert.equal(frames[0].source, 'watcher-1')
    assert.ok(frames[0].since >= before && frames[0].since <= Date.now())
  }
  assert.equal(a.w.ws.readyState, 1)
  // Both Coordinator switches off.
  assert.equal(getConsentEnabled(s.db, alice.id), false)
  assert.equal(getTransferConsentEnabled(s.db, alice.id), false)
  const st = (await panicStatus(s)).json
  assert.deepEqual(st, { locked: true, since: panicFrames(a.w)[0].since, source: 'watcher-1', alert: 'disk wiped on box-a' })

  // Again: the same shape, nothing revoked, the frame sent again.
  const again = await lockIt(s, { source: 'watcher-2' })
  assert.deepEqual(again.json, { ok: true, locked: true, already_locked: true, devices_revoked: 0, bridges_notified: 2 })
  await a.w.waitFor((f) => f.kind === 'panic' && panicFrames(a.w).length === 2)
  assert.deepEqual(panicFrames(a.w)[1], panicFrames(a.w)[0])
  assert.deepEqual((await panicStatus(s)).json, st)

  // bob: nothing at all.
  await tick(50)
  assert.equal(panicFrames(bb.w).length, 0)
  assert.equal(clientCount(s, bob.id), 1)
  assert.equal((await s.http('/me', { token: bobPhone.token })).status, 200)
  assert.equal((await login(s, 'bob', 'pw-bob-123')).status, 200)
  assert.equal(getConsentEnabled(s.db, bob.id), true)
  assert.equal(isPanicLocked(s.db, bob.id), false)
  assert.ok(cap.all().every((e) => e.account === 'alice' || !e.event.startsWith('panic')))
})

test('while locked: sign-in, two-factor sign-in, link and pair are 423 before any password or code is checked; no lockout is counted; another account signs in', async (t) => {
  const { s, alice, bob } = await journal(t, { tokenKey: 'ab'.repeat(32) })
  // A two-factor sign-in started before the lock, a link claimed and a pair
  // approved before it.
  const phone = createClientDevice(s.db, alice.id, 'phone')
  const { secret } = await enableTwoFactor(s, phone.token)
  const ticket = (await login(s, 'alice', TEST_PASSWORD)).json.two_factor_ticket
  assert.ok(ticket)
  const pair = (await s.http('/pair/start', { method: 'POST', body: {}, headers: { 'cf-connecting-ip': freshIp() } })).json
  assert.equal((await s.http('/pair/approve', { method: 'POST', token: phone.token, body: { pair_code: pair.pair_code, agent_name: 'box-z' } })).status, 200)
  const preKey = { 'x-preapprove-key': s.preapproveKey }
  const minted = async () => (await s.http('/link/preapprove', { method: 'POST', body: { username: 'alice' }, headers: preKey })).json.link_code
  const claimedEarly = (await s.http('/link/claim', { method: 'POST', body: { link_code: await minted(), device_name: 'tablet' }, headers: { 'cf-connecting-ip': freshIp() } })).json
  const unclaimed = await minted()

  assert.equal((await lockIt(s)).status, 200)
  // The right password and a wrong one: the same 423, none counted.
  for (let i = 0; i < 7; i++) {
    const r = await login(s, 'alice', i % 2 ? TEST_PASSWORD : 'wrong-password')
    assert.equal(r.status, 423)
    assert.deepEqual(r.json, LOCKED(s))
  }
  // A two-factor sign-in started before the lock: its ticket went with it.
  let r = await s.http('/login/2fa', { method: 'POST', body: { ticket, code: totpCode(s, alice.id, secret) }, headers: { 'cf-connecting-ip': freshIp() } })
  assert.deepEqual([r.status, r.json.error], [401, 'two_factor_ticket_invalid'])
  // One that got through anyway (the lock row written with no request,
  // as a backstop): every step 423 before the code is looked at.
  const since = lockedSince(s)
  s.db.prepare('UPDATE panic_locks SET cleared_at=1').run()
  const late = (await login(s, 'alice', TEST_PASSWORD)).json.two_factor_ticket
  assert.ok(late)
  s.db.prepare('UPDATE panic_locks SET cleared_at=NULL').run()
  assert.equal(lockedSince(s), since)
  for (const code of [totpCode(s, alice.id, secret), '000000']) {
    r = await s.http('/login/2fa', { method: 'POST', body: { ticket: late, code }, headers: { 'cf-connecting-ip': freshIp() } })
    assert.deepEqual([r.status, r.json], [423, LOCKED(s)])
  }
  for (const step of ['/login/2fa/setup', '/login/2fa/enable']) {
    r = await s.http(step, { method: 'POST', body: { ticket: late, code: '000000' }, headers: { 'cf-connecting-ip': freshIp() } })
    assert.equal(r.status, 401, step) // a verify ticket is no enrol ticket: unchanged
  }
  r = await s.http('/link/claim', { method: 'POST', body: { link_code: unclaimed, device_name: 'tablet' }, headers: { 'cf-connecting-ip': freshIp() } })
  assert.deepEqual([r.status, r.json], [423, LOCKED(s)])
  r = await s.http('/link/poll', { method: 'POST', body: { claim_token: claimedEarly.claim_token } })
  assert.deepEqual([r.status, r.json], [423, LOCKED(s)])
  r = await s.http('/pair/claim', { method: 'POST', body: { poll_token: pair.poll_token } })
  assert.deepEqual([r.status, r.json], [423, LOCKED(s)])
  assert.equal(clientCount(s, alice.id), 0)
  assert.equal(s.db.prepare("SELECT COUNT(*) n FROM devices WHERE user_id=? AND name='box-z'").get(alice.id).n, 0)
  // bob signs in as ever.
  assert.equal((await login(s, 'bob', 'pw-bob-123')).status, 200)

  // A client token that still works (a device made by a path the lock
  // missed): 423 on any route, and the device is signed out.
  for (const [p, method] of [['/me', 'GET'], ['/link/start', 'POST'], ['/pair/approve', 'POST'], ['/devices', 'GET']]) {
    const late = createClientDevice(s.db, alice.id, 'late')
    const res = await s.http(p, { method, token: late.token, body: method === 'POST' ? { pair_code: 'X', agent_name: 'y' } : null })
    assert.deepEqual([res.status, res.json], [423, LOCKED(s)], p)
    assert.equal(s.db.prepare('SELECT 1 FROM devices WHERE id=?').get(late.deviceId), undefined, p)
  }

  // Cleared on the host: the password works at once, no lockout from the
  // wrong ones above (it asks for the code: two-factor is on).
  await runAdmin(s.db, ['panic', 'clear', 'alice'])
  r = await login(s, 'alice', TEST_PASSWORD)
  assert.equal(r.json.error, 'two_factor_required')
  const done = await s.http('/login/2fa', { method: 'POST', body: { ticket: r.json.two_factor_ticket, code: totpCode(s, alice.id, secret) }, headers: { 'cf-connecting-ip': freshIp() } })
  assert.equal(done.status, 200)
  // The two-factor sign-in started before the lock does not finish after it.
  r = await s.http('/login/2fa', { method: 'POST', body: { ticket, code: totpCode(s, alice.id, secret) }, headers: { 'cf-connecting-ip': freshIp() } })
  assert.equal(r.status, 401)
  void bob
})

test('while locked: no new work reaches a box: consent answers, session control, client agent_request; agents stay connected', async (t) => {
  const cap = capture()
  const f = await fleet(t, panicOpts(cap, { revocationSweepMs: 60000 }))
  const { s, alice } = f
  const spawnId = await parkSpawn(f)
  await parkInviteAsk(f)
  upsertConversation(s.db, { id: 'tgt', ownerUserId: alice.id, title: 'Target', agentDeviceId: f.targetDev.deviceId })
  assert.equal((await lockIt(s)).status, 200)
  await f.target.waitFor((x) => x.kind === 'panic')
  const clientGone = closed(f.client)
  assert.equal(await clientGone, 4001)
  // Turned back on from the host: the Coordinator is still refused.
  setTransferConsentEnabled(s.db, alice.id, true)
  s.db.prepare('UPDATE user_settings SET coordinator_consent=1 WHERE user_id=?').run(alice.id)
  for (const body of [
    { kind: 'spawn', id: spawnId, decision: 'approve', reason: 'ok' },
    { kind: 'chat', id: `room/${f.targetDev.deviceId}`, decision: 'approve', reason: 'ok' },
    { kind: 'transfer', id: 'tr_' + 'a'.repeat(24), decision: 'approve', reason: 'ok' },
  ]) {
    const r = await answer(f, f.coordDev.token, body)
    assert.deepEqual([r.status, r.json], [403, { error: 'forbidden', detail: 'account_locked', since: lockedSince(s) }], body.kind)
  }
  // The answer paths themselves refuse an approval whoever gives it.
  const ctx = { db: s.db, hub: s.hub, broker: s.broker, waker: null }
  const user = { kind: 'user', deviceId: 999 }
  assert.deepEqual(answerSpawnAsk(ctx, { userId: alice.id, requestId: spawnId, decision: 'approve', decidedBy: user }), { status: 403, body: { error: 'forbidden', detail: 'account_locked', since: lockedSince(s) } })
  assert.deepEqual(answerChatAsk(ctx, { userId: alice.id, roomId: 'room', targetDeviceId: f.targetDev.deviceId, decision: 'approve', decidedBy: user }), { status: 403, body: { error: 'forbidden', detail: 'account_locked', since: lockedSince(s) } })
  assert.equal(getSpawn(s.db, spawnId).state, 'awaiting_user')
  // Session control from the Coordinator.
  f.coord.send({ op: 'session_control', request_id: 'sc1', from_convo_id: 'coord', target_convo_id: 'tgt', action: 'compact' })
  const err = await f.coord.waitFor((x) => x.kind === 'control' && x.op === 'error' && x.request_id === 'sc1')
  assert.deepEqual(err, { kind: 'control', op: 'error', code: 'forbidden', ref: 'session_control', request_id: 'sc1', detail: 'account_locked', since: lockedSince(s) })
  // A client socket of the account that is still open (the lock written
  // straight to the table, no sign-out): its agent_request is refused and
  // the device signed out.
  s.db.prepare('UPDATE panic_locks SET cleared_at=1 WHERE user_id=?').run(alice.id)
  const late = createClientDevice(s.db, alice.id, 'late')
  const lw = await makeWsClient(s.base, { token: late.token, cursor: null })
  await lw.waitFor((x) => x.op === 'hello_ok')
  s.db.prepare('UPDATE panic_locks SET cleared_at=NULL WHERE user_id=?').run(alice.id)
  const lwClosed = closed(lw)
  lw.send({ op: 'agent_request', request_id: 'rq1', agent_device_id: f.targetDev.deviceId, method: 'start', params: { workdir: '/w', prompt: 'p' } })
  const rqErr = await lw.waitFor((x) => x.kind === 'control' && x.op === 'error' && x.request_id === 'rq1')
  assert.deepEqual(rqErr, { kind: 'control', op: 'error', code: 'account_locked', ref: 'agent_request', request_id: 'rq1', since: lockedSince(s) })
  assert.equal(await lwClosed, 4001)
  assert.ok(lw.frames.some((x) => x.kind === 'panic' && x.on === true && x.since === lockedSince(s)))
  assert.equal(s.db.prepare('SELECT 1 FROM devices WHERE id=?').get(late.deviceId), undefined)
  // ... and a client hello of the account is refused the same way.
  const late2 = createClientDevice(s.db, alice.id, 'late-2')
  const lw2 = await makeWsClient(s.base, { token: late2.token, cursor: null })
  await closed(lw2)
  // The auth error's shape, with account_locked and since; the usual close.
  assert.deepEqual(lw2.frames, [{ kind: 'control', op: 'error', code: 'account_locked', since: lockedSince(s) }])
  assert.ok(!lw2.frames.some((x) => x.op === 'hello_ok'))
  assert.equal(s.db.prepare('SELECT 1 FROM devices WHERE id=?').get(late2.deviceId), undefined)
  // Nothing reached the target box but the panic frame; every agent is
  // still connected and may still publish.
  await tick(100)
  assert.deepEqual(f.target.frames.filter((x) => x.kind === 'rpc' || (x.kind === 'invite' && x.event === 'request')), [])
  for (const w of [f.coord, f.asker, f.target]) assert.equal(w.ws.readyState, 1)
  f.asker.send({ op: 'publish', convo_id: 'ask', type: 'text', payload: { body: 'still here' } })
  await tick(100)
  assert.ok(s.db.prepare("SELECT 1 FROM events WHERE convo_id='ask' AND payload LIKE '%still here%'").get())
})

test('while locked: routine fires and alert deliveries are not sent; approved work is held; a hand-over, talk or guest invite is refused', async (t) => {
  const cap = capture()
  const f = await fleet(t, panicOpts(cap, { alertWebhook: { token: 'alert_' + 'a'.repeat(40), username: 'alice' } }))
  const { s, alice } = f
  const spawnId = await parkSpawn(f)
  await parkInviteAsk(f)
  // Approved before the lock (a host approval: the invite waits for the
  // sweep's delivery pump), and a spawn approved whose start has not gone out.
  await runAdmin(s.db, ['agent-chat', 'approve', 'alice', 'room', String(f.targetDev.deviceId)])
  assert.equal((await lockIt(s)).status, 200)
  await f.coord.waitFor((x) => x.kind === 'panic')
  // The routine firer: not delivered, not retried.
  const routine = s.db.prepare('SELECT * FROM routines WHERE user_id=? LIMIT 1').get(alice.id)
  assert.ok(routine)
  assert.equal(await s.routineFirer.fire(routine), 'account_locked')
  assert.equal(s.db.prepare('SELECT last_outcome, retry_at FROM routines WHERE id=?').get(routine.id).last_outcome, 'account_locked')
  // An alert.
  const alert = await s.http('/alerts/alertmanager', { method: 'POST', token: 'alert_' + 'a'.repeat(40), body: { version: '4', status: 'firing', alerts: [{ status: 'firing', labels: { alertname: 'DiskSpaceLow' } }] } })
  assert.deepEqual([alert.status, alert.json], [202, { delivered: false, reason: 'account_locked' }])
  // The approved invite is held by the delivery pump.
  assert.equal(deliverPendingInvites(s.db, s.hub, { deviceId: f.targetDev.deviceId }), 0)
  // A spawn approved before the lock whose start had not gone out.
  s.db.prepare("UPDATE agent_spawn_requests SET state='approved' WHERE id=?").run(spawnId)
  let issued = 0
  const broker = { issue: async () => { issued += 1; return { ok: true, result: { convo_id: 'x' } } } }
  assert.equal(await approveSpawn({ db: s.db, hub: s.hub, broker, startTimeoutMs: 1000 }, getSpawn(s.db, spawnId)), 'failed')
  assert.equal(issued, 0)
  // Hand-over and talk session starts, and inviting a guest box.
  assert.deepEqual(startTarget(s.db, alice.id, { device_id: f.targetDev.deviceId }), { refused: 'account_locked' })
  assert.deepEqual(startTarget(s.db, alice.id, 'coordinator'), { refused: 'account_locked' })
  const talk = await issueTalkStart({ db: s.db, hub: s.hub, broker }, { guest_user_id: alice.id, owner_name: 'bob', topic: 'x' }, { deviceId: f.targetDev.deviceId })
  assert.deepEqual(talk, { convoId: null, code: 'account_locked' })
  assert.equal(issued, 0)
  assert.throws(() => inviteGuest(s.db, { guest_user_id: alice.id, guest_device_id: f.targetDev.deviceId }, Date.now()), /account_locked/)
  await tick(100)
  assert.deepEqual(f.target.frames.filter((x) => x.kind === 'rpc' || (x.kind === 'invite' && x.event === 'request')), [])
  assert.deepEqual(f.coord.frames.filter((x) => x.kind === 'rpc'), [])

  // Cleared: the held invite goes out.
  await runAdmin(s.db, ['panic', 'clear', 'alice'])
  assert.equal(deliverPendingInvites(s.db, s.hub, { deviceId: f.targetDev.deviceId }), 1)
})

test('hello_ok.panic: on every agent hello while locked, after a restart on the same file too; absent before and after a clear; never for a client', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'panic-restart-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const dbPath = path.join(dir, 'journal.db')
  const cap = capture()
  let s = await startTestServer(panicOpts(cap, { dbPath }))
  const alice = await createUser(s.db, 'alice', TEST_PASSWORD)
  const bob = await createUser(s.db, 'bob', 'pw-bob-123')
  const box = createAgent(s.db, alice.id, 'box-a')
  const bobBox = createAgent(s.db, bob.id, 'box-a')
  let h = await agentSocket(s, box.token)
  assert.ok(!('panic' in h.hello))
  h.w.close()
  assert.equal((await lockIt(s, { source: 'watcher-1' })).status, 200)
  const since = (await panicStatus(s)).json.since
  for (let i = 0; i < 2; i++) {
    h = await agentSocket(s, box.token)
    assert.deepEqual(h.hello.panic, { on: true, since, source: 'watcher-1' })
    h.w.close()
  }
  const hb = await agentSocket(s, bobBox.token)
  assert.ok(!('panic' in hb.hello))
  hb.w.close()
  await s.close()
  // A new journal on the same file: read from the database.
  s = await startTestServer(panicOpts(cap, { dbPath }))
  t.after(() => s.close())
  h = await agentSocket(s, box.token)
  assert.deepEqual(h.hello.panic, { on: true, since, source: 'watcher-1' })
  h.w.close()
  await runAdmin(s.db, ['panic', 'clear', 'alice'])
  h = await agentSocket(s, box.token)
  assert.ok(!('panic' in h.hello))
  h.w.close()
})

test('clear from the host on a second connection: status reads it, connected bridges get the clear frame once within the periodic check, sign-in works, switches stay off', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'panic-clear-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const dbPath = path.join(dir, 'journal.db')
  const cap = capture()
  const s = await startTestServer(panicOpts(cap, { dbPath, revocationSweepMs: 40 }))
  t.after(() => s.close())
  const alice = await createUser(s.db, 'alice', TEST_PASSWORD)
  const bob = await createUser(s.db, 'bob', 'pw-bob-123')
  await createUser(s.db, 'carol', 'pw-carol-12')
  const box = createAgent(s.db, alice.id, 'box-a')
  const bobBox = createAgent(s.db, bob.id, 'box-a')
  const a = await agentSocket(s, box.token)
  const bb = await agentSocket(s, bobBox.token)
  t.after(() => { a.w.close(); bb.w.close() })
  const db2 = openDb(dbPath)
  t.after(() => db2.close())
  const securityLog = { record: () => {} }
  assert.match(await runAdmin(db2, ['panic', 'status', 'alice'], { securityLog }), /^alice: not locked$/)
  assert.equal((await lockIt(s, { source: 'watcher-1', alert: 'disk wiped on box-a' })).status, 200)
  await a.w.waitFor((f) => f.kind === 'panic')
  const since = (await panicStatus(s)).json.since
  const status = await runAdmin(db2, ['panic', 'status', 'alice'], { securityLog })
  assert.equal(status, `alice: locked since ${new Date(since).toISOString()} (source: "watcher-1", alert: "disk wiped on box-a")`)
  await tick(150)
  assert.equal(panicFrames(a.w).length, 1)

  const out = await runAdmin(db2, ['panic', 'clear', 'alice'], { securityLog })
  assert.match(out, /^alice: panic lock cleared/)
  assert.deepEqual((await panicStatus(s)).json, { locked: false, since: null, source: null, alert: null })
  await a.w.waitFor((f) => f.kind === 'panic' && f.on === false, 2000)
  await tick(200)
  assert.deepEqual(panicFrames(a.w).slice(1), [{ kind: 'panic', on: false }])
  assert.equal(panicFrames(bb.w).length, 0)
  assert.equal((await login(s, 'alice', TEST_PASSWORD)).status, 200)
  assert.equal(getConsentEnabled(s.db, alice.id), false)
  assert.equal(getTransferConsentEnabled(s.db, alice.id), false)
  assert.equal(await runAdmin(db2, ['panic', 'status', 'alice'], { securityLog }), 'alice: not locked')
  // Clearing an account that is not locked says so, and does not fail.
  assert.equal(await runAdmin(db2, ['panic', 'clear', 'alice'], { securityLog }), 'alice: not locked; nothing to clear')
  assert.equal(await runAdmin(db2, ['panic', 'clear', 'carol'], { securityLog }), 'carol: not locked; nothing to clear')
  await assert.rejects(runAdmin(db2, ['panic', 'clear', 'nobody'], { securityLog }), /no such user/)
  await assert.rejects(runAdmin(db2, ['panic', 'lock', 'alice'], { securityLog }), /usage/)
  // Locked again later: told again, and the next clear is sent again.
  assert.equal((await lockIt(s)).status, 200)
  await a.w.waitFor((f) => f.kind === 'panic' && panicFrames(a.w).length === 3)
  await runAdmin(db2, ['panic', 'clear', 'alice'], { securityLog })
  await a.w.waitFor((f) => f.kind === 'panic' && panicFrames(a.w).length === 4, 2000)
  assert.deepEqual(panicFrames(a.w)[3], { kind: 'panic', on: false })
})

// ---- Security events -------------------------------------------------------------------

test('security events: panic_locked once, a device_revoked per client signed out, the switches that changed, panic_cleared from the host; no line has the alert', async (t) => {
  const { s, cap, alice } = await journal(t)
  const phone = createClientDevice(s.db, alice.id, 'phone')
  const laptop = createClientDevice(s.db, alice.id, 'laptop')
  createAgent(s.db, alice.id, 'box-a')
  const from = cap.lines.length
  assert.equal((await lockIt(s, { source: 'watcher "1"\nx', alert: 'ALERT-TEXT-secret' })).status, 200)
  await tick(10)
  const evs = cap.all().slice(from)
  const pick = (e) => [e.event, e.account, e.device_id, e.device_name, e.source_ip, e.target, e.decided_by]
  assert.deepEqual(evs.map(pick), [
    ['panic_locked', 'alice', null, null, WATCHER_IP, 'watcher "1"\nx', 'journal'],
    ['device_revoked', 'alice', null, null, WATCHER_IP, `device:${phone.deviceId}`, 'journal'],
    ['device_revoked', 'alice', null, null, WATCHER_IP, `device:${laptop.deviceId}`, 'journal'],
    ['consent_switch_changed', 'alice', null, null, WATCHER_IP, 'spawns', 'journal'],
  ])
  // A second call: nothing new happened, nothing recorded.
  assert.equal((await lockIt(s)).status, 200)
  await tick(10)
  assert.equal(cap.lines.length, from + 4)
  // A device made since: signed out by the next call, recorded; and a
  // client token that still worked, signed out on use.
  const late = createClientDevice(s.db, alice.id, 'late')
  assert.equal((await lockIt(s)).json.devices_revoked, 1)
  const later = createClientDevice(s.db, alice.id, 'later')
  assert.equal((await s.http('/me', { token: later.token })).status, 423)
  await tick(10)
  assert.deepEqual(cap.all().slice(from + 4).map((e) => [e.event, e.target, e.decided_by]), [
    ['device_revoked', `device:${late.deviceId}`, 'journal'],
    ['device_revoked', `device:${later.deviceId}`, 'journal'],
  ])
  // The clear, from the host, in the database and the feed.
  const n = cap.lines.length
  await runAdmin(s.db, ['panic', 'clear', 'alice'], { securityLog: { record: (u, ev, f) => cap.out(JSON.stringify({ event: ev, account: 'alice', target: f.target ?? null, decided_by: f.decidedBy, device_id: f.deviceId })) } })
  assert.deepEqual(cap.all().slice(n).map((e) => [e.event, e.decided_by, e.device_id]), [['panic_cleared', 'admin_cli', null]])
  await runAdmin(s.db, ['panic', 'clear', 'alice'])
  const feed = (await s.http('/security-events?since=0', { token: FEED_TOKEN })).json.events
  assert.deepEqual(feed.filter((e) => e.event.startsWith('panic')).map((e) => [e.event, e.decided_by]), [['panic_locked', 'journal']])
  // Every line JSON, none with the alert.
  assert.ok(cap.lines.every((l) => !l.includes('ALERT-TEXT-secret')))
  assert.ok(feed.every((e) => !JSON.stringify(e).includes('ALERT-TEXT-secret')))
})

test("the host's clear is recorded in the database through the CLI's own log", async (t) => {
  const { s, alice } = await journal(t)
  assert.equal((await lockIt(s)).status, 200)
  await runAdmin(s.db, ['panic', 'clear', 'alice'])
  const feed = (await s.http('/security-events?since=0', { token: FEED_TOKEN })).json.events
  const cleared = feed.filter((e) => e.event === 'panic_cleared')
  assert.equal(cleared.length, 1)
  assert.deepEqual([cleared[0].decided_by, cleared[0].device_id, cleared[0].source_ip, cleared[0].target], ['admin_cli', null, null, null])
  assert.equal(isPanicLocked(s.db, alice.id), false)
})
