import test from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import http2 from 'node:http2'
import { EventEmitter } from 'node:events'
import { makeApnsClient } from '../src/apns.js'
import { makeTestKey, makeFakeApnsServer } from './apns-helpers.js'

const base64urlDecode = (s) => Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64')

test('mints an ES256 JWT with the expected header/claims, verifiable with the test key', async (t) => {
  const { keyFile, publicKey } = makeTestKey()
  const { server, port, requests } = await makeFakeApnsServer(() => ({ status: 200 }))
  t.after(() => server.close())

  const client = makeApnsClient({
    keyFile, keyId: 'KID123', teamId: 'TEAM456', topic: 'chat.matron.x',
    connect: () => http2.connect(`http://127.0.0.1:${port}`),
  })
  t.after(() => client.close())

  const result = await client.send({
    deviceToken: 'a'.repeat(64), env: 'prod', payload: { aps: { alert: { title: 't', body: 'b' } } },
    priority: 5, pushType: 'alert',
  })
  assert.equal(result.status, 200)

  const auth = requests[0].headers.authorization
  assert.match(auth, /^bearer /)
  const jwtToken = auth.slice('bearer '.length)
  const [headerB64, claimsB64, sigB64] = jwtToken.split('.')
  const header = JSON.parse(base64urlDecode(headerB64))
  const claims = JSON.parse(base64urlDecode(claimsB64))
  assert.equal(header.alg, 'ES256')
  assert.equal(header.kid, 'KID123')
  assert.equal(claims.iss, 'TEAM456')
  assert.ok(Number.isInteger(claims.iat))

  const signingInput = `${headerB64}.${claimsB64}`
  const verified = crypto.verify(
    'sha256', Buffer.from(signingInput), { key: publicKey, dsaEncoding: 'ieee-p1363' }, base64urlDecode(sigB64)
  )
  assert.ok(verified, 'JWT signature does not verify against the test public key')
})

test('routes prod and sandbox to the correct APNs host', async () => {
  const { keyFile } = makeTestKey()
  const { server, port } = await makeFakeApnsServer(() => ({ status: 200 }))
  const recordedHosts = []
  const client = makeApnsClient({
    keyFile, keyId: 'k', teamId: 't', topic: 'chat.matron.x',
    connect: (authority) => { recordedHosts.push(authority); return http2.connect(`http://127.0.0.1:${port}`) },
  })

  await client.send({ deviceToken: 'a'.repeat(64), env: 'prod', payload: {}, priority: 5, pushType: 'alert' })
  await client.send({ deviceToken: 'b'.repeat(64), env: 'sandbox', payload: {}, priority: 5, pushType: 'alert' })

  assert.equal(recordedHosts[0], 'https://api.push.apple.com')
  assert.equal(recordedHosts[1], 'https://api.sandbox.push.apple.com')
  client.close()
  server.close()
})

test('sends the expected headers, including apns-collapse-id only when set', async (t) => {
  const { keyFile } = makeTestKey()
  const { server, port, requests } = await makeFakeApnsServer(() => ({ status: 200 }))
  t.after(() => server.close())
  const client = makeApnsClient({
    keyFile, keyId: 'k', teamId: 't', topic: 'chat.matron.x',
    connect: () => http2.connect(`http://127.0.0.1:${port}`),
  })
  t.after(() => client.close())

  await client.send({
    deviceToken: 'deadbeef', env: 'prod', payload: { aps: { alert: { title: 'x', body: 'y' } } },
    priority: 10, pushType: 'alert', collapseId: 'convo-42',
  })
  await client.send({
    deviceToken: 'deadbeef', env: 'prod', payload: { aps: { 'content-available': 1 } },
    priority: 5, pushType: 'background',
  })

  const [withCollapse, withoutCollapse] = requests
  assert.equal(withCollapse.headers[':method'], 'POST')
  assert.equal(withCollapse.headers[':path'], '/3/device/deadbeef')
  assert.equal(withCollapse.headers['apns-topic'], 'chat.matron.x')
  assert.equal(withCollapse.headers['apns-push-type'], 'alert')
  assert.equal(withCollapse.headers['apns-priority'], '10')
  assert.equal(withCollapse.headers['apns-expiration'], '0')
  assert.equal(withCollapse.headers['apns-collapse-id'], 'convo-42')
  assert.equal(withCollapse.payload.aps.alert.title, 'x')

  assert.equal(withoutCollapse.headers['apns-push-type'], 'background')
  assert.equal(withoutCollapse.headers['apns-priority'], '5')
  assert.equal(withoutCollapse.headers['apns-collapse-id'], undefined)
})

