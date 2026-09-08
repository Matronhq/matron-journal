import test from 'node:test'
import assert from 'node:assert/strict'
import { openDb } from '../src/db.js'
import { createUser, createAgent } from '../src/auth.js'
import { upsertConversation } from '../src/journal.js'
import { createItem, getItem, listItems, validateItemFields, resolveRank, RANK_EPSILON } from '../src/items.js'

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
  createItem(db, base({ userId: dan.id, now: 1 }))
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
})

test('listItems limit is clamped and coerced (default 100, max 500, min 1)', async () => {
  const { db, dan } = await seed()
  createItem(db, base({ userId: dan.id, title: 'A' }))
  createItem(db, base({ userId: dan.id, title: 'B' }))
  createItem(db, base({ userId: dan.id, title: 'C' }))
  const one = listItems(db, dan.id, { limit: '1' })
  assert.equal(one.items.length, 1)
  assert.ok(one.next_cursor)
  const huge = listItems(db, dan.id, { limit: 100000 })
  assert.equal(huge.items.length, 3)
  assert.equal(huge.next_cursor, null)
})

test('resolveRank renormalises on a too-tight gap and places the new item between', async () => {
  const { db, dan } = await seed()
  const a = createItem(db, base({ userId: dan.id, title: 'A' })).item
  const b = createItem(db, base({ userId: dan.id, title: 'B' })).item
  const c = createItem(db, base({ userId: dan.id, title: 'C' })).item
  // Force a and b's ranks within RANK_EPSILON of each other via a direct
  // UPDATE (mimics ranks drifting together over many small reorders).
  db.prepare('UPDATE items SET rank=? WHERE id=?').run(1000, a.id)
  db.prepare('UPDATE items SET rank=? WHERE id=?').run(1000 + RANK_EPSILON / 2, b.id)
  const mid = createItem(db, base({ userId: dan.id, title: 'Mid', after: a.id, before: b.id })).item
  const open = listItems(db, dan.id, { sort: 'rank' }).items
  const ranks = open.map((i) => i.rank)
  // Order is preserved through the renormalise.
  assert.deepEqual(ranks, [...ranks].sort((x, y) => x - y))
  // The three items that existed AT renormalise time (a, b, c — mid didn't
  // exist yet, so it's the exception) land on exact multiples of RANK_GAP
  // (1024): renormaliseRanks fired and reset every open item's rank.
  const aRank = open.find((i) => i.id === a.id).rank
  const bRank = open.find((i) => i.id === b.id).rank
  const cRank = open.find((i) => i.id === c.id).rank
  assert.equal(aRank % 1024, 0)
  assert.equal(bRank % 1024, 0)
  assert.equal(cRank % 1024, 0)
  // mid was placed strictly between the renormalised a and b — the whole
  // point of running resolveRank a second time after the renormalise.
  assert.equal(mid.rank, (aRank + bRank) / 2)
  const midIndex = open.findIndex((i) => i.id === mid.id)
  const aIndex = open.findIndex((i) => i.id === a.id)
  const bIndex = open.findIndex((i) => i.id === b.id)
  const cIndex = open.findIndex((i) => i.id === c.id)
  assert.ok(aIndex < midIndex && midIndex < bIndex, 'mid sits between a and b')
  assert.ok(cIndex > bIndex, 'c (untouched) keeps its relative order after b')
})

test('resolveRank rejects inverted or identical after/before instead of looping', async () => {
  const { db, dan } = await seed()
  const a = createItem(db, base({ userId: dan.id, title: 'A' })).item
  const b = createItem(db, base({ userId: dan.id, title: 'B' })).item
  // Identical: after === before.
  assert.throws(() => resolveRank(db, dan.id, { after: a.id, before: a.id }), /bad_after_before/)
  // Inverted: after is b (ranked below a in creation order is wrong here —
  // b was created after a, so b.rank > a.rank; asking to sit "after b,
  // before a" is a structural inversion since before must rank above after).
  const start = Date.now()
  assert.throws(() => resolveRank(db, dan.id, { after: b.id, before: a.id }), /bad_after_before/)
  assert.ok(Date.now() - start < 5000, 'fails fast, no renormalise-and-recurse loop')
})

test('createItem stores supersedes to another of the caller\'s items; an unknown id rejects', async () => {
  const { db, dan, pat } = await seed()
  const original = createItem(db, base({ userId: dan.id, title: 'Original' })).item
  const revised = createItem(db, base({ userId: dan.id, title: 'Revised', supersedes: original.id })).item
  assert.equal(revised.supersedes, original.id)
  assert.throws(() => createItem(db, base({ userId: dan.id, supersedes: 'it_doesnotexist' })), /bad_supersedes/)
  const p = createItem(db, base({ userId: pat.id, originConvoId: 'c1' })).item
  assert.throws(() => createItem(db, base({ userId: dan.id, supersedes: p.id })), /bad_supersedes/)
})

test('listItems excludePrivateOwned hides items whose origin conversation is agent-owned by a private device', async () => {
  const { db, dan } = await seed()
  const privAgent = createAgent(db, dan.id, 'private-box')
  db.prepare('UPDATE devices SET private=1 WHERE id=?').run(privAgent.deviceId)
  upsertConversation(db, { id: 'c3', ownerUserId: dan.id, title: 'Private convo', agentDeviceId: privAgent.deviceId })
  const pub = createItem(db, base({ userId: dan.id, title: 'Public' })).item
  const priv = createItem(db, base({ userId: dan.id, title: 'Private', originConvoId: 'c3' })).item
  const hidden = listItems(db, dan.id, { excludePrivateOwned: true }).items.map((i) => i.id)
  assert.ok(hidden.includes(pub.id))
  assert.ok(!hidden.includes(priv.id))
  const shown = listItems(db, dan.id, { excludePrivateOwned: false }).items.map((i) => i.id)
  assert.ok(shown.includes(pub.id))
  assert.ok(shown.includes(priv.id))
})

test('createItem attachments: synthetic body comment written, item decorated with attachments/has_image', async () => {
  const { db, dan } = await seed()
  const withImage = createItem(db, base({
    userId: dan.id,
    title: 'With image',
    attachments: [{ blob_ref: 'b1', mime: 'image/png', name: 'a.png', size: 3 }],
  })).item
  assert.equal(withImage.attachments.length, 1)
  assert.equal(withImage.attachments[0].blob_ref, 'b1')
  assert.equal(withImage.has_image, true)
  const withoutImage = createItem(db, base({
    userId: dan.id,
    title: 'Without image',
    attachments: [{ blob_ref: 'b2', mime: 'application/pdf', name: 'a.pdf', size: 3 }],
  })).item
  assert.equal(withoutImage.attachments.length, 1)
  assert.equal(withoutImage.has_image, false)
  const noAttachments = createItem(db, base({ userId: dan.id, title: 'None' })).item
  assert.deepEqual(noAttachments.attachments, [])
  assert.equal(noAttachments.has_image, false)
  // getItem sees the same decoration as the create-time return.
  assert.equal(getItem(db, dan.id, withImage.id).has_image, true)
})
