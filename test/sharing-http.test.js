import test from 'node:test'
import assert from 'node:assert/strict'
import { startTestServer, makeWsClient } from './helpers.js'
import { createUser, createAgent } from '../src/auth.js'
import { upsertConversation } from '../src/journal.js'
import { peopleConvoId } from '../src/people-convo.js'

// Contacts and read-only mission share between two users on one journal
// (spec 2026-10-02 matron-to-matron sharing, phase 1), end to end over real
// HTTP and sockets: dan (a box, a Coordinator box and a phone) and tim (a
// box and a phone).
const settle = (ms = 120) => new Promise((r) => setTimeout(r, ms))

async function world(t) {
  const s = await startTestServer()
  t.after(() => s.close())
  const dan = await createUser(s.db, 'dan', 'pw')
  const tim = await createUser(s.db, 'tim', 'pw')
  const danBox = createAgent(s.db, dan.id, 'dan-box')
  const danCoord = createAgent(s.db, dan.id, 'dan-coord')
  const timBox = createAgent(s.db, tim.id, 'tim-box')
  upsertConversation(s.db, { id: 'work', ownerUserId: dan.id, title: 'Birthday Club', agentDeviceId: danBox.deviceId })
  upsertConversation(s.db, { id: 'coord', ownerUserId: dan.id, title: 'Coordinator', agentDeviceId: danCoord.deviceId })
  upsertConversation(s.db, { id: 'timwork', ownerUserId: tim.id, title: 'Tim', agentDeviceId: timBox.deviceId })
  const login = async (name) => (await s.http('/login', { method: 'POST', body: { username: name, password: 'pw', device_name: `${name}-phone` } })).json.token
  const danPhone = await login('dan')
  const timPhone = await login('tim')
  assert.equal((await s.http('/coordinator', { method: 'PUT', token: danPhone, body: { convo_id: 'coord' } })).status, 200)
  const sockets = {}
  for (const [k, token] of Object.entries({ danPhone, timPhone, danBox: danBox.token, danCoord: danCoord.token, timBox: timBox.token })) {
    sockets[k] = await makeWsClient(s.base, { token, cursor: null })
    await sockets[k].waitFor((f) => f.op === 'hello_ok')
  }
  t.after(() => { for (const w of Object.values(sockets)) { try { w.close() } catch { /* already closed */ } } })
  const http = (token) => (path, opts = {}) => s.http(path, { token, ...opts })
  return {
    s, dan, tim, ws: sockets,
    danBox: http(danBox.token), danCoord: http(danCoord.token), timBox: http(timBox.token),
    danPhone: http(danPhone), timPhone: http(timPhone),
  }
}

const post = (body) => ({ method: 'POST', body })
const cards = (w, kind) => w.journal().filter((f) => f.type === 'permission_request' && f.payload.kind === kind)
const audits = (w) => w.journal().filter((f) => f.type === 'people').map((f) => f.payload.event)

// dan and tim become contacts from their phones: the short path the rest
// of the tests start from.
async function makeContacts(w) {
  const r = await w.danPhone('/contacts', post({ user: 'tim' }))
  assert.equal(r.status, 201)
  const timSide = (await w.timPhone('/contacts')).json.contacts[0]
  assert.equal((await w.timPhone(`/contacts/${timSide.id}/answer`, post({ decision: 'approve' }))).status, 200)
  return { danContact: r.json.contact.id, timContact: timSide.id }
}

async function makeMission(w) {
  const m = await w.danBox('/missions', post({ convo_id: 'work', title: 'Birthday Club launch', body: 'Ship it.' }))
  assert.equal(m.status, 201)
  return m.json.mission
}

test('the user directory lists the journal\'s other users, names only', async (t) => {
  const w = await world(t)
  assert.deepEqual((await w.danBox('/contacts/users')).json, { users: [{ name: 'tim' }] })
  assert.deepEqual((await w.timPhone('/contacts/users')).json, { users: [{ name: 'dan' }] })
})

