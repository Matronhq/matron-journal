// step_up and subject on items and comments: the marking an agent puts on a
// question whose tap must be signed with an approval key (the enforcement is
// a later task). An owner with no active key gets an ordinary item.
import test from 'node:test'
import assert from 'node:assert/strict'
import { createAgent } from '../src/auth.js'
import { upsertConversation } from '../src/journal.js'
import { validateItemFields, listSharedComments, listGrantedComments } from '../src/items.js'
import { startWithKey, startApprovalServer, signIn, signAccount, signTap } from './approval-helpers.js'

async function world(t, withKey = true) {
  const base = await (withKey ? startWithKey(t) : startApprovalServer(t))
  const box = createAgent(base.s.db, base.alice.id, 'box-a')
  upsertConversation(base.s.db, { id: 'c1', ownerUserId: base.alice.id, title: 'C1', agentDeviceId: box.deviceId })
  const agent = (p, opts = {}) => base.s.http(p, { token: box.token, ...opts })
  const post = (body) => ({ method: 'POST', body })
  return { ...base, agent, post }
}
const ask = (extra) => ({ convo_id: 'c1', kind: 'question', title: 'Wire it?', actions: ['Approve', 'Deny'], ...extra })
const SUBJECT = { payee: 'Acme', amount: '12.00' }

test('validateItemFields: step_up is a boolean, subject a flat string map needing step_up', () => {
  assert.equal(validateItemFields({ title: 't', step_up: true, subject: SUBJECT }).ok, true)
  assert.deepEqual(validateItemFields({ title: 't', step_up: true, subject: SUBJECT }).value.subject, SUBJECT)
  assert.equal(validateItemFields({ title: 't', step_up: 'yes' }).ok, false)
  const many = Object.fromEntries(Array.from({ length: 13 }, (_, i) => [`k${i}`, 'v']))
  for (const bad of [many, { a: 1 }, { a: 'x'.repeat(201) }, [], 'x', null]) {
    assert.equal(validateItemFields({ title: 't', step_up: true, subject: bad }).error, 'invalid_subject', JSON.stringify(bad))
  }
  assert.equal(validateItemFields({ title: 't', subject: SUBJECT }).error, 'invalid_subject')
  assert.equal(validateItemFields({ title: 't', step_up: false, subject: SUBJECT }).error, 'invalid_subject')
})

test('an item created with step_up and a subject round-trips', async (t) => {
  const w = await world(t)
  const c = await w.agent('/items', w.post(ask({ step_up: true, subject: SUBJECT })))
  assert.equal(c.status, 201, JSON.stringify(c.json))
  assert.equal(c.json.item.step_up, true)
  assert.equal(c.json.step_up_ignored, undefined)
  const got = await w.s.http(`/items/${c.json.item.num}`, { token: w.token })
  assert.equal(got.json.item.step_up, true)
  assert.deepEqual(got.json.item.subject, SUBJECT)
  const plain = await w.agent('/items', w.post(ask()))
  assert.equal(plain.json.item.step_up, false)
  assert.equal(plain.json.item.subject, null)
})

test('step_up with no subject is allowed; subject without step_up and 13 keys are invalid_subject', async (t) => {
  const w = await world(t)
  const bare = await w.agent('/items', w.post(ask({ step_up: true })))
  assert.equal(bare.status, 201)
  assert.equal(bare.json.item.subject, null)
  const noStep = await w.agent('/items', w.post(ask({ subject: SUBJECT })))
  assert.deepEqual([noStep.status, noStep.json.error], [400, 'invalid_subject'])
  const many = Object.fromEntries(Array.from({ length: 13 }, (_, i) => [`k${i}`, 'v']))
  const r = await w.agent('/items', w.post(ask({ step_up: true, subject: many })))
  assert.deepEqual([r.status, r.json.error], [400, 'invalid_subject'])
})

test('a notice cannot be step-up', async (t) => {
  const w = await world(t)
  const r = await w.agent('/items', w.post({ convo_id: 'c1', kind: 'notice', title: 'FYI', step_up: true }))
  assert.deepEqual([r.status, r.json.error], [400, 'invalid_actions'])
})

test('an owner with no active key gets an ordinary item and step_up_ignored', async (t) => {
  const w = await world(t, false)
  const r = await w.agent('/items', w.post(ask({ step_up: true, subject: SUBJECT })))
  assert.equal(r.status, 201)
  assert.equal(r.json.step_up_ignored, true)
  assert.equal(r.json.item.step_up, false)
  assert.equal(r.json.item.subject, null)
  const row = w.s.db.prepare('SELECT step_up, subject FROM items WHERE id=?').get(r.json.item.id)
  assert.deepEqual({ ...row }, { step_up: 0, subject: null })
  const c = await w.agent(`/items/${r.json.item.id}/comments`, w.post({ body: 'again?', actions: ['Yes'], step_up: true }))
  assert.equal(c.status, 201)
  assert.equal(c.json.step_up_ignored, true)
  assert.equal(c.json.comment.step_up, false)
})

