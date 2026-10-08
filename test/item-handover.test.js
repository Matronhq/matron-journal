import test from 'node:test'
import assert from 'node:assert/strict'
import { startTestServer } from './helpers.js'
import { createUser, createAgent } from '../src/auth.js'
import { upsertConversation } from '../src/journal.js'
import { setDeviceConsentUserOnly, pinDevicePrivate } from '../src/db.js'
import { setCoordinatorConvoId } from '../src/coordinator.js'
import { sweepExpiredHandovers } from '../src/item-handover-http.js'
import { HANDOVER_TTL_MS } from '../src/item-handover.js'

// Fleet: ada's app ('laptop'); box-a (convo a1); box-b (convo b1); a third box
// (box-c, convo d1); the Coordinator (box-k, convo k1); zed's box and convo
// for the cross-user cases.
async function fleet(t) {
  const wakes = []
  const s = await startTestServer({ waker: { enabled: true, wake: (name) => wakes.push(name) } })
  t.after(() => s.close())
  const ada = await createUser(s.db, 'ada', 'pw')
  const zed = await createUser(s.db, 'zed', 'pw')
  const boxA = createAgent(s.db, ada.id, 'box-a')
  const boxB = createAgent(s.db, ada.id, 'box-b')
  const dev = createAgent(s.db, ada.id, 'box-c')
  const coord = createAgent(s.db, ada.id, 'box-k')
  const zedBox = createAgent(s.db, zed.id, 'zed-box')
  upsertConversation(s.db, { id: 'a1', ownerUserId: ada.id, title: 'Alpha', agentDeviceId: boxA.deviceId })
  upsertConversation(s.db, { id: 'b1', ownerUserId: ada.id, title: 'Beta', agentDeviceId: boxB.deviceId })
  upsertConversation(s.db, { id: 'd1', ownerUserId: ada.id, title: 'Gamma', agentDeviceId: dev.deviceId })
  upsertConversation(s.db, { id: 'k1', ownerUserId: ada.id, title: 'Coordinator', agentDeviceId: coord.deviceId })
  upsertConversation(s.db, { id: 'p1', ownerUserId: zed.id, title: 'Zed', agentDeviceId: zedBox.deviceId })
  setCoordinatorConvoId(s.db, ada.id, 'k1')
  const login = await s.http('/login', { method: 'POST', body: { username: 'ada', password: 'pw', device_name: 'laptop' } })
  return { s, ada, boxA, boxB, dev, coord, zedBox, app: login.json.token, wakes }
}

const post = (s, token, path, body = {}) => s.http(path, { method: 'POST', token, body })
const mkItem = async (s, token, convo = 'd1') => (await post(s, token, '/items', { kind: 'question', title: 'Which auth?', convo_id: convo })).json.item
const markers = (s, convo) => s.db.prepare("SELECT sender, payload FROM events WHERE type='item' AND convo_id=? ORDER BY seq").all(convo)
  .map((e) => ({ sender: e.sender, ...JSON.parse(e.payload) }))
const lastHandover = (s, convo) => markers(s, convo).filter((m) => m.handover).at(-1)
const thread = async (s, token, num) => (await s.http(`/items/${num}`, { token })).json

