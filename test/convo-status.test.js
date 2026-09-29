import test from 'node:test'
import assert from 'node:assert/strict'
import { openDb } from '../src/db.js'
import { createAgent } from '../src/auth.js'
import { upsertConversation } from '../src/journal.js'
import { sanitizeConvoStatus, upsertConvoStatus, convoStatuses, convoStatus } from '../src/convo-status.js'

// The persisted subset of a bridge's `status` op (spec 2026-09-29 coordinator
// session control §1): model, context gauge, usage-limit stall and account
// meters, per conversation, so the roster and mission detail can say how
// full a session is — for a sleeping box and across a journal restart.

const FRAME = {
  model: 'claude-opus-5-5', effort: 'high', workdir: '/home/dan/app', email: 'dan@example.com',
  context: { tokens: 87000, window: 1000000, pct: 9 },
  limits: [{ id: '5h', label: 'Current session', percent: 42, resets_at: '2026-09-29T15:00:00.000Z' }],
  stall: { kind: 'usage_limit', model: 'claude-fable-5-1', resets_at: '2026-09-29T15:00:00.000Z', since: 1758460000000 },
  vitals: { cpu: 12 }, model_options: [{ value: 'opus', label: 'Opus' }],
}

function userRow(db, name = 'dan') {
  db.prepare("INSERT INTO users(name, password_hash, created_at) VALUES(?,'x',0)").run(name)
  return { id: db.prepare('SELECT id FROM users WHERE name=?').get(name).id }
}

test('sanitizeConvoStatus keeps model, context, stall and limits; drops everything else', () => {
  const s = sanitizeConvoStatus(FRAME, 1758460001000)
  assert.deepEqual(Object.keys(s).sort(), ['context', 'limits', 'model', 'stall'])
  assert.equal(s.model, 'claude-opus-5-5')
  assert.deepEqual(s.context, { tokens: 87000, window: 1000000, pct: 9 })
  assert.deepEqual(s.stall, FRAME.stall)
  assert.deepEqual(s.limits, { as_of: 1758460001000, lines: FRAME.limits })
})

test('sanitizeConvoStatus drops an invalid block but keeps the rest; nothing valid -> null', () => {
  assert.deepEqual(sanitizeConvoStatus({ model: 'x', context: { tokens: '87000', window: 1000000, pct: 9 } }), { model: 'x' })
  assert.deepEqual(sanitizeConvoStatus({ model: 'x', context: { tokens: -1, window: 1000000, pct: 9 } }), { model: 'x' })
  assert.deepEqual(sanitizeConvoStatus({ model: 'x', context: { tokens: 1, window: Infinity, pct: 9 } }), { model: 'x' })
  assert.deepEqual(sanitizeConvoStatus({ model: 'x', context: { tokens: 1, window: 2, pct: 101 } }), { model: 'x' })
  assert.deepEqual(sanitizeConvoStatus({ context: { tokens: 1, window: 2, pct: 50 }, stall: { kind: 'other' } }), { context: { tokens: 1, window: 2, pct: 50 } })
  assert.deepEqual(sanitizeConvoStatus({ model: 'x', stall: { kind: 'usage_limit', since: -5 } }), { model: 'x' })
  assert.deepEqual(sanitizeConvoStatus({ model: 'x', limits: [{ id: '5h' }] }), { model: 'x' })
  assert.deepEqual(sanitizeConvoStatus({ model: 'x', limits: { as_of: 1, lines: [] } }), { model: 'x' }, 'limits must be the bare lines array a bridge sends')
  assert.equal(sanitizeConvoStatus({ effort: 'high', vitals: {} }), null)
  assert.equal(sanitizeConvoStatus(null), null)
  assert.equal(sanitizeConvoStatus([]), null)
  assert.equal(sanitizeConvoStatus({ model: 'x'.repeat(65) }), null)
})

test('upsertConvoStatus is latest-wins per conversation and cascades with the conversation', () => {
  const db = openDb(':memory:')
  const dan = userRow(db)
  const dev = createAgent(db, dan.id, 'gene')
  upsertConversation(db, { id: 'c1', ownerUserId: dan.id, title: 'A', sessionState: 'running', agentDeviceId: dev.deviceId })
  upsertConversation(db, { id: 'c2', ownerUserId: dan.id, title: 'B', sessionState: 'running', agentDeviceId: dev.deviceId })
  upsertConvoStatus(db, { userId: dan.id, convoId: 'c1', status: { model: 'a' }, reportedAt: 10 })
  upsertConvoStatus(db, { userId: dan.id, convoId: 'c1', status: { model: 'b', context: { tokens: 1, window: 2, pct: 50 } }, reportedAt: 20 })
  upsertConvoStatus(db, { userId: dan.id, convoId: 'c2', status: { model: 'c' }, reportedAt: 30 })
  assert.deepEqual(convoStatus(db, 'c1'), { reported_at: 20, model: 'b', context: { tokens: 1, window: 2, pct: 50 } })
  assert.equal(convoStatus(db, 'nope'), null)
  const all = convoStatuses(db, dan.id)
  assert.deepEqual([...all.keys()].sort(), ['c1', 'c2'])
  assert.equal(convoStatuses(db, dan.id + 1).size, 0)
  db.prepare('DELETE FROM conversations WHERE id=?').run('c1')
  assert.equal(convoStatus(db, 'c1'), null)
  assert.equal(convoStatuses(db, dan.id).size, 1)
})