test('resolves {status, reason} from a 410 Unregistered and a 400 BadDeviceToken response', async (t) => {
  const { keyFile } = makeTestKey()
  const { server, port } = await makeFakeApnsServer((ctx) => {
    if (ctx.headers[':path'] === '/3/device/deadtoken') return { status: 410, reasonBody: { reason: 'Unregistered', timestamp: 123 } }
    return { status: 400, reasonBody: { reason: 'BadDeviceToken' } }
  })
  t.after(() => server.close())
  const client = makeApnsClient({
    keyFile, keyId: 'k', teamId: 't', topic: 'chat.matron.x',
    connect: () => http2.connect(`http://127.0.0.1:${port}`),
  })
  t.after(() => client.close())

  const unregistered = await client.send({ deviceToken: 'deadtoken', env: 'prod', payload: {}, priority: 5, pushType: 'alert' })
  assert.equal(unregistered.status, 410)
  assert.equal(unregistered.reason, 'Unregistered')

  const badToken = await client.send({ deviceToken: 'wrongenvtoken', env: 'prod', payload: {}, priority: 5, pushType: 'alert' })
  assert.equal(badToken.status, 400)
  assert.equal(badToken.reason, 'BadDeviceToken')
})

test('a transport failure resolves {status: 0, reason: "transport"} instead of throwing', async () => {
  const { keyFile } = makeTestKey()
  const client = makeApnsClient({
    keyFile, keyId: 'k', teamId: 't', topic: 'chat.matron.x',
    connect: () => { throw new Error('ECONNREFUSED') },
  })
  const result = await client.send({ deviceToken: 'a'.repeat(64), env: 'prod', payload: {}, priority: 5, pushType: 'alert' })
  assert.deepEqual(result, { status: 0, reason: 'transport' })
})

// A controllable stand-in for an http2 ClientHttp2Session, so the
// reconnect-on-dead-session path can be exercised deterministically without
// real sockets. `session.destroy()` simulates the session dying between two
// sends — mirrors the 'error'/'goaway'/'close' teardown makeApnsClient wires
// up on every session it creates.
function makeFakeSession({ status = 200, reasonBody = null } = {}) {
  const session = new EventEmitter()
  session.destroyed = false
  session.closed = false
  session.request = () => {
    const stream = new EventEmitter()
    stream.setEncoding = () => {}
    stream.write = () => {}
    stream.end = () => {
      queueMicrotask(() => {
        stream.emit('response', { ':status': status })
        if (reasonBody) stream.emit('data', JSON.stringify(reasonBody))
        stream.emit('end')
      })
    }
    return stream
  }
  session.close = () => { session.closed = true }
  session.destroy = () => { session.destroyed = true; session.emit('close') }
  return session
}

test('a session torn down between sends is not reused — the next send reconnects once', async () => {
  const { keyFile } = makeTestKey()
  const sessions = [makeFakeSession(), makeFakeSession()]
  let connectCount = 0
  const client = makeApnsClient({
    keyFile, keyId: 'k', teamId: 't', topic: 'chat.matron.x',
    connect: () => sessions[connectCount++],
  })

  const r1 = await client.send({ deviceToken: 'a'.repeat(64), env: 'prod', payload: {}, priority: 5, pushType: 'alert' })
  assert.equal(r1.status, 200)
  assert.equal(connectCount, 1)

  sessions[0].destroy() // simulate the session dying between sends

  const r2 = await client.send({ deviceToken: 'b'.repeat(64), env: 'prod', payload: {}, priority: 5, pushType: 'alert' })
  assert.equal(r2.status, 200)
  assert.equal(connectCount, 2, 'expected a fresh session after the old one was torn down')
})

