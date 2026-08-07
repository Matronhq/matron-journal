import test from 'node:test'
import assert from 'node:assert/strict'
import { openDb } from '../src/db.js'
import { isAllowed, addAllowance, removeAllowance, listAllowances } from '../src/allowances.js'

test('directed pair: A→B does not imply B→A, add is idempotent, remove reports', () => {
  const d = openDb(':memory:')
  assert.equal(isAllowed(d, 1, 2, 3), false)
  addAllowance(d, { userId: 1, fromDeviceId: 2, targetDeviceId: 3 })
  addAllowance(d, { userId: 1, fromDeviceId: 2, targetDeviceId: 3 })
  assert.equal(isAllowed(d, 1, 2, 3), true)
  assert.equal(isAllowed(d, 1, 3, 2), false)   // reverse direction
  assert.equal(isAllowed(d, 9, 2, 3), false)   // different user — cross-user isolation
  assert.equal(listAllowances(d, 1).length, 1)
  assert.equal(removeAllowance(d, { userId: 1, fromDeviceId: 2, targetDeviceId: 3 }), true)
  assert.equal(removeAllowance(d, { userId: 1, fromDeviceId: 2, targetDeviceId: 3 }), false)
})
