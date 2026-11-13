// step_up and subject on items and comments: the marking an agent puts on a
// question whose tap must be signed with an approval key (the enforcement is
// a later task). An owner with no active key gets an ordinary item.
import test from 'node:test'
import assert from 'node:assert/strict'
import { createAgent } from '../src/auth.js'
import { upsertConversation } from '../src/journal.js'
import { validateItemFields, listSharedComments, listGrantedComments } from '../src/items.js'
import { startWithKey, startApprovalServer } from './approval-helpers.js'

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
  const own = (owner.comments ?? owner.item.comments).find((x) => x.id === c.id)
  assert.deepEqual(own.approval, { statement: 's', signature: 'g' }, 'the owner sees it')
  for (const list of [listSharedComments(db, item.id), listGrantedComments(db, item.id)]) {
    const seen = list.find((x) => x.id === c.id)
    assert.ok(seen)
    assert.equal(seen.approval, null)
  }
})
