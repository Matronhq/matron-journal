import test from 'node:test'
import assert from 'node:assert/strict'
import { createAgent, revokeDevice } from '../src/auth.js'
import { hasActiveKey, activeKeyFor, issueNonce, consumeNonce, requireApproval, NONCE_TTL_MS } from '../src/approval-keys.js'
import {
  generateApprovalKey, signForTest, startApprovalServer, startWithKey, enableTwoFactor, enrolKeyByPassword,
  signIn, signApproval, signAccount, totpCode, TEST_JOURNAL, TEST_PASSWORD,
} from './approval-helpers.js'

const keysOf = async (s, token) => (await s.http('/approval-keys', { token })).json
const notices = (s, userId) => s.db.prepare("SELECT title, body FROM items WHERE user_id=? AND kind='notice' ORDER BY num").all(userId)
const ctxOf = (s, now = Date.now()) => ({ db: s.db, journalHost: TEST_JOURNAL, now })
const client = (userId, deviceId) => ({ userId, deviceId, kind: 'client' })
const invalid = (reason) => ({ ok: false, status: 400, body: { error: 'approval_invalid', reason } })

function makeStubApnsClient() {
  const calls = []
  return { calls, send(opts) { calls.push(opts); return Promise.resolve({ status: 200, reason: null }) } }
}

// ---- Switched off --------------------------------------------------------

test('without a public URL approval keys are off: listed as disabled, enrolment refused', async (t) => {
  const { s, alice, token } = await startApprovalServer(t, { publicUrl: null })
  const { secret } = await enableTwoFactor(s, token)
  assert.deepEqual(await keysOf(s, token), { enabled: false, keys: [], requests: [] })
  const key = generateApprovalKey()
  const boot = await s.http('/approval-keys', {
    method: 'POST', token, body: { public_key: key.publicKey, name: 'phone', password: TEST_PASSWORD, code: totpCode(s, alice.id, secret) },
  })
  assert.deepEqual([boot.status, boot.json], [409, { error: 'approval_keys_disabled' }])
  const req = await s.http('/approval-keys/requests', { method: 'POST', token, body: { public_key: key.publicKey, name: 'phone' } })
  assert.deepEqual([req.status, req.json], [409, { error: 'approval_keys_disabled' }])
  const nonce = await s.http('/approvals/nonce', { method: 'POST', token })
  assert.deepEqual([nonce.status, nonce.json], [409, { error: 'approval_keys_disabled' }])
  assert.equal(hasActiveKey(s.db, alice.id), false)
})

// ---- Bootstrap enrolment -------------------------------------------------

test('bootstrap: password and a TOTP code enrol the calling device\'s key, with a notice and a push', async (t) => {
  const apns = makeStubApnsClient()
  const { s, alice, token, deviceId } = await startApprovalServer(t, { apnsClient: apns })
  const laptop = signIn(s, alice.id, 'laptop')
  await s.http('/push/register', { method: 'POST', token: laptop.token, body: { apns_token: 'laptop-token', environment: 'prod' } })
  const { secret } = await enableTwoFactor(s, token)
  assert.equal(hasActiveKey(s.db, alice.id), false)

  const key = generateApprovalKey()
  const r = await s.http('/approval-keys', {
    method: 'POST', token, body: { public_key: key.publicKey, name: 'phone', password: TEST_PASSWORD, code: totpCode(s, alice.id, secret) },
  })
  assert.equal(r.status, 200, JSON.stringify(r.json))
  assert.equal(r.json.key.key_id, key.keyId)

  assert.equal(hasActiveKey(s.db, alice.id), true)
  assert.equal(activeKeyFor(s.db, alice.id, key.keyId).device_id, deviceId)
  const listed = await keysOf(s, token)
  assert.equal(listed.enabled, true)
  assert.equal(listed.keys.length, 1)
  const k = listed.keys[0]
  assert.deepEqual(
    { ...k, created_at: typeof k.created_at },
    { key_id: key.keyId, public_key: key.publicKey, alg: 'ES256', name: 'phone', device_id: deviceId, enrolled_via: 'password', created_at: 'number', revoked_at: null },
  )
  assert.deepEqual(notices(s, alice.id).map((n) => n.title), [`Approval key added: phone ${key.keyId.slice(0, 8)}`])
  await new Promise((res) => setTimeout(res, 50))
  assert.ok(apns.calls.some((c) => c.deviceToken === 'laptop-token' && c.payload.aps.alert), 'the notice pushes to the user\'s devices')
})

