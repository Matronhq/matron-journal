// HTTP surface of GitHub account linking (spec 2026-09-23 tracker
// web/teams, "Flows"). Client devices only: an agent (the bridge) never
// links its user's identity. Every route but the callback sits behind
// Bearer auth; the callback is authenticated by the single-use `state` the
// journal minted for the flow row, so the browser's session is ignored.
import { randomBytes } from 'node:crypto'
import { json, readBody } from './http-body.js'
import { badRequest, notFound, conflict } from './http-who.js'
import { GithubError } from './github.js'
import {
  githubAccountView, saveGithubIdentity, updateGithubIdentity, markGithubStale, deleteGithubAccount,
  createLinkFlow, takeLinkFlow, LINK_FLOW_TTL_MS,
} from './github-accounts.js'

const FLOWS = ['device', 'web']
const notConfigured = (res) => { json(res, 404, { error: 'not_configured' }); return true }
const upstream = (res) => { json(res, 502, { error: 'upstream' }); return true }
const forbidden = (res) => { json(res, 403, { error: 'forbidden' }); return true }

// Turns a fresh token into a stored link. Shared by the poll and the
// callback so the two flows cannot drift.
export async function finishLink(db, github, { userId, token, now = Date.now() }) {
  const identity = await github.fetchIdentity(token)
  return saveGithubIdentity(db, { userId, host: github.host, identity, token, now })
}

// Re-reads memberships with the stored token. 'stale' = GitHub refused the
// token (fail closed: the predicate ignores stale rows); 'unchanged' =
// GitHub was unreachable or answered junk, previous list kept, and also the
// outcome when the refresh's own row is gone (unlinked) or has moved on to
// a different token (re-linked) by the time GitHub answers — the update is
// scoped to that exact token so a stale write can never resurrect or
// clobber the row that replaced it (final review, revoke/re-link race).
export async function refreshGithubAccount(db, github, userId, now = Date.now()) {
  const row = db.prepare('SELECT token FROM github_accounts WHERE user_id=?').get(userId)
  if (!row) return null
  try {
    const identity = await github.fetchIdentity(row.token)
    const view = updateGithubIdentity(db, { userId, token: row.token, identity, now })
    if (!view) return { view: githubAccountView(db, userId), outcome: 'unchanged' }
    return { view, outcome: 'ok' }
  } catch (err) {
    if (err instanceof GithubError && err.code === 'unauthorized') {
      markGithubStale(db, userId, { token: row.token, now })
      return { view: githubAccountView(db, userId), outcome: 'stale' }
    }
    if (err instanceof GithubError) return { view: githubAccountView(db, userId), outcome: 'unchanged', error: err }
    throw err
  }
}