test('offer → accept moves the owner; the user\'s next reply goes to the new owner', async (t) => {
  const { s, dev, boxB, app, wakes } = await fleet(t)
  const item = await mkItem(s, dev.token)
  const offer = await post(s, dev.token, `/items/${item.num}/handover`, { to_convo_id: 'b1', note: 'over to you', as_convo_id: 'd1' })
  assert.equal(offer.status, 201)
  assert.equal(offer.json.handover.state, 'offered')
  assert.equal(offer.json.handover.offered_by, 'owner')
  assert.equal(offer.json.item.handover.to_convo_id, 'b1')
  assert.equal(offer.json.item.handover.to_convo_title, 'Beta')
  assert.equal(offer.json.item.origin_convo_id, 'd1', 'nothing moves until accepted')
  // The target hears it as a journal-sent marker, and its box is woken.
  const m = lastHandover(s, 'b1')
  assert.equal(m.sender, 'journal'); assert.equal(m.action, 'updated')
  assert.equal(m.handover.stage, 'offered'); assert.equal(m.handover.note, 'over to you')
  assert.equal(m.handover.from_label, 'Gamma (box-c)'); assert.equal(m.handover.to_label, 'Beta (box-b)')
  assert.ok(wakes.includes('box-b'))
  // The owner offered it itself: no marker back to it.
  assert.equal(lastHandover(s, 'd1'), undefined)

  // Before acceptance a reply still goes to the old owner.
  await post(s, app, `/items/${item.num}/comments`, { body: 'still yours' })
  assert.equal(markers(s, 'd1').at(-1).comment.body, 'still yours')

  // Only the target may accept.
  assert.equal((await post(s, dev.token, `/items/${item.num}/handover/accept`, { as_convo_id: 'd1' })).status, 403)
  assert.equal((await post(s, app, `/items/${item.num}/handover/accept`)).status, 403)
  const acc = await post(s, boxB.token, `/items/${item.num}/handover/accept`, { as_convo_id: 'b1' })
  assert.equal(acc.status, 200)
  assert.equal(acc.json.item.origin_convo_id, 'b1')
  assert.equal(acc.json.item.origin_device_id, boxB.deviceId)
  assert.equal(acc.json.item.filed_convo_id, 'd1')
  assert.equal(acc.json.item.origin_convo_title, 'Beta')
  assert.equal(acc.json.item.handover, null)
  assert.equal(lastHandover(s, 'd1').handover.stage, 'accepted')
  assert.equal(lastHandover(s, 'b1').handover.stage, 'accepted')

  // Now the user's reply is a marker on the new owner's conversation.
  await post(s, app, `/items/${item.num}/comments`, { body: 'over to you' })
  const reply = markers(s, 'b1').at(-1)
  assert.equal(reply.sender, 'user:ada'); assert.equal(reply.action, 'commented'); assert.equal(reply.comment.body, 'over to you')
  assert.notEqual(markers(s, 'd1').at(-1).comment?.body, 'over to you')

  // The history is intact, with the handover lines written by the journal.
  const { comments } = await thread(s, app, item.num)
  const lines = comments.filter((c) => c.meta?.handover)
  assert.deepEqual(lines.map((c) => c.meta.handover.stage), ['offered', 'accepted'])
  assert.ok(lines.every((c) => c.author === 'agent' && c.device_id === 0))
  assert.match(lines[1].body, /Handed over.*Gamma \(box-c\).*Beta \(box-b\)/)
  assert.ok(comments.some((c) => c.body === 'still yours'))

  // item_list for "this conversation" follows the owner.
  const listS = await s.http('/items?convo=b1', { token: boxB.token })
  assert.deepEqual(listS.json.items.map((i) => i.num), [item.num])
  const listD = await s.http('/items?convo=d1', { token: dev.token })
  assert.deepEqual(listD.json.items.map((i) => i.num), [])
})