test('a request that never gets a response settles {status: 0, reason: "timeout"} after requestTimeoutMs', async () => {
  const { keyFile } = makeTestKey()
  const session = new EventEmitter()
  session.destroyed = false
  session.closed = false
  let closedStreams = 0
  session.request = () => {
    // A stream that accepts the request but never responds — the shape of a
    // stalled connection where neither 'end', 'error', nor 'close' arrives.
    const stream = new EventEmitter()
    stream.setEncoding = () => {}
    stream.write = () => {}
    stream.end = () => {}
    stream.close = () => { closedStreams += 1 }
    return stream
  }
  const client = makeApnsClient({
    keyFile, keyId: 'k', teamId: 't', topic: 'chat.matron.x',
    connect: () => session, requestTimeoutMs: 50,
  })

  // The per-request timeout is deliberately unref'd (it must never keep the
  // server process alive), so in a bare test — unlike the real server, whose
  // listen handles keep the loop running — something ref'd has to hold the
  // event loop open long enough for it to fire.
  const keepAlive = setTimeout(() => {}, 5000)
  try {
    const result = await client.send({ deviceToken: 'a'.repeat(64), env: 'prod', payload: {}, priority: 5, pushType: 'alert' })
    assert.deepEqual(result, { status: 0, reason: 'timeout' })
    assert.equal(closedStreams, 1, 'the timed-out stream must be torn down, not leaked')
  } finally {
    clearTimeout(keepAlive)
  }
})

test('a stream torn down with only a close event (no end/error) settles transport failure', async () => {
  const { keyFile } = makeTestKey()
  const session = new EventEmitter()
  session.destroyed = false
  session.closed = false
  session.request = () => {
    const stream = new EventEmitter()
    stream.setEncoding = () => {}
    stream.write = () => {}
    stream.end = () => { queueMicrotask(() => stream.emit('close')) }
    return stream
  }
  const client = makeApnsClient({ keyFile, keyId: 'k', teamId: 't', topic: 'chat.matron.x', connect: () => session })

  const result = await client.send({ deviceToken: 'a'.repeat(64), env: 'prod', payload: {}, priority: 5, pushType: 'alert' })
  assert.deepEqual(result, { status: 0, reason: 'transport' })
})

test('a send whose stream errors mid-flight resolves transport failure without throwing', async () => {
  const { keyFile } = makeTestKey()
  const session = new EventEmitter()
  session.destroyed = false
  session.closed = false
  session.request = () => {
    const stream = new EventEmitter()
    stream.setEncoding = () => {}
    stream.write = () => {}
    stream.end = () => { queueMicrotask(() => stream.emit('error', new Error('stream reset'))) }
    return stream
  }
  const client = makeApnsClient({ keyFile, keyId: 'k', teamId: 't', topic: 'chat.matron.x', connect: () => session })

  const result = await client.send({ deviceToken: 'a'.repeat(64), env: 'prod', payload: {}, priority: 5, pushType: 'alert' })
  assert.deepEqual(result, { status: 0, reason: 'transport' })
})

// Fake session whose streams behave per `mode` ('ok' responds 200, 'close'
// tears the stream down with no response, 'hang' never answers). It records
// destroy() and answers ping() per `ping` ('ack', 'error', 'silent').
function makeScriptedSession({ mode = 'ok', ping = 'ack' } = {}) {
  const session = new EventEmitter()
  session.destroyed = false
  session.closed = false
  session.requests = 0
  session.headers = []
  session.pings = 0
  session.request = (headers) => {
    session.requests += 1
    session.headers.push(headers)
    const stream = new EventEmitter()
    stream.setEncoding = () => {}
    stream.write = () => {}
    stream.close = () => {}
    stream.end = () => {
      if (mode === 'ok') {
        queueMicrotask(() => { stream.emit('response', { ':status': 200 }); stream.emit('end') })
      } else if (mode === 'close') {
        queueMicrotask(() => stream.emit('close'))
      }
    }
    return stream
  }
  session.ping = (cb) => {
    session.pings += 1
    if (ping === 'ack') queueMicrotask(() => cb(null, 1))
    else if (ping === 'error') queueMicrotask(() => cb(new Error('ERR_HTTP2_PING_CANCEL')))
    return true
  }
  session.close = () => { session.closed = true }
  session.destroy = () => { session.destroyed = true; session.emit('close') }
  return session
}

