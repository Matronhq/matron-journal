import test from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { openDb } from '../src/db.js'

function cacheKib(value) {
  const previous = process.env.MATRON_SQLITE_CACHE_MB
  if (value === undefined) delete process.env.MATRON_SQLITE_CACHE_MB
  else process.env.MATRON_SQLITE_CACHE_MB = value
  try {
    const db = openDb(':memory:')
    try {
      return db.pragma('cache_size', { simple: true })
    } finally {
      db.close()
    }
  } finally {
    if (previous === undefined) delete process.env.MATRON_SQLITE_CACHE_MB
    else process.env.MATRON_SQLITE_CACHE_MB = previous
  }
}

test('openDb defaults to a 256 MiB page cache', () => {
  assert.equal(cacheKib(undefined), -262144)
})

test('MATRON_SQLITE_CACHE_MB overrides the page cache size in MiB', () => {
  assert.equal(cacheKib('64'), -65536)
  assert.equal(cacheKib('1.5'), -1536)
})

test('invalid or nonpositive MATRON_SQLITE_CACHE_MB leaves the SQLite default', () => {
  const db = new Database(':memory:')
  try {
    const stock = db.pragma('cache_size', { simple: true })
    for (const value of ['', '0', '-1', 'nope', 'Infinity']) {
      assert.equal(cacheKib(value), stock, `cache setting: ${JSON.stringify(value)}`)
    }
  } finally {
    db.close()
  }
})
