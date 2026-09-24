import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { startTestServer } from './helpers.js'
import { createUser } from '../src/auth.js'
import { resolveWebDir } from '../src/static-http.js'

function webDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'matron-web-'))
  fs.writeFileSync(path.join(dir, 'index.html'), '<!doctype html><title>Matron</title>')
  fs.mkdirSync(path.join(dir, 'assets'))
  fs.writeFileSync(path.join(dir, 'assets', 'app-abc123.js'), 'console.log(1)')
  fs.writeFileSync(path.join(dir, 'favicon.svg'), '<svg/>')
  fs.mkdirSync(path.join(dir, '.git'))
  fs.writeFileSync(path.join(dir, '.git', 'config'), '[core]')
  fs.writeFileSync(path.join(dir, '.env'), 'SECRET=1')
  fs.writeFileSync(path.join(path.dirname(dir), 'outside.txt'), 'outside')
  return dir
}

test('static: files, index fallback for /u/* and /app/*, root redirect, HEAD, cache headers', async (t) => {
  const dir = webDir()
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const s = await startTestServer({ webDir: dir })
  t.after(() => s.close())
  const get = (p, headers = {}, method = 'GET') => fetch(s.base + p, { method, headers, redirect: 'manual' })

  const idx = await get('/u/dan/12')
  assert.equal(idx.status, 200)
  assert.match(idx.headers.get('content-type'), /^text\/html/)
  assert.equal(idx.headers.get('cache-control'), 'no-cache')
  assert.equal(idx.headers.get('x-frame-options'), 'DENY')
  assert.equal(idx.headers.get('x-content-type-options'), 'nosniff')
  assert.match(await idx.text(), /Matron/)
  for (const p of ['/app', '/app/', '/app/items/it_1', '/u/dan/1?x=1']) assert.equal((await get(p)).status, 200, p)

  const asset = await get('/assets/app-abc123.js')
  assert.equal(asset.status, 200)
  assert.match(asset.headers.get('content-type'), /^text\/javascript/)
  assert.equal(asset.headers.get('cache-control'), 'public, max-age=31536000, immutable')
  assert.equal(await asset.text(), 'console.log(1)')
  assert.match((await get('/favicon.svg')).headers.get('content-type'), /^image\/svg\+xml/)

  const head = await get('/assets/app-abc123.js', {}, 'HEAD')
  assert.equal(head.status, 200); assert.equal(head.headers.get('content-length'), '14'); assert.equal(await head.text(), '')

  const root = await get('/')
  assert.equal(root.status, 302); assert.equal(root.headers.get('location'), '/app/')

  // A path that is neither a file nor a fallback prefix is the API's 404/401, not a static one.
  assert.equal((await get('/nope.js')).status, 401)
  assert.equal((await get('/items')).status, 401)
  assert.equal((await get('/u/dan/12', {}, 'POST')).status, 401, 'static is GET/HEAD only')
})

test('static: traversal, dot-segments, backslashes and NUL never serve; JSON Accept on /u/* reaches the lookup route (review focus 3, 4)', async (t) => {
  const dir = webDir()
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const s = await startTestServer({ webDir: dir })
  t.after(() => s.close())
  const get = (p, headers = {}) => fetch(s.base + p, { headers, redirect: 'manual' })
  for (const p of ['/../outside.txt', '/%2e%2e/outside.txt', '/assets/%2e%2e/%2e%2e/outside.txt', '/.git/config', '/.env', '/app/../.env', '/assets/..%5c..%5coutside.txt', '/assets/app-abc123.js%00.html', '/%2e%2e%2f%2e%2e%2fetc%2fpasswd']) {
    const r = await get(p)
    assert.equal(r.status, 401, `${p} fell through to the API (unauthenticated)`)
    assert.ok(!(await r.text()).includes('outside'), `${p} leaked a file outside the web dir`)
  }
  assert.equal((await get('/assets/')).status, 401, 'a directory is not a file')
  await createUser(s.db, 'dan', 'pw123456')
  const tok = (await s.http('/login', { method: 'POST', body: { username: 'dan', password: 'pw123456', device_name: 'mac' } })).json.token
  const r = await get('/u/dan/1', { authorization: `Bearer ${tok}`, accept: 'application/json' })
  assert.equal(r.status, 404, 'the JSON lookup answered (404: dan has no item 1), not index.html')
  assert.deepEqual(await r.json(), { error: 'not_found' })
})

test('static: unset MATRON_WEB_DIR changes nothing; a missing index.html makes the fallbacks fall through; a bad dir fails at boot', async (t) => {
  const s = await startTestServer()
  t.after(() => s.close())
  assert.equal((await fetch(s.base + '/u/dan/12')).status, 401)
  assert.equal((await fetch(s.base + '/', { redirect: 'manual' })).status, 401)
  const bare = fs.mkdtempSync(path.join(os.tmpdir(), 'matron-web-bare-'))
  t.after(() => fs.rmSync(bare, { recursive: true, force: true }))
  const s2 = await startTestServer({ webDir: bare })
  t.after(() => s2.close())
  assert.equal((await fetch(s2.base + '/app/x')).status, 401)
  assert.equal(resolveWebDir(''), null)
  assert.equal(resolveWebDir(undefined), null)
  assert.throws(() => resolveWebDir(path.join(bare, 'missing')), /MATRON_WEB_DIR/)
  fs.writeFileSync(path.join(bare, 'a-file.txt'), '')
  assert.throws(() => resolveWebDir(path.join(bare, 'a-file.txt')), /MATRON_WEB_DIR/)
})