test('decline and withdraw leave the owner where it was', async (t) => {
  const { s, dev, boxB, coord } = await fleet(t)
  const item = await mkItem(s, dev.token)
  await post(s, dev.token, `/items/${item.num}/handover`, { to_convo_id: 'b1', as_convo_id: 'd1' })
  const dec = await post(s, boxB.token, `/items/${item.num}/handover/decline`, { reason: 'not mine', as_convo_id: 'b1' })
  assert.equal(dec.status, 200); assert.equal(dec.json.handover.state, 'declined')
  assert.equal(dec.json.item.origin_convo_id, 'd1')
  assert.equal(lastHandover(s, 'd1').handover.stage, 'declined')
  assert.equal(lastHandover(s, 'd1').handover.reason, 'not mine')
  assert.equal((await post(s, boxB.token, `/items/${item.num}/handover/accept`, { as_convo_id: 'b1' })).status, 409)

  // The Coordinator offers on the user's behalf; the owner hears of it.
  const off = await post(s, coord.token, `/items/${item.num}/handover`, { to_convo_id: 'b1', as_convo_id: 'k1' })
  assert.equal(off.status, 201); assert.equal(off.json.handover.offered_by, 'coordinator')
  assert.equal(lastHandover(s, 'd1').handover.stage, 'offered')
  // A second offer replaces the first, and the first target is told.
  const again = await post(s, dev.token, `/items/${item.num}/handover`, { to_convo_id: 'k1', as_convo_id: 'd1' })
  assert.equal(again.status, 201)
  assert.equal(lastHandover(s, 'b1').handover.stage, 'withdrawn')
  assert.equal((await post(s, boxB.token, `/items/${item.num}/handover/accept`, { as_convo_id: 'b1' })).status, 403, 'not the target any more')
  const wd = await post(s, dev.token, `/items/${item.num}/handover/withdraw`, { as_convo_id: 'd1' })
  assert.equal(wd.status, 200); assert.equal(wd.json.handover.state, 'withdrawn')
  assert.equal(lastHandover(s, 'k1').handover.stage, 'withdrawn')
  assert.equal((await post(s, dev.token, `/items/${item.num}/handover/withdraw`, { as_convo_id: 'd1' })).status, 409)
})

test('who may offer, and what can be offered where', async (t) => {
  const { s, dev, boxB, zedBox, app } = await fleet(t)
  const item = await mkItem(s, dev.token)
  // Another session that neither owns it nor is the Coordinator.
  assert.equal((await post(s, boxB.token, `/items/${item.num}/handover`, { to_convo_id: 'b1', as_convo_id: 'b1' })).status, 403)
  // Another user's box cannot even see it.
  assert.equal((await post(s, zedBox.token, `/items/${item.num}/handover`, { to_convo_id: 'p1', as_convo_id: 'p1' })).status, 404)
  // Bad targets: another user's conversation, a missing one, the owner itself.
  assert.equal((await post(s, dev.token, `/items/${item.num}/handover`, { to_convo_id: 'p1', as_convo_id: 'd1' })).status, 404)
  assert.equal((await post(s, dev.token, `/items/${item.num}/handover`, { to_convo_id: 'nope', as_convo_id: 'd1' })).status, 404)
  assert.equal((await post(s, dev.token, `/items/${item.num}/handover`, { to_convo_id: 'd1', as_convo_id: 'd1' })).status, 409)
  assert.equal((await post(s, dev.token, `/items/${item.num}/handover`, { as_convo_id: 'd1' })).status, 400)
  // The user may offer from an app.
  const byUser = await post(s, app, `/items/${item.num}/handover`, { to_convo_id: 'b1' })
  assert.equal(byUser.status, 201); assert.equal(byUser.json.handover.offered_by, 'user')
  // A closed item is not offered.
  const other = await mkItem(s, dev.token)
  await post(s, dev.token, `/items/${other.num}/close`, { resolution: 'answered' })
  assert.equal((await post(s, dev.token, `/items/${other.num}/handover`, { to_convo_id: 'b1', as_convo_id: 'd1' })).status, 409)
})

test('private boxes: a handover never crosses the privacy line', async (t) => {
  const { s, dev, boxB } = await fleet(t)
  pinDevicePrivate(s.db, boxB.deviceId, true)
  const item = await mkItem(s, dev.token)
  const r = await post(s, dev.token, `/items/${item.num}/handover`, { to_convo_id: 'b1', as_convo_id: 'd1' })
  assert.equal(r.status, 409); assert.equal(r.json.error, 'privacy_mismatch')
})

