import test from 'node:test'
import assert from 'node:assert/strict'
import { startTestServer } from './helpers.js'
import { createUser } from '../src/auth.js'
import { upsertConversation, append } from '../src/journal.js'

test('login → snapshot → pagination over HTTP', async (t) => {
  const s = await startTestServer()
  t.after(() => s.close())
  const dan = await createUser(s.db, 'dan', 'hunter22')
  upsertConversation(s.db, { id: 'c1', ownerUserId: dan.id, title: 'T' })
  append(s.db, { userId: dan.id, convoId: 'c1', sender: 'agent:a', type: 'text', payload: { body: 'hi' } })

  const bad = await s.http('/login', { method: 'POST', body: { username: 'dan', password: 'no', device_name: 'x' } })
  assert.equal(bad.status, 403)
  const ok = await s.http('/login', { method: 'POST', body: { username: 'dan', password: 'hunter22', device_name: 'mac' } })
  assert.equal(ok.status, 200)

  assert.equal((await s.http('/snapshot', {})).status, 401)
  const snap = await s.http('/snapshot', { token: ok.json.token })
  assert.equal(snap.json.seq, 1)
  assert.equal(snap.json.conversations.length, 1)

  const page = await s.http('/convo/c1/messages?limit=10', { token: ok.json.token })
  assert.equal(page.json.events[0].payload.body, 'hi')
  // pagination shape must match the WS journal frame shape (minus `kind`) and must not
  // leak internal columns like user_id, idem_key, blob_ref
  assert.deepEqual(Object.keys(page.json.events[0]).sort(), ['convo_id', 'payload', 'sender', 'seq', 'ts', 'type'])

  await createUser(s.db, 'pat', 'pw')
  const pat = await s.http('/login', { method: 'POST', body: { username: 'pat', password: 'pw', device_name: 'x' } })
  assert.equal((await s.http('/convo/c1/messages', { token: pat.json.token })).status, 403)
})

test('login rate limit returns 429', async (t) => {
  const s = await startTestServer()
  t.after(() => s.close())
  await createUser(s.db, 'dan', 'pw')
  for (let i = 0; i < 5; i++) {
    await s.http('/login', { method: 'POST', body: { username: 'dan', password: 'wrong', device_name: 'x' } })
  }
  const r = await s.http('/login', { method: 'POST', body: { username: 'dan', password: 'pw', device_name: 'x' } })
  assert.equal(r.status, 429)
})

test('login rate limit keys on cf-connecting-ip, not the tunnel-shared socket address', async (t) => {
  const s = await startTestServer()
  t.after(() => s.close())
  await createUser(s.db, 'dan', 'pw')

  const loginAs = (cfIp, password) => fetch(s.base + '/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'cf-connecting-ip': cfIp },
    body: JSON.stringify({ username: 'dan', password, device_name: 'x' }),
  })

  // Behind the tunnel every request arrives from the same socket (127.0.0.1), so
  // without per-header keying this would lock out every client after 5 bad logins
  // from any one of them. Exhaust the limit for client A...
  for (let i = 0; i < 5; i++) await loginAs('1.1.1.1', 'wrong')
  const blockedA = await loginAs('1.1.1.1', 'wrong')
  assert.equal(blockedA.status, 429)

  // ...client B, a different cf-connecting-ip, must still be able to log in.
  const okB = await loginAs('2.2.2.2', 'pw')
  assert.equal(okB.status, 200)
})

test('oversized login body gets 413 and server stays responsive', async (t) => {
  const s = await startTestServer()
  t.after(() => s.close())
  const big = JSON.stringify({ username: 'x'.repeat(1_100_000), password: 'y', device_name: 'z' })
  const r = await fetch(s.base + '/login', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: big,
  }).catch(() => null)
  if (r) assert.equal(r.status, 413)
  const after = await s.http('/snapshot', {})
  assert.equal(after.status, 401)
})

test('server stops consuming an oversized streaming body', async (t) => {
  const s = await startTestServer()
  t.after(() => s.close())
  const { request } = await import('node:http')
  const bytesWritten = await new Promise((resolve) => {
    const req = request(s.base + '/login', { method: 'POST', headers: { 'content-type': 'application/json' } })
    let written = 0
    let done = false
    const finish = () => { if (!done) { done = true; resolve(written) } }
    const chunk = 'x'.repeat(65536)
    req.on('error', finish)
    req.on('response', (res) => { res.resume(); res.on('end', () => setTimeout(finish, 100)) })
    setTimeout(finish, 4000)
    const pump = () => {
      while (written < 32e6 && !done) {
        written += chunk.length
        if (!req.write(chunk)) { req.once('drain', pump); return }
      }
      if (!done) req.end()
    }
    pump()
  })
  assert.ok(bytesWritten < 16e6, `client managed to write ${bytesWritten} bytes — server still consuming`)
})
