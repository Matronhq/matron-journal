// Signed account actions: once the account has an approval key, the routes
// that widen access — change the password, approve a bridge pairing, link a
// device, change the Coordinator or its consent switches, change two-factor —
// need an `account` statement over the action's subject as well as every
// check they make today. The guard runs in the write's own transaction: a
// refused request changes nothing (a second-factor code it checked is not
// spent), and a request that fails today's checks or its write does not
// spend the nonce. An account with no key behaves exactly as before.
import test from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import { createAgent, verifyUserPassword } from '../src/auth.js'
import { upsertConversation } from '../src/journal.js'
import { base32Decode, hotp, totpStep } from '../src/two-factor.js'
import {
  startApprovalServer, enableTwoFactor, enrolKeyByPassword, signAccount, totpCode, TEST_PASSWORD,
} from './approval-helpers.js'

const sha = (s) => crypto.createHash('sha256').update(s, 'utf8').digest('hex')
const NEW_PW = 'brand-new-pw-1'
const invalid = (r, reason) => assert.deepEqual([r.status, r.json], [400, { error: 'approval_invalid', reason }])
const required = (r) => assert.deepEqual([r.status, r.json], [403, { error: 'approval_required' }])

// alice signed in on her phone with two-factor on, and (by default) an
// approval key on the phone; two conversations of hers on box-a.
async function world(t, { withKey = true } = {}) {
  const base = await startApprovalServer(t)
  const { s, alice, token } = base
  const { secret, recoveryCodes } = await enableTwoFactor(s, token)
  const key = withKey ? await enrolKeyByPassword(s, { token, userId: alice.id, secret }) : null
  const box = createAgent(s.db, alice.id, 'box-a')
  upsertConversation(s.db, { id: 'c1', ownerUserId: alice.id, title: 'One', agentDeviceId: box.deviceId })
  upsertConversation(s.db, { id: 'c2', ownerUserId: alice.id, title: 'Two', agentDeviceId: box.deviceId })
  const post = (path, body, method = 'POST') => s.http(path, { method, token, body })
  const sign = (subject) => signAccount(s, { token, key, subject })
  const code = () => totpCode(s, alice.id, secret)
  const spentNonces = () => s.db.prepare('SELECT COUNT(*) n FROM approval_nonces WHERE used_at IS NOT NULL').get().n
  const twoFactor = async () => (await s.http('/2fa', { token })).json
  return { ...base, secret, recoveryCodes, key, box, post, sign, code, spentNonces, twoFactor }
}

// ---- Password ------------------------------------------------------------

test('POST /password with a key: the signature comes on top of the current password; a refused change changes nothing and spends nothing', async (t) => {
  const w = await world(t)
  const body = { old_password: TEST_PASSWORD, new_password: NEW_PW }
  required(await w.post('/password', body))
  invalid(await w.post('/password', { ...body, approval: await w.sign({ op: 'two_factor', action: 'setup' }) }), 'mismatch')
  assert.ok(await verifyUserPassword(w.s.db, w.alice.id, TEST_PASSWORD), 'unchanged')

  const approval = await w.sign({ op: 'change_password' })
  // The current password is still asked for, and still checked first: a
  // wrong one with a valid signature is today's 401 and leaves the nonce.
  assert.deepEqual((await w.post('/password', { new_password: NEW_PW, approval })).json, { error: 'bad_request' })
  const wrong = await w.post('/password', { ...body, old_password: 'not-the-password', approval })
  assert.deepEqual([wrong.status, wrong.json], [401, { error: 'bad_password' }])
  assert.equal(w.spentNonces(), 0)

  const ok = await w.post('/password', { ...body, approval })
  assert.deepEqual([ok.status, ok.json], [200, { ok: true, signed_out: 0 }])
  assert.ok(await verifyUserPassword(w.s.db, w.alice.id, NEW_PW))
  invalid(await w.post('/password', { old_password: NEW_PW, new_password: 'third-pw-12', approval }), 'nonce')
  assert.ok(await verifyUserPassword(w.s.db, w.alice.id, NEW_PW))
})

// ---- Bridge pairing ------------------------------------------------------

