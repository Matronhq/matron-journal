import test from 'node:test'
import assert from 'node:assert/strict'
import { openDb } from '../src/db.js'

test('schema: items, item_comments, item_counters exist with the expected columns', () => {
  const db = openDb(':memory:')
  const cols = (t) => db.prepare(`PRAGMA table_info(${t})`).all().map((c) => c.name)
  assert.deepEqual(cols('items'), [
    'id', 'user_id', 'num', 'kind', 'state', 'resolution', 'awaiting', 'rank', 'title', 'body',
    'labels', 'links', 'supersedes', 'origin_convo_id', 'origin_device_id', 'created_by',
    'idem_key', 'created_at', 'updated_at', 'closed_at',
  ])
  assert.deepEqual(cols('item_comments'), [
    'id', 'item_id', 'user_id', 'author', 'device_id', 'kind', 'body', 'attachments', 'meta', 'idem_key', 'created_at',
  ])
  assert.deepEqual(cols('item_counters'), ['user_id', 'next_num'])
  // (user_id, num) is unique
  db.prepare("INSERT INTO users(id, name, password_hash, created_at) VALUES(1,'dan','x',0)").run()
  const ins = db.prepare(`INSERT INTO items(id,user_id,num,kind,state,rank,title,origin_convo_id,origin_device_id,created_by,created_at,updated_at)
    VALUES(?,1,1,'task','open',1024,'t','c1',1,'user',0,0)`)
  ins.run('it_a')
  assert.throws(() => ins.run('it_b'), /UNIQUE/)
})

import { createUser, createAgent } from '../src/auth.js'
import { upsertConversation } from '../src/journal.js'
import { createItem, getItem, listItems, validateItemFields } from '../src/items.js'

async function seed() {
  const db = openDb(':memory:')
  const dan = await createUser(db, 'dan', 'pw')
  const pat = await createUser(db, 'pat', 'pw')
  const agent = createAgent(db, dan.id, 'dev-2')
  upsertConversation(db, { id: 'c1', ownerUserId: dan.id, title: 'C1', agentDeviceId: agent.deviceId })
  upsertConversation(db, { id: 'c2', ownerUserId: dan.id, title: 'C2', agentDeviceId: agent.deviceId })
  return { db, dan, pat, agent }
}

const base = (o = {}) => ({
  kind: 'task', title: 'Do the thing', originConvoId: 'c1', originDeviceId: 1, createdBy: 'agent', ...o,
})

test('validateItemFields: trims, caps, dedupes, rejects junk', () => {
  assert.equal(validateItemFields({ title: '  ' }).ok, false)
  assert.equal(validateItemFields({ title: 'x'.repeat(201) }).ok, false)
  assert.equal(validateItemFields({ title: 't', body: 'x'.repeat(32769) }).ok, false)
  assert.equal(validateItemFields({ title: 't', labels: ['a', 'a', 'b'] }).value.labels.join(), 'a,b')
  assert.equal(validateItemFields({ title: 't', labels: 'nope' }).ok, false)
  assert.equal(validateItemFields({ title: 't', links: [{ url: 'https://x' }] }).value.links[0].url, 'https://x')
  assert.equal(validateItemFields({ title: 't', links: [{ url: 'javascript:alert(1)' }] }).ok, false)
  assert.equal(validateItemFields({ title: 't', attachments: [{ blob_ref: 'b', mime: 'image/png', name: 'a.png', size: 3 }] }).value.attachments[0].mime, 'image/png')
  assert.equal(validateItemFields({ title: 't', attachments: [{ mime: 'image/png' }] }).ok, false)
  // partial: title may be absent
  assert.equal(validateItemFields({ body: 'b' }, { partial: true }).ok, true)
})