export async function handleGithubRoute(ctx, req, res, url, who) {
  const { db, github, rateLimiter } = ctx
  const path = url.pathname
  if (path !== '/github/link' && path !== '/github/refresh' && !path.startsWith('/github/link/')) return false
  if (who.kind !== 'client') return forbidden(res)
  if (!github || !github.enabled) return notConfigured(res)

  if (path === '/github/link' && req.method === 'POST') {
    // Same per-IP limiter /login uses: a link start is a GitHub round trip.
    const ip = req.headers['cf-connecting-ip'] || req.socket.remoteAddress || 'unknown'
    if (rateLimiter && !rateLimiter.allow(ip)) { json(res, 429, { error: 'rate_limited' }); return true }
    const body = await readBody(req)
    if (!FLOWS.includes(body.flow)) return badRequest(res)
    if (body.flow === 'web') {
      if (!github.webFlow) return badRequest(res)
      const state = randomBytes(16).toString('hex')
      createLinkFlow(db, { userId: who.userId, deviceId: who.deviceId, flow: 'web', state })
      json(res, 200, { url: github.authorizeUrl(state) })
      return true
    }
    let start
    try { start = await github.startDeviceFlow() } catch (err) { if (err instanceof GithubError) return upstream(res); throw err }
    // GitHub's expires_in has no upper bound; the spec caps every link flow
    // at LINK_FLOW_TTL_MS (10 min), so the row and the value we hand back
    // to the client must agree, or the client would keep polling a row that
    // has already been swept.
    const ttlMs = Math.min(start.expires_in * 1000, LINK_FLOW_TTL_MS)
    const flow = createLinkFlow(db, { userId: who.userId, deviceId: who.deviceId, flow: 'device', deviceCode: start.device_code, ttlMs })
    json(res, 200, { flow_id: flow.id, user_code: start.user_code, verification_uri: start.verification_uri, interval: start.interval, expires_in: Math.floor(ttlMs / 1000) })
    return true
  }

  const m = path.match(/^\/github\/link\/([^/]+)\/poll$/)
  if (m && req.method === 'POST') {
    // Peek without consuming: a pending poll must leave the row in place.
    const row = db.prepare("SELECT * FROM github_link_flows WHERE id=? AND flow='device' AND user_id=? AND expires_at > ?").get(m[1], who.userId, Date.now())
    if (!row) return notFound(res)
    let poll
    try { poll = await github.pollDeviceFlow(row.device_code) } catch (err) { if (err instanceof GithubError) return upstream(res); throw err }
    if (poll.status === 'pending') { json(res, 200, poll.interval ? { status: 'pending', interval: poll.interval } : { status: 'pending' }); return true }
    // Every other answer ends the flow, so consume the row now.
    takeLinkFlow(db, { id: row.id })
    if (poll.status !== 'ok') { json(res, 200, { status: poll.status }); return true }
    try {
      const view = await finishLink(db, github, { userId: who.userId, token: poll.token })
      json(res, 200, { status: 'linked', github: view })
    } catch (err) {
      if (err.message === 'github_conflict') return conflict(res)
      if (err instanceof GithubError) return upstream(res)
      throw err
    }
    return true
  }

  if (path === '/github/link' && req.method === 'DELETE') {
    if (!deleteGithubAccount(db, who.userId)) return notFound(res)
    json(res, 200, { ok: true })
    return true
  }

  if (path === '/github/refresh' && req.method === 'POST') {
    const r = await refreshGithubAccount(db, github, who.userId)
    if (!r) return notFound(res)
    if (r.outcome === 'unchanged') return upstream(res)
    json(res, 200, { github: r.view })
    return true
  }
  return false
}

// GET /github/callback?code&state — the browser returning from GitHub's
// authorize page. No Bearer: the flow row's `state` is the credential, and
// it binds the resulting link to the row's user. Always redirects into the
// web app's account page so a user never sees raw JSON here. The state is
// consumed BEFORE the code is checked, so a malformed callback still burns
// the state and a replay cannot complete it later.
export async function handleGithubCallback(ctx, req, res, url) {
  if (url.pathname !== '/github/callback' || req.method !== 'GET') return false
  const { db, github } = ctx
  const redirect = (to) => { res.writeHead(302, { location: to }); res.end(); return true }
  const code = url.searchParams.get('code')
  const state = url.searchParams.get('state')
  if (!github || !github.enabled || !github.webFlow) return redirect('/account?link_error=not_configured')
  if (typeof state !== 'string' || !state) return redirect('/account?link_error=bad_request')
  const row = takeLinkFlow(db, { state })
  if (!row) return redirect('/account?link_error=expired')
  if (typeof code !== 'string' || !code) return redirect('/account?link_error=bad_request')
  try {
    const { token } = await github.exchangeCode(code)
    await finishLink(db, github, { userId: row.user_id, token })
    return redirect('/account?linked=1')
  } catch (err) {
    if (err.message === 'github_conflict') return redirect('/account?link_error=conflict')
    if (err instanceof GithubError) return redirect('/account?link_error=upstream')
    throw err
  }
}