test('bootstrap: a recovery code is refused, as is a wrong code, a wrong password and an account without two-factor', async (t) => {
  const { s, alice, token } = await startApprovalServer(t)
  const key = generateApprovalKey()
  const enrol = (body) => s.http('/approval-keys', { method: 'POST', token, body: { public_key: key.publicKey, name: 'phone', password: TEST_PASSWORD, ...body } })

  const off = await enrol({ code: '123456' })
  assert.deepEqual([off.status, off.json], [409, { error: 'two_factor_required' }])

  const { secret, recoveryCodes } = await enableTwoFactor(s, token)
  const recovery = await enrol({ code: recoveryCodes[0] })
  assert.deepEqual([recovery.status, recovery.json], [400, { error: 'totp_required' }])
  const state = (await s.http('/2fa', { token })).json
  assert.equal(state.recovery_codes_left, 10, 'the refused recovery code is not spent')

  const right = totpCode(s, alice.id, secret)
  const wrong = right === '000000' ? '000001' : '000000'
  const badCode = await enrol({ code: wrong })
  assert.deepEqual([badCode.status, badCode.json], [403, { error: 'bad_code' }])
  const badPassword = await enrol({ password: 'nope', code: totpCode(s, alice.id, secret) })
  assert.deepEqual([badPassword.status, badPassword.json], [401, { error: 'bad_password' }])
  assert.equal(hasActiveKey(s.db, alice.id), false)
  assert.deepEqual(notices(s, alice.id), [])
})

test('bootstrap: wrong codes count against the username lockout', async (t) => {
  const { s, alice, token } = await startApprovalServer(t)
  const { secret } = await enableTwoFactor(s, token)
  const key = generateApprovalKey()
  const right = totpCode(s, alice.id, secret)
  const wrong = right === '000000' ? '000001' : '000000'
  for (let i = 0; i < 5; i++) {
    const r = await s.http('/approval-keys', { method: 'POST', token, body: { public_key: key.publicKey, name: 'phone', password: TEST_PASSWORD, code: wrong } })
    assert.equal(r.status, 403)
  }
  const locked = await s.http('/approval-keys', {
    method: 'POST', token, body: { public_key: key.publicKey, name: 'phone', password: TEST_PASSWORD, code: totpCode(s, alice.id, secret) },
  })
  assert.equal(locked.status, 429)
  assert.equal(locked.json.error, 'locked_out')
  const login = await s.http('/login', { method: 'POST', body: { username: 'alice', password: TEST_PASSWORD } })
  assert.equal(login.status, 429, 'the same lockout as a sign-in')
})

test('bootstrap: a malformed public key or name is refused; an enrolled key cannot be enrolled twice', async (t) => {
  const { s, alice, token, secret, key } = await startWithKey(t)
  const enrol = (body) => s.http('/approval-keys', { method: 'POST', token, body: { name: 'phone', password: TEST_PASSWORD, code: totpCode(s, alice.id, secret), ...body } })
  const short = Buffer.from(key.publicKey, 'base64url').subarray(0, 64).toString('base64url')
  assert.deepEqual((await enrol({ public_key: short })).json, { error: 'bad_public_key' })
  assert.deepEqual((await enrol({ public_key: 42 })).json, { error: 'bad_public_key' })
  assert.equal((await enrol({ public_key: generateApprovalKey().publicKey, name: '' })).status, 400)
  assert.equal((await enrol({ public_key: generateApprovalKey().publicKey, name: 'x'.repeat(41) })).status, 400)
  const again = await enrol({ public_key: key.publicKey })
  assert.deepEqual([again.status, again.json], [409, { error: 'key_exists' }])
})

test('bootstrap still works while a key is enrolled: the fallback when no enrolled device is left', async (t) => {
  const { s, alice, token, secret } = await startWithKey(t)
  const laptop = signIn(s, alice.id, 'laptop')
  const second = await enrolKeyByPassword(s, { token: laptop.token, userId: alice.id, secret, name: 'laptop' })
  assert.equal(activeKeyFor(s.db, alice.id, second.keyId).device_id, laptop.deviceId)
})

// ---- Tokens --------------------------------------------------------------

