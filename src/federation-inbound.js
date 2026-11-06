// The inbound federation endpoint (docs/protocol.md "Federation": receiving
// an op). `POST /federation/v1` takes one signed envelope from another
// journal and applies its op at most once, under the delivery rules:
//
//   1. The body is read as bytes (at most 1 MiB) and parsed strictly.
//   2. `to` must name a user of this journal, and `from` a journal this one
//      knows (fed_peers, 'active'), whose pinned key must verify `sig`.
//   3. The attempt must be fresh (±5 min); 'stale' answers with our clock.
//   4. In one transaction: an `id` this peer already used is answered from
//      its receipt when {op, body} hash alike (nothing is applied again), or
//      `409 id_reused` when they differ. Otherwise the op applies and its
//      receipt is written in the same transaction, so a crash can never
//      leave an op applied without a receipt, or the reverse.
//
// A refusal (any 4xx) writes no receipt: a resend of the same op is judged
// afresh against the state at that time, which is rule 4 (authority is
// checked when an op applies). Every answer from step 2 on is signed with
// this journal's key (RESPONSE_SIG_HEADER), so a sender can tell a real
// acknowledgement from a proxy's error page.
//
// Ops register a sync `apply({db, envelope, peer, now})` that returns the
// result object, or throws Error(code) for a refusal named in its `errors`
// map (code -> status). Phase 5's later stages add the ops; this one only
// knows `ping`.

import { MAX_ENVELOPE_BYTES, opHash, parseEnvelope, RESPONSE_SIG_HEADER, signResponse, verifyEnvelope, importPublicKey } from './federation-envelope.js'

export const FEDERATION_PATH = '/federation/v1'
export const RECEIPT_TTL_MS = 30 * 24 * 3600 * 1000

export const PING_OP = {
  apply: ({ now }) => ({ pong: true, clock: now }),
  errors: {},
}

export const DEFAULT_OPS = { ping: PING_OP }

const readBytes = (req, maxBytes) => new Promise((resolve, reject) => {
  const chunks = []
  let bytes = 0
  let settled = false
  req.on('data', (c) => {
    bytes += c.length
    if (bytes > maxBytes) {
      settled = true
      req.removeAllListeners('data')
      req.pause()
      reject(new Error('too_large'))
      return
    }
    chunks.push(c)
  })
  req.on('end', () => { if (!settled) { settled = true; resolve(Buffer.concat(chunks)) } })
  req.on('error', (e) => { if (!settled) { settled = true; reject(e) } })
})

const hostOf = (address) => address.slice(address.indexOf('@') + 1)
const nameOf = (address) => address.slice(0, address.indexOf('@'))

export function pruneReceipts(db, now = Date.now()) {
  return db.prepare('DELETE FROM fed_receipts WHERE created_at < ?').run(now - RECEIPT_TTL_MS).changes
}

export function makeFederationHandler({ db, federation, ops = DEFAULT_OPS, now = Date.now }) {
  const findPeer = db.prepare('SELECT host, key_pub, state FROM fed_peers WHERE host=?')
  const findUser = db.prepare('SELECT id FROM users WHERE name=?')
  const findReceipt = db.prepare('SELECT hash, status, response FROM fed_receipts WHERE peer_key=? AND id=?')
  const putReceipt = db.prepare('INSERT INTO fed_receipts(peer_key, id, hash, status, response, created_at) VALUES(?,?,?,?,?,?)')
  const touchPeer = db.prepare('UPDATE fed_peers SET last_ok_at=? WHERE host=?')
  const keys = new Map()
  const keyFor = (pub) => {
    if (!keys.has(pub)) keys.set(pub, importPublicKey(pub))
    return keys.get(pub)
  }

  const send = (res, status, body, id = null) => {
    const text = JSON.stringify(body)
    const headers = { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(text)), 'cache-control': 'no-store' }
    if (id) headers[RESPONSE_SIG_HEADER] = signResponse({ id, status, body }, federation.key.privateKey)
    res.writeHead(status, headers)
    res.end(text)
  }

  return async function handleFederation(req, res, url) {
    if (url.pathname !== FEDERATION_PATH) return false
    if (!federation?.enabled) { send(res, 404, { error: 'not_found' }); return true }
    if (req.method !== 'POST') { res.setHeader('allow', 'POST'); send(res, 405, { error: 'method_not_allowed' }); return true }

    let envelope
    try {
      envelope = parseEnvelope(await readBytes(req, MAX_ENVELOPE_BYTES))
    } catch (err) {
      const code = err.message === 'too_large' ? 'too_large' : err.message === 'unsupported_version' ? 'unsupported_version' : 'malformed'
      send(res, code === 'too_large' ? 413 : 400, { error: code })
      return true
    }
    const { id } = envelope

    if (hostOf(envelope.to) !== federation.host || !findUser.get(nameOf(envelope.to))) {
      send(res, 403, { error: 'not_here' }, id)
      return true
    }
    const peer = findPeer.get(hostOf(envelope.from))
    if (!peer) { send(res, 403, { error: 'unknown_journal' }, id); return true }
    if (peer.state !== 'active') { send(res, 403, { error: 'peer_refused' }, id); return true }

    const at = now()
    try {
      verifyEnvelope(envelope, keyFor(peer.key_pub), { now: at })
    } catch (err) {
      if (err.message === 'stale') send(res, 401, { error: 'stale', clock: err.clock }, id)
      else send(res, 403, { error: 'bad_signature' }, id)
      return true
    }

    const handler = Object.hasOwn(ops, envelope.op) ? ops[envelope.op] : null
    if (!handler) { send(res, 400, { error: 'unknown_op' }, id); return true }

    const hash = opHash(envelope)
    let answer
    try {
      answer = db.transaction(() => {
        const prior = findReceipt.get(peer.key_pub, id)
        if (prior) {
          if (prior.hash !== hash) return { status: 409, body: { error: 'id_reused' } }
          return { status: prior.status, body: JSON.parse(prior.response) }
        }
        const result = handler.apply({ db, envelope, peer, now: at })
        const body = { ok: true, result: result ?? {} }
        putReceipt.run(peer.key_pub, id, hash, 200, JSON.stringify(body), at)
        touchPeer.run(at, peer.host)
        return { status: 200, body }
      })()
    } catch (err) {
      const status = handler.errors?.[err.message]
      if (!status) throw err
      answer = { status, body: { error: err.message } }
    }
    send(res, answer.status, answer.body, id)
    return true
  }
}
