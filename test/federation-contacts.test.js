import test from 'node:test'
import assert from 'node:assert/strict'
import { createUser, createAgent } from '../src/auth.js'
import { exportPublicKey, generateFederationKey, formatFingerprint, signEnvelope, newOpId } from '../src/federation-envelope.js'
import { makeFederationClient } from '../src/federation-client.js'
import { inviteLink, parseInviteLink, MAX_OPEN_INVITES } from '../src/federation-contacts.js'
import { startTestServer } from './helpers.js'
import { enqueue, makeOutbox } from '../src/federation-outbox.js'
import { ensureFederationKey } from '../src/federation-identity.js'
import { makeTokenBox } from '../src/token-box.js'
import { upsertConversation } from '../src/journal.js'

// Contacts across journals (phase 5 stage 5), end to end between two real
// journals on loopback: a.example (alice) and b.example (bob, carol). The
// client sends each test host to the loopback server that plays it.
const KEY = 'd'.repeat(64)
const post = (body) => ({ method: 'POST', body })
const TOKEN = 'A'.repeat(43)
const FP = 'a'.repeat(26)

async function world(t, { a: aEnv = {}, b: bEnv = {} } = {}) {
  const bases = {}
  const fetched = []
  const real = makeFederationClient({
    allowHttp: true, allowHosts: ['127.0.0.1'],
    rewriteUrl: (u) => { const x = new URL(u); return bases[x.host] ? bases[x.host] + x.pathname + x.search : u },
  })
  const client = { ...real, fetchWellKnown: (host) => { fetched.push(host); return real.fetchWellKnown(host) } }
  const start = async (host, env) => {
    const s = await startTestServer({ tokenKey: KEY, federationEnv: { federation: 'on', publicUrl: `https://${host}`, ...env }, federationClient: client })
    t.after(() => s.close())
    bases[host] = s.base
    return s
  }
  const a = await start('a.example', aEnv)
  const b = await start('b.example', bEnv)
  const users = {}
  const phones = {}
  for (const [s, name] of [[a, 'alice'], [b, 'bob'], [b, 'carol']]) {
    users[name] = await createUser(s.db, name, 'pw')
    const token = (await s.http('/login', post({ username: name, password: 'pw', device_name: `${name}-phone` }))).json.token
    phones[name] = (path, opts = {}) => s.http(path, { token, ...opts })
  }
  const aliceBox = createAgent(a.db, users.alice.id, 'alice-box')
  // Every pass both outboxes have due, until neither has anything queued.
  const settle = async () => {
    for (let i = 0; i < 10; i++) {
      await a.federationOutbox.tick()
      await b.federationOutbox.tick()
      const live = (s) => s.db.prepare("SELECT COUNT(*) AS n FROM fed_outbox WHERE state='queued' AND next_at<=?").get(Date.now()).n
      if (!live(a) && !live(b)) return
    }
  }
  return { a, b, users, phones, fetched, settle, client: real, aliceBoxId: aliceBox.deviceId, aliceBox: (path, opts = {}) => a.http(path, { token: aliceBox.token, ...opts }) }
}

const contactsOf = async (phone) => (await phone('/contacts')).json.contacts
const notices = (s, userId) => s.db.prepare("SELECT title, body FROM items WHERE user_id=? AND kind='notice' ORDER BY rowid").all(userId)
const audits = (s, userId) => s.db.prepare("SELECT json_extract(payload, '$.event') AS e, json_extract(payload, '$.summary') AS summary FROM events WHERE user_id=? AND type='people' ORDER BY seq").all(userId)

async function invite(w) {
  const r = await w.phones.alice('/contacts/invites', post({}))
  assert.equal(r.status, 201)
  return r.json
}

async function befriend(w) {
  const { link } = await invite(w)
  const r = await w.phones.bob('/contacts/invites/accept', post({ link }))
  assert.equal(r.status, 202)
  await w.settle()
  return link
}

// --- Links ------------------------------------------------------------------