test('an agent token is refused on every POST; GET /approval-keys works with one', async (t) => {
  const { s, alice, token, key } = await startWithKey(t)
  const agent = createAgent(s.db, alice.id, 'box-a')
  for (const path of ['/approval-keys', '/approvals/nonce', '/approval-keys/requests', '/approval-keys/requests/x/approve', `/approval-keys/${key.keyId}/revoke`, '/approval-keys/attach']) {
    const r = await s.http(path, { method: 'POST', token: agent.token, body: {} })
    assert.deepEqual([path, r.status, r.json], [path, 403, { error: 'forbidden' }])
  }
  const listed = await s.http('/approval-keys', { token: agent.token })
  assert.equal(listed.status, 200)
  assert.deepEqual(listed.json.keys.map((k) => k.key_id), [key.keyId])
  assert.deepEqual(listed.json, await keysOf(s, token))
})

// ---- Enrolment by another device ------------------------------------------

test('a second key enrols by request, approved with a statement signed by the first', async (t) => {
  const { s, alice, token, key } = await startWithKey(t)
  const laptop = signIn(s, alice.id, 'laptop')
  const second = generateApprovalKey()
  const asked = await s.http('/approval-keys/requests', { method: 'POST', token: laptop.token, body: { public_key: second.publicKey, name: 'laptop' } })
  assert.equal(asked.status, 200)
  assert.equal(typeof asked.json.id, 'string')
  const pending = (await keysOf(s, token)).requests
  assert.equal(pending.length, 1)
  assert.deepEqual({ ...pending[0], created_at: typeof pending[0].created_at }, { id: asked.json.id, key_id: second.keyId, name: 'laptop', created_at: 'number' })

  const unsigned = await s.http(`/approval-keys/requests/${asked.json.id}/approve`, { method: 'POST', token, body: {} })
  assert.deepEqual([unsigned.status, unsigned.json], [403, { error: 'approval_required' }])

  const approval = await signAccount(s, { token, key, subject: { op: 'enrol_key', key_id: second.keyId } })
  const ok = await s.http(`/approval-keys/requests/${asked.json.id}/approve`, { method: 'POST', token, body: { approval } })
  assert.equal(ok.status, 200, JSON.stringify(ok.json))
  assert.equal(ok.json.key.key_id, second.keyId)
  const row = activeKeyFor(s.db, alice.id, second.keyId)
  assert.equal(row.device_id, laptop.deviceId, 'the key belongs to the device that asked')
  assert.equal(row.enrolled_via, 'device')
  assert.equal(row.enrolled_by, key.keyId)
  assert.deepEqual((await keysOf(s, token)).requests, [])
  assert.equal(notices(s, alice.id).at(-1).title, `Approval key added: laptop ${second.keyId.slice(0, 8)}`)
})

test('an approval signed for a different key_id is a mismatch, and does not burn the nonce', async (t) => {
  const { s, alice, token, key } = await startWithKey(t)
  const laptop = signIn(s, alice.id, 'laptop')
  const second = generateApprovalKey()
  const { id } = (await s.http('/approval-keys/requests', { method: 'POST', token: laptop.token, body: { public_key: second.publicKey, name: 'laptop' } })).json
  const nonce = (await s.http('/approvals/nonce', { method: 'POST', token })).json.nonce
  const sign = (keyId) => signForTest(key.privateKeyPem, {
    v: 1, type: 'account', journal: TEST_JOURNAL, user: 'alice', key_id: key.keyId, nonce, signed_at: Date.now(), subject: { op: 'enrol_key', key_id: keyId },
  })
  const wrong = await s.http(`/approval-keys/requests/${id}/approve`, { method: 'POST', token, body: { approval: sign(generateApprovalKey().keyId) } })
  assert.deepEqual([wrong.status, wrong.json], [400, { error: 'approval_invalid', reason: 'mismatch' }])
  assert.equal(activeKeyFor(s.db, alice.id, second.keyId), null)
  const right = await s.http(`/approval-keys/requests/${id}/approve`, { method: 'POST', token, body: { approval: sign(second.keyId) } })
  assert.equal(right.status, 200, 'the same nonce is still good after a failed attempt')
})

