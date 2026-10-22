import test from 'node:test'
import assert from 'node:assert/strict'
import { startTestServer, makeWsClient } from './helpers.js'
import { createUser, createAgent } from '../src/auth.js'
import { upsertConversation } from '../src/journal.js'
import { withdrawComment, WITHDRAWN_NOTE } from '../src/withdrawn-comments.js'
import { listSharedComments } from '../src/items.js'

// alice: a client ('mac') and an agent (box-a) managing c1, plus a second
// agent (box-b) of hers that manages nothing here.
async function fleet(t) {
  const s = await startTestServer()
  t.after(() => s.close())
  const alice = await createUser(s.db, 'alice', 'pw')
  const agent = createAgent(s.db, alice.id, 'box-a')
  const other = createAgent(s.db, alice.id, 'box-b')
  upsertConversation(s.db, { id: 'c1', ownerUserId: alice.id, title: 'C1', agentDeviceId: agent.deviceId })
  upsertConversation(s.db, { id: 'c9', ownerUserId: alice.id, title: 'C9', agentDeviceId: other.deviceId })
  const login = await s.http('/login', { method: 'POST', body: { username: 'alice', password: 'pw', device_name: 'mac' } })
  const client = login.json.token
  const item = (await s.http('/items', { method: 'POST', token: agent.token, body: { kind: 'question', title: 'Which account?', convo_id: 'c1' } })).json.item
  const reply = (await s.http(`/items/${item.id}/comments`, { method: 'POST', token: client, body: { body: 'use the zebra ledger' } })).json.comment
  return { s, alice, agent, other, client, item, reply }
}

// The bridge's queue card for the reply, then its release.
async function queueAndRelease(s, agent, { item, reply, action, promptId = 'pr_1' }) {
  const ws = await makeWsClient(s.base, { token: agent.token, cursor: null })
  await ws.waitFor((f) => f.op === 'hello_ok')
  ws.send({
    op: 'publish', convo_id: 'c1', type: 'prompt',
    payload: {
      kind: 'queued_release', prompt_id: promptId, question: 'Send this queued message now, or cancel it?',
      items: [{ id: `${promptId}::0`, text: `📌 Item #${item.num} "Which account?" — alice replied:\nuse the zebra ledger` }],
      actions: [{ id: 'send', label: 'Send now' }, { id: 'cancel', label: 'Cancel' }],
      body: `📨 Queued (1): 📌 #${item.num} Which account?`,
      item: { item_id: item.id, comment_id: reply.id },
    },
  })
  await ws.waitFor((f) => f.kind === 'journal' && f.type === 'prompt')
  ws.send({ op: 'publish', convo_id: 'c1', type: 'prompt_reply', payload: { kind: 'queued_release', prompt_id: promptId, action, released: [`${promptId}::0`] } })
  await ws.waitFor((f) => f.kind === 'journal' && f.type === 'prompt_reply')
  ws.close()
}

const thread = async (s, token, item) => (await s.http(`/items/${item.id}`, { token })).json.comments
const replyIn = (comments, reply) => comments.find((c) => c.id === reply.id)
const search = async (s, token) => (await s.http('/search/all?q=zebra&semantic=0&chats=0', { token })).json.results
const log = (s, userId) => s.db.prepare('SELECT type, payload FROM events WHERE user_id=? AND convo_id=? ORDER BY seq').all(userId, 'c1')

