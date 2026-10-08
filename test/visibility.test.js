import test from 'node:test'
import assert from 'node:assert/strict'
import { openDb, pinDevicePrivate } from '../src/db.js'
import { createUser, createAgent } from '../src/auth.js'
import { upsertConversation } from '../src/journal.js'
import { saveGithubIdentity, markGithubStale } from '../src/github-accounts.js'
import { canReadConvo, sharedConvoSql, sharedOrgScopes } from '../src/visibility.js'

async function world() {
  const db = openDb(':memory:')
  const alice = await createUser(db, 'alice', 'pw')
  const pat = await createUser(db, 'pat', 'pw')
  const sam = await createUser(db, 'sam', 'pw') // no link
  const aliceBox = createAgent(db, alice.id, 'alice-box')
  const alicePrivate = createAgent(db, alice.id, 'alice-private')
  pinDevicePrivate(db, alicePrivate.deviceId, true)
  const link = (u, gid, scopes) => saveGithubIdentity(db, { userId: u.id, host: 'github.com', identity: { github_id: gid, login: u.name, scopes }, token: `t${gid}`, now: 1 })
  link(alice, 1, ['github.com/matronhq', 'github.com/otherorg'])
  link(pat, 2, ['github.com/matronhq'])
  upsertConversation(db, { id: 'org', ownerUserId: alice.id, title: 'org', agentDeviceId: aliceBox.deviceId, repo: 'github.com/matronhq/journal' })
  upsertConversation(db, { id: 'other-org', ownerUserId: alice.id, title: 'yb', agentDeviceId: aliceBox.deviceId, repo: 'github.com/otherorg/app' })
  upsertConversation(db, { id: 'personal', ownerUserId: alice.id, title: 'p', agentDeviceId: aliceBox.deviceId, repo: 'github.com/alice-example/dotfiles' })
  upsertConversation(db, { id: 'norepo', ownerUserId: alice.id, title: 'n', agentDeviceId: aliceBox.deviceId })
  upsertConversation(db, { id: 'private', ownerUserId: alice.id, title: 'pr', agentDeviceId: alicePrivate.deviceId, repo: 'github.com/matronhq/secret' })
  return { db, alice, pat, sam }
}

test('canReadConvo: table of viewer × conversation', async () => {
  const { db, alice, pat, sam } = await world()
  const rows = [
    // viewer, convo, expected, why
    [alice.id, 'org', true, 'owner'],
    [alice.id, 'private', true, 'owner sees own private'],
    [pat.id, 'org', true, 'both verified members of matronhq'],
    [pat.id, 'other-org', false, 'pat is not in otherorg'],
    [pat.id, 'personal', false, 'personal login is nobody\'s org'],
    [pat.id, 'norepo', false, 'no repo, no audience'],
    [pat.id, 'private', false, 'private device sieve beats the org match (review focus 5)'],
    [pat.id, 'nope', false, 'unknown conversation'],
    [sam.id, 'org', false, 'viewer has no link'],
  ]
  for (const [viewer, convo, expected, why] of rows) assert.equal(canReadConvo(db, viewer, convo), expected, why)
  db.close()
})

test('canReadConvo: a stale link on either side ends sharing (review focus 1)', async () => {
  const { db, alice, pat } = await world()
  markGithubStale(db, pat.id, { now: 2 })
  assert.equal(canReadConvo(db, pat.id, 'org'), false, 'viewer stale')
  assert.equal(canReadConvo(db, alice.id, 'org'), true, 'owner unaffected')
  const { db: db2, alice: alice2, pat: pat2 } = await world()
  markGithubStale(db2, alice2.id, { now: 2 })
  assert.equal(canReadConvo(db2, pat2.id, 'org'), false, 'owner stale')
  db.close(); db2.close()
})

test('canReadConvo: private device revoked → not shared (fails closed)', async () => {
  const { db, alice, pat } = await world()
  assert.equal(canReadConvo(db, pat.id, 'org'), true, 'shared before revoke')
  const { agent_device_id: deviceId } = db.prepare('SELECT agent_device_id FROM conversations WHERE id=?').get('org')
  db.prepare('DELETE FROM devices WHERE id=?').run(deviceId)
  assert.equal(canReadConvo(db, pat.id, 'org'), false, 'revoked device fails closed, not open')
  db.close()
})

test('sharedConvoSql: usable inside a query with @viewer', async () => {
  const { db, pat } = await world()
  const ids = db.prepare(`SELECT c.id FROM conversations c WHERE ${sharedConvoSql('c')} ORDER BY c.id`).all({ viewer: pat.id }).map((r) => r.id)
  assert.deepEqual(ids, ['org'])
  assert.deepEqual(sharedOrgScopes(db, pat.id), ['github.com/matronhq'])
  db.close()
})

test('canReadConvo: a revoked device id reused by another user\'s public box does not re-share the old conversation', async () => {
  const db = openDb(':memory:')
  const alice = await createUser(db, 'alice', 'pw'); const pat = await createUser(db, 'pat', 'pw')
  for (const [u, gid] of [[alice, 1], [pat, 2]]) saveGithubIdentity(db, { userId: u.id, host: 'github.com', identity: { github_id: gid, login: u.name, scopes: ['github.com/matronhq'] }, token: `t${gid}`, now: 1 })
  const priv = createAgent(db, alice.id, 'alice-private')
  pinDevicePrivate(db, priv.deviceId, true)
  upsertConversation(db, { id: 'org', ownerUserId: alice.id, title: 'o', agentDeviceId: priv.deviceId, repo: 'github.com/matronhq/x' })
  assert.equal(canReadConvo(db, pat.id, 'org'), false, 'private: not shared')
  db.prepare('DELETE FROM devices WHERE id=?').run(priv.deviceId)
  assert.equal(canReadConvo(db, pat.id, 'org'), false, 'revoked: fails closed')
  // SQLite may hand the freed rowid to the next device; simulate that for a
  // public box owned by someone else.
  const reused = createAgent(db, pat.id, 'pat-box')
  db.prepare('UPDATE devices SET id=? WHERE id=?').run(priv.deviceId, reused.deviceId)
  assert.equal(canReadConvo(db, pat.id, 'org'), false, 'another user\'s public box on the reused id confers nothing')
  // The same id back on a public box of the OWNER is the documented residual case: shared.
  db.prepare('UPDATE devices SET user_id=? WHERE id=?').run(alice.id, priv.deviceId)
  assert.equal(canReadConvo(db, pat.id, 'org'), true)
})