test('an agent\'s contact ask parks for its own user; the tap sends it; the other person accepts once', async (t) => {
  const w = await world(t)
  // Being on the same journal makes nobody a contact (spec decision 8).
  assert.deepEqual((await w.danPhone('/contacts')).json.contacts, [])
  assert.equal((await w.danBox('/contacts', post({ user: 'tim' }))).status, 400, 'an agent must say which conversation asks')
  assert.equal((await w.danBox('/contacts', post({ user: 'tim', convo_id: 'timwork' }))).status, 404, 'not a conversation of this agent')
  assert.equal((await w.danBox('/contacts', post({ user: 'nobody', convo_id: 'work' }))).status, 404)
  assert.equal((await w.danBox('/contacts', post({ user: 'dan', convo_id: 'work' }))).status, 404, 'yourself is the same 404')

  const ask = await w.danBox('/contacts', post({ user: 'tim', convo_id: 'work' }))
  assert.equal(ask.status, 202)
  assert.equal(ask.json.pending, 'owner')
  assert.equal(ask.json.contact.state, 'awaiting_user')
  const id = ask.json.contact.id
  await settle()

  // dan's phone has the card, in the asking conversation; no agent does.
  const card = cards(w.ws.danPhone, 'contact_request')[0]
  assert.equal(card.convo_id, 'work')
  assert.equal(card.payload.direction, 'out')
  assert.equal(card.payload.peer.name, 'tim')
  assert.equal(card.payload.from_name, 'dan-box')
  for (const k of ['danBox', 'danCoord', 'timBox']) assert.equal(cards(w.ws[k], 'contact_request').length, 0, `${k} never sees the card`)
  // Nothing has left for tim.
  assert.deepEqual((await w.timPhone('/contacts')).json.contacts, [])
  assert.equal(cards(w.ws.timPhone, 'contact_request').length, 0)

  // The mirror: a question for dan with two buttons, invisible to agents.
  const mirror = (await w.danPhone('/items?label=consent')).json.items[0]
  assert.equal(mirror.consent, 'contact')
  assert.deepEqual(mirror.actions, ['Approve', 'Decline'])
  assert.equal(mirror.awaiting, 'user')
  assert.equal((await w.danBox(`/items/${mirror.id}`)).status, 404)
  assert.equal((await w.danBox('/items?label=consent')).json.items.length, 0)

  // No agent answers — not the asker, not the Coordinator.
  for (const agent of [w.danBox, w.danCoord]) {
    assert.equal((await agent(`/contacts/${id}/answer`, post({ decision: 'approve' }))).status, 403)
  }
  assert.equal((await w.danBox(`/items/${mirror.id}/comments`, post({ action: 'Approve' }))).status, 404)
  // The asking agent asking again is told it is pending.
  const again = await w.danBox('/contacts', post({ user: 'tim', convo_id: 'work' }))
  assert.equal(again.status, 409)
  assert.equal(again.json.blocked_by, 'pending')

  // dan taps Approve on the mirror — the path today's apps have.
  const tap = await w.danPhone(`/items/${mirror.id}/comments`, post({ action: 'Approve' }))
  assert.equal(tap.status, 200)
  assert.equal(tap.json.item.state, 'closed')
  assert.equal(tap.json.contact.state, 'pending_out')
  await settle()

  // tim: one accept card in his People conversation, and its mirror.
  const people = peopleConvoId(w.s.db, w.tim.id)
  assert.ok(people)
  const timCard = cards(w.ws.timPhone, 'contact_request')[0]
  assert.equal(timCard.convo_id, people)
  assert.equal(timCard.sender, 'journal')
  assert.equal(timCard.payload.direction, 'in')
  assert.equal(timCard.payload.peer.name, 'dan')
  assert.equal(cards(w.ws.timBox, 'contact_request').length, 0, 'tim\'s agent never sees it')
  const timSide = (await w.timPhone('/contacts')).json.contacts[0]
  assert.equal(timSide.state, 'pending_in')
  assert.equal(timSide.address, 'dan')
  const timMirror = (await w.timPhone('/items?label=consent')).json.items[0]
  assert.deepEqual(timMirror.actions, ['Accept', 'Decline'])
  assert.equal(timMirror.origin_convo_id, people)

  // tim's agent can read that a request is waiting, but cannot accept it.
  assert.equal((await w.timBox('/contacts')).json.contacts[0].state, 'pending_in')
  assert.equal((await w.timBox(`/contacts/${timSide.id}/answer`, post({ decision: 'approve' }))).status, 403)
  const sneaky = await w.timBox('/contacts', post({ user: 'dan', convo_id: 'timwork' }))
  assert.equal(sneaky.status, 409, 'asking back is not a way around the accept card for an agent')
  assert.equal(sneaky.json.blocked_by, 'pending_in')

  const accept = await w.timPhone(`/contacts/${timSide.id}/answer`, post({ decision: 'approve' }))
  assert.equal(accept.status, 200)
  assert.equal(accept.json.contact.state, 'active')
  await settle()
  assert.equal((await w.danPhone(`/contacts/${id}`)).json.contact.state, 'active')
  assert.equal((await w.timPhone(`/items/${timMirror.id}`)).json.item.state, 'closed')

  // Both logs carry the trail, and both phones were told to refetch.
  assert.deepEqual(audits(w.ws.danPhone), ['contact.requested', 'contact.accepted'])
  assert.deepEqual(audits(w.ws.timPhone), ['contact.received', 'contact.accepted'])
  assert.ok(w.ws.danPhone.frames.some((f) => f.kind === 'people' && f.event === 'changed'))
  for (const k of ['danBox', 'danCoord', 'timBox']) assert.deepEqual(audits(w.ws[k]), [], `${k} hears no audit event`)
  const activity = (await w.danPhone(`/contacts/${id}/activity`)).json.events.map((e) => e.event)
  assert.deepEqual(activity, ['contact.accepted', 'contact.requested'])
})