test('createItem numbers per user, ranks at the bottom, and honours position/after/before', async () => {
  const { db, dan, pat } = await seed()
  const a = createItem(db, base({ userId: dan.id })).item
  const b = createItem(db, base({ userId: dan.id, title: 'B' })).item
  const p = createItem(db, base({ userId: pat.id, originConvoId: 'c1' })).item
  assert.equal(a.num, 1); assert.equal(b.num, 2); assert.equal(p.num, 1)
  assert.equal(a.rank, 1024); assert.equal(b.rank, 2048)
  const top = createItem(db, base({ userId: dan.id, title: 'T', position: 'top' })).item
  assert.equal(top.rank, 0)
  const mid = createItem(db, base({ userId: dan.id, title: 'M', after: a.id, before: b.id })).item
  assert.equal(mid.rank, 1536)
  assert.throws(() => createItem(db, base({ userId: dan.id, after: p.id })), /bad_after_before/)
  assert.equal(a.state, 'open'); assert.equal(a.awaiting, 'agent') // task default
  const q = createItem(db, base({ userId: dan.id, kind: 'question' })).item
  assert.equal(q.awaiting, 'user')
  const d = createItem(db, base({ userId: dan.id, kind: 'decision' })).item
  assert.equal(d.awaiting, null)
})

test('createItem idempotency returns the original row', async () => {
  const { db, dan } = await seed()
  const r1 = createItem(db, base({ userId: dan.id, idemKey: 'k1' }))
  const r2 = createItem(db, base({ userId: dan.id, idemKey: 'k1', title: 'changed' }))
  assert.equal(r1.duplicate, false); assert.equal(r2.duplicate, true)
  assert.equal(r2.item.id, r1.item.id); assert.equal(r2.item.title, 'Do the thing')
})

test('getItem accepts id, #num, num; other user 404s', async () => {
  const { db, dan, pat } = await seed()
  const a = createItem(db, base({ userId: dan.id })).item
  assert.equal(getItem(db, dan.id, a.id).id, a.id)
  assert.equal(getItem(db, dan.id, '#1').id, a.id)
  assert.equal(getItem(db, dan.id, 1).id, a.id)
  assert.equal(getItem(db, pat.id, a.id), null)
  assert.deepEqual(getItem(db, dan.id, a.id).labels, [])
})

test('listItems filters, sorts, pages, and decorates', async () => {
  const { db, dan } = await seed()
  const a = createItem(db, base({ userId: dan.id, now: 1 })).item
  const b = createItem(db, base({ userId: dan.id, kind: 'question', originConvoId: 'c2', now: 2 })).item
  createItem(db, base({ userId: dan.id, kind: 'decision', labels: ['ui'], now: 3 }))
  assert.equal(listItems(db, dan.id, {}).items.length, 3)
  assert.equal(listItems(db, dan.id, { convoId: 'c2' }).items[0].id, b.id)
  assert.equal(listItems(db, dan.id, { kind: 'decision' }).items.length, 1)
  assert.equal(listItems(db, dan.id, { awaiting: 'user' }).items[0].id, b.id)
  assert.equal(listItems(db, dan.id, { label: 'ui' }).items.length, 1)
  assert.equal(listItems(db, dan.id, { since: 2 }).items.length, 2) // updated_at >= since
  const byRank = listItems(db, dan.id, { sort: 'rank' }).items.map((i) => i.num)
  assert.deepEqual(byRank, [1, 2, 3])
  const byUpd = listItems(db, dan.id, { sort: 'updated' }).items.map((i) => i.num)
  assert.deepEqual(byUpd, [3, 2, 1])
  const p1 = listItems(db, dan.id, { limit: 2 })
  assert.equal(p1.items.length, 2); assert.ok(p1.next_cursor)
  const p2 = listItems(db, dan.id, { limit: 2, cursor: p1.next_cursor })
  assert.equal(p2.items.length, 1); assert.equal(p2.next_cursor, null)
  assert.equal(p1.items[0].comment_count, 0)
  assert.equal(p1.items[0].has_image, false)
  assert.equal(listItems(db, dan.id, { state: 'open' }).items.length, 3)
  assert.equal(listItems(db, dan.id, { state: 'closed' }).items.length, 0)
  void a
})
