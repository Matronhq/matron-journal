import test from 'node:test'
import assert from 'node:assert/strict'
import { getSpawn } from '../src/spawns.js'
import { revokeOwnedDevice } from '../src/auth.js'
import { reconcileConsentItems } from '../src/consent-items.js'
import { fleet, parkSpawn, parkInviteAsk, answer, settle } from './consent-fleet.js'

// A consent item is open exactly while its ask is 'awaiting_user'. The bug
// this file pins: an approved spawn left that state at the answer, but its
// item was closed only at the outcome — minutes later when the target box
// had to be woken first. Meanwhile the item sat in the user's Decisions list
// and its Approve could only answer 409 ("no longer waiting").

const isItemMarker = (f) => f.kind === 'journal' && f.type === 'item'
const itemOf = (s, spawnId) => s.db.prepare('SELECT * FROM items WHERE id=?').get(getSpawn(s.db, spawnId).item_id)
const reread = (s, id) => s.db.prepare('SELECT * FROM items WHERE id=?').get(id)
const thread = (s, itemId) => s.db.prepare('SELECT kind, body, author, device_id FROM item_comments WHERE item_id=? ORDER BY rowid').all(itemId)
const awaitingUser = async (f) => (await f.s.http('/items?awaiting=user', { token: f.clientToken })).json.items.map((i) => i.id)
const tap = (f, spawnId, decision) => f.s.http('/agent-spawn/answer', { method: 'POST', token: f.clientToken, body: { request_id: spawnId, decision } })

test('the Coordinator approves a spawn whose box has not started the session yet: the item leaves the Decisions list at the answer, not at the outcome', async (t) => {
  const f = await fleet(t)
  const spawnId = await parkSpawn(f)
  const item = itemOf(f.s, spawnId)
  assert.deepEqual(await awaitingUser(f), [item.id])
  // The target never answers `start` until told to: the row sits in
  // 'approved', which is where a box being woken leaves it for minutes.
  const startRpc = f.target.waitFor((x) => x.kind === 'rpc' && x.request?.method === 'start')
  assert.equal((await answer(f, f.coordDev.token, { kind: 'spawn', id: spawnId, decision: 'approve', reason: 'follows the box rules' })).status, 200)
  const req = await startRpc
  assert.equal(getSpawn(f.s.db, spawnId).state, 'approved')

  const during = reread(f.s, item.id)
  assert.equal(during.state, 'closed'); assert.equal(during.resolution, 'decided'); assert.equal(during.awaiting, null)
  assert.deepEqual(await awaitingUser(f), [])
  const closing = thread(f.s, item.id).at(-1)
  assert.equal(closing.kind, 'status'); assert.equal(closing.author, 'agent'); assert.equal(closing.device_id, f.coordDev.deviceId)
  assert.match(closing.body, /^Approved by the Coordinator — follows the box rules\. Starting the session on opal;/)
  // Every connected app hears the close live, and no agent does.
  const marker = await f.client.waitFor((x) => isItemMarker(x) && x.payload.action === 'closed' && x.payload.item_id === item.id)
  assert.equal(marker.payload.consent, 'spawn'); assert.equal(marker.payload.resolution, 'decided'); assert.equal(marker.payload.awaiting, null)
  // The tap that used to be offered: still a 409, but nothing lists the item any more.
  assert.equal((await tap(f, spawnId, 'approve')).status, 409)

  f.target.send({ op: 'agent_response', request_id: req.request.request_id, to_device_id: 0, ok: true, result: { convo_id: 'child' } })
  const out = await f.asker.waitFor((x) => x.kind === 'spawn' && x.event === 'outcome')
  assert.equal(out.outcome, 'started')
  const after = reread(f.s, item.id)
  assert.equal(after.state, 'closed'); assert.equal(after.resolution, 'decided')
  const followUp = thread(f.s, item.id).at(-1)
  assert.equal(followUp.kind, 'comment'); assert.equal(followUp.author, 'agent'); assert.equal(followUp.body, 'The session started on opal.')
  const noted = await f.client.waitFor((x) => isItemMarker(x) && x.payload.action === 'commented' && x.payload.item_id === item.id)
  assert.equal(noted.payload.consent, 'spawn'); assert.equal(noted.payload.comment.body, 'The session started on opal.')
  await settle()
  for (const agent of [f.asker, f.target, f.coord]) assert.equal(agent.frames.some(isItemMarker), false)
})