test('a user-only box: the user\'s tap on the item lets the offer through, the Coordinator\'s cannot', async (t) => {
  const { s, boxA, boxB, coord, app, wakes } = await fleet(t)
  setDeviceConsentUserOnly(s.db, boxA.deviceId, true)
  const item = await mkItem(s, boxA.token, 'a1')
  const off = await post(s, coord.token, `/items/${item.num}/handover`, { to_convo_id: 'b1', note: 'over to you', as_convo_id: 'k1' })
  assert.equal(off.status, 201); assert.equal(off.json.handover.state, 'awaiting_user')
  assert.equal(off.json.item.awaiting, 'user')
  // Nothing reaches the target yet.
  assert.equal(lastHandover(s, 'b1'), undefined)
  assert.ok(!wakes.includes('box-b'))
  assert.equal((await post(s, boxB.token, `/items/${item.num}/handover/accept`, { as_convo_id: 'b1' })).status, 409)
  // The question sits in the item's thread with two buttons, and pushes like any "needs you".
  const { comments } = await thread(s, app, item.num)
  const q = comments.find((c) => c.meta?.role === 'handover_approval')
  assert.deepEqual(q.actions, ['Hand over', 'Keep it here'])
  const qm = markers(s, 'a1').at(-1)
  assert.equal(qm.action, 'commented'); assert.equal(qm.by, 'agent'); assert.equal(qm.awaiting, 'user')
  // An agent cannot tap it.
  assert.equal((await post(s, coord.token, `/items/${item.num}/comments`, { action: 'Hand over', reply_to: q.id })).status, 403)
  // The user taps Hand over: the tap is recorded, the owner's session is not
  // handed a "ada tapped" turn, and the offer goes on to the target.
  const tap = await post(s, app, `/items/${item.num}/comments`, { action: 'Hand over', reply_to: q.id })
  assert.equal(tap.status, 201)
  assert.ok(!markers(s, 'a1').some((m) => m.action === 'commented' && m.comment?.action === 'Hand over'))
  assert.equal(lastHandover(s, 'b1').handover.stage, 'offered')
  assert.ok(wakes.includes('box-b'))
  const after = await thread(s, app, item.num)
  assert.equal(after.comments.find((c) => c.id === q.id).chosen_action, 'Hand over')
  // A second tap on the settled question is refused.
  assert.equal((await post(s, app, `/items/${item.num}/comments`, { action: 'Keep it here', reply_to: q.id })).status, 409)
  const acc = await post(s, boxB.token, `/items/${item.num}/handover/accept`, { as_convo_id: 'b1' })
  assert.equal(acc.status, 200); assert.equal(acc.json.item.origin_convo_id, 'b1')
})

test('a user-only box: Keep it here settles it, and an offer the user makes needs no tap', async (t) => {
  const { s, boxA, boxB, app } = await fleet(t)
  setDeviceConsentUserOnly(s.db, boxB.deviceId, true)
  const item = await mkItem(s, boxA.token, 'a1')
  await post(s, boxA.token, `/items/${item.num}/handover`, { to_convo_id: 'b1', as_convo_id: 'a1' })
  const q = (await thread(s, app, item.num)).comments.find((c) => c.meta?.role === 'handover_approval')
  const keep = await post(s, app, `/items/${item.num}/comments`, { action: 'Keep it here', reply_to: q.id })
  assert.equal(keep.status, 201)
  assert.equal(lastHandover(s, 'a1').handover.stage, 'refused')
  assert.equal(lastHandover(s, 'b1'), undefined)
  assert.equal(keep.json.item.handover, null)

  const byUser = await post(s, app, `/items/${item.num}/handover`, { to_convo_id: 'b1' })
  assert.equal(byUser.json.handover.state, 'offered')
})

test('offers expire after 24 h and both sides are told', async (t) => {
  const { s, dev, boxB } = await fleet(t)
  const item = await mkItem(s, dev.token)
  const off = await post(s, dev.token, `/items/${item.num}/handover`, { to_convo_id: 'b1', as_convo_id: 'd1' })
  sweepExpiredHandovers({ db: s.db, hub: s.hub, waker: null }, off.json.handover.created_at + HANDOVER_TTL_MS - 1)
  assert.equal(lastHandover(s, 'b1').handover.stage, 'offered')
  sweepExpiredHandovers({ db: s.db, hub: s.hub, waker: null }, off.json.handover.created_at + HANDOVER_TTL_MS)
  assert.equal(lastHandover(s, 'b1').handover.stage, 'expired')
  assert.equal(lastHandover(s, 'd1').handover.stage, 'expired')
  assert.equal((await post(s, boxB.token, `/items/${item.num}/handover/accept`, { as_convo_id: 'b1' })).status, 409)
})

