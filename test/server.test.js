import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// Spawns `node <entrypoint>` and resolves once the "matron-journal
// listening on ..." boot line appears on stdout (proving the realpathSync
// entrypoint guard evaluated true), or rejects on early exit/timeout.
function runServerAndWaitForListen(entrypoint, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [entrypoint], { env })
    let out = ''
    let settled = false
    const timer = setTimeout(() => {
      if (!settled) { settled = true; child.kill(); reject(new Error(`timed out waiting for listen; output so far: ${out}`)) }
    }, 5000)
    child.stdout.on('data', (d) => {
      out += d.toString()
      const m = out.match(/matron-journal listening on [^\s]+:(\d+)/)
      if (m && !settled) { settled = true; clearTimeout(timer); resolve({ child, port: Number(m[1]) }) }
    })
    child.stderr.on('data', (d) => { out += d.toString() })
    child.on('error', (e) => { if (!settled) { settled = true; clearTimeout(timer); reject(e) } })
    child.on('exit', (code) => {
      if (!settled) { settled = true; clearTimeout(timer); reject(new Error(`server exited early (code ${code}); output: ${out}`)) }
    })
  })
}

test('server entrypoint starts when run directly and via a symlink (systemd/npx-style invocation)', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'matron-server-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const real = path.resolve('src/server.js')

  const dbPath1 = path.join(dir, 'direct.db')
  const { child: direct, port: port1 } = await runServerAndWaitForListen(real, { ...process.env, MATRON_DB: dbPath1, MATRON_PORT: '0' })
  assert.ok(port1 > 0)
  direct.kill()

  const link = path.join(dir, 'server-link.js')
  fs.symlinkSync(real, link)
  const dbPath2 = path.join(dir, 'link.db')
  const { child: viaLink, port: port2 } = await runServerAndWaitForListen(link, { ...process.env, MATRON_DB: dbPath2, MATRON_PORT: '0' })
  assert.ok(port2 > 0)
  viaLink.kill()
})