test("the user's own Approve closes the item at the tap, attributed to the tapping device; a failed start is added as a note and the item stays closed", async (t) => {
  const f = await fleet(t)
  const spawnId = await parkSpawn(f)
  const item = itemOf(f.s, spawnId)
  const startRpc = f.target.waitFor((x) => x.kind === 'rpc' && x.request?.method === 'start')
  assert.equal((await tap(f, spawnId, 'approve')).status, 200)
  const req = await startRpc
  const during = reread(f.s, item.id)
  assert.equal(during.state, 'closed'); assert.equal(during.resolution, 'decided')
  const closing = thread(f.s, item.id).at(-1)
  assert.equal(closing.author, 'user'); assert.match(closing.body, /^Approved\. Starting the session on opal;/)
  const clientDeviceId = f.s.db.prepare("SELECT id FROM devices WHERE kind='client'").get().id
  assert.equal(closing.device_id, clientDeviceId)

  f.target.send({ op: 'agent_response', request_id: req.request.request_id, to_device_id: 0, ok: false, error: { code: 'workdir_missing' } })
  const out = await f.asker.waitFor((x) => x.kind === 'spawn' && x.event === 'outcome')
  assert.equal(out.outcome, 'failed')
  const after = reread(f.s, item.id)
  assert.equal(after.state, 'closed'); assert.equal(after.resolution, 'decided')
  assert.equal(thread(f.s, item.id).at(-1).body, 'The session could not be started (workdir_missing).')
})

test('an item its approval did not close (a row approved by an older build) is still closed by the outcome, with the whole story', async (t) => {
  const f = await fleet(t)
  const spawnId = await parkSpawn(f)
  const item = itemOf(f.s, spawnId)
  const startRpc = f.target.waitFor((x) => x.kind === 'rpc' && x.request?.method === 'start')
  assert.equal((await tap(f, spawnId, 'approve')).status, 200)
  const req = await startRpc
  // What an older build left behind: the row approved, the item still open.
  f.s.db.prepare("UPDATE items SET state='open', resolution=NULL, closed_at=NULL, awaiting='user' WHERE id=?").run(item.id)
  f.s.db.prepare('DELETE FROM item_comments WHERE item_id=?').run(item.id)
  f.target.send({ op: 'agent_response', request_id: req.request.request_id, to_device_id: 0, ok: true, result: { convo_id: 'child' } })
  await f.asker.waitFor((x) => x.kind === 'spawn' && x.event === 'outcome')
  const after = reread(f.s, item.id)
  assert.equal(after.state, 'closed'); assert.equal(after.resolution, 'decided')
  assert.equal(thread(f.s, item.id).at(-1).body, 'Approved — the session started on opal.')
})

