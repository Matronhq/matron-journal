// Security event feed (src/security-log.js; docs/protocol.md "Security
// event feed"): one line per security event, numbered per account, on
// stdout, in an optional file and in the database, read back by an external
// watcher through GET /security-events with a read-only token bound to one
// account.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { startTestServer, makeWsClient } from './helpers.js'
import { openDb } from '../src/db.js'
import { createUser, createAgent, createClientDevice } from '../src/auth.js'
import { upsertConversation } from '../src/journal.js'
import { issueNonce } from '../src/approval-keys.js'
import { base32Decode, hotp, totpStep, setTwoFactorRequired } from '../src/two-factor.js'
import {
  makeSecurityLog, readSecurityEvents, resolveSecurityFeed, SECURITY_EVENT_KEEP_MS,
} from '../src/security-log.js'
import { runAdmin } from '../bin/matron-admin.js'
import {
  startWithKey, signIn, signAccount, enableTwoFactor, enrolKeyByPassword, generateApprovalKey, totpCode, TEST_PASSWORD,
} from './approval-helpers.js'
import { fleet, parkSpawn, parkInviteAsk, answer } from './consent-fleet.js'

const FEED_TOKEN = 'feed_' + 'x'.repeat(40)
const IP = '203.0.113.7'
const DAY = 24 * 3600000
const tick = (ms = 30) => new Promise((r) => setTimeout(r, ms))

// Captured lines, parsed, and the feed's page.
function capture() {
  const lines = []
  return {
    lines,
    out: (l) => lines.push(l),
    all: () => lines.map((l) => JSON.parse(l)),
    of: (event) => lines.map((l) => JSON.parse(l)).filter((e) => e.event === event),
  }
}
const serverOpts = (cap, extra = {}) => ({ securityLog: { out: cap.out }, securityFeed: { token: FEED_TOKEN, account: 'alice' }, ...extra })
const feed = (s, query = '', token = FEED_TOKEN) => s.http(`/security-events${query}`, { token })

async function journal(t, extra = {}) {
  const cap = capture()
  const s = await startTestServer(serverOpts(cap, extra))
  t.after(() => s.close())
  const alice = await createUser(s.db, 'alice', TEST_PASSWORD)
  return { s, cap, alice }
}

// The one event `name` captured since `from`, checked to be the only one.
function one(cap, name, from = 0) {
  const hits = cap.all().slice(from).filter((e) => e.event === name)
  assert.equal(hits.length, 1, `${name}: ${JSON.stringify(cap.all().slice(from))}`)
  return hits[0]
}
const pick = (e) => ({ account: e.account, device_id: e.device_id, device_name: e.device_name, target: e.target, decided_by: e.decided_by })

// ---- The log itself -----------------------------------------------------------

test('seq starts at 1 per account, counts every event of it, apart from other accounts; line = row = feed object', async () => {
  const db = openDb(':memory:')
  const cap = capture()
  let clock = 1000
  const log = makeSecurityLog({ db, out: cap.out, file: null, now: () => clock++ })
  const alice = await createUser(db, 'alice', 'pw-alice-1')
  const bob = await createUser(db, 'bob', 'pw-bob-123')
  const phone = createClientDevice(db, alice.id, 'phone')
  log.record(alice.id, 'password_changed', { deviceId: phone.deviceId, sourceIp: IP, decidedBy: 'user' })
  log.record(bob.id, 'client_signin', { decidedBy: 'user' })
  log.record(alice.id, 'device_revoked', { deviceId: phone.deviceId, target: 'device:9', decidedBy: 'user' })
  log.record(alice.id, 'enrolment_locked', { target: '1h', decidedBy: 'journal' })
  const all = cap.all()
  assert.deepEqual(all.map((e) => [e.account, e.seq, e.event]), [
    ['alice', 1, 'password_changed'], ['bob', 1, 'client_signin'], ['alice', 2, 'device_revoked'], ['alice', 3, 'enrolment_locked'],
  ])
  assert.deepEqual(all[0], {
    kind: 'matron_security', seq: 1, ts: 1000, event: 'password_changed', account: 'alice',
    device_id: phone.deviceId, device_name: 'phone', source_ip: IP, target: null, decided_by: 'user',
  })
  // The exact key order of the contract.
  assert.deepEqual(Object.keys(JSON.parse(cap.lines[0])), ['kind', 'seq', 'ts', 'event', 'account', 'device_id', 'device_name', 'source_ip', 'target', 'decided_by'])
  const page = readSecurityEvents(db, alice.id, { since: 0 })
  assert.deepEqual(page, { account: 'alice', last_seq: 3, events: all.filter((e) => e.account === 'alice') })
  assert.deepEqual(readSecurityEvents(db, bob.id).events, [all[1]])
  // Unknown names and deciders are not invented: nothing for a typo.
  log.record(alice.id, 'no_such_event', {})
  assert.equal(cap.lines.length, 4)
  db.close()
})

