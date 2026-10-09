// Comment author (protocol.md "Comment author"): an agent's comment names the
// box that wrote it (`device_name`) and, when the bridge says which session
// it was (`as_convo_id`), the conversation (`convo_id`, `convo_title`).
import test from 'node:test'
import assert from 'node:assert/strict'
import { startTestServer } from './helpers.js'
import { openDb, pinDevicePrivate } from '../src/db.js'
import { createUser, createAgent } from '../src/auth.js'
import { upsertConversation } from '../src/journal.js'
import { recordJoined } from '../src/participants.js'
import { createItem, addComment, closeItem, listComments, listSharedComments, listGrantedComments } from '../src/items.js'

const who = (c) => [c.device_name, c.convo_id, c.convo_title]

test('an agent comment carries its box and conversation; a user comment and an unnamed session carry nulls', async () => {
  const db = openDb(':memory:')
  const alice = await createUser(db, 'alice', 'pw')
  const a = createAgent(db, alice.id, 'box-a')
  const b = createAgent(db, alice.id, 'box-b')
  upsertConversation(db, { id: 'c1', ownerUserId: alice.id, title: 'Audit', agentDeviceId: a.deviceId })
  upsertConversation(db, { id: 'c2', ownerUserId: alice.id, title: 'Runner', agentDeviceId: b.deviceId })
  const item = createItem(db, { userId: alice.id, kind: 'task', title: 'T', originConvoId: 'c1', originDeviceId: a.deviceId, createdBy: 'agent' }).item
  const say = (o) => addComment(db, { userId: alice.id, itemId: item.id, body: 'x', ...o }).comment
  assert.deepEqual(who(say({ author: 'agent', deviceId: a.deviceId, convoId: 'c1' })), ['box-a', 'c1', 'Audit'])
  assert.deepEqual(who(say({ author: 'agent', deviceId: b.deviceId, convoId: 'c2' })), ['box-b', 'c2', 'Runner'])
  // A bridge that names no session: the box alone.
  assert.deepEqual(who(say({ author: 'agent', deviceId: b.deviceId })), ['box-b', null, null])
  // The user's own comment has no author to name, whatever the caller passes.
  assert.deepEqual(who(say({ author: 'user', deviceId: 99, convoId: 'c1' })), [null, null, null])
  // A closing note is a comment too.
  const closed = closeItem(db, { userId: alice.id, itemId: item.id, resolution: 'done', author: 'agent', deviceId: b.deviceId, convoId: 'c2', comment: 'Shipped' }).comment
  assert.deepEqual(who(closed), ['box-b', 'c2', 'Runner'])
  assert.deepEqual(listComments(db, item.id).map(who), [
    ['box-a', 'c1', 'Audit'], ['box-b', 'c2', 'Runner'], ['box-b', null, null], [null, null, null], ['box-b', 'c2', 'Runner'],
  ])
  // Another person's view names neither box nor conversation.
  for (const c of [...listSharedComments(db, item.id), ...listGrantedComments(db, item.id)]) assert.deepEqual(who(c), [null, null, null])
})

async function fleet(t) {
  const s = await startTestServer()
  t.after(() => s.close())
  const alice = await createUser(s.db, 'alice', 'pw')
  const a = createAgent(s.db, alice.id, 'box-a')
  const b = createAgent(s.db, alice.id, 'box-b')
  upsertConversation(s.db, { id: 'c1', ownerUserId: alice.id, title: 'Audit', agentDeviceId: a.deviceId })
  upsertConversation(s.db, { id: 'c2', ownerUserId: alice.id, title: 'Runner', agentDeviceId: b.deviceId })
  const login = await s.http('/login', { method: 'POST', body: { username: 'alice', password: 'pw', device_name: 'mac' } })
  const made = await s.http('/items', { method: 'POST', token: a.token, body: { kind: 'task', title: 'T', convo_id: 'c1' } })
  const post = (token, body, sub = 'comments') => s.http(`/items/${made.json.item.id}/${sub}`, { method: 'POST', token, body })
  return { s, alice, a, b, client: login.json.token, id: made.json.item.id, post }
}