const PUSH = { deviceToken: 'a'.repeat(64), env: 'prod', payload: {}, priority: 5, pushType: 'alert' }
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

test('a transport failure on a reused session retries the push once on a fresh session', async () => {
  const { keyFile } = makeTestKey()
  const first = makeScriptedSession()
  const fresh = makeScriptedSession()
  const sessions = [first, fresh]
  let connectCount = 0
  const client = makeApnsClient({
    keyFile, keyId: 'k', teamId: 't', topic: 'chat.matron.x', pingIntervalMs: 0,
    connect: () => sessions[connectCount++],
  })

  assert.equal((await client.send(PUSH)).status, 200)
  // The connection dies under the next request without the session noticing.
  const dying = makeScriptedSession({ mode: 'close' })
  first.request = dying.request

  const result = await client.send(PUSH)
  assert.equal(result.status, 200, 'the retry on a fresh session should deliver the push')
  assert.equal(connectCount, 2)
  assert.equal(first.destroyed, true, 'the dead session must be discarded')
  assert.equal(fresh.requests, 1)
  const [failedId, retriedId] = [dying.headers[0]['apns-id'], fresh.headers[0]['apns-id']]
  assert.match(failedId, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)
  assert.equal(retriedId, failedId, 'both attempts must carry the same apns-id')
  assert.notEqual(first.headers[0]['apns-id'], failedId, 'each send gets its own apns-id')
})

test('a transport failure on a session opened for the send is not retried, but the session is discarded', async () => {
  const { keyFile } = makeTestKey()
  const opened = []
  const client = makeApnsClient({
    keyFile, keyId: 'k', teamId: 't', topic: 'chat.matron.x', pingIntervalMs: 0,
    connect: () => { const s = makeScriptedSession({ mode: opened.length ? 'ok' : 'close' }); opened.push(s); return s },
  })

  assert.deepEqual(await client.send(PUSH), { status: 0, reason: 'transport' })
  assert.equal(opened.length, 1, 'no retry on a session opened for this send')
  assert.equal(opened[0].destroyed, true)
  assert.equal((await client.send(PUSH)).status, 200)
  assert.equal(opened.length, 2, 'the next send must not reuse the failed session')
})

test('a retry that also fails returns transport failure and stops', async () => {
  const { keyFile } = makeTestKey()
  const first = makeScriptedSession()
  let connectCount = 0
  const client = makeApnsClient({
    keyFile, keyId: 'k', teamId: 't', topic: 'chat.matron.x', pingIntervalMs: 0,
    connect: () => (connectCount++ === 0 ? first : makeScriptedSession({ mode: 'close' })),
  })

  await client.send(PUSH)
  first.request = makeScriptedSession({ mode: 'close' }).request
  assert.deepEqual(await client.send(PUSH), { status: 0, reason: 'transport' })
  assert.equal(connectCount, 2, 'exactly one retry')
})

test('a timed-out request discards the session so the next send reconnects', async () => {
  const { keyFile } = makeTestKey()
  const stalled = makeScriptedSession({ mode: 'hang' })
  const fresh = makeScriptedSession()
  const sessions = [stalled, fresh]
  let connectCount = 0
  const client = makeApnsClient({
    keyFile, keyId: 'k', teamId: 't', topic: 'chat.matron.x', requestTimeoutMs: 50, pingIntervalMs: 0,
    connect: () => sessions[connectCount++],
  })

  const keepAlive = setTimeout(() => {}, 5000) // the request timer is unref'd
  try {
    assert.deepEqual(await client.send(PUSH), { status: 0, reason: 'timeout' })
  } finally {
    clearTimeout(keepAlive)
  }
  assert.equal(stalled.destroyed, true)
  assert.equal((await client.send(PUSH)).status, 200)
  assert.equal(connectCount, 2)
})