test('seq survives a restart on the same database file, and the 30-day sweep never lets a number come back', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'security-events-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const file = path.join(dir, 'journal.db')
  let db = openDb(file)
  const alice = await createUser(db, 'alice', 'pw-alice-1')
  const old = Date.now() - SECURITY_EVENT_KEEP_MS - DAY
  let log = makeSecurityLog({ db, out: () => {}, file: null, now: () => old })
  log.record(alice.id, 'client_signin', {})
  log.record(alice.id, 'password_changed', {})
  db.close()
  db = openDb(file)
  const cap = capture()
  log = makeSecurityLog({ db, out: cap.out, file: null })
  log.record(alice.id, 'two_factor_changed', { target: 'enable' })
  assert.deepEqual(cap.all().map((e) => e.seq), [3])
  // The sweep the approval nonces get removes the month-old rows, keeps the
  // counter: the next number is 4, and the feed's last_seq still says 3.
  issueNonce(db, { userId: alice.id, deviceId: createClientDevice(db, alice.id, 'phone').deviceId })
  assert.deepEqual(db.prepare('SELECT seq FROM security_events WHERE user_id=? ORDER BY seq').all(alice.id).map((r) => r.seq), [3])
  db.prepare('DELETE FROM security_events').run()
  assert.equal(readSecurityEvents(db, alice.id).last_seq, 3)
  log.record(alice.id, 'password_changed', {})
  assert.deepEqual(cap.all().map((e) => e.seq), [3, 4])
  db.close()
})

test('the file sink appends each line; an unwritable path warns once and recording goes on', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'security-log-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const db = openDb(':memory:')
  const alice = await createUser(db, 'alice', 'pw-alice-1')
  const file = path.join(dir, 'security.log')
  const cap = capture()
  const log = makeSecurityLog({ db, out: cap.out, file })
  log.record(alice.id, 'client_signin', {})
  log.record(alice.id, 'password_changed', {})
  assert.deepEqual(fs.readFileSync(file, 'utf8').split('\n'), [...cap.lines, ''])

  const errors = t.mock.method(console, 'error', () => {})
  const bad = makeSecurityLog({ db, out: cap.out, file: path.join(dir, 'missing', 'dir', 'security.log') })
  bad.record(alice.id, 'device_revoked', {})
  bad.record(alice.id, 'device_revoked', {})
  assert.equal(errors.mock.callCount(), 1)
  assert.equal(cap.lines.length, 4)
  assert.equal(readSecurityEvents(db, alice.id).last_seq, 4)
  // An out that throws is not the caller's problem either.
  makeSecurityLog({ db, out: () => { throw new Error('closed') }, file: null }).record(alice.id, 'device_revoked', {})
  assert.equal(readSecurityEvents(db, alice.id).last_seq, 5)
  db.close()
})

test('an event recorded inside a transaction that rolls back is still recorded, once it has rolled back', async () => {
  const db = openDb(':memory:')
  const alice = await createUser(db, 'alice', 'pw-alice-1')
  const cap = capture()
  const log = makeSecurityLog({ db, out: cap.out, file: null })
  assert.throws(() => db.transaction(() => {
    log.record(alice.id, 'approval_invalid', { target: 'signature' })
    throw new Error('refused')
  })())
  await tick(0)
  assert.deepEqual(cap.all().map((e) => [e.seq, e.event, e.target]), [[1, 'approval_invalid', 'signature']])
  assert.equal(readSecurityEvents(db, alice.id).events.length, 1)
  db.close()
})

// ---- The feed -------------------------------------------------------------------

test('feed env: both set and a well-formed token, or off with one warning that never prints the token', () => {
  const warns = []
  const warn = (m) => warns.push(m)
  assert.equal(resolveSecurityFeed({}, { warn }), null)
  assert.deepEqual(resolveSecurityFeed({ token: FEED_TOKEN, account: 'alice' }, { warn }), { token: FEED_TOKEN, account: 'alice' })
  assert.equal(warns.length, 0)
  for (const token of ['short', 'x'.repeat(129), 'has space'.padEnd(40, 'y'), 'x'.repeat(31)]) {
    assert.equal(resolveSecurityFeed({ token, account: 'alice' }, { warn }), null)
  }
  assert.equal(resolveSecurityFeed({ token: FEED_TOKEN }, { warn }), null)
  assert.equal(warns.length, 5)
  assert.ok(warns.every((w) => !w.includes('xxxx') && !w.includes('short')))
  assert.ok(resolveSecurityFeed({ token: 'A'.repeat(128), account: 'alice' }, { warn }))
  assert.ok(resolveSecurityFeed({ token: 'a-b_C'.repeat(7).slice(0, 32), account: 'alice' }, { warn }))
})

test('feed off: 404 like any unknown path, whatever the token', async (t) => {
  const cap = capture()
  const s = await startTestServer({ securityLog: { out: cap.out }, securityFeed: null })
  t.after(() => s.close())
  const alice = await createUser(s.db, 'alice', TEST_PASSWORD)
  const phone = createClientDevice(s.db, alice.id, 'phone')
  assert.equal((await feed(s)).status, 404)
  assert.equal((await feed(s, '', null)).status, 404)
  assert.equal((await feed(s, '', phone.token)).status, 404)
})