// Review follow-ups: the from side is the conversation's own box, not the
// device that filed the item; the caller's session is named and checked; a
// parked offer that settles any way gives `awaiting` back; shared readers
// never see handover lines or fields.

test('an item the user filed into a user-only box\'s conversation still needs the user\'s tap', async (t) => {
  const { s, boxA, boxB, app } = await fleet(t)
  setDeviceConsentUserOnly(s.db, boxA.deviceId, true)
  const item = await mkItem(s, app, 'a1')
  const off = await post(s, boxA.token, `/items/${item.num}/handover`, { to_convo_id: 'b1', as_convo_id: 'a1' })
  assert.equal(off.status, 201); assert.equal(off.json.handover.state, 'awaiting_user')
  assert.equal(off.json.handover.from_device_id, boxA.deviceId)
})

test('an item the user filed into a private box\'s conversation cannot cross to an ordinary one', async (t) => {
  const { s, boxA, app } = await fleet(t)
  pinDevicePrivate(s.db, boxA.deviceId, true)
  const item = await mkItem(s, app, 'a1')
  const r = await post(s, app, `/items/${item.num}/handover`, { to_convo_id: 'd1' })
  assert.equal(r.status, 409); assert.equal(r.json.error, 'privacy_mismatch')
})

test('the caller names its session: another session on the target\'s box cannot accept, nor on the owner\'s box offer', async (t) => {
  const { s, dev, boxB, ada } = await fleet(t)
  upsertConversation(s.db, { id: 'b2', ownerUserId: ada.id, title: 'Other', agentDeviceId: boxB.deviceId })
  upsertConversation(s.db, { id: 'd2', ownerUserId: ada.id, title: 'Other gamma', agentDeviceId: dev.deviceId })
  const item = await mkItem(s, dev.token)
  // A session must say which conversation it is.
  assert.equal((await post(s, dev.token, `/items/${item.num}/handover`, { to_convo_id: 'b1' })).status, 400)
  // Another session on the owner's box is not the owner.
  assert.equal((await post(s, dev.token, `/items/${item.num}/handover`, { to_convo_id: 'b1', as_convo_id: 'd2' })).status, 403)
  // Claiming a conversation on another box gets nowhere either.
  assert.equal((await post(s, dev.token, `/items/${item.num}/handover`, { to_convo_id: 'b1', as_convo_id: 'b1' })).status, 403)
  assert.equal((await post(s, dev.token, `/items/${item.num}/handover`, { to_convo_id: 'b1', as_convo_id: 'd1' })).status, 201)
  assert.equal((await post(s, boxB.token, `/items/${item.num}/handover/accept`, { as_convo_id: 'b2' })).status, 403)
  assert.equal((await post(s, boxB.token, `/items/${item.num}/handover/decline`, { as_convo_id: 'b2' })).status, 403)
  assert.equal((await post(s, boxB.token, `/items/${item.num}/handover/accept`, { as_convo_id: 'b1' })).status, 200)
})

