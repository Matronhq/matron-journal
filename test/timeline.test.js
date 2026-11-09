import test from 'node:test'
import assert from 'node:assert/strict'
import { openDb } from '../src/db.js'
import { createUser } from '../src/auth.js'
import {
  userTimeZone, weekStartOf, weekEndOf, previousWeekStart, formatWeekKey, parseWeekKey,
} from '../src/timeline.js'

const LON = 'Europe/London'

test('userTimeZone defaults to Europe/London and honours a stored zone', async () => {
  const db = openDb(':memory:')
  const alice = await createUser(db, 'alice', 'pw')
  assert.equal(userTimeZone(db, alice.id), LON)
  const id = alice.id
  db.prepare('UPDATE users SET time_zone = ? WHERE id = ?').run('America/New_York', id)
  assert.equal(userTimeZone(db, id), 'America/New_York')
  db.prepare('UPDATE users SET time_zone = ? WHERE id = ?').run('Not/AZone', id)
  assert.equal(userTimeZone(db, id), LON)
  assert.equal(userTimeZone(db, 99999), LON)
})

test('weekStartOf is the local Monday 00:00 at or before the instant', () => {
  assert.equal(weekStartOf(Date.UTC(2026, 10, 9, 14, 0), LON), Date.UTC(2026, 10, 9, 0, 0))
  assert.equal(weekStartOf(Date.UTC(2026, 10, 9, 0, 0), LON), Date.UTC(2026, 10, 9, 0, 0))
  // Sunday 15 Nov 23:30 local (GMT) -> Monday 9 Nov.
  assert.equal(weekStartOf(Date.UTC(2026, 10, 15, 23, 30), LON), Date.UTC(2026, 10, 9, 0, 0))
  // BST: Sunday 4 Oct 23:30 local = 22:30 UTC -> Monday 28 Sep 00:00 BST = 27 Sep 23:00 UTC.
  assert.equal(weekStartOf(Date.UTC(2026, 9, 4, 22, 30), LON), Date.UTC(2026, 8, 27, 23, 0))
})

test('weekEndOf spans the 25 Oct 2026 clock change as a 169 hour week', () => {
  const start = weekStartOf(Date.UTC(2026, 9, 21), LON)
  assert.equal(weekEndOf(start, LON) - start, 169 * 3600e3)
  const plain = weekStartOf(Date.UTC(2026, 10, 10), LON)
  assert.equal(weekEndOf(plain, LON) - plain, 168 * 3600e3)
})

test('previousWeekStart steps back one local week across the change', () => {
  const nov2 = Date.UTC(2026, 10, 2, 0, 0)
  const oct26 = previousWeekStart(nov2, LON)
  assert.equal(oct26, Date.UTC(2026, 9, 26, 0, 0))
  const oct19 = previousWeekStart(oct26, LON) // Mon 19 Oct 00:00 BST
  assert.equal(oct19, Date.UTC(2026, 9, 18, 23, 0))
  assert.equal(oct26 - oct19, 169 * 3600e3)
  assert.equal(weekEndOf(oct19, LON), oct26)
})

test('formatWeekKey and parseWeekKey round-trip the local Monday date', () => {
  const start = weekStartOf(Date.UTC(2026, 9, 21), LON) // Mon 19 Oct, BST
  assert.equal(formatWeekKey(start, LON), '2026-10-19')
  assert.equal(parseWeekKey('2026-10-19', LON), start)
  const nov9 = Date.UTC(2026, 10, 9, 0, 0)
  assert.equal(formatWeekKey(nov9, LON), '2026-11-09')
  assert.equal(parseWeekKey('2026-11-09', LON), nov9)
  const ny = weekStartOf(Date.UTC(2026, 10, 11, 12), 'America/New_York')
  assert.equal(parseWeekKey(formatWeekKey(ny, 'America/New_York'), 'America/New_York'), ny)
})

test('parseWeekKey rejects non-Mondays, bad shapes and impossible dates', () => {
  assert.equal(parseWeekKey('2026-11-10', LON), null)
  assert.equal(parseWeekKey('2026-02-30', LON), null)
  assert.equal(parseWeekKey('2026-1-09', LON), null)
  assert.equal(parseWeekKey('nope', LON), null)
  assert.equal(parseWeekKey(undefined, LON), null)
})

test('an invalid zone falls back to Europe/London', () => {
  const t = Date.UTC(2026, 10, 9, 14, 0)
  assert.equal(weekStartOf(t, 'Bogus/Zone'), weekStartOf(t, LON))
})

test('weekStartOf handles the exact Monday boundary and sub-second edges', () => {
  const mon = Date.UTC(2026, 10, 9, 0, 0)
  assert.equal(weekStartOf(mon, LON), mon)
  assert.equal(weekStartOf(mon + 500, LON), mon)
  assert.equal(weekStartOf(mon - 1, LON), Date.UTC(2026, 10, 2, 0, 0))
  assert.equal(weekStartOf(weekEndOf(mon, LON) - 1, LON), mon)
})