test('links: made and read back; anything else in the link is refused', () => {
  const good = { host: 'a.example:8443', user: 'alice.s', token: TOKEN, fingerprint: FP }
  const link = inviteLink(good)
  assert.match(link, /^matron:\/\/contact\?v=1&j=a.example%3A8443&u=alice.s&t=A{43}&fp=a{26}$/)
  assert.deepEqual(parseInviteLink(link), good)
  assert.deepEqual(parseInviteLink(link.replace(`fp=${FP}`, `fp=${FP.toUpperCase()}`)), good, 'the fingerprint is case-blind')
  for (const bad of [
    link.replace('matron:', 'https:'), link.replace('//contact', '//other'), link.replace('v=1', 'v=2'),
    `${link}&x=1`, `${link}&t=${TOKEN}`, link.replace(`t=${TOKEN}`, 't=short'), link.replace(`fp=${FP}`, 'fp=abc'),
    link.replace('u=alice.s', 'u=-alice'), link.replace('j=a.example%3A8443', 'j=a_b.example'), 'not a link', null,
  ]) assert.equal(parseInviteLink(bad), null, String(bad))
})

// --- Invites ------------------------------------------------------------------

test('invites: a client mints, lists and withdraws them; an agent never sees one', async (t) => {
  const w = await world(t)
  const { invite: inv, link } = await invite(w)
  const parsed = parseInviteLink(link)
  assert.equal(parsed.host, 'a.example')
  assert.equal(parsed.user, 'alice')
  assert.equal(parsed.fingerprint, (await w.a.http('/.well-known/matron-journal')).json.key.id)
  assert.equal(inv.state, 'open')
  assert.equal(inv.expires_at - inv.created_at, 7 * 24 * 3600 * 1000)
  assert.equal(w.a.db.prepare('SELECT COUNT(*) AS n FROM fed_invites WHERE token_hash=?').get(parsed.token).n, 0, 'only the hash is kept')

  const listed = (await w.phones.alice('/contacts/invites')).json.invites
  assert.deepEqual(listed.map((i) => [i.id, i.state]), [[inv.id, 'open']])
  assert.equal(JSON.stringify(listed).includes(parsed.token), false)

  for (const [path, opts] of [['/contacts/invites', post({})], ['/contacts/invites', {}], [`/contacts/invites/${inv.id}`, { method: 'DELETE' }],
    ['/contacts/invites/open', post({ link })], ['/contacts/invites/accept', post({ link })]]) {
    assert.equal((await w.aliceBox(path, opts)).status, 403, path)
  }

  const gone = await w.phones.alice(`/contacts/invites/${inv.id}`, { method: 'DELETE' })
  assert.deepEqual([gone.status, gone.json.invite.state], [200, 'revoked'])
  assert.equal((await w.phones.alice(`/contacts/invites/${inv.id}`, { method: 'DELETE' })).json.blocked_by, 'not_open')
  assert.equal((await w.phones.bob(`/contacts/invites/${inv.id}`, { method: 'DELETE' })).status, 404, 'not theirs')

  for (let i = 0; i < MAX_OPEN_INVITES; i++) await invite(w)
  const over = await w.phones.alice('/contacts/invites', post({}))
  assert.deepEqual([over.status, over.json.blocked_by], [409, 'too_many_invites'])
})

test('invites: federation off answers every route with federation_off', async (t) => {
  const s = await startTestServer()
  t.after(() => s.close())
  await createUser(s.db, 'alice', 'pw')
  const token = (await s.http('/login', post({ username: 'alice', password: 'pw', device_name: 'phone' }))).json.token
  const r = await s.http('/contacts/invites', { method: 'POST', token, body: {} })
  assert.deepEqual([r.status, r.json.blocked_by], [409, 'federation_off'])
})

// --- Opening and accepting ----------------------------------------------------