test('a cancelled queued reply: agents read that it was there, never its words; the user still reads it', async (t) => {
  const { s, alice, agent, other, client, item, reply } = await fleet(t)
  assert.equal(replyIn(await thread(s, agent.token, item), reply).body, 'use the zebra ledger')
  assert.equal((await search(s, agent.token)).length, 1)

  await queueAndRelease(s, agent, { item, reply, action: 'cancel' })

  for (const token of [agent.token, other.token]) {
    const c = replyIn(await thread(s, token, item), reply)
    assert.equal(c.body, ''); assert.deepEqual(c.attachments, []); assert.equal(c.withdrawn, true)
    assert.equal(c.author, 'user')
    assert.deepEqual(await search(s, token), [])
  }
  // The user's own apps keep the words, so the thread can show and resend them.
  const own = replyIn(await thread(s, client, item), reply)
  assert.equal(own.body, 'use the zebra ledger'); assert.equal(typeof own.withdrawn_at, 'number')
  assert.equal(own.withdrawn, undefined)
  assert.deepEqual(await search(s, client), [])

  // Nothing in the conversation log holds the words any more: the item
  // marker, the old-client fallback text, and the queue card.
  const rows = log(s, alice.id)
  for (const r of rows) assert.ok(!r.payload.includes('zebra'), `${r.type} still holds the reply: ${r.payload}`)
  const marker = rows.map((r) => JSON.parse(r.payload)).find((p) => p.action === 'commented' && p.comment)
  assert.equal(marker.comment.withdrawn, true); assert.equal(marker.comment.id, reply.id)
  const fallback = rows.filter((r) => r.type === 'text').map((r) => JSON.parse(r.payload)).find((p) => p.action === 'commented')
  assert.match(fallback.body, /alice commented:\n/); assert.ok(fallback.body.endsWith(WITHDRAWN_NOTE))
  const card = rows.filter((r) => r.type === 'prompt').map((r) => JSON.parse(r.payload))[0]
  assert.equal(card.items[0].text, WITHDRAWN_NOTE)
  // Read back through the agent's own transcript route, too.
  const page = await s.http('/convo/c1/messages?limit=50', { token: agent.token })
  assert.ok(!JSON.stringify(page.json).includes('zebra'))
})

test('a reply sent from the queue, or one whose session ended, stays readable', async (t) => {
  for (const action of ['send', 'send_one', 'expired']) {
    const { s, agent, item, reply } = await fleet(t)
    await queueAndRelease(s, agent, { item, reply, action })
    assert.equal(replyIn(await thread(s, agent.token, item), reply).body, 'use the zebra ledger', action)
    assert.equal((await search(s, agent.token)).length, 1, action)
  }
})

test('withdrawComment: only the user\'s own replies, once', async (t) => {
  const { s, alice, agent, item, reply } = await fleet(t)
  const mine = (await s.http(`/items/${item.id}/comments`, { method: 'POST', token: agent.token, body: { body: 'noted' } })).json.comment
  assert.equal(withdrawComment(s.db, { userId: alice.id, itemId: item.id, commentId: mine.id }), null)
  assert.equal(replyIn(await thread(s, agent.token, item), mine).body, 'noted')
  assert.equal(withdrawComment(s.db, { userId: alice.id, itemId: 'it_nope', commentId: reply.id }), null)
  assert.equal(withdrawComment(s.db, { userId: alice.id, itemId: item.id, commentId: reply.id }), reply.id)
  assert.equal(withdrawComment(s.db, { userId: alice.id, itemId: item.id, commentId: reply.id }), null)
})

test('a cancel release for a card that held no item reply touches nothing', async (t) => {
  const { s, alice, agent, item, reply } = await fleet(t)
  const ws = await makeWsClient(s.base, { token: agent.token, cursor: null })
  await ws.waitFor((f) => f.op === 'hello_ok')
  ws.send({ op: 'publish', convo_id: 'c1', type: 'prompt', payload: { kind: 'queued_release', prompt_id: 'pr_plain', items: [{ id: 'pr_plain::0', text: 'a chat message' }] } })
  await ws.waitFor((f) => f.kind === 'journal' && f.type === 'prompt')
  ws.send({ op: 'publish', convo_id: 'c1', type: 'prompt_reply', payload: { kind: 'queued_release', prompt_id: 'pr_plain', action: 'cancel' } })
  await ws.waitFor((f) => f.kind === 'journal' && f.type === 'prompt_reply')
  ws.close()
  assert.equal(replyIn(await thread(s, agent.token, item), reply).body, 'use the zebra ledger')
  assert.ok(log(s, alice.id).some((r) => r.payload.includes('a chat message')))
})

test('another person\'s view of the thread shows a withdrawn reply without its words', async (t) => {
  const { s, alice, item, reply } = await fleet(t)
  withdrawComment(s.db, { userId: alice.id, itemId: item.id, commentId: reply.id })
  const c = replyIn(listSharedComments(s.db, item.id), reply)
  assert.equal(c.body, ''); assert.equal(c.withdrawn, true)
})
