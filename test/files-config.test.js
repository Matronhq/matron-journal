// File Explorer boot configuration and access control, over a real server:
// opt-in and fail-safe disabling, write-root configuration, admin-only
// access, server-state exclusion, and bounded listings.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import crypto from 'node:crypto'
import { startTestServer } from './helpers.js'
import { pinAllowedRootsSync } from '../src/file-guard.js'
import { assertNoProhibitedFileWriteRoots, pinProhibitedFileWriteRootsSync } from '../src/server.js'
import { makeTmpDir } from './tmp-dir.js'
import { makeFixture, clientToken, authGet, captureHttpHandlerOptions } from './files-fixtures.js'

// --- opt-in + fail-safe disabling ---------------------------------
test('with no roots configured, the server starts and /files/* is 404 (feature off)', async (t) => {
  const s = await startTestServer() // no fileReadRoots, env unset
  t.after(() => s.close())
  const token = await clientToken(s)
  // server is fully functional
  assert.equal((await s.http('/snapshot', { token })).status, 200)
  // file routes are simply not there
  for (const url of ['/files/list?path=/tmp', '/files/meta?path=/etc/hosts', '/files/content?path=/etc/hosts']) {
    const r = await authGet(s, url, token)
    assert.equal(r.status, 404, `${url} should 404 when the file API is disabled`)
  }
})

test('startServer fails visible on an unreadable configured read-root', async () => {
  await assert.rejects(
    startTestServer({ fileReadRoots: [path.join(os.tmpdir(), 'matron-does-not-exist-' + crypto.randomBytes(6).toString('hex'))] }),
    (e) => e && e.reason === 'bad-workdir',
  )
})

test('an empty configured root set disables the API (never fails open)', async (t) => {
  const s = await startTestServer({ fileReadRoots: [] })
  t.after(() => s.close())
  const token = await clientToken(s)
  assert.equal((await s.http('/snapshot', { token })).status, 200)
  // Must NOT serve an arbitrary absolute file — the route is off entirely.
  assert.equal((await authGet(s, '/files/content?path=/etc/hosts', token)).status, 404)
  assert.equal((await authGet(s, '/files/list?path=/etc', token)).status, 404)
})

test('file API disabled (fail closed) when /proc/self/fd is unavailable', async (t) => {
  const { root } = makeFixture()
  // Roots ARE configured, but the fd-identity re-check platform is absent.
  const s = await startTestServer({ fileReadRoots: [root], procSelfFdAvailable: false })
  t.after(() => s.close())
  const token = await clientToken(s)
  assert.equal((await s.http('/snapshot', { token })).status, 200)
  assert.equal((await authGet(s, `/files/list?path=${encodeURIComponent(root)}`, token)).status, 404)
  assert.equal((await authGet(s, `/files/content?path=${encodeURIComponent(path.join(root, 'app.js'))}`, token)).status, 404)
})

// --- server-owned write configuration -----------------------
test('writes are off by default even with a valid pinned write-root', async (t) => {
  const { root } = makeFixture()
  const writeRoot = path.join(root, 'src')
  const capture = captureHttpHandlerOptions()
  const s = await startTestServer({
    fileReadRoots: [root], fileWriteRoots: [writeRoot], httpHandlerFactory: capture.factory,
  })
  t.after(() => s.close())

  assert.deepEqual(capture.options.fileWriteRoots.roots.map((pinned) => pinned.realPath), [writeRoot])
  assert.equal(capture.options.fileEnableWrites, false)
  assert.equal(capture.options.fileWritesDryRun, false)
})

test('ENABLE_WRITES=1 without write-roots fails closed and logs why', async (t) => {
  const { root } = makeFixture()
  const warn = t.mock.method(console, 'warn', () => {})
  const capture = captureHttpHandlerOptions()
  const s = await startTestServer({
    fileReadRoots: [root], fileEnableWrites: true, httpHandlerFactory: capture.factory,
  })
  t.after(() => s.close())

  assert.ok(warn.mock.calls.some((c) => /MATRON_FILE_WRITE_ROOTS is unset or empty/.test(c.arguments[0])))
  assert.equal(capture.options.fileWriteRoots, null)
  assert.equal(capture.options.fileEnableWrites, false)
})

