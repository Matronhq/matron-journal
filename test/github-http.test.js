import test from 'node:test'
import assert from 'node:assert/strict'
import { startTestServer } from './helpers.js'
import { createUser, createAgent } from '../src/auth.js'
import { GithubError } from '../src/github.js'
import { openDb } from '../src/db.js'
import { saveGithubIdentity, deleteGithubAccount, githubAccountView } from '../src/github-accounts.js'
import { refreshGithubAccount } from '../src/github-http.js'

// A scripted stand-in for makeGithub(): poll/identity/exchange answers are
// queues of thunks; an empty queue answers the default.
function fakeGithub({ enabled = true, webFlow = false } = {}) {
  const q = { poll: [], identity: [], exchange: [], start: [] }
  const next = (k, fallback) => (q[k].length ? q[k].shift() : fallback)()
  return {
    q, enabled, webFlow, host: 'github.com',
    startDeviceFlow: async () => next('start', () => ({ device_code: 'dc', user_code: 'ABCD-1234', verification_uri: 'https://github.com/login/device', interval: 5, expires_in: 900 })),
    pollDeviceFlow: async () => next('poll', () => ({ status: 'pending' })),
    authorizeUrl: (state) => `https://github.com/login/oauth/authorize?client_id=abc&scope=read%3Aorg&state=${state}`,
    exchangeCode: async () => next('exchange', () => ({ token: 'tok' })),
    fetchIdentity: async () => next('identity', () => ({ github_id: 42, login: 'DanBarker', scopes: ['github.com/matronhq'] })),
  }
}

async function fleet(t, github) {
  const s = await startTestServer({ github })
  t.after(() => s.close())
  const dan = await createUser(s.db, 'dan', 'pw')
  const pat = await createUser(s.db, 'pat', 'pw')
  const agent = createAgent(s.db, dan.id, 'dev-2')
  const danTok = (await s.http('/login', { method: 'POST', body: { username: 'dan', password: 'pw', device_name: 'mac' } })).json.token
  const patTok = (await s.http('/login', { method: 'POST', body: { username: 'pat', password: 'pw', device_name: 'mac' } })).json.token
  return { s, dan, pat, agent, danTok, patTok }
}

test('device flow end to end: start, poll pending, poll linked; /me shows the link', async (t) => {
  const gh = fakeGithub()
  const { s, danTok, agent } = await fleet(t, gh)
  const me0 = await s.http('/me', { token: danTok })
  assert.equal(me0.status, 200); assert.equal(me0.json.github, null); assert.deepEqual(me0.json.github_linking, { enabled: true, web_flow: false })
  assert.equal((await s.http('/github/link', { method: 'POST', token: agent.token, body: { flow: 'device' } })).status, 403, 'agents do not link accounts')
  const start = await s.http('/github/link', { method: 'POST', token: danTok, body: { flow: 'device' } })
  assert.equal(start.status, 200)
  assert.match(start.json.flow_id, /^gl_/); assert.equal(start.json.user_code, 'ABCD-1234'); assert.equal(start.json.interval, 5)
  assert.equal((await s.http('/github/link', { method: 'POST', token: danTok, body: { flow: 'web' } })).status, 400, 'web flow needs a secret')
  const p1 = await s.http(`/github/link/${start.json.flow_id}/poll`, { method: 'POST', token: danTok })
  assert.deepEqual(p1.json, { status: 'pending' })
  gh.q.poll.push(() => ({ status: 'ok', token: 'tok' }))
  const p2 = await s.http(`/github/link/${start.json.flow_id}/poll`, { method: 'POST', token: danTok })
  assert.equal(p2.status, 200); assert.equal(p2.json.status, 'linked'); assert.equal(p2.json.github.login, 'DanBarker')
  assert.deepEqual(p2.json.github.orgs, ['github.com/matronhq'])
  assert.equal((await s.http(`/github/link/${start.json.flow_id}/poll`, { method: 'POST', token: danTok })).status, 404, 'flow is single use')
  const me = await s.http('/me', { token: danTok })
  assert.equal(me.json.github.login, 'DanBarker'); assert.equal(me.json.github.state, 'ok')
  assert.equal(JSON.stringify(me.json).includes('tok'), false, 'token never leaves the journal')
})

test('device flow: denied and expired end the flow; another user cannot poll it', async (t) => {
  const gh = fakeGithub()
  const { s, danTok, patTok } = await fleet(t, gh)
  const a = await s.http('/github/link', { method: 'POST', token: danTok, body: { flow: 'device' } })
  assert.equal((await s.http(`/github/link/${a.json.flow_id}/poll`, { method: 'POST', token: patTok })).status, 404)
  gh.q.poll.push(() => ({ status: 'denied' }))
  assert.deepEqual((await s.http(`/github/link/${a.json.flow_id}/poll`, { method: 'POST', token: danTok })).json, { status: 'denied' })
  assert.equal((await s.http(`/github/link/${a.json.flow_id}/poll`, { method: 'POST', token: danTok })).status, 404)
  const b = await s.http('/github/link', { method: 'POST', token: danTok, body: { flow: 'device' } })
  gh.q.poll.push(() => ({ status: 'expired' }))
  assert.deepEqual((await s.http(`/github/link/${b.json.flow_id}/poll`, { method: 'POST', token: danTok })).json, { status: 'expired' })
})