test('the Coordinator is never offered, and cannot answer, a contact or share ask', async (t) => {
  const w = await world(t)
  const ask = await w.danBox('/contacts', post({ user: 'tim', convo_id: 'work' }))
  const pending = await w.danCoord('/consent/pending?convo_id=coord')
  assert.equal(pending.status, 200)
  assert.deepEqual(pending.json.pending, [])
  await settle()
  assert.ok(!w.ws.danCoord.frames.some((f) => f.kind === 'consent'), 'no nudge either')
  for (const kind of ['contact', 'share']) {
    const r = await w.danCoord('/consent/answer', post({ convo_id: 'coord', kind, id: ask.json.contact.id, decision: 'approve', reason: 'looks fine' }))
    assert.equal(r.status, 400)
  }
  assert.equal((await w.danPhone(`/contacts/${ask.json.contact.id}`)).json.contact.state, 'awaiting_user')
})

test('declining, withdrawing and blocking', async (t) => {
  const w = await world(t)
  // tim declines.
  const a = await w.danPhone('/contacts', post({ user: 'tim' }))
  let timSide = (await w.timPhone('/contacts')).json.contacts[0]
  const mirror = (await w.timPhone('/items?label=consent')).json.items[0]
  assert.equal((await w.timPhone(`/items/${mirror.id}/comments`, post({ action: 'Decline' }))).status, 200)
  assert.equal((await w.danPhone(`/contacts/${a.json.contact.id}`)).json.contact.state, 'declined')
  assert.deepEqual((await w.timPhone('/contacts')).json.contacts, [], 'ended rows are not listed')

  // dan asks again and withdraws before tim answers: tim's card closes.
  assert.equal((await w.danPhone('/contacts', post({ user: 'tim' }))).status, 201)
  const second = (await w.timPhone('/items?label=consent&state=open')).json.items[0]
  assert.equal((await w.danBox(`/contacts/${a.json.contact.id}`, { method: 'DELETE' })).status, 200, 'an agent may withdraw')
  assert.equal((await w.timPhone(`/items/${second.id}`)).json.item.state, 'closed')
  timSide = (await w.timPhone(`/contacts/${timSide.id}`)).json.contact
  assert.equal(timSide.state, 'removed')

  // tim blocks dan: dan's next request looks sent, and reaches nobody.
  assert.equal((await w.timBox(`/contacts/${timSide.id}/block`, post({}))).status, 200)
  const blocked = await w.danPhone('/contacts', post({ user: 'tim' }))
  assert.equal(blocked.status, 201)
  assert.equal(blocked.json.pending, 'peer')
  assert.equal(blocked.json.contact.state, 'pending_out')
  assert.equal((await w.timPhone(`/contacts/${timSide.id}`)).json.contact.state, 'blocked')
  assert.equal((await w.timPhone('/items?label=consent&state=open')).json.items.length, 0, 'no card reaches the blocker')
  // tim cannot ask while he blocks; only his phone unblocks.
  assert.equal((await w.timPhone('/contacts', post({ user: 'dan' }))).json.blocked_by, 'blocked')
  assert.equal((await w.timBox(`/contacts/${timSide.id}/unblock`, post({}))).status, 403)
  assert.equal((await w.timPhone(`/contacts/${timSide.id}/unblock`, post({}))).status, 200)
  // dan's request is still out: tim asking now crosses it, and both are active.
  const crossed = await w.timPhone('/contacts', post({ user: 'dan' }))
  assert.equal(crossed.status, 201)
  assert.equal(crossed.json.contact.state, 'active')
  assert.equal((await w.danPhone(`/contacts/${a.json.contact.id}`)).json.contact.state, 'active')
})