test('end to end: bob opens alice\'s link, accepts, and both sides are contacts', async (t) => {
  const w = await world(t)
  const { invite: inv, link } = await invite(w)
  const fp = parseInviteLink(link).fingerprint

  const seen = await w.phones.bob('/contacts/invites/open', post({ link }))
  assert.equal(seen.status, 200)
  assert.deepEqual(seen.json, { inviter: { address: 'alice@a.example', name: 'alice', journal: 'a.example', fingerprint: formatFingerprint(fp) }, key_changed: false, contact: null })
  assert.equal(w.b.db.prepare('SELECT COUNT(*) AS n FROM fed_peers').get().n, 0, 'opening pins nothing')

  const r = await w.phones.bob('/contacts/invites/accept', post({ link }))
  assert.equal(r.status, 202)
  assert.deepEqual([r.json.contact.address, r.json.contact.state, r.json.pending], ['alice@a.example', 'pending_out', 'peer'])
  await w.settle()

  const [bobSide] = await contactsOf(w.phones.bob)
  assert.deepEqual([bobSide.address, bobSide.state, bobSide.peer_journal, bobSide.key_changed], ['alice@a.example', 'active', 'a.example', false])
  const [aliceSide] = await contactsOf(w.phones.alice)
  assert.deepEqual([aliceSide.address, aliceSide.state, aliceSide.display_name], ['bob@b.example', 'active', 'bob'])
  // Each side pinned the other's key.
  const aKey = (await w.a.http('/.well-known/matron-journal')).json.key.pub
  const bKey = (await w.b.http('/.well-known/matron-journal')).json.key.pub
  assert.equal(w.b.db.prepare("SELECT peer_journal_key AS k FROM contacts WHERE peer_journal='a.example'").get().k, aKey)
  assert.equal(w.a.db.prepare("SELECT peer_journal_key AS k FROM contacts WHERE peer_journal='b.example'").get().k, bKey)
  assert.deepEqual(w.a.db.prepare('SELECT host, state FROM fed_peers').all(), [{ host: 'b.example', state: 'active' }])

  // The invite is spent; alice was told with a notice, not a card.
  const used = (await w.phones.alice('/contacts/invites')).json.invites.find((i) => i.id === inv.id)
  assert.deepEqual([used.state, used.used_by], ['used', 'bob@b.example'])
  assert.deepEqual(notices(w.a, w.users.alice.id).map((n) => n.title), ['bob@b.example accepted your invite'])
  assert.equal(w.a.db.prepare("SELECT COUNT(*) AS n FROM events WHERE type='permission_request'").get().n, 0)
  assert.ok(audits(w.a, w.users.alice.id).some((e) => e.e === 'contact.accepted' && e.summary.includes('bob@b.example')))
  assert.ok(audits(w.b, w.users.bob.id).some((e) => e.e === 'contact.accepted' && e.summary === 'You and alice@a.example are now contacts'))

  // A contact on another journal is found by its address, too.
  const byAddress = await w.phones.alice('/contacts/bob%40b.example')
  assert.deepEqual([byAddress.status, byAddress.json.contact.id], [200, aliceSide.id])
  // A second tap on the same link is the same answer.
  assert.equal((await w.phones.bob('/contacts/invites/accept', post({ link }))).json.blocked_by, 'already_contact')
  assert.equal((await w.phones.bob('/contacts/invites/open', post({ link }))).json.contact.state, 'active')
})

test('accepting: a spent invite fails for anyone else, with one notice and nothing left to resend', async (t) => {
  const w = await world(t)
  const link = await befriend(w)
  const r = await w.phones.carol('/contacts/invites/accept', post({ link }))
  assert.equal(r.status, 202)
  await w.settle()
  const [carolSide] = (await w.phones.carol('/contacts?state=expired')).json.contacts
  assert.deepEqual([carolSide.address, carolSide.state], ['alice@a.example', 'expired'])
  assert.deepEqual(notices(w.b, w.users.carol.id), [{
    title: "Couldn't add alice@a.example",
    body: 'The invite link has already been used, has expired or was withdrawn. Ask alice for a new one.',
  }])
  assert.deepEqual(w.b.db.prepare("SELECT state, last_error FROM fed_outbox WHERE user_id=?").all(w.users.carol.id), [{ state: 'cancelled', last_error: 'invite_invalid' }])
  // Alice gained nobody.
  assert.deepEqual((await contactsOf(w.phones.alice)).map((c) => c.address), ['bob@b.example'])
  // Carol can try again with a new link.
  const again = await invite(w)
  assert.equal((await w.phones.carol('/contacts/invites/accept', post({ link: again.link }))).status, 202)
  await w.settle()
  assert.equal((await contactsOf(w.phones.carol))[0].state, 'active')
})