test('conflict: the same GitHub identity cannot be linked to two users (review focus 3)', async (t) => {
  const gh = fakeGithub()
  const { s, danTok, patTok } = await fleet(t, gh)
  const a = await s.http('/github/link', { method: 'POST', token: danTok, body: { flow: 'device' } })
  gh.q.poll.push(() => ({ status: 'ok', token: 't1' }))
  assert.equal((await s.http(`/github/link/${a.json.flow_id}/poll`, { method: 'POST', token: danTok })).json.status, 'linked')
  const b = await s.http('/github/link', { method: 'POST', token: patTok, body: { flow: 'device' } })
  gh.q.poll.push(() => ({ status: 'ok', token: 't2' }))
  const r = await s.http(`/github/link/${b.json.flow_id}/poll`, { method: 'POST', token: patTok })
  assert.equal(r.status, 409); assert.equal(r.json.error, 'conflict')
  assert.equal((await s.http('/me', { token: danTok })).json.github.login, 'DanBarker', 'first link untouched')
  assert.equal((await s.http('/me', { token: patTok })).json.github, null)
})

test('web flow: link returns the authorize URL; callback binds to the flow row, redirects, and a replayed state fails (review focus 4)', async (t) => {
  const gh = fakeGithub({ webFlow: true })
  const { s, danTok } = await fleet(t, gh)
  const start = await s.http('/github/link', { method: 'POST', token: danTok, body: { flow: 'web' } })
  assert.equal(start.status, 200)
  const state = new URL(start.json.url).searchParams.get('state')
  assert.match(state, /^[0-9a-f]{32}$/)
  // No Bearer on the callback: it is the browser coming back from GitHub.
  const cb = await fetch(`${s.base}/github/callback?code=c0de&state=${state}`, { redirect: 'manual' })
  assert.equal(cb.status, 302); assert.equal(cb.headers.get('location'), '/account?linked=1')
  assert.equal((await s.http('/me', { token: danTok })).json.github.login, 'DanBarker')
  const replay = await fetch(`${s.base}/github/callback?code=c0de&state=${state}`, { redirect: 'manual' })
  assert.equal(replay.status, 302); assert.equal(replay.headers.get('location'), '/account?link_error=expired')
  const junk = await fetch(`${s.base}/github/callback?code=c0de&state=nope`, { redirect: 'manual' })
  assert.equal(junk.headers.get('location'), '/account?link_error=expired')
  const start2 = await s.http('/github/link', { method: 'POST', token: danTok, body: { flow: 'web' } })
  const state2 = new URL(start2.json.url).searchParams.get('state')
  const missing = await fetch(`${s.base}/github/callback?state=${state2}`, { redirect: 'manual' })
  assert.equal(missing.headers.get('location'), '/account?link_error=bad_request')
  const again = await fetch(`${s.base}/github/callback?code=c0de&state=${state2}`, { redirect: 'manual' })
  assert.equal(again.headers.get('location'), '/account?link_error=expired', 'a code-less callback still consumed the state')
})

test('refresh: ok updates orgs; unauthorized marks stale; unreachable leaves everything; unlink deletes', async (t) => {
  const gh = fakeGithub()
  const { s, danTok } = await fleet(t, gh)
  const a = await s.http('/github/link', { method: 'POST', token: danTok, body: { flow: 'device' } })
  gh.q.poll.push(() => ({ status: 'ok', token: 't1' }))
  await s.http(`/github/link/${a.json.flow_id}/poll`, { method: 'POST', token: danTok })
  gh.q.identity.push(() => ({ github_id: 42, login: 'DanBarker', scopes: ['github.com/matronhq', 'github.com/yearbooks'] }))
  const r1 = await s.http('/github/refresh', { method: 'POST', token: danTok })
  assert.equal(r1.status, 200); assert.deepEqual(r1.json.github.orgs, ['github.com/matronhq', 'github.com/yearbooks'])
  gh.q.identity.push(() => { throw new GithubError('unauthorized') })
  const r2 = await s.http('/github/refresh', { method: 'POST', token: danTok })
  assert.equal(r2.status, 200); assert.equal(r2.json.github.state, 'stale')
  gh.q.identity.push(() => { throw new GithubError('unreachable') })
  const r3 = await s.http('/github/refresh', { method: 'POST', token: danTok })
  assert.equal(r3.status, 502); assert.equal(r3.json.error, 'upstream')
  assert.equal((await s.http('/me', { token: danTok })).json.github.state, 'stale', 'unreachable changed nothing')
  assert.equal((await s.http('/github/link', { method: 'DELETE', token: danTok })).status, 200)
  assert.equal((await s.http('/me', { token: danTok })).json.github, null)
  assert.equal((await s.http('/github/link', { method: 'DELETE', token: danTok })).status, 404)
  assert.equal((await s.http('/github/refresh', { method: 'POST', token: danTok })).status, 404, 'nothing to refresh')
})