test('POST comments {as_convo_id}: stored for the session that may write it, dropped otherwise, ignored from a client', async (t) => {
  const { s, a, b, client, id, post } = await fleet(t)
  const mine = await post(b.token, { body: 'from the runner', as_convo_id: 'c2' })
  assert.equal(mine.status, 201); assert.deepEqual(who(mine.json.comment), ['box-b', 'c2', 'Runner'])
  // Another box's conversation is not this session's to claim: the comment
  // is kept, labelled with the box alone.
  const forged = await post(b.token, { body: 'hm', as_convo_id: 'c1' })
  assert.equal(forged.status, 201); assert.deepEqual(who(forged.json.comment), ['box-b', null, null])
  const unknown = await post(b.token, { body: 'hm', as_convo_id: 'nope' })
  assert.equal(unknown.status, 201); assert.deepEqual(who(unknown.json.comment), ['box-b', null, null])
  for (const bad of [7, '', 'x'.repeat(129)]) assert.equal((await post(b.token, { body: 'x', as_convo_id: bad })).status, 400)
  const user = await post(client, { body: 'thanks', as_convo_id: 'c1' })
  assert.equal(user.status, 201); assert.deepEqual(who(user.json.comment), [null, null, null])
  // Close and reopen notes carry it as well.
  const closed = await post(a.token, { resolution: 'done', comment: 'Done', as_convo_id: 'c1' }, 'close')
  assert.deepEqual(who(closed.json.comment), ['box-a', 'c1', 'Audit'])
  const reopened = await post(a.token, { comment: 'Not yet', as_convo_id: 'c1' }, 'reopen')
  assert.deepEqual(who(reopened.json.comment), ['box-a', 'c1', 'Audit'])
  const got = await s.http(`/items/${id}`, { token: client })
  assert.deepEqual(got.json.comments.filter((c) => c.body).map(who), [
    ['box-b', 'c2', 'Runner'], ['box-b', null, null], ['box-b', null, null], [null, null, null], ['box-a', 'c1', 'Audit'], ['box-a', 'c1', 'Audit'],
  ])
})

test('a private box\'s comment is unnamed to an ordinary agent, named to the user and to the private box', async (t) => {
  const { s, alice, a, client, id, post } = await fleet(t)
  const priv = createAgent(s.db, alice.id, 'private-box')
  pinDevicePrivate(s.db, priv.deviceId, true)
  upsertConversation(s.db, { id: 'secret', ownerUserId: alice.id, title: 'Secret work', agentDeviceId: priv.deviceId })
  assert.equal((await post(priv.token, { body: 'a word from elsewhere', as_convo_id: 'secret' })).status, 201)
  const last = async (token) => who((await s.http(`/items/${id}`, { token })).json.comments.at(-1))
  assert.deepEqual(await last(a.token), [null, null, null])
  assert.deepEqual(await last(client), ['private-box', 'secret', 'Secret work'])
  assert.deepEqual(await last(priv.token), ['private-box', 'secret', 'Secret work'])
})

test('a public box naming a private box\'s conversation: the conversation is hidden from an ordinary agent, the box is not', async (t) => {
  const { s, alice, a, b, client, id, post } = await fleet(t)
  const priv = createAgent(s.db, alice.id, 'private-box')
  pinDevicePrivate(s.db, priv.deviceId, true)
  upsertConversation(s.db, { id: 'secret', ownerUserId: alice.id, title: 'Secret work', agentDeviceId: priv.deviceId })
  // box-b has joined the private box's conversation, so it may write there
  // and may name it on its comment.
  recordJoined(s.db, { convoId: 'secret', agentDeviceId: b.deviceId, initiatorDeviceId: priv.deviceId })
  const made = await post(b.token, { body: 'from inside the room', as_convo_id: 'secret' })
  assert.equal(made.status, 201)
  const last = async (token) => who((await s.http(`/items/${id}`, { token })).json.comments.at(-1))
  assert.deepEqual(await last(a.token), ['box-b', null, null])
  assert.deepEqual(await last(client), ['box-b', 'secret', 'Secret work'])
  assert.deepEqual(await last(priv.token), ['box-b', 'secret', 'Secret work'])
  // The write's own response goes through the same sieve.
  assert.deepEqual(who(made.json.comment), ['box-b', null, null])
})

test('item_comments gains convo_id on open', async () => {
  const db = openDb(':memory:')
  assert.ok(db.prepare('PRAGMA table_info(item_comments)').all().some((c) => c.name === 'convo_id'))
})