test('POST /pair/approve with a key: signed over the code and the name; refused, the pair stays pending', async (t) => {
  const w = await world(t)
  const start = (await w.s.http('/pair/start', { method: 'POST', body: {} })).json
  const claim = async () => (await w.s.http('/pair/claim', { method: 'POST', body: { poll_token: start.poll_token } })).json
  const body = { pair_code: start.pair_code, agent_name: 'box-b' }
  required(await w.post('/pair/approve', body))
  invalid(await w.post('/pair/approve', { ...body, approval: await w.sign({ op: 'pair_bridge', code: start.pair_code, name: 'box-c' }) }), 'mismatch')
  invalid(await w.post('/pair/approve', { ...body, approval: await w.sign({ op: 'pair_bridge', code: 'ZZZZ-ZZZZ', name: 'box-b' }) }), 'mismatch')
  assert.deepEqual(await claim(), { status: 'pending' })

  const ok = await w.post('/pair/approve', { ...body, approval: await w.sign({ op: 'pair_bridge', code: start.pair_code, name: 'box-b' }) })
  assert.deepEqual([ok.status, ok.json], [200, { status: 'approved' }])
  const claimed = await claim()
  assert.equal(claimed.status, 'approved')
  assert.equal(w.s.db.prepare('SELECT name FROM devices WHERE id=?').get(claimed.device_id).name, 'box-b')
})

test('POST /pair/approve with a key: an unknown code is today\'s 404 and spends no nonce; a name over 200 characters is signed as name_sha256', async (t) => {
  const w = await world(t)
  const lost = await w.post('/pair/approve', { pair_code: 'ZZZZ-ZZZZ', agent_name: 'box-b', approval: await w.sign({ op: 'pair_bridge', code: 'ZZZZ-ZZZZ', name: 'box-b' }) })
  assert.deepEqual([lost.status, lost.json], [404, { error: 'not_found' }])
  assert.equal(w.spentNonces(), 0)

  const start = (await w.s.http('/pair/start', { method: 'POST', body: {} })).json
  const name = 'b'.repeat(250)
  invalid(await w.post('/pair/approve', { pair_code: start.pair_code, agent_name: name, approval: await w.sign({ op: 'pair_bridge', code: start.pair_code, name }) }), 'bad_statement')
  const ok = await w.post('/pair/approve', { pair_code: start.pair_code, agent_name: name, approval: await w.sign({ op: 'pair_bridge', code: start.pair_code, name_sha256: sha(name) }) })
  assert.equal(ok.status, 200, JSON.stringify(ok.json))
})

// ---- Device link ---------------------------------------------------------

test('POST /link/approve with a key: signed over the link code; a refused approval leaves the link claimed; a too-early one spends no nonce', async (t) => {
  const w = await world(t)
  const start = (await w.post('/link/start', {})).json
  const approval = await w.sign({ op: 'link_device', code: start.link_code })
  // Nothing claimed yet: today's 409, and the statement is still good.
  const early = await w.post('/link/approve', { link_code: start.link_code, approval })
  assert.deepEqual([early.status, early.json], [409, { error: 'conflict' }])
  assert.equal(w.spentNonces(), 0)

  const claim = (await w.s.http('/link/claim', { method: 'POST', body: { link_code: start.link_code, device_name: 'laptop' } })).json
  required(await w.post('/link/approve', { link_code: start.link_code }))
  invalid(await w.post('/link/approve', { link_code: start.link_code, approval: await w.sign({ op: 'link_device', code: 'ZZZZ-ZZZZ' }) }), 'mismatch')
  assert.equal((await w.post('/link/status', {})).json.status, 'claimed')

  const ok = await w.post('/link/approve', { link_code: start.link_code, approval })
  assert.deepEqual([ok.status, ok.json], [200, { status: 'approved' }])
  const polled = await w.s.http('/link/poll', { method: 'POST', body: { claim_token: claim.claim_token } })
  assert.equal(polled.json.status, 'approved')
})

// ---- Coordinator ---------------------------------------------------------

