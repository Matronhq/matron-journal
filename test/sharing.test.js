import test from 'node:test'
import assert from 'node:assert/strict'
import { openDb, pinDevicePrivate, insertBlob } from '../src/db.js'
import { createUser, createAgent, createClientDevice } from '../src/auth.js'
import { upsertConversation, append } from '../src/journal.js'
import { createMission, createMilestone, listGrantedMissions, getGrantedMission, grantedMissionDetail, updateMission } from '../src/missions.js'
import { createItem, addComment, getSharedItem } from '../src/items.js'
import {
  requestContact, answerContact, removeContact, blockContact, listContacts, expireContactAsks, getContactRaw,
  OWN_ASK_TTL_MS, MAX_PARKED_PER_DEVICE,
} from '../src/contacts.js'
import { shareMission, answerGrant, revokeGrant, listGrants, expireGrantAsks, sharePreview, activeGranteeIds } from '../src/grants.js'
import { canReadMission, canWriteMission, missionAccess, canReadBlob, canReadConvo } from '../src/visibility.js'

// Pure-DB half of contacts and grants (spec 2026-10-02 matron-to-matron
// sharing, phase 1): the state machines and the grant clause of the read
// rule. The HTTP and socket half is test/sharing-http.test.js.
async function world() {
  const db = openDb(':memory:')
  const dan = await createUser(db, 'dan', 'pw')
  const tim = await createUser(db, 'tim', 'pw')
  const sam = await createUser(db, 'sam', 'pw')
  const box = createAgent(db, dan.id, 'dan-box')
  const priv = createAgent(db, dan.id, 'dan-private')
  pinDevicePrivate(db, priv.deviceId, true)
  const phone = createClientDevice(db, dan.id, 'dan-phone')
  upsertConversation(db, { id: 'work', ownerUserId: dan.id, title: 'work', agentDeviceId: box.deviceId })
  upsertConversation(db, { id: 'secret', ownerUserId: dan.id, title: 'secret', agentDeviceId: priv.deviceId })
  return { db, dan, tim, sam, box, priv, phone }
}

const state = (db, userId, peer) => getContactRaw(db, userId, peer)?.state ?? null

function contacts(db, a, b) {
  requestContact(db, { userId: a.id, peerName: b.name, by: 'user' })
  const theirs = getContactRaw(db, b.id, a.name)
  answerContact(db, { userId: b.id, contactId: theirs.id, decision: 'approve' })
  return { own: getContactRaw(db, a.id, b.name), theirs: getContactRaw(db, b.id, a.name) }
}

function mission(db, w, { convo = 'work', device = w.box.deviceId, title = 'Launch' } = {}) {
  // attach:false — the conversation is only the mission's origin, so one
  // conversation can be the origin of several.
  return createMission(db, { userId: w.dan.id, deviceId: device, createdBy: 'agent', convoId: convo, title, attach: false }).mission
}

function milestone(db, w, m, convo, title) {
  if (!db.prepare('SELECT 1 FROM mission_conversations WHERE mission_id=? AND convo_id=?').get(m.id, convo)) {
    db.prepare("INSERT INTO mission_conversations(mission_id, convo_id, user_id, how, joined_at) VALUES(?,?,?,'joined',1)").run(m.id, convo, w.dan.id)
  }
  return createMilestone(db, {
    userId: w.dan.id, deviceId: w.box.deviceId, createdBy: 'agent', convoId: convo, kind: 'progress', title, missionRef: m.id,
    appendMarker: (payload) => append(db, { userId: w.dan.id, convoId: convo, sender: 'agent:x', type: 'milestone', payload }),
  })
}

function granted(db, w, m) {
  const { own } = contacts(db, w.dan, w.tim)
  const { grant } = shareMission(db, { ownerUserId: w.dan.id, missionId: m.id, contact: own.id, level: 'read', by: 'user' })
  answerGrant(db, { userId: w.tim.id, grantId: grant.id, decision: 'approve' })
  return grant.id
}