test('PATCH changes step_up and subject; step_up:false clears subject', async (t) => {
  const w = await world(t)
  const id = (await w.agent('/items', w.post(ask()))).json.item.id
  const patch = (body) => w.agent(`/items/${id}`, { method: 'PATCH', body })
  assert.equal((await patch({ subject: SUBJECT })).json.error, 'invalid_subject') // not step-up yet
  const on = await patch({ step_up: true, subject: SUBJECT })
  assert.deepEqual([on.json.item.step_up, on.json.item.subject], [true, SUBJECT])
  const re = await patch({ subject: { payee: 'Other' } })
  assert.deepEqual(re.json.item.subject, { payee: 'Other' })
  const off = await patch({ step_up: false })
  assert.deepEqual([off.json.item.step_up, off.json.item.subject], [false, null])
})

test('a comment with actions and step_up round-trips; step_up needs actions', async (t) => {
  const w = await world(t)
  const id = (await w.agent('/items', w.post(ask()))).json.item.id
  const c = await w.agent(`/items/${id}/comments`, w.post({ body: 'Really?', actions: ['Yes', 'No'], step_up: true, subject: SUBJECT }))
  assert.equal(c.status, 201, JSON.stringify(c.json))
  assert.equal(c.json.comment.step_up, true)
  assert.deepEqual(c.json.comment.subject, SUBJECT)
  assert.equal(c.json.comment.approval, null)
  const list = await w.s.http(`/items/${id}`, { token: w.token })
  const mine = list.json.comments.find((x) => x.id === c.json.comment.id)
  assert.equal(mine?.step_up, true)
  const bad = await w.agent(`/items/${id}/comments`, w.post({ body: 'no buttons', step_up: true }))
  assert.deepEqual([bad.status, bad.json.error], [400, 'invalid_actions'])
  const noStep = await w.agent(`/items/${id}/comments`, w.post({ body: 'x', actions: ['A'], subject: SUBJECT }))
  assert.equal(noStep.json.error, 'invalid_subject')
})

test('shared and granted reads do not expose a comment approval', async (t) => {
  const w = await world(t)
  const { db } = w.s
  const item = (await w.agent('/items', w.post(ask()))).json.item
  const c = (await w.agent(`/items/${item.id}/comments`, w.post({ body: 'Really?', actions: ['Yes'], step_up: true }))).json.comment
  db.prepare('UPDATE item_comments SET approval=? WHERE id=?').run(JSON.stringify({ statement: 's', signature: 'g' }), c.id)
  const owner = (await w.s.http(`/items/${item.id}`, { token: w.token })).json
  const own = owner.comments.find((x) => x.id === c.id)
  assert.deepEqual(own.approval, { statement: 's', signature: 'g' }, 'the owner sees it')
  for (const list of [listSharedComments(db, item.id), listGrantedComments(db, item.id)]) {
    const seen = list.find((x) => x.id === c.id)
    assert.ok(seen)
    assert.equal(seen.approval, null)
  }
})

// Lowering the mark (step_up:false) or changing the subject of a step-up
// item on an account with an approval key: a client needs a signed
// {op:'item_step_up'}, an agent must be the box that filed the item.
const lower = { op: 'item_step_up', on: 'false' }

test('a keyless second client cannot switch step_up off and then tap unsigned', async (t) => {
  const w = await world(t)
  const item = (await w.agent('/items', w.post(ask({ step_up: true, subject: SUBJECT })))).json.item
  const laptop = signIn(w.s, w.alice.id, 'laptop')
  const patch = (body) => w.s.http(`/items/${item.id}`, { method: 'PATCH', token: laptop.token, body })
  const off = await patch({ step_up: false })
  assert.deepEqual([off.status, off.json], [403, { error: 'approval_required' }])
  const row = w.s.db.prepare('SELECT step_up, subject FROM items WHERE id=?').get(item.id)
  assert.deepEqual({ ...row }, { step_up: 1, subject: JSON.stringify(SUBJECT) })
  // Along with an ordinary field, nothing is written either.
  const both = await patch({ title: 'Changed', step_up: false })
  assert.equal(both.status, 403)
  assert.equal(w.s.db.prepare('SELECT title FROM items WHERE id=?').get(item.id).title, 'Wire it?')
  const tap = await w.s.http(`/items/${item.id}/comments`, { method: 'POST', token: laptop.token, body: { action: 'Approve' } })
  assert.deepEqual([tap.status, tap.json.error], [403, 'approval_required'])
  // A client never changes a step-up item's subject, signed or not.
  const sub = await patch({ subject: { payee: 'Mallory' } })
  assert.deepEqual([sub.status, sub.json.error], [400, 'invalid_subject'])
  const again = await patch({ step_up: true, subject: { payee: 'Mallory' } })
  assert.deepEqual([again.status, again.json.error], [400, 'invalid_subject'])
  // Raising, or re-sending the mark with no subject, stays open.
  const same = await patch({ step_up: true })
  assert.equal(same.status, 200)
  assert.equal(same.json.item.step_up, true)
})