test('a key request lives ten minutes', async (t) => {
  const { s, alice, token, key } = await startWithKey(t)
  const laptop = signIn(s, alice.id, 'laptop')
  const second = generateApprovalKey()
  const { id } = (await s.http('/approval-keys/requests', { method: 'POST', token: laptop.token, body: { public_key: second.publicKey, name: 'laptop' } })).json
  s.db.prepare('UPDATE approval_key_requests SET created_at=? WHERE id=?').run(Date.now() - 10 * 60000 + 5000, id)
  assert.deepEqual((await keysOf(s, token)).requests.map((r) => r.id), [id], 'still live just under ten minutes')
  s.db.prepare('UPDATE approval_key_requests SET created_at=? WHERE id=?').run(Date.now() - 10 * 60000 - 1, id)
  assert.deepEqual((await keysOf(s, token)).requests, [])
  const approval = await signAccount(s, { token, key, subject: { op: 'enrol_key', key_id: second.keyId } })
  const r = await s.http(`/approval-keys/requests/${id}/approve`, { method: 'POST', token, body: { approval } })
  assert.deepEqual([r.status, r.json], [404, { error: 'not_found' }])
})

// ---- Nonces --------------------------------------------------------------

test('a nonce is single use', async (t) => {
  const { s, alice, token, deviceId, key } = await startWithKey(t)
  const expect = { type: 'account', subject: { op: 'test' } }
  const approval = await signAccount(s, { token, key, subject: { op: 'test' } })
  const first = requireApproval(ctxOf(s), client(alice.id, deviceId), { approval }, expect)
  assert.equal(first.ok, true)
  assert.deepEqual(requireApproval(ctxOf(s), client(alice.id, deviceId), { approval }, expect), invalid('nonce'))
})

test('a nonce is good for five minutes, and only for the device it was issued to', async (t) => {
  const { s, alice, token, deviceId } = await startWithKey(t)
  const who = client(alice.id, deviceId)
  const issuedAt = Date.now()
  const a = issueNonce(s.db, who, issuedAt)
  assert.match(a.nonce, /^[A-Za-z0-9_-]{43}$/, '32 random bytes, base64url')
  assert.equal(a.expires_at, issuedAt + NONCE_TTL_MS)
  assert.equal(consumeNonce(s.db, who, a.nonce, issuedAt + NONCE_TTL_MS), false, 'expired at five minutes')
  const b = issueNonce(s.db, who, issuedAt)
  assert.equal(consumeNonce(s.db, client(alice.id, deviceId + 1), b.nonce, issuedAt), false, 'another device')
  assert.equal(consumeNonce(s.db, who, b.nonce, issuedAt + NONCE_TTL_MS - 1), true)
  assert.equal(consumeNonce(s.db, who, b.nonce, issuedAt + 1), false, 'spent')
  const n = await s.http('/approvals/nonce', { method: 'POST', token })
  assert.equal(n.status, 200)
  assert.ok(n.json.expires_at > Date.now() + NONCE_TTL_MS - 5000)
})

test('requireApproval: an expired nonce fails with reason nonce', async (t) => {
  const { s, alice, token, deviceId, key } = await startWithKey(t)
  const approval = await signAccount(s, { token, key, subject: { op: 'test' } })
  const late = requireApproval(ctxOf(s, Date.now() + NONCE_TTL_MS + 1000), client(alice.id, deviceId), { approval }, { type: 'account', subject: { op: 'test' } })
  assert.deepEqual(late, invalid('nonce'))
})

// ---- requireApproval -----------------------------------------------------

test('requireApproval: a user without an active key passes with no approval, whatever is sent', async (t) => {
  const { s, alice, deviceId } = await startApprovalServer(t)
  const who = client(alice.id, deviceId)
  assert.deepEqual(requireApproval(ctxOf(s), who, {}, { type: 'account', subject: {} }), { ok: true, approval: null })
  assert.deepEqual(requireApproval(ctxOf(s), who, { approval: 'junk' }, { type: 'account', subject: {} }), { ok: true, approval: null })
})