test('contacts: request, accept, and both rows are active', async () => {
  const { db, dan, tim } = await world()
  const out = requestContact(db, { userId: dan.id, peerName: 'tim', by: 'user' })
  assert.equal(out.outcome, 'sent')
  assert.equal(state(db, dan.id, 'tim'), 'pending_out')
  assert.equal(state(db, tim.id, 'dan'), 'pending_in')
  assert.throws(() => requestContact(db, { userId: dan.id, peerName: 'tim', by: 'user' }), /pending/)
  // Only the person asked may accept; the requester's own row is not answerable.
  assert.throws(() => answerContact(db, { userId: dan.id, contactId: out.contact.id, decision: 'approve' }), /not_pending/)
  assert.equal(answerContact(db, { userId: tim.id, contactId: out.contact.id, decision: 'approve' }), null, 'not tim\'s row')
  const acc = answerContact(db, { userId: tim.id, contactId: out.peer.id, decision: 'approve' })
  assert.equal(acc.outcome, 'accepted')
  assert.equal(state(db, dan.id, 'tim'), 'active')
  assert.equal(state(db, tim.id, 'dan'), 'active')
  assert.throws(() => requestContact(db, { userId: dan.id, peerName: 'tim', by: 'user' }), /already_contact/)
  assert.throws(() => requestContact(db, { userId: dan.id, peerName: 'dan', by: 'user' }), /no_user/)
  assert.throws(() => requestContact(db, { userId: dan.id, peerName: 'ghost', by: 'user' }), /no_user/)
  db.close()
})

test('contacts: an agent\'s ask parks, expires after 24 h, and is capped per device', async () => {
  const { db, dan, tim, box } = await world()
  const t0 = 1_000_000
  const out = requestContact(db, { userId: dan.id, peerName: 'tim', by: 'agent', convoId: 'work', deviceId: box.deviceId, now: t0 })
  assert.equal(out.outcome, 'parked')
  assert.equal(state(db, tim.id, 'dan'), null, 'nothing has left')
  // A tap after the TTL expires it instead of sending it.
  const late = answerContact(db, { userId: dan.id, contactId: out.contact.id, decision: 'approve', now: t0 + OWN_ASK_TTL_MS + 1 })
  assert.equal(late.outcome, 'expired')
  assert.equal(state(db, tim.id, 'dan'), null)
  // The sweep does the same for one nobody tapped, and the row can be reused.
  requestContact(db, { userId: dan.id, peerName: 'tim', by: 'agent', convoId: 'work', deviceId: box.deviceId, now: t0 })
  assert.deepEqual(expireContactAsks(db, t0 + OWN_ASK_TTL_MS - 1), [])
  assert.equal(expireContactAsks(db, t0 + OWN_ASK_TTL_MS + 1).length, 1)
  assert.equal(state(db, dan.id, 'tim'), 'expired')
  // The cap counts parked asks of one device.
  for (let i = 0; i < MAX_PARKED_PER_DEVICE; i++) {
    await createUser(db, `u${i}`, 'pw')
    requestContact(db, { userId: dan.id, peerName: `u${i}`, by: 'agent', convoId: 'work', deviceId: box.deviceId })
  }
  assert.throws(() => requestContact(db, { userId: dan.id, peerName: 'tim', by: 'agent', convoId: 'work', deviceId: box.deviceId }), /too_many_asks/)
  db.close()
})

test('contacts: a request overtakes the other side\'s parked ask; crossed requests make contacts', async () => {
  const { db, dan, tim, sam, box } = await world()
  const timBox = createAgent(db, tim.id, 'tim-box')
  upsertConversation(db, { id: 'timwork', ownerUserId: tim.id, title: 't', agentDeviceId: timBox.deviceId })
  const parked = requestContact(db, { userId: tim.id, peerName: 'dan', by: 'agent', convoId: 'timwork', deviceId: timBox.deviceId })
  const out = requestContact(db, { userId: dan.id, peerName: 'tim', by: 'user' })
  assert.equal(out.outcome, 'sent')
  assert.equal(out.superseded.id, parked.contact.id)
  assert.equal(state(db, tim.id, 'dan'), 'pending_in')
  // sam asked dan; dan's own request back is the accept.
  requestContact(db, { userId: sam.id, peerName: 'dan', by: 'user' })
  assert.throws(() => requestContact(db, { userId: dan.id, peerName: 'sam', by: 'agent', convoId: 'work', deviceId: box.deviceId }), /pending_in/)
  assert.equal(requestContact(db, { userId: dan.id, peerName: 'sam', by: 'user' }).outcome, 'accepted')
  assert.equal(state(db, sam.id, 'dan'), 'active')
  db.close()
})