test('ENABLE_WRITES=1 with an empty write-root list also fails closed', async (t) => {
  const { root } = makeFixture()
  const warn = t.mock.method(console, 'warn', () => {})
  const capture = captureHttpHandlerOptions()
  const s = await startTestServer({
    fileReadRoots: [root], fileWriteRoots: [], fileEnableWrites: true,
    httpHandlerFactory: capture.factory,
  })
  t.after(() => s.close())

  assert.ok(warn.mock.calls.some((c) => /MATRON_FILE_WRITE_ROOTS is unset or empty/.test(c.arguments[0])))
  assert.equal(capture.options.fileWriteRoots, null)
  assert.equal(capture.options.fileEnableWrites, false)
})

test('write-root, enable, and dry-run env config accepts colon-separated nested roots', async (t) => {
  const { root } = makeFixture()
  const envNames = ['MATRON_FILE_WRITE_ROOTS', 'MATRON_FILE_ENABLE_WRITES', 'MATRON_FILE_WRITES_DRYRUN']
  const previous = new Map(envNames.map((name) => [name, process.env[name]]))
  t.after(() => {
    for (const [name, value] of previous) {
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
    }
  })
  process.env.MATRON_FILE_WRITE_ROOTS = `${path.join(root, 'src')}:${path.join(root, 'node_modules')}`
  process.env.MATRON_FILE_ENABLE_WRITES = '1'
  process.env.MATRON_FILE_WRITES_DRYRUN = '1'

  const capture = captureHttpHandlerOptions()
  const s = await startTestServer({
    fileReadRoots: [root],
    fileAuditDir: makeTmpDir('matron-files-audit-'),
    httpHandlerFactory: capture.factory,
  })
  t.after(() => s.close())
  assert.deepEqual(
    capture.options.fileWriteRoots.roots.map((pinned) => pinned.realPath),
    [path.join(root, 'src'), path.join(root, 'node_modules')],
  )
  assert.equal(capture.options.fileEnableWrites, true)
  assert.equal(capture.options.fileWritesDryRun, true)
})

test('broad write-root identities reject synthetic bind-mount aliases', () => {
  const { root, outside } = makeFixture()
  const broadRoots = [root, path.join(root, 'src'), path.join(root, 'node_modules')]
  const missingRoot = path.join(root, 'host-path-not-present')
  const prohibitedRoots = pinProhibitedFileWriteRootsSync([...broadRoots, missingRoot])
  assert.deepEqual(prohibitedRoots.roots.map((pinned) => pinned.realPath), broadRoots)

  for (const [index, broadRoot] of broadRoots.entries()) {
    const pinnedWriteRoots = pinAllowedRootsSync([broadRoot])
    const aliasPath = path.join(outside, `synthetic-bind-alias-${index}`)
    const aliasedWriteRoots = {
      roots: pinnedWriteRoots.roots.map((pinned) => ({ ...pinned, realPath: aliasPath })),
    }
    assert.throws(
      () => assertNoProhibitedFileWriteRoots(aliasedWriteRoots, prohibitedRoots),
      (err) => err?.message === `file writes: configured write-root is prohibited because it is too broad: ${aliasPath}`,
      aliasPath,
    )
  }
})

test('a write-root outside all read-roots fails visibly at boot', async () => {
  const { root, outside } = makeFixture()
  await assert.rejects(
    startTestServer({ fileReadRoots: [root], fileWriteRoots: [outside] }),
    /every configured write-root must be contained in a configured read-root/,
  )
})

test('an unreadable configured write-root fails visibly while pinning', async () => {
  const { root } = makeFixture()
  await assert.rejects(
    startTestServer({
      fileReadRoots: [root],
      fileWriteRoots: [path.join(root, 'missing-' + crypto.randomBytes(6).toString('hex'))],
    }),
    (e) => e && e.reason === 'bad-workdir',
  )
})