test('PUT /coordinator with a key: choosing or clearing the Coordinator is signed over the conversation id', async (t) => {
  const w = await world(t)
  const coordinator = async () => (await w.s.http('/coordinator', { token: w.token })).json.convo_id
  required(await w.post('/coordinator', { convo_id: 'c1' }, 'PUT'))
  invalid(await w.post('/coordinator', { convo_id: 'c1', approval: await w.sign({ op: 'set_coordinator', convo: 'c2' }) }, 'PUT'), 'mismatch')
  assert.equal(await coordinator(), null)

  const ok = await w.post('/coordinator', { convo_id: 'c1', approval: await w.sign({ op: 'set_coordinator', convo: 'c1' }) }, 'PUT')
  assert.deepEqual([ok.status, ok.json], [200, { convo_id: 'c1', consent: true, transfer_consent: false }])
  assert.equal(await coordinator(), 'c1')

  // A conversation that is not hers: today's 404, the nonce not spent.
  const spent = w.spentNonces()
  const nope = await w.post('/coordinator', { convo_id: 'nope', approval: await w.sign({ op: 'set_coordinator', convo: 'nope' }) }, 'PUT')
  assert.deepEqual([nope.status, nope.json], [404, { error: 'not_found' }])
  assert.equal(w.spentNonces(), spent)

  required(await w.post('/coordinator', { convo_id: null }, 'PUT'))
  invalid(await w.post('/coordinator', { convo_id: null, approval: await w.sign({ op: 'set_coordinator', convo: 'c1' }) }, 'PUT'), 'mismatch')
  const cleared = await w.post('/coordinator', { convo_id: null, approval: await w.sign({ op: 'set_coordinator', convo: '' }) }, 'PUT')
  assert.deepEqual([cleared.status, cleared.json], [200, { convo_id: null, consent: true, transfer_consent: false }])
})

test('PUT /coordinator with a key: each consent switch is signed over which switch and its new value', async (t) => {
  const w = await world(t)
  const settings = async () => (await w.s.http('/coordinator', { token: w.token })).json
  // The Coordinator's consent is on by default: turning it off is signed.
  required(await w.post('/coordinator', { consent: false }, 'PUT'))
  invalid(await w.post('/coordinator', { consent: false, approval: await w.sign({ op: 'set_consent', which: 'spawns', on: 'true' }) }, 'PUT'), 'mismatch')
  invalid(await w.post('/coordinator', { consent: false, approval: await w.sign({ op: 'set_consent', which: 'transfers', on: 'false' }) }, 'PUT'), 'mismatch')
  assert.equal((await settings()).consent, true)
  const off = await w.post('/coordinator', { consent: false, approval: await w.sign({ op: 'set_consent', which: 'spawns', on: 'false' }) }, 'PUT')
  assert.deepEqual([off.status, off.json], [200, { convo_id: null, consent: false, transfer_consent: false }])
  // And so is turning it back on.
  required(await w.post('/coordinator', { consent: true }, 'PUT'))
  const on = await w.post('/coordinator', { consent: true, approval: await w.sign({ op: 'set_consent', which: 'spawns', on: 'true' }) }, 'PUT')
  assert.equal(on.json.consent, true)

  required(await w.post('/coordinator', { transfer_consent: true }, 'PUT'))
  invalid(await w.post('/coordinator', { transfer_consent: true, approval: await w.sign({ op: 'set_consent', which: 'spawns', on: 'true' }) }, 'PUT'), 'mismatch')
  assert.equal((await settings()).transfer_consent, false)
  const tr = await w.post('/coordinator', { transfer_consent: true, approval: await w.sign({ op: 'set_consent', which: 'transfers', on: 'true' }) }, 'PUT')
  assert.deepEqual([tr.status, tr.json], [200, { convo_id: null, consent: true, transfer_consent: true }])
})