test('requireApproval: each check fails with its own reason, in order', async (t) => {
  const { s, alice, token, deviceId, key } = await startWithKey(t)
  const who = client(alice.id, deviceId)
  const expect = { type: 'account', subject: { op: 'test', target: 'x' } }
  const check = (approval, e = expect) => requireApproval(ctxOf(s), who, { approval }, e)

  assert.deepEqual(requireApproval(ctxOf(s), who, {}, expect), { ok: false, status: 403, body: { error: 'approval_required' } })
  const good = await signAccount(s, { token, key, subject: expect.subject })
  assert.deepEqual(check('junk'), invalid('bad_statement'))
  assert.deepEqual(check({ statement: good.statement }), invalid('bad_statement'))
  assert.deepEqual(check({ ...good, extra: 'x' }), invalid('bad_statement'))
  assert.deepEqual(check({ statement: good.statement.replace('{', '{ '), signature: good.signature }), invalid('bad_statement'))

  assert.deepEqual(check(await signAccount(s, { token, key, subject: expect.subject, journal: 'other.example' })), invalid('mismatch'))
  assert.deepEqual(check(await signAccount(s, { token, key, subject: expect.subject, user: 'bob' })), invalid('mismatch'))

  const stranger = generateApprovalKey()
  assert.deepEqual(check(await signAccount(s, { token, key: stranger, subject: expect.subject })), invalid('unknown_key'))

  assert.deepEqual(check(await signAccount(s, { token, key, subject: { op: 'test', target: 'y' } })), invalid('mismatch'))
  assert.deepEqual(check(await signAccount(s, { token, key, subject: { op: 'test' } })), invalid('mismatch'), 'a missing subject key')
  assert.deepEqual(check(await signAccount(s, { token, key, subject: { ...expect.subject, more: 'z' } })), invalid('mismatch'), 'an extra subject key')
  assert.deepEqual(check(await signApproval(s, { token, key, type: 'consent', subject: expect.subject })), invalid('mismatch'), 'another type')

  // Claims the enrolled key but is signed by another.
  const forged = await signAccount(s, { token, key: { ...stranger, keyId: key.keyId }, subject: expect.subject })
  assert.deepEqual(check(forged), invalid('signature'))

  const ok = check(good)
  assert.equal(ok.ok, true)
  assert.deepEqual(ok.approval, { statement: good.statement, signature: good.signature })
  assert.equal(ok.keyId, key.keyId)
})

test('requireApproval: an item tap must match item, action and prompt digest', async (t) => {
  const { s, alice, token, deviceId, key } = await startWithKey(t)
  const who = client(alice.id, deviceId)
  const tap = { type: 'item_tap', item: { id: 'it_1', num: 7, reply_to: null }, action: 'Merge', prompt_digest: 'a'.repeat(64), subject: { op: 'merge' } }
  const sign = (over = {}) => signApproval(s, { token, key, ...tap, ...over })
  const check = async (over) => requireApproval(ctxOf(s), who, { approval: await sign(over) }, tap)
  assert.deepEqual(await check({ item: { id: 'it_2', num: 7, reply_to: null } }), invalid('mismatch'))
  assert.deepEqual(await check({ item: { id: 'it_1', num: 8, reply_to: null } }), invalid('mismatch'))
  assert.deepEqual(await check({ item: { id: 'it_1', num: 7, reply_to: 'ic_1' } }), invalid('mismatch'))
  assert.deepEqual(await check({ action: 'Close' }), invalid('mismatch'))
  assert.deepEqual(await check({ prompt_digest: 'b'.repeat(64) }), invalid('mismatch'))
  assert.equal((await check({})).ok, true)
})

// ---- Revocation ----------------------------------------------------------

test('revoke by a signed statement, with a notice', async (t) => {
  const { s, alice, token, key } = await startWithKey(t)
  const unsigned = await s.http(`/approval-keys/${key.keyId}/revoke`, { method: 'POST', token, body: {} })
  assert.deepEqual([unsigned.status, unsigned.json], [403, { error: 'approval_required' }])
  const other = await signAccount(s, { token, key, subject: { op: 'revoke_key', key_id: 'f'.repeat(64) } })
  const mismatch = await s.http(`/approval-keys/${key.keyId}/revoke`, { method: 'POST', token, body: { approval: other } })
  assert.deepEqual(mismatch.json, { error: 'approval_invalid', reason: 'mismatch' })

  const approval = await signAccount(s, { token, key, subject: { op: 'revoke_key', key_id: key.keyId } })
  const r = await s.http(`/approval-keys/${key.keyId}/revoke`, { method: 'POST', token, body: { approval } })
  assert.equal(r.status, 200, JSON.stringify(r.json))
  assert.equal(activeKeyFor(s.db, alice.id, key.keyId), null)
  assert.equal(typeof (await keysOf(s, token)).keys[0].revoked_at, 'number')
  assert.equal(hasActiveKey(s.db, alice.id), false, 'the last key gone: back to no key')
  assert.equal(notices(s, alice.id).at(-1).title, `Approval key removed: phone ${key.keyId.slice(0, 8)}`)
  const again = await s.http(`/approval-keys/${key.keyId}/revoke`, { method: 'POST', token, body: { approval } })
  assert.equal(again.status, 404)
})

