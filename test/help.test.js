import test from 'node:test'
import assert from 'node:assert/strict'
import { startTestServer } from './helpers.js'
import { createUser, createAgent } from '../src/auth.js'
import { HELP_TEXT } from '../src/help.js'

test('GET /help serves the API digest to authenticated devices only', async (t) => {
  const s = await startTestServer()
  t.after(() => s.close())
  const dan = await createUser(s.db, 'dan', 'hunter22')
  const ag = createAgent(s.db, dan.id, 'dev-2')

  // Unauthenticated callers get the same 401 as the rest of the surface.
  assert.equal((await s.http('/help', {})).status, 401)

  const r = await fetch(s.base + '/help', {
    headers: { authorization: `Bearer ${ag.token}` },
  })
  assert.equal(r.status, 200)
  assert.match(r.headers.get('content-type'), /text\/markdown/)
  const body = await r.text()
  assert.equal(body, HELP_TEXT)

  // The digest must at least name the discovery surface it exists to expose.
  assert.match(body, /GET \/search\?q=/)
  assert.match(body, /around_seq/)
})
