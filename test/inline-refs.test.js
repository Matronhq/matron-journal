// Inline attachments in item and comment bodies (mission: inline images). A
// body places one of its own attachments as `![caption](attachment:<ref>)`;
// the journal checks the ref names one of the same write's attachments, and
// presents the refs as captions to apps that don't announce the form.
import test from 'node:test'
import assert from 'node:assert/strict'
import { startTestServer } from './helpers.js'
import { createUser, createAgent } from '../src/auth.js'
import { upsertConversation } from '../src/journal.js'
import { inlineRefs, inlineRefsToText, strayInlineRef, knowsInlineRefs } from '../src/inline-refs.js'
import { itemFallbackText } from '../src/items-marker.js'

const INLINE = { 'x-matron-item-inline': 'attachments' }

test('inlineRefs: refs in order, outside fenced blocks and code spans', () => {
  assert.deepEqual(inlineRefs('Before\n\n![login](attachment:aa11)\n\nAfter ![](attachment:bb-22)'), ['aa11', 'bb-22'])
  assert.deepEqual(inlineRefs('```\n![a](attachment:aa11)\n```\nthen ![b](attachment:bb22)'), ['bb22'])
  assert.deepEqual(inlineRefs('~~~~\n![a](attachment:aa11)\n```\nstill code\n~~~~\n![c](attachment:cc33)'), ['cc33'])
  assert.deepEqual(inlineRefs('`![a](attachment:aa11)` and ``x ![b](attachment:bb22) y``'), [])
  assert.deepEqual(inlineRefs('![a](./shot.png) ![b](https://x/y.png) ![c\nd](attachment:aa11)'), [])
  // A code span inside the caption does not hide the ref.
  assert.deepEqual(inlineRefs('![run `make`](attachment:aa11)'), ['aa11'])
  assert.deepEqual(inlineRefs('`x ![a](attachment:aa11) y` ![b `c`](attachment:bb22)'), ['bb22'])
  assert.deepEqual(inlineRefs(null), [])
})

test('inlineRefsToText: captions in place of refs, (image) for an empty caption, code untouched', () => {
  assert.equal(inlineRefsToText('Before\n\n![login page](attachment:aa11)\n\nAfter'), 'Before\n\nlogin page\n\nAfter')
  assert.equal(inlineRefsToText('![](attachment:aa11)'), '(image)')
  assert.equal(inlineRefsToText('```\n![a](attachment:aa11)\n```'), '```\n![a](attachment:aa11)\n```')
  assert.equal(inlineRefsToText('![run `make`](attachment:aa11) then `![a](attachment:bb22)`'), 'run `make` then `![a](attachment:bb22)`')
  assert.equal(inlineRefsToText('plain'), 'plain')
})

test('strayInlineRef: the first ref the attachments do not hold', () => {
  const atts = [{ blob_ref: 'aa11' }]
  assert.equal(strayInlineRef('![a](attachment:aa11)', atts), null)
  assert.equal(strayInlineRef('![a](attachment:aa11) ![b](attachment:zz99)', atts), 'zz99')
  assert.equal(strayInlineRef('![a](attachment:aa11)', undefined), 'aa11')
  assert.equal(strayInlineRef('no refs', undefined), null)
})

test('knowsInlineRefs: agents always; clients only with the header', () => {
  assert.equal(knowsInlineRefs({ headers: {} }, { kind: 'agent' }), true)
  assert.equal(knowsInlineRefs({ headers: {} }, { kind: 'client' }), false)
  assert.equal(knowsInlineRefs({ headers: { 'x-matron-item-inline': 'foo, Attachments' } }, { kind: 'client' }), true)
})

test('itemFallbackText: refs read as captions in the chat line', () => {
  const t = itemFallbackText({ action: 'created', kind: 'task', num: 3, title: 'T', by: 'agent', awaiting: null }, { body: 'Look\n![the login page](attachment:aa11)' })
  assert.match(t, /Look\nthe login page/)
  assert.doesNotMatch(t, /attachment:/)
})

// --- HTTP ------------------------------------------------------------------

async function fleet(t) {
  const s = await startTestServer()
  t.after(() => s.close())
  const alice = await createUser(s.db, 'alice', 'pw')
  const agent = createAgent(s.db, alice.id, 'box-2')
  upsertConversation(s.db, { id: 'c1', ownerUserId: alice.id, title: 'C1', agentDeviceId: agent.deviceId })
  const login = await s.http('/login', { method: 'POST', body: { username: 'alice', password: 'pw', device_name: 'mac' } })
  return { s, agent, client: login.json.token }
}

async function upload(s, token) {
  const r = await fetch(s.base + '/media', { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'text/plain' }, body: 'bytes' })
  assert.equal(r.status, 200)
  const up = await r.json()
  return { blob_ref: up.media_id, mime: 'text/plain', name: 'x.txt', size: up.size }
}