test('PUT /coordinator with a key: one change per signed request; two at once is a 400 and changes nothing', async (t) => {
  const w = await world(t)
  const approval = await w.sign({ op: 'set_coordinator', convo: 'c1' })
  const both = await w.post('/coordinator', { convo_id: 'c1', consent: false, approval }, 'PUT')
  assert.deepEqual([both.status, both.json], [400, { error: 'bad_request', detail: 'one_change_per_approval' }])
  assert.deepEqual((await w.s.http('/coordinator', { token: w.token })).json, { convo_id: null, consent: true, transfer_consent: false })
  assert.equal(w.spentNonces(), 0)
  assert.equal((await w.post('/coordinator', { convo_id: 'c1', approval }, 'PUT')).status, 200)
})

// ---- Two-factor ----------------------------------------------------------

test('POST /2fa/setup and /2fa/enable with a key: each signed; refused, the code checked is not spent and nothing changes', async (t) => {
  const w = await world(t)
  const pending = () => w.s.db.prepare('SELECT pending_secret FROM two_factor WHERE user_id=?').get(w.alice.id).pending_secret
  // A recovery code is spent by a request that goes through; a refused one
  // leaves it unspent.
  const [rc] = w.recoveryCodes
  required(await w.post('/2fa/setup', { password: TEST_PASSWORD, code: rc }))
  invalid(await w.post('/2fa/setup', { password: TEST_PASSWORD, code: rc, approval: await w.sign({ op: 'two_factor', action: 'enable' }) }), 'mismatch')
  assert.equal((await w.twoFactor()).recovery_codes_left, 10)
  assert.equal(pending(), null)

  // Today's checks first: a wrong password with a valid signature is a 401
  // and leaves the nonce.
  const approval = await w.sign({ op: 'two_factor', action: 'setup' })
  assert.equal((await w.post('/2fa/setup', { password: 'not-the-password', code: rc, approval })).status, 401)
  assert.equal((await w.post('/2fa/setup', { password: TEST_PASSWORD, code: '000000', approval })).status, 403)
  assert.equal(w.spentNonces(), 0)
  const setup = await w.post('/2fa/setup', { password: TEST_PASSWORD, code: rc, approval })
  assert.equal(setup.status, 200, JSON.stringify(setup.json))
  assert.equal((await w.twoFactor()).recovery_codes_left, 9)
  assert.ok(pending())

  const newCode = () => { w.s.db.prepare('UPDATE two_factor SET last_step=0 WHERE user_id=?').run(w.alice.id); return hotp(base32Decode(setup.json.secret), totpStep()) }
  required(await w.post('/2fa/enable', { code: newCode() }))
  invalid(await w.post('/2fa/enable', { code: newCode(), approval: await w.sign({ op: 'two_factor', action: 'setup' }) }), 'mismatch')
  assert.ok(pending(), 'still pending')
  const enable = await w.post('/2fa/enable', { code: newCode(), approval: await w.sign({ op: 'two_factor', action: 'enable' }) })
  assert.equal(enable.status, 200, JSON.stringify(enable.json))
  assert.equal(enable.json.recovery_codes.length, 10)
  assert.equal(pending(), null)
})

test('POST /2fa/disable and /2fa/recovery-codes with a key: each signed; a bad code with a valid signature spends no nonce', async (t) => {
  const w = await world(t)
  required(await w.post('/2fa/recovery-codes', { password: TEST_PASSWORD, code: w.code() }))
  invalid(await w.post('/2fa/recovery-codes', { password: TEST_PASSWORD, code: w.code(), approval: await w.sign({ op: 'two_factor', action: 'disable' }) }), 'mismatch')
  const approval = await w.sign({ op: 'two_factor', action: 'recovery_codes' })
  assert.deepEqual((await w.post('/2fa/recovery-codes', { password: TEST_PASSWORD, code: '000000', approval })).json, { error: 'bad_code' })
  assert.equal(w.spentNonces(), 0)
  const codes = await w.post('/2fa/recovery-codes', { password: TEST_PASSWORD, code: w.code(), approval })
  assert.equal(codes.status, 200)
  assert.ok(!codes.json.recovery_codes.includes(w.recoveryCodes[0]))

  required(await w.post('/2fa/disable', { password: TEST_PASSWORD, code: w.code() }))
  invalid(await w.post('/2fa/disable', { password: TEST_PASSWORD, code: w.code(), approval: await w.sign({ op: 'two_factor', action: 'recovery_codes' }) }), 'mismatch')
  assert.equal((await w.twoFactor()).enabled, true)
  const off = await w.post('/2fa/disable', { password: TEST_PASSWORD, code: w.code(), approval: await w.sign({ op: 'two_factor', action: 'disable' }) })
  assert.deepEqual([off.status, off.json], [200, { ok: true }])
  assert.equal((await w.twoFactor()).enabled, false)
})