test('a client lowers step_up with a signed item_step_up; the subject then changes with a fresh raise', async (t) => {
  const w = await world(t)
  const item = (await w.agent('/items', w.post(ask({ step_up: true, subject: SUBJECT })))).json.item
  const patch = (body) => w.s.http(`/items/${item.id}`, { method: 'PATCH', token: w.token, body })
  const wrong = await signAccount(w.s, { token: w.token, key: w.key, subject: { ...lower, item: 'it_other' } })
  const bad = await patch({ step_up: false, approval: wrong })
  assert.deepEqual([bad.status, bad.json], [400, { error: 'approval_invalid', reason: 'mismatch' }])
  // A statement for another item is a mismatch; one for this item lowers it.
  const approval = await signAccount(w.s, { token: w.token, key: w.key, subject: { ...lower, item: item.id } })
  const off = await patch({ step_up: false, approval })
  assert.equal(off.status, 200, JSON.stringify(off.json))
  assert.deepEqual([off.json.item.step_up, off.json.item.subject], [false, null])
  const replay = await patch({ step_up: false, approval })
  assert.equal(replay.status, 200, 'not step-up any more: an ordinary patch')
  const on = await patch({ step_up: true, subject: { payee: 'Other' } })
  assert.equal(on.status, 200)
  assert.deepEqual(on.json.item.subject, { payee: 'Other' })
  // The unsigned tap is still refused on the re-raised item.
  const tap = await w.s.http(`/items/${item.id}/comments`, { method: 'POST', token: w.token, body: { action: 'Approve' } })
  assert.equal(tap.status, 403)
  const signed = await signTap(w.s, { token: w.token, key: w.key, item: on.json.item, action: 'Approve' })
  const ok = await w.s.http(`/items/${item.id}/comments`, { method: 'POST', token: w.token, body: { action: 'Approve', approval: signed } })
  assert.equal(ok.status, 201, JSON.stringify(ok.json))
})

test('a refused signed lowering spends no nonce', async (t) => {
  const w = await world(t)
  const item = (await w.agent('/items', w.post(ask({ step_up: true, subject: SUBJECT })))).json.item
  const approval = await signAccount(w.s, { token: w.token, key: w.key, subject: { ...lower, item: item.id } })
  // A mission that does not exist: 404 before the guard.
  const nf = await w.s.http(`/items/${item.id}`, { method: 'PATCH', token: w.token, body: { step_up: false, mission: 9999, approval } })
  assert.equal(nf.status, 404)
  const ok = await w.s.http(`/items/${item.id}`, { method: 'PATCH', token: w.token, body: { step_up: false, approval } })
  assert.equal(ok.status, 200, JSON.stringify(ok.json))
})

test('only the agent that filed a step-up item lowers it or changes its subject', async (t) => {
  const w = await world(t)
  const other = createAgent(w.s.db, w.alice.id, 'box-b')
  const item = (await w.agent('/items', w.post(ask({ step_up: true, subject: SUBJECT })))).json.item
  const byOther = (body) => w.s.http(`/items/${item.id}`, { method: 'PATCH', token: other.token, body })
  assert.deepEqual([(await byOther({ step_up: false })).status, (await byOther({ step_up: false })).json.error], [403, 'forbidden'])
  assert.equal((await byOther({ subject: { payee: 'Mallory' } })).status, 403)
  assert.equal((await byOther({ title: 'Retitled' })).status, 200, 'other fields stay open')
  assert.equal((await byOther({ step_up: true })).status, 200, 'raising stays open')
  const sub = await w.agent(`/items/${item.id}`, { method: 'PATCH', body: { subject: { payee: 'Other' } } })
  assert.deepEqual([sub.status, sub.json.item.subject], [200, { payee: 'Other' }])
  const off = await w.agent(`/items/${item.id}`, { method: 'PATCH', body: { step_up: false } })
  assert.deepEqual([off.status, off.json.item.step_up], [200, false])
})

test('a keyless owner: PATCH step_up:true is step_up_ignored, and step_up:false is an ordinary patch', async (t) => {
  const w = await world(t, false)
  const id = (await w.agent('/items', w.post(ask()))).json.item.id
  const on = await w.s.http(`/items/${id}`, { method: 'PATCH', token: w.token, body: { step_up: true, subject: SUBJECT } })
  assert.equal(on.status, 200)
  assert.equal(on.json.step_up_ignored, true)
  assert.deepEqual([on.json.item.step_up, on.json.item.subject], [false, null])
  const other = createAgent(w.s.db, w.alice.id, 'box-b')
  const off = await w.s.http(`/items/${id}`, { method: 'PATCH', token: other.token, body: { step_up: false } })
  assert.equal(off.status, 200)
  const second = signIn(w.s, w.alice.id, 'laptop')
  const off2 = await w.s.http(`/items/${id}`, { method: 'PATCH', token: second.token, body: { step_up: false } })
  assert.equal(off2.status, 200)
})