test('a parked offer settled without the user\'s tap gives awaiting back as it was', async (t) => {
  const { s, boxA, boxB, app } = await fleet(t)
  setDeviceConsentUserOnly(s.db, boxA.deviceId, true)
  const task = (await post(s, boxA.token, '/items', { kind: 'task', title: 'Chase', convo_id: 'a1' })).json.item
  assert.equal(task.awaiting, 'agent')
  const off = await post(s, boxA.token, `/items/${task.num}/handover`, { to_convo_id: 'b1', as_convo_id: 'a1' })
  assert.equal(off.json.item.awaiting, 'user')
  const wd = await post(s, boxA.token, `/items/${task.num}/handover/withdraw`, { as_convo_id: 'a1' })
  assert.equal(wd.json.item.awaiting, 'agent')
  // A question that was waiting on the user before the offer still is after the tap.
  const q = await mkItem(s, boxA.token, 'a1')
  await post(s, boxA.token, `/items/${q.num}/handover`, { to_convo_id: 'b1', as_convo_id: 'a1' })
  const ask = (await thread(s, app, q.num)).comments.find((c) => c.meta?.role === 'handover_approval')
  const tap = await post(s, app, `/items/${q.num}/comments`, { action: 'Hand over', reply_to: ask.id })
  assert.equal(tap.json.item.awaiting, 'user')
  // Expiry too.
  const q2 = (await post(s, boxA.token, '/items', { kind: 'task', title: 'Later', convo_id: 'a1' })).json.item
  const off2 = await post(s, boxA.token, `/items/${q2.num}/handover`, { to_convo_id: 'b1', as_convo_id: 'a1' })
  sweepExpiredHandovers({ db: s.db, hub: s.hub, waker: null }, off2.json.handover.created_at + HANDOVER_TTL_MS)
  assert.equal((await thread(s, app, q2.num)).item.awaiting, 'agent')
  void boxB
})

test('an expired offer cannot be accepted before the sweep runs', async (t) => {
  const { s, dev, boxB } = await fleet(t)
  const item = await mkItem(s, dev.token)
  await post(s, dev.token, `/items/${item.num}/handover`, { to_convo_id: 'b1', as_convo_id: 'd1' })
  s.db.prepare('UPDATE item_handovers SET expires_at=?').run(Date.now() - 1)
  assert.equal((await post(s, boxB.token, `/items/${item.num}/handover/accept`, { as_convo_id: 'b1' })).status, 409)
})

test('closing an item withdraws its pending offer, and the target is told', async (t) => {
  const { s, dev, boxB } = await fleet(t)
  const item = await mkItem(s, dev.token)
  await post(s, dev.token, `/items/${item.num}/handover`, { to_convo_id: 'b1', as_convo_id: 'd1' })
  await post(s, dev.token, `/items/${item.num}/close`, { resolution: 'answered' })
  const m = lastHandover(s, 'b1')
  assert.equal(m.handover.stage, 'withdrawn'); assert.equal(m.handover.by, 'closed')
  assert.equal(lastHandover(s, 'd1').handover.by, 'closed')
  assert.equal((await post(s, boxB.token, `/items/${item.num}/handover/accept`, { as_convo_id: 'b1' })).status, 409)
})

test('a tap on a parked offer that has lapsed stores nothing', async (t) => {
  const { s, boxA, app } = await fleet(t)
  setDeviceConsentUserOnly(s.db, boxA.deviceId, true)
  const item = await mkItem(s, boxA.token, 'a1')
  await post(s, boxA.token, `/items/${item.num}/handover`, { to_convo_id: 'b1', as_convo_id: 'a1' })
  const q = (await thread(s, app, item.num)).comments.find((c) => c.meta?.role === 'handover_approval')
  s.db.prepare('UPDATE item_handovers SET expires_at=?').run(Date.now() - 1)
  const before = (await thread(s, app, item.num)).comments.length
  const tap = await post(s, app, `/items/${item.num}/comments`, { action: 'Hand over', reply_to: q.id })
  assert.equal(tap.status, 409); assert.equal(tap.json.error, 'handover_settled')
  const after = await thread(s, app, item.num)
  assert.equal(after.comments.length, before)
  assert.equal(after.comments.find((c) => c.id === q.id).chosen_action, null)
})

test('the owner hears who withdrew an offer', async (t) => {
  const { s, dev, coord } = await fleet(t)
  const item = await mkItem(s, dev.token)
  await post(s, dev.token, `/items/${item.num}/handover`, { to_convo_id: 'b1', as_convo_id: 'd1' })
  await post(s, coord.token, `/items/${item.num}/handover/withdraw`, { as_convo_id: 'k1' })
  assert.equal(lastHandover(s, 'd1').handover.by, 'coordinator')
})