test('contacts: a block is silent to the blocked, and survives their removal', async () => {
  const { db, dan, tim } = await world()
  const { own, theirs } = contacts(db, dan, tim)
  blockContact(db, { userId: tim.id, contactId: theirs.id })
  assert.equal(state(db, tim.id, 'dan'), 'blocked')
  assert.equal(state(db, dan.id, 'tim'), 'removed')
  const again = requestContact(db, { userId: dan.id, peerName: 'tim', by: 'user' })
  assert.equal(again.outcome, 'silent')
  assert.equal(again.contact.state, 'pending_out')
  assert.equal(state(db, tim.id, 'dan'), 'blocked')
  removeContact(db, { userId: dan.id, contactId: own.id })
  assert.equal(state(db, tim.id, 'dan'), 'blocked', 'dan removing his row does not lift tim\'s block')
  assert.deepEqual(listContacts(db, dan.id), [])
  // Removing a blocked row is not a second way to unblock: it is refused,
  // and dan's next request still reaches nobody.
  assert.throws(() => removeContact(db, { userId: tim.id, contactId: theirs.id }), /blocked/)
  assert.throws(() => blockContact(db, { userId: tim.id, contactId: theirs.id }), /not_active/)
  assert.equal(requestContact(db, { userId: dan.id, peerName: 'tim', by: 'user' }).outcome, 'silent')
  assert.equal(state(db, tim.id, 'dan'), 'blocked')
  db.close()
})

test('the grant clause: an active grant between two active contact rows, and nothing less', async () => {
  const w = await world()
  const { db, dan, tim, sam } = w
  const m = mission(db, w)
  assert.equal(missionAccess(db, dan.id, m.id), 'owner')
  assert.equal(canReadMission(db, tim.id, m.id), false)
  const { own, theirs } = contacts(db, dan, tim)
  assert.equal(canReadMission(db, tim.id, m.id), false, 'contacts alone share nothing')
  const { grant } = shareMission(db, { ownerUserId: dan.id, missionId: m.id, contact: 'tim', level: 'read', by: 'user' })
  assert.equal(grant.state, 'pending')
  assert.equal(canReadMission(db, tim.id, m.id), false, 'offered is not accepted')
  assert.throws(() => answerGrant(db, { userId: dan.id, grantId: grant.id, decision: 'approve' }), /not_pending/, 'the owner cannot accept for the grantee')
  assert.equal(answerGrant(db, { userId: sam.id, grantId: grant.id, decision: 'approve' }), null)
  assert.equal(answerGrant(db, { userId: tim.id, grantId: grant.id, decision: 'approve' }).outcome, 'accepted')
  assert.equal(missionAccess(db, tim.id, m.id), 'read')
  assert.equal(canReadMission(db, sam.id, m.id), false)
  assert.deepEqual(activeGranteeIds(db, m.id), [tim.id])
  // Read is not write, and a grant is not a transcript.
  assert.equal(canWriteMission(db, tim.id, m.id), false)
  assert.equal(canWriteMission(db, dan.id, m.id), true)
  assert.equal(canReadConvo(db, tim.id, 'work'), false)
  // Either contact row leaving 'active' closes the clause, with the grant row untouched.
  db.prepare("UPDATE contacts SET state='removed' WHERE id=?").run(theirs.id)
  assert.equal(canReadMission(db, tim.id, m.id), false)
  db.prepare("UPDATE contacts SET state='active' WHERE id=?").run(theirs.id)
  db.prepare("UPDATE contacts SET state='blocked' WHERE id=?").run(own.id)
  assert.equal(canReadMission(db, tim.id, m.id), false)
  assert.deepEqual(activeGranteeIds(db, m.id), [])
  db.prepare("UPDATE contacts SET state='active' WHERE id=?").run(own.id)
  assert.equal(canReadMission(db, tim.id, m.id), true)
  // Revocation, by either party and nobody else.
  assert.equal(revokeGrant(db, { userId: sam.id, grantId: grant.id }), null)
  assert.equal(revokeGrant(db, { userId: tim.id, grantId: grant.id }).by, 'grantee')
  assert.equal(canReadMission(db, tim.id, m.id), false)
  assert.throws(() => revokeGrant(db, { userId: dan.id, grantId: grant.id }), /not_active/)
  // The row is reused by a new share.
  const renewed = shareMission(db, { ownerUserId: dan.id, missionId: m.id, contact: own.id, level: 'read', by: 'user' })
  assert.equal(renewed.grant.id, grant.id)
  assert.equal(renewed.grant.state, 'pending')
  db.close()
})