test('accepting: a link whose fingerprint is not the journal\'s key is refused before anything is sent', async (t) => {
  const w = await world(t)
  const { link } = await invite(w)
  const forged = link.replace(/fp=[a-z2-7]+/, `fp=${FP}`)
  for (const route of ['open', 'accept']) {
    const r = await w.phones.bob(`/contacts/invites/${route}`, post({ link: forged }))
    assert.deepEqual([r.status, r.json.blocked_by], [409, 'fingerprint_mismatch'], route)
  }
  assert.equal(w.b.db.prepare('SELECT COUNT(*) AS n FROM fed_outbox').get().n, 0)
  assert.equal(w.b.db.prepare('SELECT COUNT(*) AS n FROM contacts').get().n, 0)
  assert.equal((await w.phones.bob('/contacts/invites/open', post({ link: 'matron://contact?v=1' }))).status, 400)
  const own = await w.phones.alice('/contacts/invites/open', post({ link }))
  assert.equal(own.json.blocked_by, 'own_journal')
})

test('accepting: a withdrawn invite is refused at the inviter\'s journal', async (t) => {
  const w = await world(t)
  const { invite: inv, link } = await invite(w)
  await w.phones.alice(`/contacts/invites/${inv.id}`, { method: 'DELETE' })
  await w.phones.bob('/contacts/invites/accept', post({ link }))
  await w.settle()
  assert.equal((await w.phones.bob('/contacts?state=expired')).json.contacts.length, 1)
  assert.equal((await contactsOf(w.phones.alice)).length, 0)
  // The answer never got past the admits check: alice's journal pinned nothing.
  assert.equal(w.a.db.prepare('SELECT COUNT(*) AS n FROM fed_peers').get().n, 0)
})

// --- The inbound door -----------------------------------------------------------

test('inbound: an unknown journal without one of our invites is refused before any work', async (t) => {
  const w = await world(t)
  const key = generateFederationKey()
  const send = (body, op = 'contact.accept_invite') => fetch(`${w.a.base}/federation/v1`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify(signEnvelope({ from: 'mallory@m.example', to: 'alice@a.example', op, id: newOpId(), body }, key.privateKey)),
  })
  for (const [body, op] of [[{ token: TOKEN, display_name: 'm' }], [{}, 'contact.remove'], [{ token: 'x' }]]) {
    const r = await send(body, op)
    assert.deepEqual([r.status, (await r.json()).error], [403, 'unknown_journal'])
  }
  assert.deepEqual(w.fetched, [], 'no well-known was fetched')
})

test('inbound: a valid invite answered under a key the sender\'s journal does not serve is refused', async (t) => {
  const w = await world(t)
  const { link } = await invite(w)
  const forger = generateFederationKey()
  const r = await fetch(`${w.a.base}/federation/v1`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify(signEnvelope({
      from: 'bob@b.example', to: 'alice@a.example', op: 'contact.accept_invite', id: newOpId(),
      body: { token: parseInviteLink(link).token, display_name: 'bob' },
    }, forger.privateKey)),
  })
  assert.deepEqual([r.status, (await r.json()).error], [403, 'bad_signature'])
  assert.deepEqual(w.fetched, ['b.example'])
  assert.equal(w.a.db.prepare('SELECT COUNT(*) AS n FROM fed_peers').get().n, 0)
  assert.equal((await w.phones.alice('/contacts/invites')).json.invites[0].state, 'open')
})

test('lists: a denied journal can neither be opened nor answer', async (t) => {
  const w = await world(t, { a: { denyJournals: 'b.example' } })
  const { link } = await invite(w)
  await w.phones.bob('/contacts/invites/accept', post({ link }))
  await w.settle()
  assert.equal((await w.phones.bob('/contacts?state=expired')).json.contacts.length, 1, 'b\'s answer was refused by a')
  assert.equal(notices(w.b, w.users.bob.id)[0].body, 'Their journal at a.example does not accept contacts from this journal.')

  const w2 = await world(t, { b: { allowJournals: 'c.example' } })
  const { link: link2 } = await invite(w2)
  const r = await w2.phones.bob('/contacts/invites/open', post({ link: link2 }))
  assert.deepEqual([r.status, r.json.blocked_by], [409, 'journal_not_allowed'])
})