test('server-owned state inside a read-root is never listed or served', async (t) => {
  const root = fs.realpathSync(makeTmpDir('matron-state-'))
  const dataDir = path.join(root, 'data')
  fs.mkdirSync(dataDir)
  fs.writeFileSync(path.join(root, 'notes.md'), 'hello\n')
  const dbPath = path.join(dataDir, 'journal.db')
  const s = await startTestServer({ dbPath, fileReadRoots: [root] })
  t.after(() => s.close())
  const token = await clientToken(s)

  for (const route of ['content', 'meta']) {
    const r = await authGet(s, `/files/${route}?path=${encodeURIComponent(dbPath)}`, token)
    assert.equal(r.status, 403, route)
  }
  const media = path.join(dataDir, 'media')
  fs.mkdirSync(media, { recursive: true })
  assert.equal((await authGet(s, `/files/list?path=${encodeURIComponent(media)}`, token)).status, 403)
  const listed = await (await authGet(s, `/files/list?path=${encodeURIComponent(dataDir)}&all=1`, token)).json()
  assert.deepEqual(listed.entries.map((e) => e.name).filter((n) => n.startsWith('journal.db') || n === 'media'), [])
  // Ordinary files next to it are unaffected.
  assert.equal((await authGet(s, `/files/content?path=${encodeURIComponent(path.join(root, 'notes.md'))}`, token)).status, 200)
})

test('only a journal admin reaches the file API: other users get 403 forbidden, admins can be demoted live', async (t) => {
  const { root } = makeFixture()
  const s = await startTestServer({ fileReadRoots: [root] })
  t.after(() => s.close())
  const adminToken = await clientToken(s, 'admin', 'pw')
  const plainToken = await clientToken(s, 'plain', 'pw', { admin: false })
  const enc = encodeURIComponent(root)
  const fileEnc = encodeURIComponent(path.join(root, 'app.js'))
  const urls = [`/files/list?path=${enc}`, `/files/meta?path=${fileEnc}`, `/files/content?path=${fileEnc}`]
  for (const url of urls) {
    const r = await authGet(s, url, plainToken)
    assert.equal(r.status, 403, url)
    assert.deepEqual(await r.json(), { error: 'forbidden' }, url)
    assert.equal((await authGet(s, url, adminToken)).status, 200, url)
  }
  s.db.prepare("UPDATE users SET is_admin=0 WHERE name='admin'").run()
  for (const url of urls) {
    const r = await authGet(s, url, adminToken)
    assert.equal(r.status, 403, url)
    assert.deepEqual(await r.json(), { error: 'forbidden' }, url)
  }
})

test('.envrc is treated as credential material', async (t) => {
  const { root } = makeFixture()
  fs.writeFileSync(path.join(root, '.envrc'), 'export TOKEN=abc\n')
  const s = await startTestServer({ fileReadRoots: [root] })
  t.after(() => s.close())
  const token = await clientToken(s)
  const listed = await (await authGet(s, `/files/list?path=${encodeURIComponent(root)}&all=1`, token)).json()
  assert.ok(!listed.entries.some((e) => e.name === '.envrc'))
  const r = await authGet(s, `/files/content?path=${encodeURIComponent(path.join(root, '.envrc'))}`, token)
  assert.equal(r.status, 403)
})

test('a listing stops examining entries at its scan budget and says it was truncated', async (t) => {
  const root = fs.realpathSync(makeTmpDir('matron-scan-'))
  // Mostly filtered entries: none would be returned, but each costs work.
  for (let i = 0; i < 40; i++) fs.writeFileSync(path.join(root, `k${i}.pem`), 'x')
  const s = await startTestServer({ fileReadRoots: [root], fileListMax: 2 })
  t.after(() => s.close())
  const token = await clientToken(s)
  const listed = await (await authGet(s, `/files/list?path=${encodeURIComponent(root)}&all=1`, token)).json()
  assert.deepEqual(listed.entries, [])
  assert.equal(listed.truncated, true)
})

