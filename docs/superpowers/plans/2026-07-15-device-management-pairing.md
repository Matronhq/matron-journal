# Device Management & Pairing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Journal-side endpoints for app-managed device management: `GET /devices`, `POST /devices/:id/revoke`, and the `pair/start` → `pair/approve` → `pair/claim` device-authorization flow with mint-at-claim semantics.

**Architecture:** One new module `src/pairing.js` (an in-memory pending-pair store following the `makeRateLimiter`/`makeLoginGuard` factory pattern), five new routes in the existing `src/http.js` handler, one owner-scoped delete in `src/auth.js`, one roster query in `src/db.js`, wiring in `src/server.js`, and a `docs/protocol.md` section per endpoint. The `devices` row is minted at **claim** time by the existing `createAgent` — never at approve — so unclaimed pairs leave zero DB residue.

**Tech Stack:** Node 20 ES modules, better-sqlite3, node:test + assert/strict, no new dependencies.

**Spec:** `docs/superpowers/specs/2026-07-15-app-managed-agent-enrollment-design.md` (merged to master). Read it before starting any task.

## Global Constraints

- Working directory for ALL tasks: the git worktree at `/tmp/claude-1000/-home-danbarker/6b356d9f-a236-4ccc-8f3f-85e325c5614b/scratchpad/impl-wt`, branch `feat/device-management-pairing`. NEVER work in `/home/danbarker/matron-journal` itself — the live production service runs from that checkout, and `data/` inside it is the live production database. Never open, write, or point anything at that `data/` directory.
- All tests use `startTestServer()` from `test/helpers.js` (`:memory:` DBs). Never restart or touch `matron-journal.service`.
- Error envelope conventions (match existing code exactly): `{error:'bad_request'}` 400, `{error:'forbidden'}` 403, `{error:'not_found'}` 404, `{error:'conflict'}` 409, `{error:'rate_limited'}` 429. Not-owned and nonexistent resources are indistinguishable: both 404, never 403 (see `GET /convo/:id/messages` and `GET /media/:id`).
- Management endpoints are client-kind only: `if (who.kind !== 'client') return json(res, 403, { error: 'forbidden' })` — same gating as `POST /password`.
- Run the full suite (`npm test`, expect **all tests passing**; the pre-existing `POST /media over the size cap -> 413` test is known to flake rarely under load — rerun once if it's the only failure) before every commit.
- Every commit message ends with: `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`
- Push to `origin feat/device-management-pairing` after EVERY task commit (review bot reviews incrementally).

## File Structure

- `src/pairing.js` (create) — pending-pair store: code/token generation, TTL, cap, approve/claim state machine. Pure state, no DB, no HTTP.
- `src/db.js` (modify) — add `listDevices(db, userId)` roster query.
- `src/auth.js` (modify) — add `revokeOwnedDevice(db, userId, deviceId)` next to `revokeDevice`.
- `src/http.js` (modify) — two unauthenticated routes (`/pair/start`, `/pair/claim`) before the bearer gate; three authenticated routes (`GET /devices`, `POST /devices/:id/revoke`, `POST /pair/approve`) after `/password`.
- `src/server.js` (modify) — construct/accept the pair store, pass to `makeHttpHandler`.
- `test/pairing.test.js` (create) — store unit tests.
- `test/devices.test.js` (create) — roster + revoke endpoint tests.
- `test/pairing-http.test.js` (create) — end-to-end pairing flow tests.
- `docs/protocol.md` (modify) — endpoint list entries + "Device management & pairing" section.

---

### Task 1: Pending-pair store (`src/pairing.js`)

**Files:**
- Create: `src/pairing.js`
- Test: `test/pairing.test.js`

**Interfaces:**
- Consumes: nothing (node:crypto only).
- Produces (Tasks 4 relies on these exact signatures):
  - `makePairStore({ ttlMs = 600000, maxPending = 64 } = {})` returning:
    - `start() -> { pairCode: 'XXXX-XXXX', pollToken: <64-char hex>, expiresIn: <seconds> } | null` (null when at cap)
    - `approve(codeInput, { userId, agentName }) -> 'approved' | 'conflict' | 'not_found'`
    - `claim(pollToken) -> { status: 'pending' } | { status: 'approved', userId, agentName } | { status: 'not_found' }` (the `approved` return deletes the pair — one-shot)
    - `size() -> number`
  - `normalizeCode(input) -> string` (exported for tests)

- [ ] **Step 1: Write the failing tests**

Create `test/pairing.test.js`:

```js
import test from 'node:test'
import assert from 'node:assert/strict'
import { makePairStore, normalizeCode } from '../src/pairing.js'

test('start returns a well-formed pair and claim is pending until approve', () => {
  const store = makePairStore()
  const p = store.start()
  assert.match(p.pairCode, /^[0-9BCDFGHJKMNPQRSTVWXYZ]{4}-[0-9BCDFGHJKMNPQRSTVWXYZ]{4}$/)
  assert.match(p.pollToken, /^[0-9a-f]{64}$/)
  assert.equal(p.expiresIn, 600)
  assert.deepEqual(store.claim(p.pollToken), { status: 'pending' })
  assert.equal(store.size(), 1)
})

test('approve → claim returns identity exactly once, then not_found', () => {
  const store = makePairStore()
  const p = store.start()
  assert.equal(store.approve(p.pairCode, { userId: 7, agentName: 'dev-9' }), 'approved')
  const c = store.claim(p.pollToken)
  assert.deepEqual(c, { status: 'approved', userId: 7, agentName: 'dev-9' })
  assert.deepEqual(store.claim(p.pollToken), { status: 'not_found' })
  assert.equal(store.size(), 0)
})

test('approve normalizes user-typed codes (lowercase, hyphens, spaces)', () => {
  const store = makePairStore()
  const p = store.start()
  const sloppy = ` ${p.pairCode.toLowerCase().replace('-', ' ')} `
  assert.equal(store.approve(sloppy, { userId: 1, agentName: 'a' }), 'approved')
  assert.equal(normalizeCode('ab-cd 12'), 'ABCD12')
})

test('second approve of the same code is conflict; unknown code is not_found', () => {
  const store = makePairStore()
  const p = store.start()
  assert.equal(store.approve(p.pairCode, { userId: 1, agentName: 'a' }), 'approved')
  assert.equal(store.approve(p.pairCode, { userId: 2, agentName: 'b' }), 'conflict')
  // the winning approval is untouched by the losing one
  assert.deepEqual(store.claim(p.pollToken), { status: 'approved', userId: 1, agentName: 'a' })
  assert.equal(store.approve('ZZZZ-ZZZZ', { userId: 1, agentName: 'a' }), 'not_found')
})

test('expiry: approve and claim both see an expired pair as not_found', async () => {
  const store = makePairStore({ ttlMs: 20 })
  const p = store.start()
  await new Promise((r) => setTimeout(r, 40))
  assert.equal(store.approve(p.pairCode, { userId: 1, agentName: 'a' }), 'not_found')
  assert.deepEqual(store.claim(p.pollToken), { status: 'not_found' })
})

test('an approved-but-unclaimed pair also expires', async () => {
  const store = makePairStore({ ttlMs: 20 })
  const p = store.start()
  store.approve(p.pairCode, { userId: 1, agentName: 'a' })
  await new Promise((r) => setTimeout(r, 40))
  assert.deepEqual(store.claim(p.pollToken), { status: 'not_found' })
})

test('cap: start returns null at maxPending, and expired pairs free slots', async () => {
  const store = makePairStore({ ttlMs: 20, maxPending: 2 })
  assert.ok(store.start())
  assert.ok(store.start())
  assert.equal(store.start(), null)
  await new Promise((r) => setTimeout(r, 40))
  assert.ok(store.start()) // sweep on start() reclaimed the expired slots
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd /tmp/claude-1000/-home-danbarker/6b356d9f-a236-4ccc-8f3f-85e325c5614b/scratchpad/impl-wt && node --test test/pairing.test.js`
Expected: FAIL — `Cannot find module '../src/pairing.js'`

- [ ] **Step 3: Implement the store**

Create `src/pairing.js`:

```js
import crypto from 'node:crypto'

// Pair-code alphabet: Crockford base32 (no I/L/O/U lookalikes) minus the
// remaining vowels A/E so codes can't spell words. 30 chars; 8 chars ≈ 39
// bits — plenty for a code that grants nothing without an authenticated
// approval and dies in ttlMs anyway.
const ALPHABET = '0123456789BCDFGHJKMNPQRSTVWXYZ'
const CODE_LEN = 8

// crypto.randomInt is unbiased (rejection sampling), unlike bytes % 30.
const randomCode = () => Array.from({ length: CODE_LEN }, () => ALPHABET[crypto.randomInt(ALPHABET.length)]).join('')

// Boxes display XXXX-XXXX; humans type variations. Comparison happens on
// this normal form only.
export function normalizeCode(input) {
  return String(input).toUpperCase().replace(/[^0-9A-Z]/g, '')
}

// In-memory pending-pair store (spec: device-authorization flow, mint at
// claim). Same in-memory-factory shape as makeRateLimiter/makeLoginGuard:
// a restart forgets pending pairs, which is fine — the box CLI retries
// with a fresh code, and nothing durable exists until claim.
//
// Keyed by pollToken (the 256-bit claim secret) so claim() is a direct
// Map.get on the high-entropy value. approve() scans for the low-entropy
// display code instead — bounded by maxPending (≤64) and only reachable
// with an authenticated client bearer, so the scan is fine.
export function makePairStore({ ttlMs = 600000, maxPending = 64 } = {}) {
  const pairs = new Map() // pollToken -> { code, userId, agentName, approved, expiresAt }

  const sweep = (now) => {
    for (const [k, p] of pairs) if (now >= p.expiresAt) pairs.delete(k)
  }

  return {
    start() {
      const now = Date.now()
      sweep(now)
      if (pairs.size >= maxPending) return null
      let code
      do { code = randomCode() } while ([...pairs.values()].some((p) => p.code === code))
      const pollToken = crypto.randomBytes(32).toString('hex')
      pairs.set(pollToken, { code, userId: null, agentName: null, approved: false, expiresAt: now + ttlMs })
      return { pairCode: `${code.slice(0, 4)}-${code.slice(4)}`, pollToken, expiresIn: Math.floor(ttlMs / 1000) }
    },
    approve(codeInput, { userId, agentName }) {
      const now = Date.now()
      const code = normalizeCode(codeInput)
      for (const p of pairs.values()) {
        if (p.code !== code) continue
        if (now >= p.expiresAt) break // expired is indistinguishable from unknown
        if (p.approved) return 'conflict'
        p.approved = true
        p.userId = userId
        p.agentName = agentName
        return 'approved'
      }
      return 'not_found'
    },
    claim(pollToken) {
      const p = pairs.get(pollToken)
      if (!p || Date.now() >= p.expiresAt) {
        if (p) pairs.delete(pollToken)
        return { status: 'not_found' }
      }
      if (!p.approved) return { status: 'pending' }
      pairs.delete(pollToken) // one-shot: the pair is gone before the caller sees the identity
      return { status: 'approved', userId: p.userId, agentName: p.agentName }
    },
    size() { return pairs.size },
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test test/pairing.test.js`
Expected: 7 passing.

- [ ] **Step 5: Run the full suite, then commit and push**

Run: `npm test` — expect all passing.

```bash
git add src/pairing.js test/pairing.test.js
git commit -m "feat: in-memory pending-pair store for device-authorization pairing

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
git push origin feat/device-management-pairing
```

---

### Task 2: Device roster — `GET /devices`

**Files:**
- Modify: `src/db.js` (append the new function at the end of the file)
- Modify: `src/http.js` (imports at top; new route after the `/password` block, which currently ends at line 149)
- Modify: `docs/protocol.md` (HTTP endpoints list, after the `GET /metrics` entry)
- Test: `test/devices.test.js` (create)

**Interfaces:**
- Consumes: the `devices` table (columns `id, user_id, kind, name, token_hash, created_at, last_seen_at, cursor`) and `user_seq` (`user_id, seq`) — the same pair `buildMetrics` reads in `src/metrics.js:11-15`.
- Produces: `listDevices(db, userId) -> [{ device_id, kind, name, created_at, cursor, last_seen_at, lag }]` (Task 3's test reuses the endpoint; nothing else consumes the function).

- [ ] **Step 1: Write the failing tests**

Create `test/devices.test.js`:

```js
import test from 'node:test'
import assert from 'node:assert/strict'
import { startTestServer } from './helpers.js'
import { createUser, createAgent } from '../src/auth.js'

test('GET /devices lists only the caller user devices, marks is_self, gates agents', async (t) => {
  const s = await startTestServer()
  t.after(() => s.close())
  const dan = await createUser(s.db, 'dan', 'hunter22')
  const agent = createAgent(s.db, dan.id, 'dev-9')
  await createUser(s.db, 'pat', 'password')
  const patLogin = await s.http('/login', { method: 'POST', body: { username: 'pat', password: 'password', device_name: 'pat-phone' } })

  const login = await s.http('/login', { method: 'POST', body: { username: 'dan', password: 'hunter22', device_name: 'dan-mac' } })
  const r = await s.http('/devices', { token: login.json.token })
  assert.equal(r.status, 200)
  // dan has exactly two devices: the agent and this client — never pat's
  assert.equal(r.json.devices.length, 2)
  const kinds = r.json.devices.map((d) => d.kind).sort()
  assert.deepEqual(kinds, ['agent', 'client'])
  const self = r.json.devices.find((d) => d.is_self)
  assert.equal(self.device_id, login.json.device_id)
  assert.equal(self.name, 'dan-mac')
  const agentRow = r.json.devices.find((d) => d.kind === 'agent')
  assert.equal(agentRow.is_self, false)
  assert.equal(agentRow.name, 'dev-9')
  // roster shape: exactly these keys, no token_hash/user_id leakage
  assert.deepEqual(Object.keys(agentRow).sort(),
    ['created_at', 'cursor', 'device_id', 'is_self', 'kind', 'lag', 'last_seen_at', 'name'])

  // agent bearers are gated like /password: 403 forbidden
  const asAgent = await s.http('/devices', { token: agent.token })
  assert.equal(asAgent.status, 403)
  assert.deepEqual(asAgent.json, { error: 'forbidden' })

  // pat sees only pat's device
  const patR = await s.http('/devices', { token: patLogin.json.token })
  assert.equal(patR.json.devices.length, 1)
  assert.equal(patR.json.devices[0].name, 'pat-phone')

  // unauthenticated: 401
  assert.equal((await s.http('/devices', {})).status, 401)
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test test/devices.test.js`
Expected: FAIL — `GET /devices` returns 404 `{error:'not_found'}` (route doesn't exist), so `r.status` is 404 not 200.

- [ ] **Step 3: Implement**

Append to `src/db.js`:

```js
// Roster for GET /devices — same devices+user_seq read as buildMetrics
// (src/metrics.js), plus name/created_at, which metrics deliberately omits.
// token_hash and user_id never leave this function.
export function listDevices(db, userId) {
  const head = db.prepare('SELECT seq FROM user_seq WHERE user_id=?').get(userId)
  const headSeq = head ? head.seq : 0
  return db.prepare(
    'SELECT id AS device_id, kind, name, created_at, cursor, last_seen_at FROM devices WHERE user_id=? ORDER BY id'
  ).all(userId).map((d) => ({ ...d, lag: headSeq - d.cursor }))
}
```

In `src/http.js`, extend the `./db.js` import (line 4):

```js
import { insertBlob, getBlob, setApnsRegistration, listDevices } from './db.js'
```

Insert after the `/password` block (after the line `return json(res, 200, { ok: true })` closing it, currently line 148-149):

```js
      if (req.method === 'GET' && url.pathname === '/devices') {
        // Management surface: client devices only, same gating as /password —
        // an agent has no business enumerating its user's other devices.
        if (who.kind !== 'client') return json(res, 403, { error: 'forbidden' })
        const devices = listDevices(db, who.userId).map((d) => ({ ...d, is_self: d.device_id === who.deviceId }))
        return json(res, 200, { devices })
      }
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test test/devices.test.js` — expect 1 passing.
Run: `npm test` — expect all passing (metrics tests prove `/metrics` is unperturbed).

- [ ] **Step 5: Document in protocol.md**

In `docs/protocol.md`, after the `GET /metrics` bullet (ends line 57), add:

```markdown
- `GET /devices` (Bearer, client devices only — agents get 403
  `{error:'forbidden'}`) -> `{devices: [{device_id, kind, name, created_at,
  cursor, lag, last_seen_at, is_self}]}`. The caller's own user's devices
  only; `is_self` marks the requesting device. Overlaps `/metrics`'
  `user.devices` deliberately — metrics is observability (agents may read
  it, no `name`), this is the management roster.
```

- [ ] **Step 6: Commit and push**

```bash
git add src/db.js src/http.js test/devices.test.js docs/protocol.md
git commit -m "feat: GET /devices roster (client-only, is_self, no hash leakage)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
git push origin feat/device-management-pairing
```

---

### Task 3: Revocation — `POST /devices/:id/revoke`

**Files:**
- Modify: `src/auth.js` (add `revokeOwnedDevice` directly under `revokeDevice`, currently line 87-89)
- Modify: `src/http.js` (import; route after the `GET /devices` block from Task 2)
- Modify: `docs/protocol.md` ("Device revocation" section, currently starting line 155)
- Test: `test/devices.test.js` (append a second test)

**Interfaces:**
- Consumes: `startTestServer`, `createUser`, `createAgent` (as Task 2).
- Produces: `revokeOwnedDevice(db, userId, deviceId) -> boolean` (true iff a row was deleted).

- [ ] **Step 1: Write the failing test**

Append to `test/devices.test.js`:

```js
test('POST /devices/:id/revoke: owner-scoped, 404 for not-owned/nonexistent, self-revoke works', async (t) => {
  const s = await startTestServer()
  t.after(() => s.close())
  const dan = await createUser(s.db, 'dan', 'hunter22')
  const agent = createAgent(s.db, dan.id, 'dev-9')
  await createUser(s.db, 'pat', 'password')
  const pat = await s.http('/login', { method: 'POST', body: { username: 'pat', password: 'password', device_name: 'x' } })
  const dan1 = await s.http('/login', { method: 'POST', body: { username: 'dan', password: 'hunter22', device_name: 'mac' } })

  // pat cannot revoke dan's agent — 404, indistinguishable from nonexistent
  const notOwned = await s.http(`/devices/${agent.deviceId}/revoke`, { method: 'POST', token: pat.json.token })
  assert.equal(notOwned.status, 404)
  assert.deepEqual(notOwned.json, { error: 'not_found' })
  const nonexistent = await s.http('/devices/999999/revoke', { method: 'POST', token: dan1.json.token })
  assert.equal(nonexistent.status, 404)
  assert.deepEqual(nonexistent.json, { error: 'not_found' })

  // agents cannot revoke anything: 403 before any lookup
  const asAgent = await s.http(`/devices/${dan1.json.device_id}/revoke`, { method: 'POST', token: agent.token })
  assert.equal(asAgent.status, 403)

  // owner revokes the agent: row gone, token dead on next use
  const ok = await s.http(`/devices/${agent.deviceId}/revoke`, { method: 'POST', token: dan1.json.token })
  assert.equal(ok.status, 200)
  assert.deepEqual(ok.json, { ok: true })
  assert.equal((await s.http('/snapshot', { token: agent.token })).status, 401)
  // idempotence surface: revoking again is 404 (row no longer exists)
  assert.equal((await s.http(`/devices/${agent.deviceId}/revoke`, { method: 'POST', token: dan1.json.token })).status, 404)

  // self-revocation is allowed (it is a logout) — the very token used dies
  const self = await s.http(`/devices/${dan1.json.device_id}/revoke`, { method: 'POST', token: dan1.json.token })
  assert.equal(self.status, 200)
  assert.equal((await s.http('/devices', { token: dan1.json.token })).status, 401)
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test test/devices.test.js`
Expected: the new test FAILS — the revoke URL falls through to the handler's final 404, so the "owner revokes" assertion gets 404 where 200 is expected. (The 404/403 assertions may coincidentally pass; the `ok.status` one cannot.)

- [ ] **Step 3: Implement**

In `src/auth.js`, directly under `revokeDevice` (line 87-89), add:

```js
// Owner-scoped revocation for POST /devices/:id/revoke. One atomic DELETE
// (no TOCTOU window): the WHERE clause is the ownership check, and the
// boolean lets the handler 404 nonexistent and not-owned identically.
export function revokeOwnedDevice(db, userId, deviceId) {
  return db.prepare('DELETE FROM devices WHERE id=? AND user_id=?').run(deviceId, userId).changes > 0
}
```

In `src/http.js`, extend the `./auth.js` import (line 2):

```js
import { login, authToken, changePassword, revokeOwnedDevice } from './auth.js'
```

Insert directly after the `GET /devices` block from Task 2:

```js
      const dm = url.pathname.match(/^\/devices\/(\d+)\/revoke$/)
      if (req.method === 'POST' && dm) {
        if (who.kind !== 'client') return json(res, 403, { error: 'forbidden' })
        // Deleting the row IS the revocation (docs/protocol.md "Device
        // revocation"): HTTP 401s on the next call, WS closes next-frame or
        // via the ≤60s sweep. Not-owned and nonexistent are indistinguishable.
        if (!revokeOwnedDevice(db, who.userId, Number(dm[1]))) return json(res, 404, { error: 'not_found' })
        return json(res, 200, { ok: true })
      }
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test test/devices.test.js` — expect 2 passing.
Run: `npm test` — expect all passing.

- [ ] **Step 5: Document in protocol.md**

In `docs/protocol.md`'s "Device revocation" section (starts line 155), after the sentence ending "…and last-seen time." append to the section:

```markdown
Owners can also revoke from a client device over HTTP:
`POST /devices/:id/revoke` (Bearer, client devices only — agents get 403)
deletes the row exactly like `matron-admin device revoke`; not-owned and
nonexistent ids are indistinguishable (404 `{error:'not_found'}`).
Self-revocation is allowed and acts as a logout. WS enforcement is the
same next-frame-or-≤60s-sweep described above.
```

- [ ] **Step 6: Commit and push**

```bash
git add src/auth.js src/http.js test/devices.test.js docs/protocol.md
git commit -m "feat: POST /devices/:id/revoke — owner-scoped, 404-indistinguishable

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
git push origin feat/device-management-pairing
```

---

### Task 4: Pairing endpoints — `/pair/start`, `/pair/approve`, `/pair/claim`

**Files:**
- Modify: `src/server.js` (signature line 173-177; construction near line 193; handler wiring line 207-210)
- Modify: `src/http.js` (imports; two unauthenticated routes; one authenticated route)
- Modify: `docs/protocol.md` (endpoints list + new section after "Device revocation")
- Test: `test/pairing-http.test.js` (create)

**Interfaces:**
- Consumes: `makePairStore` from Task 1 (exact signatures in Task 1's Produces block); `createAgent(db, userId, name) -> { token, deviceId }` from `src/auth.js:74`; `listDevices` endpoint from Task 2 (for the no-orphans assertion); `makeWsClient(base, { token, cursor })` from `test/helpers.js:26`.
- Produces: nothing consumed by later tasks (this is the last code task).

- [ ] **Step 1: Write the failing tests**

Create `test/pairing-http.test.js`:

```js
import test from 'node:test'
import assert from 'node:assert/strict'
import { startTestServer, makeWsClient } from './helpers.js'
import { createUser, createAgent } from '../src/auth.js'
import { makePairStore } from '../src/pairing.js'

async function loggedInClient(s, username = 'dan', password = 'hunter22') {
  await createUser(s.db, username, password)
  const login = await s.http('/login', { method: 'POST', body: { username, password, device_name: 'phone' } })
  return login.json
}

test('happy path: start → approve → claim mints the device at claim; token works over ws', async (t) => {
  const s = await startTestServer()
  t.after(() => s.close())
  const me = await loggedInClient(s)

  const start = await s.http('/pair/start', { method: 'POST', body: {} })
  assert.equal(start.status, 200)
  assert.match(start.json.pair_code, /^[0-9BCDFGHJKMNPQRSTVWXYZ]{4}-[0-9BCDFGHJKMNPQRSTVWXYZ]{4}$/)
  assert.match(start.json.poll_token, /^[0-9a-f]{64}$/)
  assert.equal(start.json.expires_in, 600)

  // pending before approve; and crucially NO device row exists yet
  const pending = await s.http('/pair/claim', { method: 'POST', body: { poll_token: start.json.poll_token } })
  assert.deepEqual(pending.json, { status: 'pending' })
  let roster = await s.http('/devices', { token: me.token })
  assert.equal(roster.json.devices.length, 1) // just the phone

  const approve = await s.http('/pair/approve', { method: 'POST', token: me.token, body: { pair_code: start.json.pair_code, agent_name: 'dev-9' } })
  assert.equal(approve.status, 200)
  assert.deepEqual(approve.json, { status: 'approved' })
  // still no device row: mint happens at claim, not approve
  roster = await s.http('/devices', { token: me.token })
  assert.equal(roster.json.devices.length, 1)

  const claim = await s.http('/pair/claim', { method: 'POST', body: { poll_token: start.json.poll_token } })
  assert.equal(claim.status, 200)
  assert.equal(claim.json.status, 'approved')
  assert.match(claim.json.token, /^[0-9a-f]{64}$/)
  assert.ok(Number.isInteger(claim.json.device_id))

  // exactly once: second claim is 404
  const again = await s.http('/pair/claim', { method: 'POST', body: { poll_token: start.json.poll_token } })
  assert.equal(again.status, 404)

  // the minted device is a real agent of the approving user…
  roster = await s.http('/devices', { token: me.token })
  const minted = roster.json.devices.find((d) => d.device_id === claim.json.device_id)
  assert.equal(minted.kind, 'agent')
  assert.equal(minted.name, 'dev-9')
  // …and its token authenticates over ws like any agent
  const ws = await makeWsClient(s.base, { token: claim.json.token, cursor: null })
  await ws.waitFor((f) => f.op === 'hello_ok')
  ws.close()
})

test('double-approve is 409; exactly one device row after the eventual claim', async (t) => {
  const s = await startTestServer()
  t.after(() => s.close())
  const me = await loggedInClient(s)
  const start = await s.http('/pair/start', { method: 'POST', body: {} })
  const a1 = await s.http('/pair/approve', { method: 'POST', token: me.token, body: { pair_code: start.json.pair_code, agent_name: 'dev-9' } })
  assert.equal(a1.status, 200)
  const a2 = await s.http('/pair/approve', { method: 'POST', token: me.token, body: { pair_code: start.json.pair_code, agent_name: 'other' } })
  assert.equal(a2.status, 409)
  assert.deepEqual(a2.json, { error: 'conflict' })
  await s.http('/pair/claim', { method: 'POST', body: { poll_token: start.json.poll_token } })
  const roster = await s.http('/devices', { token: me.token })
  assert.equal(roster.json.devices.filter((d) => d.kind === 'agent').length, 1)
  assert.equal(roster.json.devices.find((d) => d.kind === 'agent').name, 'dev-9')
})

test('expired approved-but-unclaimed pair leaves zero DB residue', async (t) => {
  const s = await startTestServer({ pairs: makePairStore({ ttlMs: 30 }) })
  t.after(() => s.close())
  const me = await loggedInClient(s)
  const start = await s.http('/pair/start', { method: 'POST', body: {} })
  await s.http('/pair/approve', { method: 'POST', token: me.token, body: { pair_code: start.json.pair_code, agent_name: 'dev-9' } })
  await new Promise((r) => setTimeout(r, 60))
  const claim = await s.http('/pair/claim', { method: 'POST', body: { poll_token: start.json.poll_token } })
  assert.equal(claim.status, 404)
  const roster = await s.http('/devices', { token: me.token })
  assert.equal(roster.json.devices.length, 1) // no orphan agent row, ever
})

test('gating and validation: approve needs a client bearer; bad bodies 400; unknown code 404', async (t) => {
  const s = await startTestServer()
  t.after(() => s.close())
  const me = await loggedInClient(s)
  const agent = createAgent(s.db, 1, 'existing-agent')

  const asAgent = await s.http('/pair/approve', { method: 'POST', token: agent.token, body: { pair_code: 'XXXX-XXXX', agent_name: 'x' } })
  assert.equal(asAgent.status, 403)
  assert.equal((await s.http('/pair/approve', { method: 'POST', body: { pair_code: 'XXXX-XXXX', agent_name: 'x' } })).status, 401)

  for (const body of [{}, { pair_code: 'ABCD-1234' }, { agent_name: 'x' }, { pair_code: 7, agent_name: 'x' }, { pair_code: 'ABCD-1234', agent_name: '' }]) {
    const r = await s.http('/pair/approve', { method: 'POST', token: me.token, body })
    assert.equal(r.status, 400, JSON.stringify(body))
    assert.deepEqual(r.json, { error: 'bad_request' })
  }
  const unknown = await s.http('/pair/approve', { method: 'POST', token: me.token, body: { pair_code: 'XXXX-XXXX', agent_name: 'x' } })
  assert.equal(unknown.status, 404)

  for (const body of [{}, { poll_token: 7 }, { poll_token: '' }]) {
    const r = await s.http('/pair/claim', { method: 'POST', body })
    assert.equal(r.status, 400, JSON.stringify(body))
  }
  assert.equal((await s.http('/pair/claim', { method: 'POST', body: { poll_token: 'f'.repeat(64) } })).status, 404)
})

test('pair/start is rate-limited per IP (shared /login budget) and capped by the store', async (t) => {
  // rateLimiter default: 5/min per IP. All test-client requests share 127.0.0.1.
  const s = await startTestServer({ pairs: makePairStore({ maxPending: 2 }) })
  t.after(() => s.close())
  const r1 = await s.http('/pair/start', { method: 'POST', body: {} })
  const r2 = await s.http('/pair/start', { method: 'POST', body: {} })
  assert.equal(r1.status, 200)
  assert.equal(r2.status, 200)
  // 3rd within the IP budget but over the store cap → 429 from the cap
  const r3 = await s.http('/pair/start', { method: 'POST', body: {} })
  assert.equal(r3.status, 429)
  assert.deepEqual(r3.json, { error: 'rate_limited' })
  // 4th and 5th burn the remaining IP budget; 6th is the limiter's 429
  await s.http('/pair/start', { method: 'POST', body: {} })
  await s.http('/pair/start', { method: 'POST', body: {} })
  const r6 = await s.http('/pair/start', { method: 'POST', body: {} })
  assert.equal(r6.status, 429)
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test test/pairing-http.test.js`
Expected: FAIL — `/pair/start` without a bearer hits the auth gate and returns 401 (route doesn't exist yet), so the first assertion (`start.status` 200) fails.

- [ ] **Step 3: Wire the store through server.js**

In `src/server.js`:

Add to the imports (line 5-6 area):

```js
import { makePairStore } from './pairing.js'
```

Add `pairs` to the `startServer` options destructure (line 173-177):

```js
export function startServer({
  dbPath, port = 0, bind = '127.0.0.1', mediaDir, mediaMaxBytes, apnsClient, replayBackpressureBytes,
  retentionDays, retentionIntervalMs, maxReplay, revocationSweepMs, walCheckpointIntervalMs, toolStreamOpts,
  toolLogTtlHours, pairs,
} = {}) {
```

After `const loginGuard = makeLoginGuard()` (line 194):

```js
  const resolvedPairs = pairs || makePairStore()
```

And pass it in the `makeHttpHandler({...})` call (line 207-210):

```js
  const server = http.createServer(makeHttpHandler({
    db, rateLimiter, loginGuard, mediaDir: resolvedMediaDir, mediaMaxBytes: resolvedMediaMaxBytes,
    hub, pushPipeline, dbPath: resolvedDbPath, pairs: resolvedPairs,
  }))
```

- [ ] **Step 4: Add the routes in http.js**

Extend the `./auth.js` import (line 2) with `createAgent`:

```js
import { login, authToken, changePassword, revokeOwnedDevice, createAgent } from './auth.js'
```

Add `pairs` to the `makeHttpHandler` destructure (line 70):

```js
export function makeHttpHandler({ db, rateLimiter, loginGuard, mediaDir, mediaMaxBytes, hub, pushPipeline, dbPath, pairs }) {
```

Insert the two UNAUTHENTICATED routes immediately after the closing brace of the `/login` block (line 113) and BEFORE `const who = bearer(req) && …` (line 114):

```js
      if (req.method === 'POST' && url.pathname === '/pair/start') {
        // Unauthenticated by design: this grants nothing — the pair becomes
        // an agent only if an authenticated client approves the code, and
        // it binds to whichever user approves. Shares /login's per-IP
        // limiter instance (spec: same budget class) so the whole
        // unauthenticated surface sits under one throttle.
        const ip = req.headers['cf-connecting-ip'] || req.socket.remoteAddress || 'unknown'
        if (!rateLimiter.allow(ip)) return rejectEarly(req, res, 429, { error: 'rate_limited' })
        await readBody(req) // no fields today; still drains/validates the body
        const p = pairs.start()
        // Pending-map cap: same envelope as the limiter — a caller can't
        // tell which throttle it hit, and shouldn't need to.
        if (!p) return json(res, 429, { error: 'rate_limited' })
        return json(res, 200, { pair_code: p.pairCode, poll_token: p.pollToken, expires_in: p.expiresIn })
      }
      if (req.method === 'POST' && url.pathname === '/pair/claim') {
        // Deliberately not rate-limited: the box polls this every few
        // seconds for up to the TTL, and each miss costs one Map.get on a
        // 256-bit key — guessing poll_tokens is not a realistic attack.
        const { poll_token } = await readBody(req)
        if (typeof poll_token !== 'string' || !poll_token) return json(res, 400, { error: 'bad_request' })
        const c = pairs.claim(poll_token)
        if (c.status === 'not_found') return json(res, 404, { error: 'not_found' })
        if (c.status === 'pending') return json(res, 200, { status: 'pending' })
        // Mint at claim (spec): the devices row first exists HERE. The pair
        // is already deleted; if createAgent somehow threw, the box retries
        // with a fresh code and no orphan row exists either way.
        const d = createAgent(db, c.userId, c.agentName)
        return json(res, 200, { status: 'approved', token: d.token, device_id: d.deviceId })
      }
```

Insert the AUTHENTICATED route after the revoke block from Task 3:

```js
      if (req.method === 'POST' && url.pathname === '/pair/approve') {
        if (who.kind !== 'client') return json(res, 403, { error: 'forbidden' })
        const { pair_code, agent_name } = await readBody(req)
        if (typeof pair_code !== 'string' || !pair_code ||
            typeof agent_name !== 'string' || !agent_name) {
          return json(res, 400, { error: 'bad_request' })
        }
        const r = pairs.approve(pair_code, { userId: who.userId, agentName: agent_name })
        // conflict (already approved) is distinguishable — the caller is
        // authenticated, so this leaks nothing exploitable and tells a
        // double-tapping user the truth. Unknown and expired stay merged
        // into 404, same anti-enumeration stance as everywhere else.
        if (r === 'conflict') return json(res, 409, { error: 'conflict' })
        if (r === 'not_found') return json(res, 404, { error: 'not_found' })
        return json(res, 200, { status: 'approved' })
      }
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `node --test test/pairing-http.test.js` — expect 5 passing.
Run: `npm test` — expect all passing.

- [ ] **Step 6: Document in protocol.md**

In the HTTP endpoints list, after the `GET /devices` entry added in Task 2:

```markdown
- `POST /pair/start` (unauthenticated; shares /login's per-IP rate limit) ->
  `{pair_code, poll_token, expires_in}`. Pending pairs are in-memory only
  (10-minute TTL, 64 outstanding max — 429 `rate_limited` beyond either);
  a restart forgets them.
- `POST /pair/approve {pair_code, agent_name}` (Bearer, client devices
  only) -> `{status:'approved'}`. Binds the pair to the approving caller's
  user. Exactly once per pair: already-approved is 409 `{error:'conflict'}`;
  unknown and expired are indistinguishable 404s. Codes are normalized
  (case/hyphens/spaces) before lookup.
- `POST /pair/claim {poll_token}` (unauthenticated) -> `{status:'pending'}`
  until approval, then exactly once `{status:'approved', token, device_id}`
  — the agent device row is minted at claim, not approve, so an unclaimed
  pair leaves no DB residue. Second claim / unknown / expired: 404.
```

After the "Device revocation" section, add a new section:

```markdown
## Agent pairing (device authorization)

`gh auth login`-style enrollment for headless boxes (spec:
`docs/superpowers/specs/2026-07-15-app-managed-agent-enrollment-design.md`).
The box calls `pair/start` and displays the `pair_code` (`XXXX-XXXX`,
Crockford base32 minus vowels); the human approves that code in an
authenticated client app with `pair/approve`, naming the agent; the box
polls `pair/claim` with its secret `poll_token` (32 random bytes hex,
never displayed) and receives the agent token exactly once, straight into
its token file — no human ever sees it. Nothing durable exists until
claim: approve only flips the in-memory pair's state, and the `devices`
row is created by the claim response itself. The approve→claim regret
window (≤ TTL) is accepted in v1; once claimed, the agent appears in
`GET /devices` and is revocable instantly.
```

- [ ] **Step 7: Commit and push**

```bash
git add src/server.js src/http.js test/pairing-http.test.js docs/protocol.md
git commit -m "feat: pair/start + pair/approve + pair/claim — mint-at-claim device authorization

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
git push origin feat/device-management-pairing
```

---

## Self-Review (completed by the plan author)

1. **Spec coverage:** roster with is_self ✓ (Task 2), revoke owner-scoped/404-indistinguishable/self-revoke ✓ (Task 3), pair trio with mint-at-claim ✓, 409 double-approve ✓, TTL + cap + shared rate limit ✓, one-shot claim ✓, no-orphans test ✓, ws hello with minted token ✓, protocol.md per endpoint ✓ (Tasks 2-4). Metrics regression: existing metrics tests run in every `npm test` and Task 2 asserts roster shape separately. Out of scope per spec: app UI, enroll CLI, matron-admin changes (none needed — `createAgent`/`revokeDevice` untouched).
2. **Placeholder scan:** none — every step carries full code and exact commands.
3. **Type consistency:** `makePairStore` signatures in Task 1's Produces match every use in Task 4; `revokeOwnedDevice(db, userId, deviceId)` matches Task 3's handler; `listDevices` key set matches Task 2's shape assertion; snake_case at the HTTP boundary, camelCase internally, consistent with existing code.