// --- Ending ---------------------------------------------------------------------

test('remove: either side ends it on both journals', async (t) => {
  const w = await world(t)
  await befriend(w)
  const [bobSide] = await contactsOf(w.phones.bob)
  assert.equal((await w.phones.bob(`/contacts/${bobSide.id}`, { method: 'DELETE' })).status, 200)
  assert.deepEqual(w.b.db.prepare("SELECT op, urgent FROM fed_outbox WHERE state='queued'").all(), [{ op: 'contact.remove', urgent: 1 }])
  await w.settle()
  assert.equal((await contactsOf(w.phones.alice)).length, 0)
  assert.equal(w.a.db.prepare("SELECT state FROM contacts WHERE peer_journal='b.example'").get().state, 'removed')
  assert.ok(audits(w.a, w.users.alice.id).some((e) => e.e === 'contact.removed' && e.summary === 'bob@b.example is no longer your contact'))
  assert.ok(audits(w.b, w.users.bob.id).some((e) => e.e === 'contact.removed' && e.summary === 'You removed alice@a.example from your contacts'))
  // A fresh invite makes them contacts again.
  await befriend(w)
  assert.equal((await contactsOf(w.phones.alice))[0].state, 'active')
})

test('block: the other side sees a removal; the block refuses every later invite answer', async (t) => {
  const w = await world(t)
  await befriend(w)
  const [aliceSide] = await contactsOf(w.phones.alice)
  assert.equal((await w.phones.alice(`/contacts/${aliceSide.id}/block`, post({}))).status, 200)
  await w.settle()
  assert.equal(w.b.db.prepare("SELECT state FROM contacts WHERE peer_journal='a.example'").get().state, 'removed', 'not told it was a block')
  assert.equal(JSON.stringify(audits(w.b, w.users.bob.id)).includes('block'), false)

  const { link } = await invite(w)
  await w.phones.bob('/contacts/invites/accept', post({ link }))
  await w.settle()
  assert.equal((await w.phones.alice('/contacts?state=blocked')).json.contacts.length, 1, 'still blocked')
  assert.equal(w.b.db.prepare("SELECT state FROM contacts WHERE peer_journal='a.example'").get().state, 'expired')
  assert.equal((await w.phones.alice('/contacts/invites')).json.invites[0].state, 'open', 'the refused answer did not spend the invite')
})

test('shares: a contact on another journal cannot be offered a mission yet', async (t) => {
  const w = await world(t)
  await befriend(w)
  upsertConversation(w.a.db, { id: 'work', ownerUserId: w.users.alice.id, title: 'Work', agentDeviceId: w.aliceBoxId })
  const m = await w.aliceBox('/missions', post({ convo_id: 'work', title: 'Garden Club' }))
  assert.equal(m.status, 201)
  const r = await w.phones.alice(`/missions/${m.json.mission.id}/shares`, post({ contact: 'bob@b.example', level: 'read' }))
  assert.deepEqual([r.status, r.json.blocked_by], [409, 'not_contact'])
})

// --- Keys ------------------------------------------------------------------------