test('feed: since, limit, last_seq, one account only; bad tokens, device tokens and bad values refused; the token opens nothing else', async (t) => {
  const { s, alice } = await journal(t)
  const bob = await createUser(s.db, 'bob', 'pw-bob-123')
  const phone = createClientDevice(s.db, alice.id, 'phone')
  const log = makeSecurityLog({ db: s.db, out: () => {}, file: null })
  let r = await feed(s)
  assert.equal(r.status, 200)
  assert.deepEqual(r.json, { account: 'alice', last_seq: 0, events: [] })
  for (let i = 0; i < 620; i++) log.record(alice.id, 'approval_invalid', { target: 'nonce' })
  log.record(bob.id, 'password_changed', { decidedBy: 'user' })

  r = await feed(s)
  assert.equal(r.json.last_seq, 620)
  assert.deepEqual(r.json.events.map((e) => e.seq), Array.from({ length: 100 }, (_, i) => 521 + i))
  r = await feed(s, '?since=10')
  assert.deepEqual(r.json.events.map((e) => e.seq), Array.from({ length: 100 }, (_, i) => 11 + i))
  r = await feed(s, '?since=600&limit=5')
  assert.deepEqual(r.json.events.map((e) => e.seq), [601, 602, 603, 604, 605])
  assert.equal(r.json.last_seq, 620)
  r = await feed(s, '?since=0&limit=10000')
  assert.equal(r.json.events.length, 500)
  r = await feed(s, '?limit=3')
  assert.deepEqual(r.json.events.map((e) => e.seq), [618, 619, 620])
  r = await feed(s, '?since=620')
  assert.deepEqual(r.json, { account: 'alice', last_seq: 620, events: [] })
  // Another account's events never appear.
  r = await feed(s, '?since=0&limit=500')
  assert.ok(r.json.events.every((e) => e.account === 'alice' && e.event === 'approval_invalid'))

  for (const q of ['?since=-1', '?since=abc', '?limit=0', '?limit=-3', '?limit=1.5', '?since=1e3', '?limit=']) {
    assert.equal((await feed(s, q)).status, 400, q)
  }
  assert.equal((await feed(s, '', null)).status, 401)
  assert.equal((await feed(s, '', FEED_TOKEN + 'y')).status, 401)
  assert.equal((await feed(s, '', phone.token)).status, 401)
  // The feed token is not a device token.
  assert.equal((await s.http('/me', { token: FEED_TOKEN })).status, 401)
  assert.equal((await s.http('/devices', { token: FEED_TOKEN })).status, 401)
  assert.equal((await s.http('/snapshot', { token: FEED_TOKEN })).status, 401)
})

// ---- Events at their sites -----------------------------------------------------

test('client_signin: a password sign-in and a two-factor sign-in, each once, naming the new device and the caller address', async (t) => {
  const { s, cap, alice } = await journal(t, { tokenKey: 'ab'.repeat(32) })
  const r = await s.http('/login', { method: 'POST', body: { username: 'alice', password: TEST_PASSWORD, device_name: 'laptop' }, headers: { 'cf-connecting-ip': IP } })
  assert.equal(r.status, 200)
  const e = one(cap, 'client_signin')
  assert.deepEqual(pick(e), { account: 'alice', device_id: r.json.device_id, device_name: 'laptop', target: `device:${r.json.device_id}`, decided_by: 'user' })
  assert.equal(e.source_ip, IP)
  // A wrong password records nothing.
  const n = cap.lines.length
  assert.equal((await s.http('/login', { method: 'POST', body: { username: 'alice', password: 'wrong-password' } })).status, 403)
  assert.equal(cap.lines.length, n)

  const { secret } = await enableTwoFactor(s, r.json.token)
  const from = cap.lines.length
  const login = await s.http('/login', { method: 'POST', body: { username: 'alice', password: TEST_PASSWORD, device_name: 'tablet' } })
  assert.equal(login.status, 401)
  assert.equal(cap.lines.length, from)
  const code = totpCode(s, alice.id, secret)
  const done = await s.http('/login/2fa', { method: 'POST', body: { ticket: login.json.two_factor_ticket, code } })
  assert.equal(done.status, 200)
  assert.deepEqual(pick(one(cap, 'client_signin', from)), { account: 'alice', device_id: done.json.device_id, device_name: 'tablet', target: `device:${done.json.device_id}`, decided_by: 'user' })
})