test('revoke by password and TOTP; a recovery code is refused', async (t) => {
  const base = await startApprovalServer(t)
  const { s, alice, token } = base
  const { secret, recoveryCodes } = await enableTwoFactor(s, token)
  const key = await enrolKeyByPassword(s, { token, userId: alice.id, secret })
  const recovery = await s.http(`/approval-keys/${key.keyId}/revoke`, { method: 'POST', token, body: { password: TEST_PASSWORD, code: recoveryCodes[0] } })
  assert.deepEqual([recovery.status, recovery.json], [400, { error: 'totp_required' }])
  const badPassword = await s.http(`/approval-keys/${key.keyId}/revoke`, { method: 'POST', token, body: { password: 'nope', code: totpCode(s, alice.id, secret) } })
  assert.equal(badPassword.status, 401)
  assert.equal(hasActiveKey(s.db, alice.id), true)
  const r = await s.http(`/approval-keys/${key.keyId}/revoke`, { method: 'POST', token, body: { password: TEST_PASSWORD, code: totpCode(s, alice.id, secret) } })
  assert.equal(r.status, 200, JSON.stringify(r.json))
  assert.equal(hasActiveKey(s.db, alice.id), false)
  assert.equal(notices(s, alice.id).at(-1).title, `Approval key removed: phone ${key.keyId.slice(0, 8)}`)
})

test('the last key revoked, and only then, the account is back to no key', async (t) => {
  const { s, alice, token, deviceId, secret, key } = await startWithKey(t)
  const laptop = signIn(s, alice.id, 'laptop')
  const second = await enrolKeyByPassword(s, { token: laptop.token, userId: alice.id, secret, name: 'laptop' })
  const revoke = async (k, tok) => s.http(`/approval-keys/${k.keyId}/revoke`, {
    method: 'POST', token: tok, body: { approval: await signAccount(s, { token: tok, key: k, subject: { op: 'revoke_key', key_id: k.keyId } }) },
  })
  assert.equal((await revoke(key, token)).status, 200)
  assert.equal(hasActiveKey(s.db, alice.id), true, 'one key left')
  assert.deepEqual(requireApproval(ctxOf(s), client(alice.id, deviceId), {}, { type: 'account', subject: {} }).body, { error: 'approval_required' })
  assert.equal((await revoke(second, laptop.token)).status, 200)
  assert.equal(hasActiveKey(s.db, alice.id), false)
  assert.deepEqual(requireApproval(ctxOf(s), client(alice.id, deviceId), {}, { type: 'account', subject: {} }), { ok: true, approval: null })
})

test('revoking a device revokes its key; a sign-out that deletes the row only detaches it', async (t) => {
  const { s, alice, token, secret, key } = await startWithKey(t)
  const laptop = signIn(s, alice.id, 'laptop')
  const laptopKey = await enrolKeyByPassword(s, { token: laptop.token, userId: alice.id, secret, name: 'laptop' })

  // The admin's revoke.
  revokeDevice(s.db, laptop.deviceId)
  assert.equal(activeKeyFor(s.db, alice.id, laptopKey.keyId), null)

  // The user's revoke of one of their devices, from another.
  const tablet = signIn(s, alice.id, 'tablet')
  const tabletKey = await enrolKeyByPassword(s, { token: tablet.token, userId: alice.id, secret, name: 'tablet' })
  const r = await s.http(`/devices/${tablet.deviceId}/revoke`, { method: 'POST', token })
  assert.equal(r.status, 200)
  assert.equal(activeKeyFor(s.db, alice.id, tabletKey.keyId), null)
  assert.equal(notices(s, alice.id).at(-1).title, `Approval key removed: tablet ${tabletKey.keyId.slice(0, 8)}`)

  // A password change signing the others out: the phone's key stays enrolled,
  // with no device until the phone signs in again and attaches it. (The
  // change is an account action, signed by the desk's own key.)
  const desk = signIn(s, alice.id, 'desk')
  const deskKey = await enrolKeyByPassword(s, { token: desk.token, userId: alice.id, secret, name: 'desk' })
  const approval = await signAccount(s, { token: desk.token, key: deskKey, subject: { op: 'change_password' } })
  const changed = await s.http('/password', { method: 'POST', token: desk.token, body: { old_password: TEST_PASSWORD, new_password: TEST_PASSWORD, sign_out_others: true, approval } })
  assert.equal(changed.status, 200)
  assert.equal((await s.http('/approval-keys', { token })).status, 401, 'the phone was signed out')
  const kept = activeKeyFor(s.db, alice.id, key.keyId)
  assert.ok(kept, 'still enrolled')
  assert.equal(kept.device_id, null)
})