test('POST /items and comments: a ref must name one of the same write\'s attachments', async (t) => {
  const { s, agent } = await fleet(t)
  const a = await upload(s, agent.token)
  const b = await upload(s, agent.token)
  const bad = await s.http('/items', { method: 'POST', token: agent.token, body: { kind: 'task', title: 'T', convo_id: 'c1', body: `![x](attachment:${b.blob_ref})`, attachments: [a] } })
  assert.equal(bad.status, 400)
  assert.deepEqual(bad.json, { error: 'invalid_attachment_ref', ref: b.blob_ref })
  const ok = await s.http('/items', { method: 'POST', token: agent.token, body: { kind: 'task', title: 'T', convo_id: 'c1', body: `Before\n\n![x](attachment:${a.blob_ref})\n\nAfter`, attachments: [a] } })
  assert.equal(ok.status, 201)
  const id = ok.json.item.id
  // A ref in code is text, not a placement.
  assert.equal((await s.http('/items', { method: 'POST', token: agent.token, body: { kind: 'task', title: 'T2', convo_id: 'c1', body: '`![x](attachment:nope)`' } })).status, 201)

  // A comment may place only its own attachments, not the body's.
  const cBad = await s.http(`/items/${id}/comments`, { method: 'POST', token: agent.token, body: { body: `![x](attachment:${a.blob_ref})` } })
  assert.equal(cBad.status, 400); assert.equal(cBad.json.error, 'invalid_attachment_ref')
  assert.equal((await s.http(`/items/${id}/comments`, { method: 'POST', token: agent.token, body: { body: `Here ![y](attachment:${b.blob_ref})`, attachments: [b] } })).status, 201)

  // A body edit can place the body's existing attachments, nothing else.
  assert.equal((await s.http(`/items/${id}`, { method: 'PATCH', token: agent.token, body: { body: `Moved ![x](attachment:${a.blob_ref})` } })).status, 200)
  const pBad = await s.http(`/items/${id}`, { method: 'PATCH', token: agent.token, body: { body: `![y](attachment:${b.blob_ref})` } })
  assert.equal(pBad.status, 400); assert.equal(pBad.json.error, 'invalid_attachment_ref')

  // Close and reopen notes carry no attachments, so they can place nothing.
  const closeBad = await s.http(`/items/${id}/close`, { method: 'POST', token: agent.token, body: { resolution: 'done', comment: `![x](attachment:${a.blob_ref})` } })
  assert.equal(closeBad.status, 400); assert.equal(closeBad.json.error, 'invalid_attachment_ref')
  assert.equal((await s.http(`/items/${id}/close`, { method: 'POST', token: agent.token, body: { resolution: 'done', comment: 'Done' } })).status, 200)
  const reopenBad = await s.http(`/items/${id}/reopen`, { method: 'POST', token: agent.token, body: { comment: `![x](attachment:${a.blob_ref})` } })
  assert.equal(reopenBad.status, 400); assert.equal(reopenBad.json.error, 'invalid_attachment_ref')
})

test('GET /items: old apps get captions; apps with the header and agents get the stored refs', async (t) => {
  const { s, agent, client } = await fleet(t)
  const a = await upload(s, agent.token)
  const b = await upload(s, agent.token)
  const body = `Before\n\n![the login page](attachment:${a.blob_ref})\n\nAfter`
  const id = (await s.http('/items', { method: 'POST', token: agent.token, body: { kind: 'task', title: 'T', convo_id: 'c1', body, attachments: [a] } })).json.item.id
  const cBody = `See ![](attachment:${b.blob_ref})`
  const posted = await s.http(`/items/${id}/comments`, { method: 'POST', token: agent.token, body: { body: cBody, attachments: [b] } })
  assert.equal(posted.json.comment.body, cBody)

  const legacy = await s.http(`/items/${id}`, { token: client })
  assert.equal(legacy.json.item.body, 'Before\n\nthe login page\n\nAfter')
  assert.equal(legacy.json.item.attachments.length, 1)
  assert.equal(legacy.json.comments.find((c) => c.kind === 'comment').body, 'See (image)')
  assert.equal((await s.http('/items', { token: client })).json.items.find((i) => i.id === id).body, 'Before\n\nthe login page\n\nAfter')

  const modern = await s.http(`/items/${id}`, { token: client, headers: INLINE })
  assert.equal(modern.json.item.body, body)
  assert.equal(modern.json.comments.find((c) => c.kind === 'comment').body, cBody)
  assert.equal((await s.http(`/items/${id}`, { token: agent.token })).json.item.body, body)

  // A user's own comment answer is presented the same way.
  const c = await upload(s, client)
  const mine = await s.http(`/items/${id}/comments`, { method: 'POST', token: client, body: { body: `Mine ![shot](attachment:${c.blob_ref})`, attachments: [c] } })
  assert.equal(mine.status, 201); assert.equal(mine.json.comment.body, 'Mine shot')
})