test('reconcile closes the consent items earlier builds left open: an approved row, a started row, a declined row, an answered chat ask, and an item whose ask is gone', async (t) => {
  const f = await fleet(t)
  const reopen = (id) => {
    f.s.db.prepare("UPDATE items SET state='open', resolution=NULL, closed_at=NULL, awaiting='user' WHERE id=?").run(id)
    f.s.db.prepare('DELETE FROM item_comments WHERE item_id=?').run(id)
  }
  // 1. approved by the Coordinator, start still in flight
  const inFlight = await parkSpawn(f, { rid: 'q1' })
  const startRpc = f.target.waitFor((x) => x.kind === 'rpc' && x.request?.method === 'start')
  assert.equal((await answer(f, f.coordDev.token, { kind: 'spawn', id: inFlight, decision: 'approve', reason: 'rules' })).status, 200)
  const startReq = await startRpc
  // 2. declined by the user
  const declined = await parkSpawn(f, { rid: 'q2' })
  assert.equal((await tap(f, declined, 'deny')).status, 200)
  // 3. a chat ask the user approved
  await parkInviteAsk(f)
  const chatItemId = f.s.db.prepare("SELECT item_id FROM convo_agents WHERE convo_id='room' AND agent_device_id=?").get(f.targetDev.deviceId).item_id
  assert.equal((await f.s.http('/agent-chat/answer', { method: 'POST', token: f.clientToken, body: { room_id: 'room', target_device_id: f.targetDev.deviceId, decision: 'approve' } })).status, 200)
  // 4. still waiting — must be left alone
  const waiting = await parkSpawn(f, { rid: 'q3' })
  // 5. an item whose ask row is gone
  const orphaned = await parkSpawn(f, { rid: 'q4' })
  const orphanItem = itemOf(f.s, orphaned)
  f.s.db.prepare('DELETE FROM agent_spawn_requests WHERE id=?').run(orphaned)

  const items = { inFlight: itemOf(f.s, inFlight).id, declined: itemOf(f.s, declined).id, chat: chatItemId, waiting: itemOf(f.s, waiting).id, orphan: orphanItem.id }
  for (const id of [items.inFlight, items.declined, items.chat]) reopen(id)
  assert.equal((await awaitingUser(f)).length, 5)
  f.client.frames.length = 0

  assert.equal(reconcileConsentItems({ db: f.s.db, hub: f.s.hub }), 4)
  assert.deepEqual(await awaitingUser(f), [items.waiting])
  const last = (id) => thread(f.s, id).at(-1)
  assert.match(last(items.inFlight).body, /^Approved by the Coordinator — rules\. Starting the session on opal;/)
  assert.equal(reread(f.s, items.inFlight).resolution, 'decided')
  assert.equal(last(items.declined).body, 'Declined.')
  assert.equal(reread(f.s, items.declined).resolution, 'decided')
  assert.equal(last(items.chat).body, 'Approved — the invitation is on its way.')
  assert.equal(last(items.orphan).body, 'Closed — the request is no longer waiting for an answer.')
  assert.equal(reread(f.s, items.orphan).resolution, 'cancelled')
  // Each close reaches a connected app as a client-only marker.
  await settle()
  const closedMarkers = f.client.frames.filter((x) => isItemMarker(x) && x.payload.action === 'closed')
  assert.deepEqual(closedMarkers.map((m) => m.payload.item_id).sort(), [items.inFlight, items.declined, items.chat, items.orphan].sort())
  assert.ok(closedMarkers.every((m) => typeof m.payload.consent === 'string'))
  // Nothing left to do on a second pass.
  assert.equal(reconcileConsentItems({ db: f.s.db, hub: f.s.hub }), 0)
  // The start still lands on the reconciled item as a note.
  f.target.send({ op: 'agent_response', request_id: startReq.request.request_id, to_device_id: 0, ok: true, result: { convo_id: 'child' } })
  await f.asker.waitFor((x) => x.kind === 'spawn' && x.event === 'outcome' && x.outcome === 'started')
  assert.equal(last(items.inFlight).body, 'The session started on opal.')
  assert.equal(reread(f.s, items.inFlight).state, 'closed')
})

test('the sweep reconciles by itself: revoking the invited box takes its chat ask away and the next tick closes the item', async (t) => {
  const f = await fleet(t, { revocationSweepMs: 100 })
  await parkInviteAsk(f)
  const row = () => f.s.db.prepare("SELECT item_id FROM convo_agents WHERE convo_id='room' AND agent_device_id=?").get(f.targetDev.deviceId)
  const itemId = row().item_id
  assert.deepEqual(await awaitingUser(f), [itemId])
  f.target.close()
  assert.equal(revokeOwnedDevice(f.s.db, f.alice.id, f.targetDev.deviceId), true)
  assert.equal(row(), undefined) // the membership row cascades away with its device; the item does not
  for (let i = 0; i < 40 && reread(f.s, itemId).state === 'open'; i += 1) await settle(50)
  const after = reread(f.s, itemId)
  assert.equal(after.state, 'closed'); assert.equal(after.resolution, 'cancelled')
  assert.equal(thread(f.s, itemId).at(-1).body, 'Closed — the request is no longer waiting for an answer.')
  assert.deepEqual(await awaitingUser(f), [])
})