test('grants: an agent\'s ask parks for the owner, expires, and removal of the contact revokes everything', async () => {
  const w = await world()
  const { db, dan, tim, box } = w
  const m = mission(db, w)
  const { own } = contacts(db, dan, tim)
  const t0 = 5_000_000
  const ask = shareMission(db, { ownerUserId: dan.id, missionId: m.id, contact: 'tim', level: 'read', by: 'agent', convoId: 'work', deviceId: box.deviceId, now: t0 })
  assert.equal(ask.grant.state, 'awaiting_owner')
  assert.deepEqual(listGrants(db, tim.id, { direction: 'in' }), [], 'the grantee is not told of an unapproved ask')
  assert.equal(revokeGrant(db, { userId: tim.id, grantId: ask.grant.id }), null)
  assert.equal(answerGrant(db, { userId: tim.id, grantId: ask.grant.id, decision: 'approve' }), null)
  assert.throws(() => shareMission(db, { ownerUserId: dan.id, missionId: m.id, contact: 'tim', level: 'read', by: 'user' }), /pending/)
  assert.equal(expireGrantAsks(db, t0 + OWN_ASK_TTL_MS + 1).length, 1)
  // Approved while the two are no longer contacts: revoked, not sent.
  const again = shareMission(db, { ownerUserId: dan.id, missionId: m.id, contact: 'tim', level: 'read', by: 'agent', convoId: 'work', deviceId: box.deviceId })
  db.prepare("UPDATE contacts SET state='removed' WHERE user_id=?").run(tim.id)
  assert.equal(answerGrant(db, { userId: dan.id, grantId: again.grant.id, decision: 'approve' }).outcome, 'unavailable')
  db.prepare("UPDATE contacts SET state='active' WHERE user_id=?").run(tim.id)
  // Live and pending grants both end with the contact.
  const m2 = mission(db, w, { title: 'Second' })
  const g1 = shareMission(db, { ownerUserId: dan.id, missionId: m.id, contact: 'tim', level: 'read', by: 'user' }).grant
  answerGrant(db, { userId: tim.id, grantId: g1.id, decision: 'approve' })
  shareMission(db, { ownerUserId: dan.id, missionId: m2.id, contact: 'tim', level: 'read', by: 'user' })
  const out = removeContact(db, { userId: tim.id, contactId: getContactRaw(db, tim.id, 'dan').id })
  assert.equal(out.revokedGrants.length, 2)
  assert.deepEqual(listGrants(db, dan.id, { direction: 'out' }), [])
  assert.deepEqual(listGrants(db, dan.id, { state: 'revoked' }).map((g) => g.revoked_by), ['contact_removed', 'contact_removed'])
  assert.equal(state(db, dan.id, 'tim'), 'removed')
  assert.equal(own.user_id, dan.id)
  db.close()
})

test('grants: only read, only the owner\'s own shareable missions', async () => {
  const w = await world()
  const { db, dan, tim, priv } = w
  const m = mission(db, w)
  const hidden = mission(db, w, { convo: 'secret', device: priv.deviceId, title: 'Private' })
  contacts(db, dan, tim)
  const share = (over) => shareMission(db, { ownerUserId: dan.id, missionId: m.id, contact: 'tim', level: 'read', by: 'user', ...over })
  assert.throws(() => share({ level: 'contribute' }), /level_unavailable/)
  assert.throws(() => share({ level: 'owner' }), /level_unavailable/)
  assert.throws(() => share({ level: 'admin' }), /bad_level/)
  assert.throws(() => share({ contact: 'sam' }), /not_contact/)
  assert.throws(() => share({ missionId: hidden.id }), /private_mission/)
  assert.throws(() => share({ ownerUserId: tim.id, contact: 'dan' }), /no_mission/, 'not the caller\'s mission')
  db.close()
})