test('two_factor_changed: setup, enable, recovery codes, disable from a device; enable at sign-in; admin reset', async (t) => {
  const { s, cap, alice } = await journal(t, { tokenKey: 'ab'.repeat(32) })
  const phone = createClientDevice(s.db, alice.id, 'phone')
  const { secret } = await enableTwoFactor(s, phone.token)
  let tf = cap.of('two_factor_changed')
  assert.deepEqual(tf.map(pick), ['setup', 'enable'].map((target) => ({ account: 'alice', device_id: phone.deviceId, device_name: 'phone', target, decided_by: 'user' })))
  // A wrong code changes nothing and records nothing.
  assert.equal((await s.http('/2fa/recovery-codes', { method: 'POST', token: phone.token, body: { password: TEST_PASSWORD, code: '000000' } })).status, 403)
  assert.equal(cap.of('two_factor_changed').length, 2)
  assert.equal((await s.http('/2fa/recovery-codes', { method: 'POST', token: phone.token, body: { password: TEST_PASSWORD, code: totpCode(s, alice.id, secret) } })).status, 200)
  assert.equal((await s.http('/2fa/disable', { method: 'POST', token: phone.token, body: { password: TEST_PASSWORD, code: totpCode(s, alice.id, secret) } })).status, 200)
  tf = cap.of('two_factor_changed')
  assert.deepEqual(tf.map((e) => e.target), ['setup', 'enable', 'recovery_codes', 'disable'])

  // At sign-in, when two-factor is required: setup and enable with no
  // device yet, then the sign-in itself.
  setTwoFactorRequired(s.db, true)
  const from = cap.lines.length
  const login = await s.http('/login', { method: 'POST', body: { username: 'alice', password: TEST_PASSWORD, device_name: 'tablet' } })
  assert.equal(login.json.error, 'two_factor_enrolment_required')
  const setup = await s.http('/login/2fa/setup', { method: 'POST', body: { ticket: login.json.two_factor_ticket } })
  assert.equal(setup.status, 200)
  const en = await s.http('/login/2fa/enable', { method: 'POST', body: { ticket: login.json.two_factor_ticket, code: hotp(base32Decode(setup.json.secret), totpStep()) } })
  assert.equal(en.status, 200)
  const after = cap.all().slice(from)
  assert.deepEqual(after.map((e) => [e.event, e.target, e.device_id, e.decided_by]), [
    ['two_factor_changed', 'setup', null, 'user'],
    ['two_factor_changed', 'enable', null, 'user'],
    ['client_signin', `device:${en.json.device_id}`, en.json.device_id, 'user'],
  ])

  // The web admin's reset, recorded on the target account.
  const root = await createUser(s.db, 'root', 'pw-root-123')
  s.db.prepare('UPDATE users SET is_admin=1 WHERE id=?').run(root.id)
  const desk = createClientDevice(s.db, root.id, 'desk')
  const at = cap.lines.length
  assert.equal((await s.http(`/users/${alice.id}/two-factor`, { method: 'DELETE', token: desk.token, body: {} })).status, 200)
  assert.deepEqual(pick(one(cap, 'two_factor_changed', at)), { account: 'alice', device_id: desk.deviceId, device_name: 'desk', target: 'reset', decided_by: 'admin' })
})