test('a read-only mission share: two yeses, a sieved view, live, and no writes', async (t) => {
  const w = await world(t)
  const mission = await makeMission(w)
  assert.equal((await w.danBox('/milestones', post({ convo_id: 'work', kind: 'progress', title: 'Plan agreed', body: 'Details.' }))).status, 201)
  const item = (await w.danBox('/items', post({ convo_id: 'work', kind: 'task', title: 'Book the hall', body: 'By Friday.' }))).json.item
  assert.equal((await w.danBox(`/items/${item.id}/comments`, post({ body: 'Called them.' }))).status, 201)

  // Not contacts yet: nothing can be shared.
  const early = await w.danBox(`/missions/${mission.num}/shares`, post({ contact: 'tim', convo_id: 'work' }))
  assert.equal(early.status, 409)
  assert.equal(early.json.blocked_by, 'not_contact')
  await makeContacts(w)
  for (const level of ['contribute', 'owner']) {
    const r = await w.danBox(`/missions/${mission.num}/shares`, post({ contact: 'tim', level, convo_id: 'work' }))
    assert.equal(r.json.blocked_by, 'level_unavailable', `${level} is a later phase`)
  }
  for (const k of Object.keys(w.ws)) w.ws[k].frames.length = 0

  // dan's agent asks; dan gets the card with the preview of what crosses.
  const ask = await w.danBox(`/missions/${mission.num}/shares`, post({ contact: 'tim', level: 'read', convo_id: 'work' }))
  assert.equal(ask.status, 202)
  assert.equal(ask.json.grant.state, 'awaiting_owner')
  const gid = ask.json.grant.id
  await settle()
  const card = cards(w.ws.danPhone, 'mission_share')[0]
  assert.equal(card.convo_id, 'work')
  assert.equal(card.payload.direction, 'out')
  assert.deepEqual(card.payload.preview, { milestones: 1, items: 1, comments: 1, attachments: 0 })
  assert.equal(cards(w.ws.danBox, 'mission_share').length, 0)
  // tim knows nothing yet: no grant, no mission, no card.
  assert.deepEqual((await w.timPhone('/grants')).json.grants, [])
  assert.equal((await w.timPhone(`/grants/${gid}`)).status, 404)
  assert.equal((await w.timPhone(`/missions/${mission.id}`)).status, 404)
  assert.equal((await w.danBox(`/grants/${gid}/answer`, post({ decision: 'approve' }))).status, 403)
  assert.equal((await w.danCoord(`/grants/${gid}/answer`, post({ decision: 'approve' }))).status, 403)

  assert.equal((await w.danPhone(`/grants/${gid}/answer`, post({ decision: 'approve' }))).json.grant.state, 'pending')
  await settle()
  const timCard = cards(w.ws.timPhone, 'mission_share')[0]
  assert.equal(timCard.convo_id, peopleConvoId(w.s.db, w.tim.id))
  assert.equal(timCard.payload.owner.name, 'dan')
  assert.equal(timCard.payload.mission.title, 'Birthday Club launch')
  assert.equal(cards(w.ws.timBox, 'mission_share').length, 0)
  // Pending is not active: still unreadable.
  assert.equal((await w.timPhone(`/missions/${mission.id}`)).status, 404)
  assert.equal((await w.timBox(`/grants/${gid}/answer`, post({ decision: 'approve' }))).status, 403)

  const timMirror = (await w.timPhone('/items?label=consent&state=open')).json.items[0]
  assert.equal(timMirror.consent, 'share')
  const tap = await w.timPhone(`/items/${timMirror.id}/comments`, post({ action: 'Accept' }))
  assert.equal(tap.status, 200)
  assert.equal(tap.json.grant.state, 'active')
  await settle()
  assert.ok(w.ws.timPhone.frames.some((f) => f.kind === 'shared' && f.event === 'mission_added' && f.mission_id === mission.id))

  // tim's view: "shared by dan", and nothing that names a conversation,
  // a device or a project.
  const list = (await w.timPhone('/missions?scope=shared')).json.missions
  assert.equal(list.length, 1)
  assert.equal(list[0].id, mission.id)
  assert.deepEqual(list[0].owner.name, 'dan')
  assert.equal(list[0].shared_via, 'grant')
  assert.deepEqual(list[0].grant, { id: gid, level: 'read' })
  assert.equal(list[0].origin_convo_id, '')
  assert.equal(list[0].project_id, null)
  assert.equal(list[0].conversations, 0)
  const detail = (await w.timPhone(`/missions/${mission.id}`)).json
  assert.equal(detail.mission.title, 'Birthday Club launch')
  assert.deepEqual(detail.conversations, [])
  assert.deepEqual(detail.milestones.map((m) => m.title), ['Plan agreed'])
  assert.deepEqual(Object.keys(detail.milestones[0]).sort(), ['body', 'created_at', 'created_by', 'id', 'kind', 'mission_id', 'num', 'title'])
  assert.deepEqual(detail.items.map((i) => i.title), ['Book the hall'], 'the consent mirror on the mission is not listed')
  const shownItem = (await w.timPhone(`/items/${item.id}`)).json
  assert.equal(shownItem.item.shared_via, 'grant')
  assert.equal(shownItem.item.origin_convo_id, '')
  assert.equal(shownItem.item.owner.name, 'dan')
  assert.deepEqual(shownItem.comments.map((c) => [c.body, c.device_id]), [['Called them.', 0]])
  assert.ok((await w.timPhone('/items?scope=shared')).json.items.some((i) => i.id === item.id))
  // tim's agent reads the same view; the lookup resolves dan's number.
  assert.equal((await w.timBox(`/missions/${mission.id}`)).json.mission.shared_via, 'grant')
  assert.equal((await w.timBox(`/lookup?user=dan&num=${mission.num}`)).json.id, mission.id)

  // Transcripts never cross (spec decision 6).
  assert.equal((await w.timPhone('/convo/work/messages?around_seq=1')).status, 404)
  assert.equal((await w.timPhone('/milestones?convo=work')).status, 404)

  // Read-only: every write is refused.
  assert.equal((await w.timPhone(`/missions/${mission.id}`, { method: 'PATCH', body: { title: 'mine now' } })).status, 403)
  assert.equal((await w.timPhone(`/missions/${mission.id}/close`, post({ summary: 'x' }))).status, 403)
  assert.equal((await w.timPhone(`/items/${item.id}/comments`, post({ body: 'hello' }))).status, 403)
  assert.equal((await w.timPhone(`/items/${item.id}/close`, post({ resolution: 'done' }))).status, 403)
  assert.equal((await w.timPhone(`/missions/${mission.id}/shares`, post({ contact: 'dan' }))).status, 404, 'a grantee cannot share it on')

  // Live: each write on dan's side reaches tim's phone, never tim's box.
  w.ws.timPhone.frames.length = 0
  await w.danBox('/milestones', post({ convo_id: 'work', kind: 'progress', title: 'Hall booked' }))
  await w.danBox(`/items/${item.id}/comments`, post({ body: 'Deposit paid.' }))
  await w.danBox(`/missions/${mission.id}`, { method: 'PATCH', body: { status: 'On track.', convo_id: 'work' } })
  await settle()
  const live = w.ws.timPhone.frames.filter((f) => f.kind === 'shared' && f.event === 'mission_changed')
  assert.deepEqual(live.map((f) => f.what), ['milestone', 'item', 'mission'])
  assert.deepEqual(live[0].owner, { user_id: w.dan.id, name: 'dan' })
  assert.equal(w.ws.timBox.frames.filter((f) => f.kind === 'shared').length, 0)
  const after = (await w.timPhone(`/missions/${mission.id}`)).json
  assert.deepEqual(after.milestones.map((m) => m.title), ['Hall booked', 'Plan agreed'])
  assert.equal(after.mission.status, 'On track.')

  // Sharing again is not an error.
  const twice = await w.danPhone(`/missions/${mission.id}/shares`, post({ contact: 'tim' }))
  assert.equal(twice.status, 200)
  assert.equal(twice.json.existing, true)
  assert.equal((await w.danPhone(`/missions/${mission.id}/shares`)).json.grants.length, 1)
  assert.deepEqual((await w.timPhone('/grants?direction=in')).json.grants.map((g) => [g.id, g.direction, g.state]), [[gid, 'in', 'active']])

  assert.deepEqual(audits(w.ws.danPhone), ['grant.offered', 'grant.accepted'])
})