test('the grantee\'s view applies the private sieve and carries no ids', async () => {
  const w = await world()
  const { db, dan, tim, box, priv, phone } = w
  const m = mission(db, w)
  milestone(db, w, m, 'work', 'Public step')
  milestone(db, w, m, 'secret', 'Private step')
  const item = (deviceConvo, title, extra = {}) => createItem(db, {
    userId: dan.id, kind: 'task', title, originConvoId: deviceConvo, originDeviceId: box.deviceId, createdBy: 'agent', ...extra,
  }).item
  const open = item('work', 'Visible task')
  const secret = item('secret', 'Private task')
  db.prepare('UPDATE items SET mission_id=? WHERE id IN (?,?)').run(m.id, open.id, secret.id)
  const mirror = item('work', 'Approve something', { consent: 'spawn' })
  db.prepare('UPDATE items SET mission_id=? WHERE id=?').run(m.id, mirror.id)
  insertBlob(db, { id: 'blob1', ownerUserId: dan.id, contentType: 'image/png', size: 3, sha256: 'x', diskPath: '/tmp/x' })
  insertBlob(db, { id: 'blob2', ownerUserId: dan.id, contentType: 'image/png', size: 3, sha256: 'y', diskPath: '/tmp/y' })
  const att = (id) => [{ blob_ref: id, mime: 'image/png', name: 'a.png', size: 3 }]
  addComment(db, { userId: dan.id, itemId: open.id, author: 'user', deviceId: phone.deviceId, body: 'see', attachments: att('blob1') })
  addComment(db, { userId: dan.id, itemId: secret.id, author: 'user', deviceId: phone.deviceId, body: 'see', attachments: att('blob2') })
  updateMission(db, { userId: dan.id, missionId: m.id, fields: { status: 'from the private box' }, statusWriter: { by: 'agent', convoId: 'secret', deviceId: priv.deviceId } })

  assert.deepEqual(sharePreview(db, m.id), { milestones: 1, items: 1, comments: 1, attachments: 1 })
  assert.equal(getGrantedMission(db, tim.id, m.id), null)
  assert.equal(canReadBlob(db, tim.id, 'blob1'), false)
  granted(db, w, m)

  const row = getGrantedMission(db, tim.id, m.id)
  assert.equal(row.shared_via, 'grant')
  assert.equal(row.milestones, 1)
  assert.equal(row.open_items, 1)
  // An item waiting on the OWNER is not the grantee's to answer, in the
  // count or in the activity derived from it.
  db.prepare("UPDATE items SET awaiting='user' WHERE id=?").run(open.id)
  const waiting = getGrantedMission(db, tim.id, m.id)
  assert.equal(waiting.needs_you, 0)
  assert.notEqual(waiting.activity, 'waiting')
  assert.equal(row.last_milestone.title, 'Public step')
  assert.equal(row.status, null, 'a privately written status is withheld')
  for (const k of ['status_convo_id', 'closed_convo_id', 'project_id']) assert.equal(row[k], null, k)
  assert.equal(row.origin_convo_id, '')
  assert.equal(row.origin_device_id, 0)
  assert.equal(row.owner.name, 'dan')
  assert.deepEqual(listGrantedMissions(db, tim.id).map((x) => x.id), [m.id])
  assert.deepEqual(listGrantedMissions(db, dan.id), [], 'never the owner\'s own')
  const detail = grantedMissionDetail(db, row)
  assert.deepEqual(detail.milestones.map((l) => l.title), ['Public step'])
  assert.deepEqual(detail.items.map((i) => i.title), ['Visible task'])
  assert.deepEqual(detail.conversations, [])
  const json = JSON.stringify(detail)
  for (const leak of ['work', 'secret', 'dan-box', 'convo_id":"']) assert.ok(!json.includes(`"${leak}"`), `${leak} must not cross`)

  assert.equal(getSharedItem(db, tim.id, open.id).shared_via, 'grant')
  assert.equal(getSharedItem(db, tim.id, secret.id), null)
  assert.equal(getSharedItem(db, tim.id, mirror.id), null)
  assert.equal(canReadBlob(db, tim.id, 'blob1'), true)
  assert.equal(canReadBlob(db, tim.id, 'blob2'), false, 'an attachment on a private-box item stays home')
  assert.equal(canReadBlob(db, w.sam.id, 'blob1'), false)
  // The mission's origin box turning private later hides the mission, its
  // items and their attachments together: a kept URL opens nothing.
  pinDevicePrivate(db, box.deviceId, true)
  assert.equal(getGrantedMission(db, tim.id, m.id), null)
  assert.equal(getSharedItem(db, tim.id, open.id), null)
  assert.equal(canReadBlob(db, tim.id, 'blob1'), false)
  db.close()
})

test('contacts: a user whose name starts with ct_ is found by name; a grant names its contact to the owner only', async () => {
  const w = await world()
  const { db, dan, tim } = w
  const odd = await createUser(db, 'ct_bob', 'pw')
  assert.equal(requestContact(db, { userId: dan.id, peerName: 'ct_bob', by: 'user' }).outcome, 'sent')
  const theirs = getContactRaw(db, odd.id, 'dan')
  answerContact(db, { userId: odd.id, contactId: theirs.id, decision: 'approve' })
  const own = getContactRaw(db, dan.id, 'ct_bob')
  assert.equal(own.state, 'active')
  assert.equal(getContactRaw(db, dan.id, own.id).id, own.id, 'and still by id')
  assert.equal(getContactRaw(db, tim.id, own.id), null, 'never another user\'s row')
  const m = mission(db, w)
  const { grant } = shareMission(db, { ownerUserId: dan.id, missionId: m.id, contact: 'ct_bob', level: 'read', by: 'user' })
  assert.equal(grant.contact_id, own.id)
  assert.equal(listGrants(db, dan.id, { direction: 'out' })[0].contact_id, own.id)
  assert.equal('contact_id' in listGrants(db, odd.id, { direction: 'in' })[0], false, 'the owner\'s row id is not the grantee\'s business')
  db.close()
})