test('key change: a journal serving a new key cuts its contacts off until a fresh invite pins it', async (t) => {
  const w = await world(t)
  await befriend(w)
  // Pretend b.example knew a.example under another key, and bob's contact
  // was pinned to it.
  const old = exportPublicKey(generateFederationKey().publicKey)
  w.b.db.prepare("UPDATE fed_peers SET key_pub=? WHERE host='a.example'").run(old)
  w.b.db.prepare("UPDATE contacts SET peer_journal_key=? WHERE peer_journal='a.example'").run(old)
  assert.equal((await contactsOf(w.phones.carol)).length, 0)

  // Carol opens a fresh link from alice: b.example sees the new key.
  const { link } = await invite(w)
  const seen = await w.phones.carol('/contacts/invites/open', post({ link }))
  assert.equal(seen.json.key_changed, true)
  assert.equal(w.b.db.prepare("SELECT state FROM fed_peers WHERE host='a.example'").get().state, 'key_changed')
  assert.equal((await contactsOf(w.phones.bob))[0].key_changed, true)
  assert.deepEqual(notices(w.b, w.users.bob.id).map((n) => n.title), ['The journal at a.example changed its key'])

  // Carol accepts: the new key is pinned for her; bob stays cut off.
  await w.phones.carol('/contacts/invites/accept', post({ link }))
  await w.settle()
  assert.deepEqual((await contactsOf(w.phones.carol)).map((c) => [c.state, c.key_changed]), [['active', false]])
  assert.equal((await contactsOf(w.phones.bob))[0].key_changed, true)
  assert.equal(notices(w.b, w.users.bob.id).length, 1, 'one notice, not one per sighting')

  // Bob's own fresh invite reconnects him.
  const again = await invite(w)
  const r = await w.phones.bob('/contacts/invites/accept', post({ link: again.link }))
  assert.equal(r.status, 202)
  await w.settle()
  assert.deepEqual((await contactsOf(w.phones.bob)).map((c) => [c.state, c.key_changed]), [['active', false]])
})

test('spent: an answer under a used link counts only as a retry while its contact is live', async (t) => {
  const w = await world(t)
  const link = await befriend(w)
  const { token } = parseInviteLink(link)
  // A retry from bob's journal under a new op id, while they are contacts,
  // sent past b's own checks: alice's journal takes it as the same yes.
  const id = enqueue(w.b.db, { userId: w.users.bob.id, from: 'bob@b.example', to: 'alice@a.example', op: 'contact.accept_invite', body: { token, display_name: 'bob' }, subject: 'test:retry' })
  const bare = makeOutbox({ db: w.b.db, federation: { key: ensureFederationKey(w.b.db, makeTokenBox(KEY)) }, client: w.client, log: { log() {}, error() {} } })
  await bare.tick()
  assert.equal(w.b.db.prepare('SELECT state FROM fed_outbox WHERE id=?').get(id).state, 'sent')
  assert.equal(notices(w.a, w.users.alice.id).length, 1, 'no second notice')

  // Alice removes bob: the old link no longer brings him back.
  const [aliceSide] = await contactsOf(w.phones.alice)
  await w.phones.alice(`/contacts/${aliceSide.id}`, { method: 'DELETE' })
  await w.settle()
  assert.equal((await contactsOf(w.phones.bob)).length, 0)
  assert.equal((await w.phones.bob('/contacts/invites/accept', post({ link }))).status, 202)
  await w.settle()
  assert.equal((await contactsOf(w.phones.alice)).length, 0, 'still removed')
  assert.equal(w.b.db.prepare("SELECT state FROM contacts WHERE peer_journal='a.example'").get().state, 'expired')
  assert.equal(notices(w.b, w.users.bob.id).at(-1).title, "Couldn't add alice@a.example")
})

test('reconnect: a failed answer on a new key leaves the live contact as it was', async (t) => {
  const w = await world(t)
  await befriend(w)
  const old = exportPublicKey(generateFederationKey().publicKey)
  w.b.db.prepare("UPDATE fed_peers SET key_pub=? WHERE host='a.example'").run(old)
  w.b.db.prepare("UPDATE contacts SET peer_journal_key=? WHERE peer_journal='a.example'").run(old)
  const { invite: inv, link } = await invite(w)
  await w.phones.alice(`/contacts/invites/${inv.id}`, { method: 'DELETE' })
  const r = await w.phones.bob('/contacts/invites/accept', post({ link }))
  assert.deepEqual([r.status, r.json.contact.state, r.json.contact.key_changed], [202, 'active', true])
  await w.settle()
  assert.deepEqual((await contactsOf(w.phones.bob)).map((c) => [c.address, c.state, c.key_changed]), [['alice@a.example', 'active', true]])
  assert.equal(notices(w.b, w.users.bob.id).at(-1).title, "Couldn't reconnect with alice@a.example")
})
