import test from 'node:test'
import assert from 'node:assert/strict'
import { startTestServer } from './helpers.js'

// A reverse proxy reuses its connections to the journal. An idle one must
// outlive the proxy's own idle time, or a request sent down a connection
// the journal is closing is reset and the caller gets a 502.
test('idle HTTP connections are kept longer than a reverse proxy keeps them', async (t) => {
  const s = await startTestServer()
  t.after(() => s.close())
  assert.equal(s.server.keepAliveTimeout, 120000)
  assert.ok(s.server.headersTimeout > s.server.keepAliveTimeout, 'Node needs the header timeout above the keep-alive one')
})

test('MATRON_KEEPALIVE_TIMEOUT_MS sets it', async (t) => {
  process.env.MATRON_KEEPALIVE_TIMEOUT_MS = '75000'
  t.after(() => { delete process.env.MATRON_KEEPALIVE_TIMEOUT_MS })
  const s = await startTestServer()
  t.after(() => s.close())
  assert.equal(s.server.keepAliveTimeout, 75000)
  assert.equal(s.server.headersTimeout, 80000)
})
