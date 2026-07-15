import test from 'node:test'
import assert from 'node:assert/strict'
import { makePairStore, normalizeCode } from '../src/pairing.js'

test('start returns a well-formed pair and claim is pending until approve', () => {
  const store = makePairStore()
  const p = store.start()
  assert.match(p.pairCode, /^[0-9BCDFGHJKMNPQRSTVWXYZ]{4}-[0-9BCDFGHJKMNPQRSTVWXYZ]{4}$/)
  assert.match(p.pollToken, /^[0-9a-f]{64}$/)
  assert.equal(p.expiresIn, 600)
  assert.deepEqual(store.claim(p.pollToken), { status: 'pending' })
  assert.equal(store.size(), 1)
})

test('approve → claim returns identity exactly once, then not_found', () => {
  const store = makePairStore()
  const p = store.start()
  assert.equal(store.approve(p.pairCode, { userId: 7, agentName: 'dev-9' }), 'approved')
  const c = store.claim(p.pollToken)
  assert.deepEqual(c, { status: 'approved', userId: 7, agentName: 'dev-9' })
  assert.deepEqual(store.claim(p.pollToken), { status: 'not_found' })
  assert.equal(store.size(), 0)
})

test('approve normalizes user-typed codes (lowercase, hyphens, spaces)', () => {
  const store = makePairStore()
  const p = store.start()
  const sloppy = ` ${p.pairCode.toLowerCase().replace('-', ' ')} `
  assert.equal(store.approve(sloppy, { userId: 1, agentName: 'a' }), 'approved')
  assert.equal(normalizeCode('ab-cd 12'), 'ABCD12')
})

test('second approve of the same code is conflict; unknown code is not_found', () => {
  const store = makePairStore()
  const p = store.start()
  assert.equal(store.approve(p.pairCode, { userId: 1, agentName: 'a' }), 'approved')
  assert.equal(store.approve(p.pairCode, { userId: 2, agentName: 'b' }), 'conflict')
  // the winning approval is untouched by the losing one
  assert.deepEqual(store.claim(p.pollToken), { status: 'approved', userId: 1, agentName: 'a' })
  assert.equal(store.approve('ZZZZ-ZZZZ', { userId: 1, agentName: 'a' }), 'not_found')
})

test('expiry: approve and claim both see an expired pair as not_found', async () => {
  const store = makePairStore({ ttlMs: 20 })
  const p = store.start()
  await new Promise((r) => setTimeout(r, 40))
  assert.equal(store.approve(p.pairCode, { userId: 1, agentName: 'a' }), 'not_found')
  assert.deepEqual(store.claim(p.pollToken), { status: 'not_found' })
})

test('an approved-but-unclaimed pair also expires', async () => {
  const store = makePairStore({ ttlMs: 20 })
  const p = store.start()
  store.approve(p.pairCode, { userId: 1, agentName: 'a' })
  await new Promise((r) => setTimeout(r, 40))
  assert.deepEqual(store.claim(p.pollToken), { status: 'not_found' })
})

test('cap: start returns null at maxPending, and expired pairs free slots', async () => {
  const store = makePairStore({ ttlMs: 20, maxPending: 2 })
  assert.ok(store.start())
  assert.ok(store.start())
  assert.equal(store.start(), null)
  await new Promise((r) => setTimeout(r, 40))
  assert.ok(store.start()) // sweep on start() reclaimed the expired slots
})
