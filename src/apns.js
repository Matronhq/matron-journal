import fs from 'node:fs'
import crypto from 'node:crypto'
import http2 from 'node:http2'

// Apple allows JWTs up to ~60 min old; re-mint well inside that so a
// borderline-stale token is never sent (no clock-skew retry in v1).
const JWT_TTL_MS = 45 * 60 * 1000

const HOSTS = {
  prod: 'https://api.push.apple.com',
  sandbox: 'https://api.sandbox.push.apple.com',
}

const base64url = (buf) => buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')

// direct APNs, no sygnal: ES256-signed provider JWT (node:crypto only) +
// node:http2 client sessions, one per environment host. `connect` is
// injectable so tests can run against an in-process fake h2 server instead
// of Apple.
export function makeApnsClient({
  keyFile, keyId, teamId, topic, connect = http2.connect, requestTimeoutMs = 30000,
  pingIntervalMs = 60000, pingTimeoutMs = 10000,
}) {
  const privateKey = crypto.createPrivateKey(fs.readFileSync(keyFile, 'utf8'))

  let cachedJwt = null
  let mintedAt = 0
  function jwt() {
    const now = Date.now()
    if (cachedJwt && now - mintedAt < JWT_TTL_MS) return cachedJwt
    const header = { alg: 'ES256', kid: keyId }
    const claims = { iss: teamId, iat: Math.floor(now / 1000) }
    const signingInput = `${base64url(Buffer.from(JSON.stringify(header)))}.${base64url(Buffer.from(JSON.stringify(claims)))}`
    const signature = crypto.sign('sha256', Buffer.from(signingInput), { key: privateKey, dsaEncoding: 'ieee-p1363' })
    cachedJwt = `${signingInput}.${base64url(signature)}`
    mintedAt = now
    return cachedJwt
  }

  const sessions = {} // env -> live http2 session, lazily connected
  const pingTimers = new Map() // session -> keepalive interval
  const pingDeadlines = new Map() // session -> pending ping's deadline

  function teardown(env, session) {
    if (sessions[env] === session) delete sessions[env]
    const timer = pingTimers.get(session)
    if (timer) {
      clearInterval(timer)
      pingTimers.delete(session)
    }
    const deadline = pingDeadlines.get(session)
    if (deadline) {
      clearTimeout(deadline)
      pingDeadlines.delete(session)
    }
  }

  // A connection can die without the socket ever closing (a peer or a
  // middlebox drops it silently). Nothing then fires 'close', so every send
  // reuses it and times out. Destroying it on that evidence lets the next
  // send reconnect.
  function discard(env, session) {
    teardown(env, session)
    try { if (!session.destroyed) session.destroy() } catch { /* already gone */ }
  }

  // Keepalive: a ping that errors or goes unanswered means the connection is
  // dead, so it is discarded before a push has to find out.
  function startKeepalive(env, session) {
    if (!pingIntervalMs || typeof session.ping !== 'function') return
    // Only a session still under keepalive may be discarded by it: after
    // teardown (including close(), which lets in-flight streams finish) a
    // late deadline or ping callback must leave the session alone.
    const live = () => pingTimers.has(session)
    const timer = setInterval(() => {
      if (session.destroyed || session.closed) return teardown(env, session)
      if (pingDeadlines.has(session)) return // previous ping still pending
      const deadline = setTimeout(() => {
        pingDeadlines.delete(session)
        if (live()) discard(env, session)
      }, pingTimeoutMs)
      deadline.unref()
      pingDeadlines.set(session, deadline)
      const settlePing = (failed) => {
        clearTimeout(deadline)
        pingDeadlines.delete(session)
        if (failed && live()) discard(env, session)
      }
      try {
        session.ping((err) => settlePing(Boolean(err)))
      } catch {
        settlePing(true)
      }
    }, pingIntervalMs)
    timer.unref()
    pingTimers.set(session, timer)
  }

  function connectEnv(env) {
    const session = connect(HOSTS[env])
    // Re-created lazily (on the next send()) rather than eagerly here.
    session.on('error', () => teardown(env, session))
    session.on('goaway', () => teardown(env, session))
    session.on('close', () => teardown(env, session))
    sessions[env] = session
    startKeepalive(env, session)
    return session
  }

  function sessionFor(env) {
    const existing = sessions[env]
    if (existing && !existing.destroyed && !existing.closed) return existing
    return connectEnv(env)
  }

  // One HTTP/2 request/response cycle. Never rejects AND always settles:
  // failures (session gone mid-request, stream error, stream closed without
  // a response) resolve {status: 0, reason: 'transport'}, and a response
  // that simply never arrives resolves {status: 0, reason: 'timeout'} after
  // requestTimeoutMs — a permanently-pending promise here would leak the
  // stream and silently skew the pipeline's counters.
  function requestOnce(session, { deviceToken, topic: pushTopic, payload, collapseId, priority, pushType, apnsId }) {
    return new Promise((resolve) => {
      let settled = false
      let req = null
      let timer = null
      const settle = (result) => {
        if (settled) return
        settled = true
        if (timer) clearTimeout(timer)
        // Tear the stream down if it's still open (timeout / early-settle
        // paths); harmless after a normal 'end'.
        try { if (req && req.close) req.close() } catch { /* already gone */ }
        resolve(result)
      }

      const headers = {
        ':method': 'POST',
        ':path': `/3/device/${deviceToken}`,
        authorization: `bearer ${jwt()}`,
        'apns-topic': pushTopic || topic,
        'apns-push-type': pushType,
        'apns-priority': String(priority),
        'apns-expiration': '0',
      }
      if (collapseId) headers['apns-collapse-id'] = collapseId
      if (apnsId) headers['apns-id'] = apnsId

      try {
        req = session.request(headers)
      } catch {
        return settle({ status: 0, reason: 'transport' })
      }

      timer = setTimeout(() => settle({ status: 0, reason: 'timeout' }), requestTimeoutMs)
      timer.unref()

      let status = null
      let body = ''
      req.on('response', (h) => { status = h[':status'] })
      req.setEncoding('utf8')
      req.on('data', (chunk) => { body += chunk })
      req.on('end', () => {
        // A stream the server resets (RST_STREAM NO_ERROR or CANCEL) before
        // sending headers ends cleanly with no 'response': nothing was
        // delivered, so it is a transport failure, not a status.
        if (status === null) return settle({ status: 0, reason: 'transport' })
        let reason = null
        if (body) {
          try { reason = JSON.parse(body).reason || null } catch { /* non-JSON body: no reason */ }
        }
        settle({ status, reason })
      })
      req.on('error', () => settle({ status: 0, reason: 'transport' }))
      // Backstop: a stream torn down with only 'close' (no 'end'/'error' —
      // e.g. the session dying mid-flight) must still settle. On the normal
      // path 'end' fires first and the settled guard makes this a no-op.
      req.on('close', () => settle({ status: 0, reason: 'transport' }))
      req.write(JSON.stringify(payload))
      req.end()
    })
  }

  // Resolves {status, reason} — never rejects.
  //
  // Any request that ends in a timeout or a transport failure discards its
  // session: a connection that swallowed or dropped one request is not
  // trusted with the next.
  //
  // A transport failure on a REUSED session means that connection died
  // between pushes, so the push is retried once on a fresh session. A failure
  // on a session opened for this send is not retried, so there is never more
  // than one retry. Both attempts carry the same apns-id, as Apple asks for a
  // notification sent more than once.
  async function send({ deviceToken, env, topic: pushTopic, payload, collapseId, priority, pushType }) {
    const push = { deviceToken, topic: pushTopic, payload, collapseId, priority, pushType, apnsId: crypto.randomUUID() }
    const attempt = async () => {
      let session
      try {
        session = sessionFor(env)
      } catch {
        return { status: 0, reason: 'transport' }
      }
      const result = await requestOnce(session, push)
      if (result.status === 0) discard(env, session)
      return result
    }
    const reused = Boolean(sessions[env]) && !sessions[env].destroyed && !sessions[env].closed
    const result = await attempt()
    if (result.reason !== 'transport' || !reused) return result
    return attempt()
  }

  function close() {
    for (const env of Object.keys(sessions)) {
      const s = sessions[env]
      teardown(env, s)
      try { s.close() } catch { /* already gone */ }
    }
  }

  return { send, close }
}