test('keepalive: an unanswered ping discards the session', async () => {
  const { keyFile } = makeTestKey()
  const silent = makeScriptedSession({ ping: 'silent' })
  const fresh = makeScriptedSession()
  const sessions = [silent, fresh]
  let connectCount = 0
  const client = makeApnsClient({
    keyFile, keyId: 'k', teamId: 't', topic: 'chat.matron.x', pingIntervalMs: 20, pingTimeoutMs: 20,
    connect: () => sessions[connectCount++],
  })
  try {
    await client.send(PUSH)
    await sleep(100)
    assert.ok(silent.pings >= 1)
    assert.equal(silent.destroyed, true, 'a session that ignores pings must be discarded')
    assert.equal((await client.send(PUSH)).status, 200)
    assert.equal(connectCount, 2)
  } finally {
    client.close()
  }
})

test('keepalive: a ping error discards the session; answered pings keep it', async () => {
  const { keyFile } = makeTestKey()
  const failing = makeScriptedSession({ ping: 'error' })
  const healthy = makeScriptedSession({ ping: 'ack' })
  const sessions = [failing, healthy]
  let connectCount = 0
  const client = makeApnsClient({
    keyFile, keyId: 'k', teamId: 't', topic: 'chat.matron.x', pingIntervalMs: 20, pingTimeoutMs: 20,
    connect: () => sessions[connectCount++],
  })
  try {
    await client.send(PUSH)
    await sleep(60)
    assert.equal(failing.destroyed, true)
    await client.send(PUSH)
    await sleep(80)
    assert.ok(healthy.pings >= 2)
    assert.equal(healthy.destroyed, false, 'a session that answers pings must be kept')
  } finally {
    client.close()
  }
})

test('close() stops the keepalive timers', async () => {
  const { keyFile } = makeTestKey()
  const session = makeScriptedSession()
  const client = makeApnsClient({
    keyFile, keyId: 'k', teamId: 't', topic: 'chat.matron.x', pingIntervalMs: 20,
    connect: () => session,
  })
  await client.send(PUSH)
  client.close()
  const pingsAtClose = session.pings
  await sleep(70)
  assert.equal(session.pings, pingsAtClose)
})

test('keepalive pings a real http2 session and keeps it while it answers', async (t) => {
  const { keyFile } = makeTestKey()
  const { server, port } = await makeFakeApnsServer(() => ({ status: 200 }))
  t.after(() => server.close())
  let connectCount = 0
  const client = makeApnsClient({
    keyFile, keyId: 'k', teamId: 't', topic: 'chat.matron.x', pingIntervalMs: 20, pingTimeoutMs: 200,
    connect: () => { connectCount += 1; return http2.connect(`http://127.0.0.1:${port}`) },
  })
  t.after(() => client.close())

  assert.equal((await client.send(PUSH)).status, 200)
  await sleep(120)
  assert.equal((await client.send(PUSH)).status, 200)
  assert.equal(connectCount, 1, 'a session answering pings must not be replaced')
})

test('close() during an unanswered ping leaves the closing session alone', async () => {
  const { keyFile } = makeTestKey()
  const session = makeScriptedSession({ ping: 'silent' })
  const client = makeApnsClient({
    keyFile, keyId: 'k', teamId: 't', topic: 'chat.matron.x', pingIntervalMs: 20, pingTimeoutMs: 60,
    connect: () => session,
  })
  await client.send(PUSH)
  await sleep(35) // one ping sent, its deadline pending
  assert.ok(session.pings >= 1)
  client.close()
  const keepAlive = setTimeout(() => {}, 1000) // the deadline timer is unref'd
  await sleep(120)
  clearTimeout(keepAlive)
  assert.equal(session.closed, true)
  assert.equal(session.destroyed, false, 'a late ping deadline must not destroy a gracefully closing session')
})
