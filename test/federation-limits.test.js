import { test } from 'node:test'
import assert from 'node:assert/strict'
import { makeFederationLimiter } from '../src/federation-inbound.js'
import { generateFederationKey, signEnvelope, newOpId } from '../src/federation-envelope.js'
import { MAX_PENDING_OFFERS } from '../src/federation-grants.js'
import { createUser } from '../src/auth.js'
import { startTestServer } from './helpers.js'
import { world, KEY } from './federation-world.js'

const raw = (s, envelope, path = '/federation/v1') => fetch(s.base + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(envelope) })
  .then(async (r) => ({ status: r.status, json: await r.json() }))

test('limiter: a journal gets its burst, then one request a second', () => {
  let t = 0
  const l = makeFederationLimiter({ peerBurst: 3, peerPerSec: 1, now: () => t })
  assert.deepEqual([1, 2, 3, 4].map(() => l.take('a.example')), [true, true, true, false])
  assert.equal(l.take('b.example'), true, 'another journal has its own bucket')
  t += 1000
  assert.equal(l.take('a.example'), true)
  assert.equal(l.take('a.example'), false)
})

test('limiter: strangers share one bucket, and it is not any peer\'s', () => {
  const l = makeFederationLimiter({ peerBurst: 2, strangerBurst: 5, strangerPerSec: 1, now: () => 0 })
  assert.equal(Array.from({ length: 8 }, () => l.takeStranger()).filter(Boolean).length, 5)
  assert.equal(l.take('a.example'), true, 'a peer is not slowed by strangers')
})

test('POST /federation/v1: strangers get 429 past their shared burst', async (t) => {
  const s = await startTestServer({ tokenKey: KEY, federationEnv: { federation: 'on', publicUrl: 'https://b.example' }, federationLimits: { strangerBurst: 2 } })
  t.after(() => s.close())
  await createUser(s.db, 'bob', 'pw')
  const k = generateFederationKey()
  const send = () => raw(s, signEnvelope({ from: 'x@m.example', to: 'bob@b.example', op: 'ping', id: newOpId(), body: {} }, k.privateKey))
  const statuses = []
  for (let i = 0; i < 3; i++) statuses.push((await send()).status)
  assert.deepEqual(statuses, [403, 403, 429])
})

test('POST /federation/v1: a stranger cannot tell a user here from a name that does not exist', async (t) => {
  const s = await startTestServer({ tokenKey: KEY, federationEnv: { federation: 'on', publicUrl: 'https://b.example' } })
  t.after(() => s.close())
  const u = await createUser(s.db, 'reviewer', 'pw')
  s.db.prepare('UPDATE users SET unlisted=1 WHERE id=?').run(u.id)
  await createUser(s.db, 'bob', 'pw')
  const k = generateFederationKey()
  const probe = (name) => raw(s, signEnvelope({ from: 'x@m.example', to: `${name}@b.example`, op: 'ping', id: newOpId(), body: {} }, k.privateKey))
  const answers = [await probe('bob'), await probe('reviewer'), await probe('nobody')]
  assert.deepEqual(answers.map((a) => [a.status, a.json.error]), Array(3).fill([403, 'unknown_journal']))
})

test('POST /federation/v1: a known journal draws on its own bucket, and asks about users only once proved', async (t) => {
  const w = await world(t)
  const key = w.a.federation.key.privateKey
  const ping = (to) => raw(w.b, signEnvelope({ from: 'alice@a.example', to, op: 'ping', id: newOpId(), body: {} }, key))
  assert.equal((await ping('bob@b.example')).status, 200)
  assert.deepEqual((await ping('nobody@b.example')).json, { error: 'not_here' })
})

test('a contact journal cannot keep raising share cards: at most MAX_PENDING_OFFERS wait', async (t) => {
  const w = await world(t)
  const key = w.a.federation.key.privateKey
  const statuses = []
  for (let i = 0; i < MAX_PENDING_OFFERS + 3; i++) {
    const r = await raw(w.b, signEnvelope({
      from: 'alice@a.example', to: 'bob@b.example', op: 'grant.offer', id: newOpId(),
      body: { grant: `gr_many${i}`, level: 'read', sent: Date.now(), mission: { num: i + 1, title: `Mission ${i}` }, preview: {} },
    }, key))
    statuses.push(r.status === 200 ? 200 : r.json.error)
  }
  assert.deepEqual(statuses, [...Array(MAX_PENDING_OFFERS).fill(200), 'too_many_offers', 'too_many_offers', 'too_many_offers'])
  const cards = w.b.db.prepare("SELECT COUNT(*) AS n FROM items WHERE user_id=? AND consent='share' AND state='open'").get(w.users.bob.id).n
  assert.equal(cards, MAX_PENDING_OFFERS)
})
