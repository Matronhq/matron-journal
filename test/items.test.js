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