test('with a key, a recovery code alone cannot turn two-factor off to make way for a new authenticator', async (t) => {
  // The path: a recovery code at /2fa/disable, then setup and enable with an
  // authenticator of one's own, then password plus TOTP enrolls a key. It
  // stops at the first step, and the recovery code is not spent.
  const w = await world(t)
  const [rc] = w.recoveryCodes
  required(await w.post('/2fa/disable', { password: TEST_PASSWORD, code: rc }))
  const state = await w.twoFactor()
  assert.equal(state.enabled, true)
  assert.equal(state.recovery_codes_left, 10)
  required(await w.post('/2fa/setup', { password: TEST_PASSWORD, code: rc }))
  assert.equal(w.s.db.prepare('SELECT pending_secret FROM two_factor WHERE user_id=?').get(w.alice.id).pending_secret, null)
})

// ---- No key, agents ------------------------------------------------------

test('no approval key: every one of these routes behaves as today, with no signature', async (t) => {
  const w = await world(t, { withKey: false })
  const ok = (r) => assert.equal(r.status, 200, JSON.stringify(r.json))
  ok(await w.post('/coordinator', { convo_id: 'c1', consent: false, transfer_consent: true }, 'PUT'))
  assert.deepEqual((await w.s.http('/coordinator', { token: w.token })).json, { convo_id: 'c1', consent: false, transfer_consent: true })
  ok(await w.post('/coordinator', { convo_id: null }, 'PUT'))
  const pair = (await w.s.http('/pair/start', { method: 'POST', body: {} })).json
  ok(await w.post('/pair/approve', { pair_code: pair.pair_code, agent_name: 'box-b' }))
  const link = (await w.post('/link/start', {})).json
  await w.s.http('/link/claim', { method: 'POST', body: { link_code: link.link_code, device_name: 'laptop' } })
  ok(await w.post('/link/approve', { link_code: link.link_code }))
  ok(await w.post('/2fa/recovery-codes', { password: TEST_PASSWORD, code: w.code() }))
  const setup = await w.post('/2fa/setup', { password: TEST_PASSWORD, code: w.code() })
  ok(setup)
  ok(await w.post('/2fa/enable', { code: hotp(base32Decode(setup.json.secret), totpStep()) }))
  w.s.db.prepare('UPDATE two_factor SET last_step=0 WHERE user_id=?').run(w.alice.id)
  ok(await w.post('/2fa/disable', { password: TEST_PASSWORD, code: hotp(base32Decode(setup.json.secret), totpStep()) }))
  ok(await w.post('/password', { old_password: TEST_PASSWORD, new_password: NEW_PW }))
  assert.equal(w.spentNonces(), 0)
})

test('agent tokens: these routes stay client-only, with or without a key', async (t) => {
  const w = await world(t)
  const asBox = (path, body, method = 'POST') => w.s.http(path, { method, token: w.box.token, body })
  for (const [path, body, method] of [
    ['/password', { old_password: TEST_PASSWORD, new_password: NEW_PW }],
    ['/pair/approve', { pair_code: 'ZZZZ-ZZZZ', agent_name: 'box-b' }],
    ['/link/approve', { link_code: 'ZZZZ-ZZZZ' }],
    ['/coordinator', { convo_id: 'c1' }, 'PUT'],
    ['/2fa/setup', { password: TEST_PASSWORD }],
    ['/2fa/enable', { code: '000000' }],
    ['/2fa/disable', { password: TEST_PASSWORD, code: '000000' }],
    ['/2fa/recovery-codes', { password: TEST_PASSWORD, code: '000000' }],
  ]) {
    const r = await asBox(path, body, method)
    assert.deepEqual([r.status, r.json], [403, { error: 'forbidden' }], path)
  }
})