test('refreshGithubAccount: a concurrent unlink is never resurrected once GitHub answers', async () => {
  const db = openDb(':memory:')
  const dan = await createUser(db, 'dan', 'pw')
  saveGithubIdentity(db, { userId: dan.id, host: 'github.com', identity: { github_id: 1, login: 'dan', scopes: ['github.com/matronhq'] }, token: 't1', now: 1 })
  let resolveIdentity
  const github = { host: 'github.com', fetchIdentity: () => new Promise((resolve) => { resolveIdentity = resolve }) }
  const p = refreshGithubAccount(db, github, dan.id, 5)
  assert.equal(deleteGithubAccount(db, dan.id), true, 'unlink lands while the refresh is in flight')
  resolveIdentity({ github_id: 1, login: 'dan', scopes: ['github.com/matronhq', 'github.com/yearbooks'] })
  const r = await p
  assert.equal(r.outcome, 'unchanged')
  assert.equal(githubAccountView(db, dan.id), null, 'unlink was not undone')
  assert.deepEqual(db.prepare('SELECT * FROM github_orgs WHERE user_id=?').all(dan.id), [], 'no orgs resurrected for the deleted account')
  db.close()
})

test('refreshGithubAccount: a concurrent re-link is never clobbered by the old token going unauthorized', async () => {
  const db = openDb(':memory:')
  const dan = await createUser(db, 'dan', 'pw')
  saveGithubIdentity(db, { userId: dan.id, host: 'github.com', identity: { github_id: 1, login: 'dan', scopes: ['github.com/matronhq'] }, token: 't1', now: 1 })
  let rejectIdentity
  const github = { host: 'github.com', fetchIdentity: () => new Promise((_resolve, reject) => { rejectIdentity = reject }) }
  const p = refreshGithubAccount(db, github, dan.id, 5)
  // A brand new link (new token, new GitHub identity) lands while the old
  // token's refresh is still in flight.
  saveGithubIdentity(db, { userId: dan.id, host: 'github.com', identity: { github_id: 2, login: 'dan2', scopes: ['github.com/yearbooks'] }, token: 't2', now: 10 })
  rejectIdentity(new GithubError('unauthorized'))
  const r = await p
  assert.equal(r.outcome, 'stale', 'reports the OLD token it was refreshing')
  const view = githubAccountView(db, dan.id)
  assert.equal(view.state, 'ok', 'the new link is untouched by the old token\'s unauthorized')
  assert.equal(view.login, 'dan2')
  db.close()
})

test('not configured: every linking route is 404 not_configured; /me says so', async (t) => {
  const { s, danTok } = await fleet(t, fakeGithub({ enabled: false }))
  assert.deepEqual((await s.http('/me', { token: danTok })).json.github_linking, { enabled: false, web_flow: false })
  const r = await s.http('/github/link', { method: 'POST', token: danTok, body: { flow: 'device' } })
  assert.equal(r.status, 404); assert.equal(r.json.error, 'not_configured')
})

test('device flow start caps the row TTL and the returned expires_in at LINK_FLOW_TTL_MS (10 min)', async (t) => {
  const gh = fakeGithub()
  const { s, danTok } = await fleet(t, gh)
  // GitHub's default expires_in (900s = 15min) exceeds the spec's 10-minute
  // link-flow limit, so both the stored row and the value handed back to
  // the client must be capped at 600s/600000ms.
  const start = await s.http('/github/link', { method: 'POST', token: danTok, body: { flow: 'device' } })
  assert.equal(start.json.expires_in, 600)
  const row = s.db.prepare('SELECT expires_at, created_at FROM github_link_flows WHERE id=?').get(start.json.flow_id)
  assert.equal(row.expires_at - row.created_at, 600000)

  // A shorter GitHub-provided expires_in is left untouched.
  gh.q.start.push(() => ({ device_code: 'dc2', user_code: 'WXYZ-5678', verification_uri: 'https://github.com/login/device', interval: 5, expires_in: 300 }))
  const start2 = await s.http('/github/link', { method: 'POST', token: danTok, body: { flow: 'device' } })
  assert.equal(start2.json.expires_in, 300)
  const row2 = s.db.prepare('SELECT expires_at, created_at FROM github_link_flows WHERE id=?').get(start2.json.flow_id)
  assert.equal(row2.expires_at - row2.created_at, 300000)
})