test('either side revokes, and the mission is gone at once', async (t) => {
  const w = await world(t)
  const mission = await makeMission(w)
  const { danContact } = await makeContacts(w)
  const share = async () => {
    const r = await w.danPhone(`/missions/${mission.id}/shares`, post({ contact: 'tim' }))
    assert.equal(r.status, 201, 'a client share goes straight to the grantee')
    assert.equal((await w.timPhone(`/grants/${r.json.grant.id}/answer`, post({ decision: 'approve' }))).status, 200)
    assert.equal((await w.timPhone(`/missions/${mission.id}`)).status, 200)
    return r.json.grant.id
  }

  // The owner revokes — from an agent, which may reduce access.
  let gid = await share()
  w.ws.timPhone.frames.length = 0
  const rev = await w.danBox(`/grants/${gid}`, { method: 'DELETE' })
  assert.equal(rev.status, 200)
  assert.equal(rev.json.grant.state, 'revoked')
  assert.equal(rev.json.grant.revoked_by, 'owner')
  assert.equal((await w.timPhone(`/missions/${mission.id}`)).status, 404)
  assert.deepEqual((await w.timPhone('/missions?scope=shared')).json.missions, [])
  await settle()
  assert.ok(w.ws.timPhone.frames.some((f) => f.kind === 'shared' && f.event === 'mission_removed' && f.mission_id === mission.id))
  assert.ok(audits(w.ws.timPhone).includes('grant.revoked'))
  assert.equal((await w.danBox(`/grants/${gid}`, { method: 'DELETE' })).json.blocked_by, 'not_active')

  // The grantee leaves.
  gid = await share()
  const left = await w.timPhone(`/grants/${gid}`, { method: 'DELETE' })
  assert.equal(left.json.grant.revoked_by, 'grantee')
  assert.equal((await w.timPhone(`/missions/${mission.id}`)).status, 404)

  // Removing the contact revokes every grant between the two.
  gid = await share()
  assert.equal((await w.danPhone(`/contacts/${danContact}`, { method: 'DELETE' })).status, 200)
  assert.equal((await w.timPhone(`/missions/${mission.id}`)).status, 404)
  const ended = (await w.danPhone('/grants?direction=out&state=revoked')).json.grants.find((g) => g.id === gid)
  assert.equal(ended.revoked_by, 'contact_removed')
  assert.equal((await w.danPhone(`/missions/${mission.id}/shares`, post({ contact: 'tim' }))).json.blocked_by, 'not_contact')
  const trail = (await w.danPhone(`/contacts/${danContact}/activity`)).json.events.map((e) => e.event)
  assert.equal(trail[0], 'grant.revoked')
  assert.ok(trail.includes('contact.removed'))
})