test('a consent item follows its ask, never a comment: a reply reaches the asking agent but does not reopen a settled item or take a waiting one out of Decisions, and Reopen is refused', async (t) => {
  const f = await fleet(t)
  const comment = (id, body) => f.s.http(`/items/${id}/comments`, { method: 'POST', token: f.clientToken, body: { body } })
  // Waiting: a reply is kept, the item still awaits the user.
  const waiting = await parkSpawn(f, { rid: 'q1' })
  const waitingItem = itemOf(f.s, waiting)
  for (const w of [f.asker, f.target, f.coord, f.client]) w.frames.length = 0
  assert.equal((await comment(waitingItem.id, 'which box is this?')).status, 201)
  const still = reread(f.s, waitingItem.id)
  assert.equal(still.state, 'open'); assert.equal(still.awaiting, 'user')
  // The reply is addressed to the agent that asked, so the asking
  // conversation hears it as an ordinary item marker (the bridge turns it
  // into a turn) — and only that conversation: the Coordinator's and the
  // target's do not.
  const heard = await f.asker.waitFor((x) => isItemMarker(x) && x.payload.action === 'commented' && x.payload.item_id === waitingItem.id)
  assert.equal(heard.convo_id, 'ask'); assert.equal(heard.payload.comment.body, 'which box is this?'); assert.equal(heard.payload.consent, undefined)
  await settle()
  for (const agent of [f.target, f.coord]) assert.equal(agent.frames.some(isItemMarker), false)
  // The item itself is still unreadable to the agent that heard the reply.
  assert.equal((await f.s.http(`/items/${waitingItem.id}`, { token: f.askerDev.token })).status, 404)
  // A hand-close stays the user's alone: no agent hears its marker.
  const other = itemOf(f.s, await parkSpawn(f, { rid: 'q2' }))
  for (const w of [f.asker, f.target, f.coord, f.client]) w.frames.length = 0
  assert.equal((await f.s.http(`/items/${other.id}/close`, { method: 'POST', token: f.clientToken, body: { resolution: 'cancelled' } })).status, 200)
  const closedMarker = await f.client.waitFor((x) => isItemMarker(x) && x.payload.action === 'closed' && x.payload.item_id === other.id)
  assert.equal(closedMarker.payload.consent, 'spawn')
  await settle()
  for (const agent of [f.asker, f.target, f.coord]) assert.equal(agent.frames.some(isItemMarker), false)
  // Settled: a reply is kept, the item stays closed; Reopen is a 409.
  assert.equal((await tap(f, waiting, 'deny')).status, 200)
  assert.equal(reread(f.s, waitingItem.id).state, 'closed')
  const late = await comment(waitingItem.id, 'actually yes')
  assert.equal(late.status, 201); assert.equal(late.json.item.state, 'closed')
  assert.equal(reread(f.s, waitingItem.id).state, 'closed')
  assert.equal((await f.s.http(`/items/${waitingItem.id}/reopen`, { method: 'POST', token: f.clientToken, body: {} })).status, 409)
  assert.equal(reread(f.s, waitingItem.id).state, 'closed')
  // An ordinary item keeps the generic rule: the user's reply reopens it.
  const plain = await f.s.http('/items', { method: 'POST', token: f.askerDev.token, body: { kind: 'question', title: 'plain', convo_id: 'ask' } })
  assert.equal((await f.s.http(`/items/${plain.json.item.id}/close`, { method: 'POST', token: f.askerDev.token, body: { resolution: 'answered' } })).status, 200)
  const reopened = await comment(plain.json.item.id, 'one more thing')
  assert.equal(reopened.json.item.state, 'open'); assert.equal(reopened.json.item.awaiting, 'agent')
})

test("a reply on a chat ask reaches the asker only when the room is the asker's own: an invite's reply goes to the room owner, a join's stays with the user", async (t) => {
  const f = await fleet(t)
  const comment = (id, body) => f.s.http(`/items/${id}/comments`, { method: 'POST', token: f.clientToken, body: { body } })
  const chatItem = (deviceId) => f.s.db.prepare("SELECT item_id FROM convo_agents WHERE convo_id='room' AND agent_device_id=?").get(deviceId).item_id
  // Invite: asker-box owns the room and asks to bring opal in.
  await parkInviteAsk(f)
  const invite = chatItem(f.targetDev.deviceId)
  for (const w of [f.asker, f.target, f.coord]) w.frames.length = 0
  assert.equal((await comment(invite, 'what for?')).status, 201)
  const heard = await f.asker.waitFor((x) => isItemMarker(x) && x.payload.action === 'commented' && x.payload.item_id === invite)
  assert.equal(heard.convo_id, 'room'); assert.equal(heard.payload.consent, undefined)
  // Join: coord-box asks to join asker-box's room. The room's owner must not
  // hear the ask, so the user's reply on it stays client-only.
  f.coord.send({ op: 'agent_join', room_id: 'room', justification: 'I have the fix' })
  await f.coord.waitFor((x) => x.kind === 'invite' && x.event === 'delivered')
  const join = chatItem(f.coordDev.deviceId)
  for (const w of [f.asker, f.target, f.coord, f.client]) w.frames.length = 0
  assert.equal((await comment(join, 'which fix?')).status, 201)
  const mine = await f.client.waitFor((x) => isItemMarker(x) && x.payload.action === 'commented' && x.payload.item_id === join)
  assert.equal(mine.payload.consent, 'chat')
  await settle()
  for (const agent of [f.asker, f.target, f.coord]) assert.equal(agent.frames.some((x) => x.kind === 'journal' && (x.type === 'item' || x.payload?.fallback_for === 'item')), false)
})

