import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { keyIdOf, parseStatement, promptDigest, verifySignature } from '../src/approvals.js'
import { canonicalize } from '../src/federation-jcs.js'
import { generateApprovalKey, signForTest } from './approval-helpers.js'

const fx = JSON.parse(fs.readFileSync(new URL('./fixtures/approval-vectors.json', import.meta.url), 'utf8'))
const tap = fx.statements.item_tap

test('keyIdOf matches the fixture and rejects bad points', () => {
  assert.equal(keyIdOf(fx.public_key), fx.key_id)
  const raw = Buffer.from(fx.public_key, 'base64url')
  assert.throws(() => keyIdOf(raw.subarray(0, 64).toString('base64url')), /bad_public_key/)
  assert.throws(() => keyIdOf(raw.subarray(0, 33).toString('base64url')), /bad_public_key/)
  const off = Buffer.from(raw); off[64] ^= 1
  assert.throws(() => keyIdOf(off.toString('base64url')), /bad_public_key/)
  assert.throws(() => keyIdOf(42), /bad_public_key/)
})

test('parseStatement accepts the fixture statements', () => {
  for (const s of Object.values(fx.statements)) assert.deepEqual(parseStatement(s.statement), JSON.parse(s.statement))
})

test('parseStatement refuses non-canonical and malformed statements', () => {
  const obj = JSON.parse(tap.statement)
  const bad = []
  bad.push(tap.statement.replace('{"', '{ "'))
  bad.push(JSON.stringify(Object.fromEntries(Object.entries(obj).reverse())))
  const mut = (f) => { const o = structuredClone(obj); f(o); return JSON.stringify(Object.fromEntries(Object.entries(o).sort(([a], [b]) => (a < b ? -1 : 1)))) }
  bad.push(mut((o) => { o.v = 2 }))
  bad.push(mut((o) => { o.type = 'x' }))
  bad.push(mut((o) => { o.subject = Object.fromEntries(Array.from({ length: 13 }, (_, i) => ['k' + i, 'v'])) }))
  bad.push(mut((o) => { o.subject = { a: 'x'.repeat(201) } }))
  bad.push(mut((o) => { o.subject = { a: { b: 'c' } } }))
  bad.push(mut((o) => { o.extra = 1 }))
  bad.push(mut((o) => { delete o.action }))
  bad.push(mut((o) => { o.signed_at = 1.5 }))
  bad.push(mut((o) => { o.item.num = '7' }))
  const consent = JSON.parse(fx.statements.consent.statement)
  bad.push(canonicalize({ ...consent, action: 'x' }))
  bad.push('not json', '', '[]', 'null')
  for (const s of bad) assert.equal(parseStatement(s), null, s)
  for (const s of [undefined, null, 5, {}, []]) assert.equal(parseStatement(s), null)
})

test('verifySignature', () => {
  assert.equal(verifySignature(fx.public_key, tap.statement, tap.signature), true)
  assert.equal(verifySignature(fx.public_key, tap.statement.replace('Approve', 'Approvf'), tap.signature), false)
  const other = generateApprovalKey()
  const forged = signForTest(other.privateKeyPem, JSON.parse(tap.statement))
  assert.equal(forged.statement, tap.statement)
  assert.equal(verifySignature(fx.public_key, forged.statement, forged.signature), false)
  assert.equal(verifySignature(other.publicKey, forged.statement, forged.signature), true)
  assert.equal(verifySignature(fx.public_key, tap.statement, '!!!not base64!!!'), false)
  assert.equal(verifySignature('garbage', tap.statement, tap.signature), false)
  assert.equal(verifySignature(fx.public_key, tap.statement, ''), false)
})

test('promptDigest', () => {
  const { input, digest } = fx.prompt_digest_example
  assert.equal(promptDigest(input), digest)
  assert.notEqual(promptDigest({ body: input.body }), digest)
})