test('a reply while an offer is parked keeps the awaiting it set', async (t) => {
  const { s, boxA, app } = await fleet(t)
  setDeviceConsentUserOnly(s.db, boxA.deviceId, true)
  const item = (await post(s, boxA.token, '/items', { kind: 'task', title: 'Chase', convo_id: 'a1' })).json.item
  await post(s, boxA.token, `/items/${item.num}/handover`, { to_convo_id: 'b1', as_convo_id: 'a1' })
  // The agent asks the user something new while the offer waits.
  await post(s, boxA.token, `/items/${item.num}/comments`, { body: 'Which one?', actions: ['A', 'B'] })
  const wd = await post(s, boxA.token, `/items/${item.num}/handover/withdraw`, { as_convo_id: 'a1' })
  assert.equal(wd.json.item.awaiting, 'user', 'the new question still waits on the user')
})

test('a notice closed by its Seen tap withdraws its pending offer too', async (t) => {
  const { s, dev, app } = await fleet(t)
  const notice = (await post(s, dev.token, '/items', { kind: 'notice', title: 'FYI', convo_id: 'd1' })).json.item
  await post(s, dev.token, `/items/${notice.num}/handover`, { to_convo_id: 'b1', as_convo_id: 'd1' })
  await post(s, app, `/items/${notice.num}/comments`, { action: 'Seen' })
  assert.equal(lastHandover(s, 'b1').handover.stage, 'withdrawn')
  assert.equal((await thread(s, app, notice.num)).item.handover, null)
})

test('a plain agent note while an offer is parked does not stop awaiting coming back', async (t) => {
  const { s, boxA } = await fleet(t)
  setDeviceConsentUserOnly(s.db, boxA.deviceId, true)
  const item = (await post(s, boxA.token, '/items', { kind: 'task', title: 'Chase', convo_id: 'a1' })).json.item
  await post(s, boxA.token, `/items/${item.num}/handover`, { to_convo_id: 'b1', as_convo_id: 'a1' })
  await post(s, boxA.token, `/items/${item.num}/comments`, { body: 'progress note' })
  const wd = await post(s, boxA.token, `/items/${item.num}/handover/withdraw`, { as_convo_id: 'a1' })
  assert.equal(wd.json.item.awaiting, 'agent')
})

test('the close reply and marker carry no offer; a Coordinator that offered hears every outcome', async (t) => {
  const { s, dev, boxB, coord } = await fleet(t)
  const item = await mkItem(s, dev.token)
  await post(s, dev.token, `/items/${item.num}/handover`, { to_convo_id: 'b1', as_convo_id: 'd1' })
  const closed = await post(s, dev.token, `/items/${item.num}/close`, { resolution: 'answered' })
  assert.equal(closed.json.item.handover, null)
  assert.equal(markers(s, 'd1').filter((m) => m.action === 'closed').at(-1).handover, undefined)

  const other = await mkItem(s, dev.token)
  await post(s, coord.token, `/items/${other.num}/handover`, { to_convo_id: 'b1', as_convo_id: 'k1' })
  assert.equal(lastHandover(s, 'k1'), undefined, 'the offerer is not told of its own offer')
  await post(s, boxB.token, `/items/${other.num}/handover/decline`, { as_convo_id: 'b1', reason: 'not mine' })
  const m = lastHandover(s, 'k1')
  assert.equal(m.handover.stage, 'declined'); assert.equal(m.handover.offered_by_convo_id, 'k1')
})

test('a new offer that replaces the Coordinator\'s tells the Coordinator', async (t) => {
  const { s, dev, coord } = await fleet(t)
  const item = await mkItem(s, dev.token)
  await post(s, coord.token, `/items/${item.num}/handover`, { to_convo_id: 'b1', as_convo_id: 'k1' })
  await post(s, dev.token, `/items/${item.num}/handover`, { to_convo_id: 'k1', as_convo_id: 'd1' })
  // k1 is now the target of the new offer, so the old offer's withdrawal
  // reaches it as the offerer of the replaced one.
  const ms = markers(s, 'k1').filter((m) => m.handover)
  assert.ok(ms.some((m) => m.handover.stage === 'withdrawn' && m.handover.by === 'owner' && m.handover.reason === 'replaced by a new offer'))
})