test('a voice reply on a spawn consent item delivers its transcript to the asking agent: the pending marker and the follow-up both reach it', async (t) => {
  const waiters = []
  const transcriber = { transcribeFile: () => new Promise((resolve) => waiters.push(resolve)) }
  const f = await fleet(t, { transcriber })
  const spawnId = await parkSpawn(f)
  const item = itemOf(f.s, spawnId)
  f.s.db.prepare('INSERT INTO blobs(id,owner_user_id,content_type,size,sha256,disk_path,created_at) VALUES(?,?,?,?,?,?,?)').run('v1', f.alice.id, 'audio/mp4', 3, 'x', '/media/v1', Date.now())
  for (const w of [f.asker, f.target, f.coord]) w.frames.length = 0
  const r = await f.s.http(`/items/${item.id}/comments`, { method: 'POST', token: f.clientToken, body: { attachments: [{ blob_ref: 'v1', mime: 'audio/mp4', name: 'v1.m4a', size: 3 }] } })
  assert.equal(r.status, 201)
  const pending = await f.asker.waitFor((x) => isItemMarker(x) && x.payload.action === 'commented' && x.payload.item_id === item.id)
  assert.equal(pending.payload.comment.attachments[0].transcript_status, 'pending')
  for (let i = 0; i < 40 && waiters.length === 0; i += 1) await settle(25)
  waiters.shift()('use the other repo')
  const done = await f.asker.waitFor((x) => isItemMarker(x) && x.payload.action === 'updated' && x.payload.transcription === 'done' && x.payload.item_id === item.id)
  assert.equal(done.payload.comment.attachments[0].transcript, 'use the other repo'); assert.equal(done.payload.consent, undefined)
  const still = reread(f.s, item.id)
  assert.equal(still.state, 'open'); assert.equal(still.awaiting, 'user')
})

// The apps hold the chat card in the same room as these markers and settle
// it from them: a card decided on another device, on another box or by the
// Coordinator must stop offering Approve everywhere. So the markers name the
// ask (the consent link's `<room>/<device>`), and the close says how it
// ended and whether the Coordinator decided — never the wording of a note.
test("a chat ask's item markers name the ask, and the close says how it ended and who decided", async (t) => {
  const f = await fleet(t)
  const askId = `room/${f.targetDev.deviceId}`
  await parkInviteAsk(f)
  const created = await f.client.waitFor((x) => isItemMarker(x) && x.payload.action === 'created' && x.payload.consent === 'chat')
  assert.equal(created.convo_id, 'room'); assert.equal(created.payload.consent_ask, askId)
  assert.equal(created.payload.consent_outcome, undefined)
  assert.equal((await f.s.http('/agent-chat/answer', { method: 'POST', token: f.clientToken, body: { room_id: 'room', target_device_id: f.targetDev.deviceId, decision: 'deny' } })).status, 200)
  const closed = await f.client.waitFor((x) => isItemMarker(x) && x.payload.action === 'closed' && x.payload.item_id === created.payload.item_id)
  assert.equal(closed.payload.consent_ask, askId); assert.equal(closed.payload.consent_outcome, 'denied')
  assert.equal(closed.payload.decided_by, undefined)

  // A fresh ask for the same pair, approved by the Coordinator.
  f.client.frames.length = 0
  await parkInviteAsk(f)
  const again = await f.client.waitFor((x) => isItemMarker(x) && x.payload.action === 'created' && x.payload.consent === 'chat')
  assert.notEqual(again.payload.item_id, created.payload.item_id); assert.equal(again.payload.consent_ask, askId)
  assert.equal((await answer(f, f.coordDev.token, { kind: 'chat', id: askId, decision: 'approve', reason: 'follows the box rules' })).status, 200)
  const byCoord = await f.client.waitFor((x) => isItemMarker(x) && x.payload.action === 'closed' && x.payload.item_id === again.payload.item_id)
  assert.equal(byCoord.payload.consent_outcome, 'approved'); assert.equal(byCoord.payload.decided_by, 'coordinator')
  await settle()
  for (const agent of [f.asker, f.target, f.coord]) assert.equal(agent.frames.some(isItemMarker), false)
})