// ---- Attach --------------------------------------------------------------

test('attach: a new sign-in re-attaches its key; the old device row then gets wrong_device', async (t) => {
  const { s, alice, token, deviceId, key } = await startWithKey(t)
  const again = signIn(s, alice.id, 'phone')
  const expect = { type: 'account', subject: { op: 'test' } }

  const before = await signAccount(s, { token: again.token, key, subject: { op: 'test' } })
  assert.deepEqual(requireApproval(ctxOf(s), client(alice.id, again.deviceId), { approval: before }, expect), invalid('wrong_device'))

  const unsigned = await s.http('/approval-keys/attach', { method: 'POST', token: again.token, body: {} })
  assert.deepEqual([unsigned.status, unsigned.json], [403, { error: 'approval_required' }])
  const approval = await signAccount(s, { token: again.token, key, subject: { op: 'attach_key', key_id: key.keyId } })
  const r = await s.http('/approval-keys/attach', { method: 'POST', token: again.token, body: { approval } })
  assert.equal(r.status, 200, JSON.stringify(r.json))
  assert.equal(r.json.key.device_id, again.deviceId)
  assert.equal(activeKeyFor(s.db, alice.id, key.keyId).device_id, again.deviceId)
  const replay = await s.http('/approval-keys/attach', { method: 'POST', token: again.token, body: { approval } })
  assert.deepEqual(replay.json, { error: 'approval_invalid', reason: 'nonce' })

  const fromOld = await signAccount(s, { token, key, subject: { op: 'test' } })
  assert.deepEqual(requireApproval(ctxOf(s), client(alice.id, deviceId), { approval: fromOld }, expect), invalid('wrong_device'))
  const fromNew = await signAccount(s, { token: again.token, key, subject: { op: 'test' } })
  assert.equal(requireApproval(ctxOf(s), client(alice.id, again.deviceId), { approval: fromNew }, expect).ok, true)
})

test('attach: only with the key\'s own signature, for an enrolled key of this account', async (t) => {
  const { s, alice, token, secret, key } = await startWithKey(t)
  const laptop = signIn(s, alice.id, 'laptop')
  const laptopKey = await enrolKeyByPassword(s, { token: laptop.token, userId: alice.id, secret, name: 'laptop' })
  // The phone's key cannot move the laptop's key: the subject names the signer.
  const other = await signAccount(s, { token, key, subject: { op: 'attach_key', key_id: laptopKey.keyId } })
  const r = await s.http('/approval-keys/attach', { method: 'POST', token, body: { approval: other } })
  assert.deepEqual(r.json, { error: 'approval_invalid', reason: 'mismatch' })
  assert.equal(activeKeyFor(s.db, alice.id, laptopKey.keyId).device_id, laptop.deviceId)
  // A key that was never enrolled.
  const stranger = generateApprovalKey()
  const u = await s.http('/approval-keys/attach', {
    method: 'POST', token, body: { approval: await signAccount(s, { token, key: stranger, subject: { op: 'attach_key', key_id: stranger.keyId } }) },
  })
  assert.deepEqual(u.json, { error: 'approval_invalid', reason: 'unknown_key' })
  // A revoked key.
  const revoked = await s.http(`/approval-keys/${laptopKey.keyId}/revoke`, {
    method: 'POST', token, body: { approval: await signAccount(s, { token, key, subject: { op: 'revoke_key', key_id: laptopKey.keyId } }) },
  })
  assert.equal(revoked.status, 200)
  const rv = await s.http('/approval-keys/attach', {
    method: 'POST', token, body: { approval: await signAccount(s, { token, key: laptopKey, subject: { op: 'attach_key', key_id: laptopKey.keyId } }) },
  })
  assert.deepEqual(rv.json, { error: 'approval_invalid', reason: 'revoked_key' })
})
