// Shared fixtures for the File Explorer HTTP tests (files-http.test.js and
// files-config.test.js). Split across two files so neither runs long enough
// to meet the per-file test timeout on a loaded machine.
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { createUser } from '../src/auth.js'
import { makeHttpHandler } from '../src/http.js'
import { makeTmpDir } from './tmp-dir.js'

// Build a canonical read-root with a representative tree + adversarial entries.
export function makeFixture() {
  const root = fs.realpathSync(makeTmpDir('matron-files-'))
  const outside = fs.realpathSync(makeTmpDir('matron-files-outside-'))

  fs.writeFileSync(path.join(root, 'README.md'), '# hello\n')
  fs.writeFileSync(path.join(root, 'app.js'), 'console.log(1)\n')
  fs.writeFileSync(path.join(root, '.env'), 'SECRET=1\n')            // sensitive — always dropped
  fs.writeFileSync(path.join(root, '.hidden'), 'dot\n')             // hidden by default (dotfile)
  fs.mkdirSync(path.join(root, 'src'))
  fs.mkdirSync(path.join(root, 'node_modules'))                    // hidden by default
  fs.mkdirSync(path.join(root, '.git'))                            // hidden by default
  fs.writeFileSync(path.join(root, 'src', 'index.ts'), 'export {}\n')

  // Non-UTF8 binary, so a string-based path would corrupt it.
  const binBytes = Buffer.concat([Buffer.from([0xff, 0xfe, 0x00, 0x80, 0x81]), crypto.randomBytes(2048)])
  fs.writeFileSync(path.join(root, 'blob.bin'), binBytes)

  // Credential/config material reachable under a broad /root-style root.
  // Each must be dropped from listings (even ?all=1) and 403 on content/meta.
  fs.mkdirSync(path.join(root, '.codex'))
  fs.writeFileSync(path.join(root, '.codex', 'auth.json'), '{"OPENAI_API_KEY":"sk-x"}\n')
  fs.mkdirSync(path.join(root, '.config', 'gh'), { recursive: true })
  fs.writeFileSync(path.join(root, '.config', 'gh', 'hosts.yml'), 'token: ghp_x\n')
  fs.mkdirSync(path.join(root, '.claude'))
  fs.writeFileSync(path.join(root, '.claude', 'settings.json'), '{"k":"v"}\n')
  fs.writeFileSync(path.join(root, 'auth.json'), '{"token":"x"}\n')
  fs.writeFileSync(path.join(root, '.git-credentials'), 'https://x:y@github.com\n')
  fs.writeFileSync(path.join(root, '.pgpass'), 'localhost:5432:db:u:p\n')
  fs.writeFileSync(path.join(root, '.claude.json'), '{"k":"v"}\n')

  // Adversarial symlinks that must never be served / listed.
  fs.writeFileSync(path.join(outside, 'target.txt'), 'ESCAPED SECRET\n')
  fs.symlinkSync(path.join(outside, 'target.txt'), path.join(root, 'escape.txt'))     // symlink-out
  fs.writeFileSync(path.join(outside, 'config.json'), '{"token":"x"}\n')
  fs.symlinkSync(path.join(outside, 'config.json'), path.join(root, 'looksok.txt'))   // symlink-to-secret

  return { root, outside, binBytes }
}

// Credential entries: (segment-relative path, secret substring that must
// never appear in any response body).
export const CREDENTIAL_ENTRIES = [
  ['.codex/auth.json', 'sk-x'],
  ['.config/gh/hosts.yml', 'ghp_x'],
  ['.claude/settings.json', '"k":"v"'],
  ['auth.json', '"token":"x"'],
  ['.git-credentials', 'github.com'],
  ['.pgpass', '5432'],
  ['.claude.json', '"k":"v"'],
]

export const makeAdmin = (db, id) => db.prepare('UPDATE users SET is_admin=1 WHERE id=?').run(id)

export async function clientToken(s, name = 'op', pw = 'pw', { admin = true } = {}) {
  const user = await createUser(s.db, name, pw)
  if (admin) makeAdmin(s.db, user.id)
  const r = await s.http('/login', { method: 'POST', body: { username: name, password: pw, device_name: 'x' } })
  return r.json.token
}

export function authGet(s, pathAndQuery, token, headers = {}) {
  return fetch(s.base + pathAndQuery, { headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers } })
}

export function captureHttpHandlerOptions() {
  const capture = { options: null }
  capture.factory = (options) => {
    capture.options = options
    return makeHttpHandler(options)
  }
  return capture
}
