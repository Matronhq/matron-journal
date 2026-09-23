import test from 'node:test'
import assert from 'node:assert/strict'
import { openDb } from '../src/db.js'
import { createUser } from '../src/auth.js'
import {
  githubAccountView, saveGithubIdentity, markGithubStale, deleteGithubAccount, listGithubAccounts,
  createLinkFlow, takeLinkFlow, LINK_FLOW_TTL_MS,
} from '../src/github-accounts.js'

const identity = { github_id: 42, login: 'DanBarker', scopes: ['github.com/matronhq'] }

test('saveGithubIdentity: creates, replaces orgs on re-save, and refuses an identity bound elsewhere', async () => {
  const db = openDb(':memory:')
  const dan = await createUser(db, 'dan', 'pw')
  const pat = await createUser(db, 'pat', 'pw')
  const v = saveGithubIdentity(db, { userId: dan.id, host: 'github.com', identity, token: 't1', now: 1000 })
  assert.deepEqual(v, { host: 'github.com', login: 'DanBarker', orgs: ['github.com/matronhq'], state: 'ok', checked_at: 1000, linked_at: 1000 })
  assert.equal(githubAccountView(db, dan.id).token, undefined, 'the view never carries the token')
  const v2 = saveGithubIdentity(db, { userId: dan.id, host: 'github.com', identity: { ...identity, scopes: ['github.com/yearbooks'] }, token: 't2', now: 2000 })
  assert.deepEqual(v2.orgs, ['github.com/yearbooks']); assert.equal(v2.linked_at, 1000); assert.equal(v2.checked_at, 2000)
  assert.equal(db.prepare('SELECT token FROM github_accounts WHERE user_id=?').get(dan.id).token, 't2')
  assert.throws(() => saveGithubIdentity(db, { userId: pat.id, host: 'github.com', identity, token: 't3', now: 3000 }), /github_conflict/)
  assert.equal(githubAccountView(db, pat.id), null)
  assert.deepEqual(listGithubAccounts(db), [{ user_id: dan.id, host: 'github.com', token: 't2' }])
  db.close()
})

test('stale and delete', async () => {
  const db = openDb(':memory:')
  const dan = await createUser(db, 'dan', 'pw')
  saveGithubIdentity(db, { userId: dan.id, host: 'github.com', identity, token: 't', now: 1 })
  markGithubStale(db, dan.id, 5)
  assert.equal(githubAccountView(db, dan.id).state, 'stale')
  assert.deepEqual(githubAccountView(db, dan.id).orgs, ['github.com/matronhq'], 'orgs are kept while stale')
  assert.equal(deleteGithubAccount(db, dan.id), true)
  assert.equal(deleteGithubAccount(db, dan.id), false)
  assert.equal(githubAccountView(db, dan.id), null)
  assert.equal(db.prepare('SELECT COUNT(*) n FROM github_orgs').get().n, 0, 'orgs cascade')
  db.close()
})

test('link flows: single use, expire, looked up by id or state', async () => {
  const db = openDb(':memory:')
  const dan = await createUser(db, 'dan', 'pw')
  const f = createLinkFlow(db, { userId: dan.id, deviceId: 9, flow: 'device', deviceCode: 'dc', now: 1000 })
  assert.match(f.id, /^gl_[0-9a-f]{16}$/); assert.equal(f.expires_at, 1000 + LINK_FLOW_TTL_MS)
  const taken = takeLinkFlow(db, { id: f.id, now: 2000 })
  assert.equal(taken.device_code, 'dc'); assert.equal(taken.user_id, dan.id)
  assert.equal(takeLinkFlow(db, { id: f.id, now: 2000 }), null, 'single use')
  const w = createLinkFlow(db, { userId: dan.id, deviceId: 9, flow: 'web', state: 'st', now: 1000 })
  assert.equal(takeLinkFlow(db, { state: 'st', now: 1000 + LINK_FLOW_TTL_MS + 1 }), null, 'expired')
  assert.equal(db.prepare('SELECT COUNT(*) n FROM github_link_flows WHERE id=?').get(w.id).n, 0, 'expired rows are deleted on read')
  db.close()
})