test('the People conversation belongs to no agent', async (t) => {
  const w = await world(t)
  await w.danPhone('/contacts', post({ user: 'tim' }))
  const people = peopleConvoId(w.s.db, w.tim.id)
  // Listed for tim's phone, marked as the journal's own; not for his box.
  const phoneSnap = (await w.timPhone('/snapshot')).json.conversations.find((c) => c.id === people)
  assert.equal(phoneSnap.system, 'people')
  assert.equal(phoneSnap.title, 'People')
  assert.ok(!(await w.timBox('/snapshot')).json.conversations.some((c) => c.id === people))
  assert.ok(!(await w.timBox('/roster')).json.conversations.some((c) => c.id === people))
  // An agent can neither adopt it nor publish into it.
  w.ws.timBox.frames.length = 0
  w.ws.timBox.send({ op: 'convo_upsert', convo_id: people, title: 'mine' })
  w.ws.timBox.send({ op: 'publish', convo_id: people, type: 'text', payload: { body: 'hi' }, local_id: 'x1' })
  await settle()
  assert.equal(w.ws.timBox.frames.filter((f) => f.op === 'error').length, 2)
  assert.equal(w.s.db.prepare('SELECT title, agent_device_id FROM conversations WHERE id=?').get(people).agent_device_id, null)
  assert.equal((await w.timBox('/items', post({ convo_id: people, kind: 'task', title: 'x' }))).status, 404)
  // And an agent cannot forge either card anywhere.
  for (const kind of ['contact_request', 'mission_share']) {
    w.ws.timBox.frames.length = 0
    w.ws.timBox.send({ op: 'publish', convo_id: 'timwork', type: 'permission_request', payload: { kind }, local_id: `f-${kind}` })
    await settle()
    assert.equal(w.ws.timBox.frames.filter((f) => f.op === 'error').length, 1, `${kind} is server-minted only`)
  }
  // A fresh socket's replay hands the agent none of it.
  // A replay from the start hands a client its People conversation, and a
  // box none of it.
  const second = (await w.s.http('/login', { method: 'POST', body: { username: 'tim', password: 'pw', device_name: 'tim-second' } })).json.token
  const freshPhone = await makeWsClient(w.s.base, { token: second, cursor: 0 })
  const freshBox = await makeWsClient(w.s.base, { token: createAgent(w.s.db, w.tim.id, 'tim-box-2').token, cursor: 0 })
  t.after(() => { freshPhone.close(); freshBox.close() })
  for (const c of [freshPhone, freshBox]) await c.waitFor((f) => f.op === 'hello_ok')
  await settle()
  assert.ok(freshPhone.journal().some((f) => f.convo_id === people))
  assert.ok(!freshBox.journal().some((f) => f.convo_id === people))
})