test('password_changed: /password once, a wrong old password records nothing; the web admin on the target account; a completed email reset', async (t) => {
  const sent = []
  const mailer = { publicUrl: 'https://journal.example', async send(m) { sent.push(m) } }
  const { s, cap, alice } = await journal(t, { mailer })
  const phone = createClientDevice(s.db, alice.id, 'phone')
  assert.equal((await s.http('/password', { method: 'POST', token: phone.token, body: { old_password: 'not-the-password', new_password: 'new-password-1' } })).status, 401)
  assert.equal(cap.lines.length, 0)
  assert.equal((await s.http('/password', { method: 'POST', token: phone.token, body: { old_password: TEST_PASSWORD, new_password: 'new-password-1' }, headers: { 'cf-connecting-ip': IP } })).status, 200)
  const e = one(cap, 'password_changed')
  assert.deepEqual(pick(e), { account: 'alice', device_id: phone.deviceId, device_name: 'phone', target: null, decided_by: 'user' })
  assert.equal(e.source_ip, IP)

  const root = await createUser(s.db, 'root', 'pw-root-123')
  s.db.prepare('UPDATE users SET is_admin=1 WHERE id=?').run(root.id)
  const desk = createClientDevice(s.db, root.id, 'desk')
  let from = cap.lines.length
  assert.equal((await s.http(`/users/${alice.id}/password`, { method: 'POST', token: desk.token, body: { password: 'admin-set-pw-1' } })).status, 200)
  assert.deepEqual(pick(one(cap, 'password_changed', from)), { account: 'alice', device_id: desk.deviceId, device_name: 'desk', target: null, decided_by: 'admin' })

  // password_reset_requested for an account that exists, with the same
  // answer as for one that does not.
  s.db.prepare("UPDATE users SET email='alice@journal.example' WHERE id=?").run(alice.id)
  from = cap.lines.length
  const unknown = await s.http('/password/forgot', { method: 'POST', body: { identifier: 'nobody' } })
  assert.equal(cap.lines.length, from)
  const known = await s.http('/password/forgot', { method: 'POST', body: { identifier: 'alice' }, headers: { 'cf-connecting-ip': IP } })
  assert.deepEqual([known.status, known.json], [unknown.status, unknown.json])
  const req = one(cap, 'password_reset_requested', from)
  assert.deepEqual(pick(req), { account: 'alice', device_id: null, device_name: null, target: null, decided_by: null })
  assert.equal(req.source_ip, IP)
  await tick(10)
  const token = sent.at(-1).text.match(/#token=([A-Za-z0-9_-]+)/)[1]
  from = cap.lines.length
  assert.equal((await s.http('/password/reset', { method: 'POST', body: { token: 'not-a-token', new_password: 'reset-password-1' } })).status, 400)
  assert.equal(cap.lines.length, from)
  assert.equal((await s.http('/password/reset', { method: 'POST', body: { token, new_password: 'reset-password-1' } })).status, 200)
  assert.deepEqual(pick(one(cap, 'password_changed', from)), { account: 'alice', device_id: null, device_name: null, target: null, decided_by: 'user' })
})

test('device_linked and bridge_paired: once each when the new device is minted, naming the approving device and the new one', async (t) => {
  const { s, cap, alice } = await journal(t)
  const phone = createClientDevice(s.db, alice.id, 'phone')
  const start = await s.http('/link/start', { method: 'POST', token: phone.token, body: {} })
  const claim = await s.http('/link/claim', { method: 'POST', body: { link_code: start.json.link_code, device_name: 'tablet' } })
  assert.equal((await s.http('/link/approve', { method: 'POST', token: phone.token, body: { link_code: start.json.link_code } })).status, 200)
  assert.equal(cap.lines.length, 0)
  const poll = await s.http('/link/poll', { method: 'POST', body: { claim_token: claim.json.claim_token }, headers: { 'cf-connecting-ip': IP } })
  assert.equal(poll.json.status, 'approved')
  const e = one(cap, 'device_linked')
  assert.deepEqual(pick(e), { account: 'alice', device_id: phone.deviceId, device_name: 'phone', target: `device:${poll.json.device_id}`, decided_by: 'user' })
  assert.equal(e.source_ip, IP)

  // Pre-approved: from the host (the admin CLI's route) and by a web admin.
  let from = cap.lines.length
  const pre = await s.http('/link/preapprove', { method: 'POST', body: { username: 'alice' }, headers: { 'x-preapprove-key': s.preapproveKey } })
  assert.equal(pre.status, 200)
  const c2 = await s.http('/link/claim', { method: 'POST', body: { link_code: pre.json.link_code, device_name: 'kiosk' } })
  const p2 = await s.http('/link/poll', { method: 'POST', body: { claim_token: c2.json.claim_token } })
  assert.deepEqual(pick(one(cap, 'device_linked', from)), { account: 'alice', device_id: null, device_name: null, target: `device:${p2.json.device_id}`, decided_by: 'admin_cli' })
  const root = await createUser(s.db, 'root', 'pw-root-123')
  s.db.prepare('UPDATE users SET is_admin=1 WHERE id=?').run(root.id)
  const desk = createClientDevice(s.db, root.id, 'desk')
  from = cap.lines.length
  const code = await s.http(`/users/${alice.id}/link-code`, { method: 'POST', token: desk.token, body: {} })
  const c3 = await s.http('/link/claim', { method: 'POST', body: { link_code: code.json.link_code, device_name: 'spare' } })
  const p3 = await s.http('/link/poll', { method: 'POST', body: { claim_token: c3.json.claim_token } })
  assert.deepEqual(pick(one(cap, 'device_linked', from)), { account: 'alice', device_id: null, device_name: null, target: `device:${p3.json.device_id}`, decided_by: 'admin' })

  from = cap.lines.length
  const pair = await s.http('/pair/start', { method: 'POST', body: {} })
  assert.equal((await s.http('/pair/approve', { method: 'POST', token: phone.token, body: { pair_code: pair.json.pair_code, agent_name: 'box-a' } })).status, 200)
  assert.equal(cap.lines.length, from)
  const pc = await s.http('/pair/claim', { method: 'POST', body: { poll_token: pair.json.poll_token } })
  assert.equal(pc.json.status, 'approved')
  assert.deepEqual(pick(one(cap, 'bridge_paired', from)), { account: 'alice', device_id: phone.deviceId, device_name: 'phone', target: `device:${pc.json.device_id}`, decided_by: 'user' })
})

test('coordinator_changed, consent_switch_changed, device_protection_changed: once per real change', async (t) => {
  const { s, cap, alice } = await journal(t)
  const phone = createClientDevice(s.db, alice.id, 'phone')
  const box = createAgent(s.db, alice.id, 'box-a')
  upsertConversation(s.db, { id: 'coord', ownerUserId: alice.id, title: 'Coordinator', agentDeviceId: box.deviceId })
  const put = (body) => s.http('/coordinator', { method: 'PUT', token: phone.token, body })
  assert.equal((await put({ convo_id: 'coord' })).status, 200)
  assert.equal((await put({ convo_id: 'coord' })).status, 200)
  assert.equal((await put({ convo_id: 'nope' })).status, 404)
  assert.equal((await put({ convo_id: null })).status, 200)
  assert.deepEqual(cap.of('coordinator_changed').map(pick), [
    { account: 'alice', device_id: phone.deviceId, device_name: 'phone', target: 'convo:coord', decided_by: 'user' },
    { account: 'alice', device_id: phone.deviceId, device_name: 'phone', target: null, decided_by: 'user' },
  ])
  // The Coordinator's consent is on by default, file transfers off.
  assert.equal((await put({ consent: true })).status, 200)
  assert.equal((await put({ consent: false })).status, 200)
  assert.equal((await put({ consent: false })).status, 200)
  assert.equal((await put({ transfer_consent: true })).status, 200)
  assert.deepEqual(cap.of('consent_switch_changed').map((e) => [e.target, e.device_id, e.decided_by]), [['spawns', phone.deviceId, 'user'], ['transfers', phone.deviceId, 'user']])
  assert.equal((await s.http(`/devices/${box.deviceId}/protected`, { method: 'POST', token: phone.token, body: { on: true } })).status, 200)
  assert.equal((await s.http('/devices/99999/protected', { method: 'POST', token: phone.token, body: { on: true } })).status, 404)
  assert.deepEqual(cap.of('device_protection_changed').map(pick), [{ account: 'alice', device_id: phone.deviceId, device_name: 'phone', target: `device:${box.deviceId}:on`, decided_by: 'user' }])
})

test('device_revoked without a key: another device and yourself, once each; a device that is not yours records nothing', async (t) => {
  const { s, cap, alice } = await journal(t)
  const phone = createClientDevice(s.db, alice.id, 'phone')
  const tablet = createClientDevice(s.db, alice.id, 'tablet')
  const box = createAgent(s.db, alice.id, 'box-a')
  assert.equal((await s.http(`/devices/${box.deviceId}/revoke`, { method: 'POST', token: phone.token, body: {} })).status, 200)
  assert.equal((await s.http(`/devices/${box.deviceId}/revoke`, { method: 'POST', token: phone.token, body: {} })).status, 404)
  assert.equal((await s.http(`/devices/${tablet.deviceId}/revoke`, { method: 'POST', token: tablet.token, body: {} })).status, 200)
  assert.deepEqual(cap.of('device_revoked').map(pick), [
    { account: 'alice', device_id: phone.deviceId, device_name: 'phone', target: `device:${box.deviceId}`, decided_by: 'user' },
    { account: 'alice', device_id: tablet.deviceId, device_name: 'tablet', target: `device:${tablet.deviceId}`, decided_by: 'user' },
  ])
})

// alice with a key on her phone: the approval-key events, the lockdown, and
// a scan of every line for anything secret.
test('approval keys: enrolled, attached, revoked, invalid, signed out, locked; device revokes with a key; no line carries a secret', async (t) => {
  const cap = capture()
  const { s, alice, token, deviceId, secret, key } = await startWithKey(t, serverOpts(cap))
  const secrets = [TEST_PASSWORD, token, key.publicKey, key.privateKeyPem]
  const short = (k) => `key:${k.keyId.slice(0, 8)}`
  const phone = { account: 'alice', device_id: deviceId, device_name: 'phone' }
  assert.deepEqual(cap.of('approval_key_enrolled').map(pick), [{ ...phone, target: short(key), decided_by: 'user' }])

  // Approved by the phone's key, for the tablet's.
  const tablet = signIn(s, alice.id, 'tablet')
  secrets.push(tablet.token)
  const tabletKey = generateApprovalKey()
  secrets.push(tabletKey.publicKey)
  const rq = await s.http('/approval-keys/requests', { method: 'POST', token: tablet.token, body: { public_key: tabletKey.publicKey, name: 'tablet' } })
  const enrol = await signAccount(s, { token, key, subject: { op: 'enrol_key', key_id: tabletKey.keyId } })
  secrets.push(enrol.statement, enrol.signature)
  assert.equal((await s.http(`/approval-keys/requests/${rq.json.id}/approve`, { method: 'POST', token, body: { approval: enrol } })).status, 200)
  assert.deepEqual(cap.of('approval_key_enrolled').map(pick)[1], { ...phone, target: short(tabletKey), decided_by: 'user' })

  // The tablet's key attached to a new sign-in by its own signature.
  const laptop = signIn(s, alice.id, 'laptop')
  secrets.push(laptop.token)
  const attach = await signAccount(s, { token: laptop.token, key: tabletKey, subject: { op: 'attach_key', key_id: tabletKey.keyId } })
  secrets.push(attach.statement, attach.signature)
  assert.equal((await s.http('/approval-keys/attach', { method: 'POST', token: laptop.token, body: { approval: attach } })).status, 200)
  assert.deepEqual(cap.of('approval_key_attached').map(pick), [{ account: 'alice', device_id: laptop.deviceId, device_name: 'laptop', target: short(tabletKey), decided_by: 'user' }])

  // Revoking the laptop (with the phone's signature) revokes the key on it.
  let from = cap.lines.length
  const rv = await signAccount(s, { token, key, subject: { op: 'revoke_device', device: String(laptop.deviceId) } })
  secrets.push(rv.statement, rv.signature)
  assert.equal((await s.http(`/devices/${laptop.deviceId}/revoke`, { method: 'POST', token, body: { approval: rv } })).status, 200)
  assert.deepEqual(cap.all().slice(from).map((e) => [e.event, e.device_id, e.target, e.decided_by]), [
    ['device_revoked', deviceId, `device:${laptop.deviceId}`, 'user'],
    ['approval_key_revoked', deviceId, short(tabletKey), 'user'],
  ])

  // A key revoked with a signature, and one with the password and a code.
  const k3 = await enrolKeyByPassword(s, { token: tablet.token, userId: alice.id, secret, name: 'tablet-2' })
  const k4 = await enrolKeyByPassword(s, { token: tablet.token, userId: alice.id, secret, name: 'tablet-3' })
  secrets.push(k3.publicKey, k4.publicKey)
  from = cap.lines.length
  const rk = await signAccount(s, { token, key, subject: { op: 'revoke_key', key_id: k3.keyId } })
  assert.equal((await s.http(`/approval-keys/${k3.keyId}/revoke`, { method: 'POST', token, body: { approval: rk } })).status, 200)
  const code = totpCode(s, alice.id, secret)
  secrets.push(code)
  assert.equal((await s.http(`/approval-keys/${k4.keyId}/revoke`, { method: 'POST', token, body: { password: TEST_PASSWORD, code } })).status, 200)
  assert.deepEqual(cap.all().slice(from).map((e) => [e.event, e.target, e.decided_by]), [
    ['approval_key_revoked', short(k3), 'user'], ['approval_key_revoked', short(k4), 'user'],
  ])

  // Invalid approvals: each recorded, though its request rolled back (the
  // nonce stays unspent); the second that counts signs the device out.
  const spare = signIn(s, alice.id, 'spare')
  secrets.push(spare.token)
  from = cap.lines.length
  const garbage = { statement: 'not a statement', signature: 'AAAA' }
  assert.equal((await s.http(`/devices/${tablet.deviceId}/revoke`, { method: 'POST', token: spare.token, body: { approval: garbage }, headers: { 'cf-connecting-ip': IP } })).status, 400)
  await tick()
  assert.deepEqual(cap.all().slice(from).map(pick), [{ account: 'alice', device_id: spare.deviceId, device_name: 'spare', target: 'bad_statement', decided_by: null }])
  // Recorded after the refused request's transaction, still with its address.
  assert.equal(cap.all().at(-1).source_ip, IP)
  const forged = await signAccount(s, { token: spare.token, key: generateApprovalKey(), subject: { op: 'change_password' } })
  assert.equal((await s.http('/password', { method: 'POST', token: spare.token, body: { old_password: TEST_PASSWORD, new_password: 'never-applied-1', approval: forged } })).status, 400)
  await tick()
  assert.deepEqual(cap.all().slice(from).map((e) => [e.event, e.device_id, e.device_name, e.target, e.decided_by]), [
    ['approval_invalid', spare.deviceId, 'spare', 'bad_statement', null],
    ['approval_invalid', spare.deviceId, 'spare', 'unknown_key', null],
    ['device_signed_out_bad_signatures', spare.deviceId, 'spare', `device:${spare.deviceId}`, 'journal'],
  ])
  assert.equal(cap.of('password_changed').length, 0)
  assert.equal(cap.of('device_revoked').length, 1)

  // Three wrong passwords on the password-and-code path lock it.
  from = cap.lines.length
  const pk = generateApprovalKey()
  for (let i = 0; i < 3; i++) {
    const r = await s.http('/approval-keys', { method: 'POST', token: tablet.token, body: { public_key: pk.publicKey, name: 'x', password: 'wrong-password', code: '123456' } })
    assert.equal(r.status, 401)
  }
  assert.deepEqual(cap.all().slice(from).map(pick), [{ account: 'alice', device_id: tablet.deviceId, device_name: 'tablet', target: '1h', decided_by: 'journal' }])

  // Signing yourself out with a key on the account.
  from = cap.lines.length
  assert.equal((await s.http(`/devices/${tablet.deviceId}/revoke`, { method: 'POST', token: tablet.token, body: {} })).status, 200)
  assert.deepEqual(cap.all().slice(from).map(pick), [{ account: 'alice', device_id: tablet.deviceId, device_name: 'tablet', target: `device:${tablet.deviceId}`, decided_by: 'user' }])

  // Every line: the contract's shape, and nothing secret anywhere in it.
  const page = (await feed(s, '?since=0&limit=500')).json
  assert.deepEqual(page.events, cap.all())
  for (const line of cap.lines) {
    for (const x of secrets) assert.ok(!line.includes(x), `a line carries a secret: ${line}`)
    const e = JSON.parse(line)
    for (const v of [e.device_name, e.source_ip, e.target, e.decided_by, e.account]) assert.ok(v == null || !secrets.some((x) => String(v).includes(x)))
    assert.ok(!line.includes('wrong-password') && !line.includes('never-applied'))
  }
})

test('spawn_approved and chat_approved: by the user and by the Coordinator, once each; a decline or a lost race records nothing', async (t) => {
  const cap = capture()
  // A short start timeout: nothing answers the approved spawns' start.
  const f = await fleet(t, serverOpts(cap, { spawnStartTimeoutMs: 300 }))
  const clientDevice = cap.of('client_signin')[0].device_id
  // The user's tap.
  const spawnId = await parkSpawn(f)
  assert.equal((await f.s.http('/agent-spawn/answer', { method: 'POST', token: f.clientToken, body: { request_id: spawnId, decision: 'approve' } })).status, 200)
  assert.equal((await f.s.http('/agent-spawn/answer', { method: 'POST', token: f.clientToken, body: { request_id: spawnId, decision: 'approve' } })).status, 409)
  assert.deepEqual(cap.of('spawn_approved').map(pick), [{ account: 'alice', device_id: clientDevice, device_name: 'mac', target: `device:${f.targetDev.deviceId}`, decided_by: 'user' }])
  await parkInviteAsk(f)
  assert.equal((await f.s.http('/agent-chat/answer', { method: 'POST', token: f.clientToken, body: { room_id: 'room', target_device_id: f.targetDev.deviceId, decision: 'deny' } })).status, 200)
  assert.equal(cap.of('chat_approved').length, 0)

  // The Coordinator's answer.
  assert.equal((await f.s.http('/coordinator', { method: 'PUT', token: f.clientToken, body: { consent: true } })).status, 200)
  await parkInviteAsk(f)
  const r = await answer(f, f.coordDev.token, { kind: 'chat', id: `room/${f.targetDev.deviceId}`, decision: 'approve', reason: 'a review between two sessions' })
  assert.equal(r.status, 200)
  assert.deepEqual(cap.of('chat_approved').map(pick), [{ account: 'alice', device_id: f.coordDev.deviceId, device_name: 'coord-box', target: `device:${f.targetDev.deviceId}`, decided_by: 'coordinator' }])
  const s2 = await parkSpawn(f, { rid: 'q2' })
  assert.equal((await answer(f, f.coordDev.token, { kind: 'spawn', id: s2, decision: 'approve', reason: 'the asker needs a hand' })).status, 200)
  assert.deepEqual(cap.of('spawn_approved').map((e) => [e.device_id, e.decided_by]), [[clientDevice, 'user'], [f.coordDev.deviceId, 'coordinator']])
  assert.ok(cap.all().every((e) => !JSON.stringify(e).includes('fix the flaky test') && !JSON.stringify(e).includes('need eyes on the diff')))
})

test('session_started_direct and coordinator_carry_on: from the WebSocket, once each, with no source address', async (t) => {
  const cap = capture()
  const f = await fleet(t, serverOpts(cap, { sessionControlTimeoutMs: 300 }))
  const clientDevice = cap.of('client_signin')[0].device_id
  f.client.send({ op: 'agent_request', request_id: 'r1', agent_device_id: f.targetDev.deviceId, method: 'start', params: { workdir: '/w', prompt: 'a secret prompt' } })
  await f.target.waitFor((x) => x.kind === 'rpc' && x.request?.request_id === 'r1')
  f.client.send({ op: 'agent_request', request_id: 'r2', agent_device_id: f.targetDev.deviceId, method: 'recent_folders' })
  await f.target.waitFor((x) => x.kind === 'rpc' && x.request?.request_id === 'r2')
  const e = one(cap, 'session_started_direct')
  assert.deepEqual(pick(e), { account: 'alice', device_id: clientDevice, device_name: 'mac', target: `device:${f.targetDev.deviceId}`, decided_by: 'user' })
  assert.equal(e.source_ip, null)

  f.coord.send({ op: 'session_control', request_id: 'c1', from_convo_id: 'coord', target_convo_id: 'ask', action: 'carry_on', message: 'carry on quietly' })
  await f.coord.waitFor((x) => x.kind === 'session_control' && x.event === 'sent')
  f.coord.send({ op: 'session_control', request_id: 'c2', from_convo_id: 'coord', target_convo_id: 'ask', action: 'compact' })
  await f.coord.waitFor((x) => x.kind === 'session_control' && x.event === 'sent' && x.request_id === 'c2')
  assert.deepEqual(pick(one(cap, 'coordinator_carry_on')), { account: 'alice', device_id: f.coordDev.deviceId, device_name: 'coord-box', target: 'convo:ask', decided_by: 'coordinator' })
  assert.ok(cap.lines.every((l) => !l.includes('secret prompt') && !l.includes('carry on quietly')))
  await f.coord.waitFor((x) => x.kind === 'session_control' && x.event === 'result' && x.request_id === 'c2', 3000)
})

test('the admin CLI: device revoke, protection, chat approve, password, two-factor reset, transfer switch, key revoke — decided_by admin_cli, no device', async (t) => {
  const cap = capture()
  const f = await fleet(t, serverOpts(capture()))
  const { s, alice } = f
  const securityLog = makeSecurityLog({ db: s.db, out: cap.out, file: null })
  const admin = (...argv) => runAdmin(s.db, argv, { securityLog, env: { MATRON_PASSWORD: 'cli-password-1' } })
  await parkInviteAsk(f)
  await admin('agent-chat', 'approve', 'alice', 'room', String(f.targetDev.deviceId))
  await admin('device', 'protected', String(f.targetDev.deviceId), 'on')
  await admin('coordinator', 'transfers', 'alice', 'on')
  await admin('user', 'passwd', 'alice')
  const phone = createClientDevice(s.db, alice.id, 'phone')
  s.db.prepare("INSERT INTO approval_keys(user_id, key_id, public_key, alg, name, device_id, enrolled_via, enrolled_by, created_at) VALUES(?,?,?,?,?,?,'password',NULL,?)")
    .run(alice.id, 'ab'.repeat(32), 'pk', 'ES256', 'phone', phone.deviceId, Date.now())
  s.db.prepare("INSERT INTO approval_keys(user_id, key_id, public_key, alg, name, device_id, enrolled_via, enrolled_by, created_at) VALUES(?,?,?,?,?,?,'password',NULL,?)")
    .run(alice.id, 'cd'.repeat(32), 'pk2', 'ES256', 'spare', null, Date.now())
  await admin('approval-key', 'revoke', 'alice', 'cd'.repeat(32))
  await admin('device', 'revoke', String(phone.deviceId))
  s.db.prepare("INSERT INTO two_factor(user_id, secret, enabled_at) VALUES(?, 'sealed', ?) ON CONFLICT(user_id) DO UPDATE SET secret='sealed'").run(alice.id, Date.now())
  await admin('user', '2fa-reset', 'alice')
  await admin('user', '2fa-reset', 'alice')
  assert.deepEqual(cap.all().map((e) => [e.account, e.event, e.target, e.device_id, e.device_name, e.source_ip, e.decided_by]), [
    ['alice', 'chat_approved', `device:${f.targetDev.deviceId}`, null, null, null, 'admin_cli'],
    ['alice', 'device_protection_changed', `device:${f.targetDev.deviceId}:on`, null, null, null, 'admin_cli'],
    ['alice', 'consent_switch_changed', 'transfers', null, null, null, 'admin_cli'],
    ['alice', 'password_changed', null, null, null, null, 'admin_cli'],
    ['alice', 'approval_key_revoked', 'key:cdcdcdcd', null, null, null, 'admin_cli'],
    ['alice', 'device_revoked', `device:${phone.deviceId}`, null, null, null, 'admin_cli'],
    ['alice', 'approval_key_revoked', 'key:abababab', null, null, null, 'admin_cli'],
    ['alice', 'two_factor_changed', 'reset', null, null, null, 'admin_cli'],
  ])
  assert.ok(cap.lines.every((l) => !l.includes('cli-password-1')))
})
