// Storage for GitHub account links (spec 2026-09-23 tracker web/teams,
// "GitHub account linking"). Pure DB functions; the HTTP layer and the
// refresh job call these. The token column is written here and read by
// listGithubAccounts (the refresh job) — no view ever returns it.
import { randomBytes } from 'node:crypto'

export const LINK_FLOW_TTL_MS = 10 * 60 * 1000

export function githubAccountView(db, userId) {
  const row = db.prepare('SELECT host, login, state, checked_at, linked_at FROM github_accounts WHERE user_id=?').get(userId)
  if (!row) return null
  const orgs = db.prepare('SELECT scope FROM github_orgs WHERE user_id=? ORDER BY scope').all(userId).map((r) => r.scope)
  return { host: row.host, login: row.login, orgs, state: row.state, checked_at: row.checked_at, linked_at: row.linked_at }
}

// One GitHub identity per journal user, one journal user per identity.
export function saveGithubIdentity(db, { userId, host, identity, token, now = Date.now() }) {
  return db.transaction(() => {
    const other = db.prepare('SELECT user_id FROM github_accounts WHERE host=? AND github_id=? AND user_id<>?').get(host, identity.github_id, userId)
    if (other) throw new Error('github_conflict')
    db.prepare(`INSERT INTO github_accounts(user_id, host, github_id, login, token, state, checked_at, linked_at)
      VALUES(?,?,?,?,?,'ok',?,?)
      ON CONFLICT(user_id) DO UPDATE SET host=excluded.host, github_id=excluded.github_id, login=excluded.login,
        token=excluded.token, state='ok', checked_at=excluded.checked_at`).run(userId, host, identity.github_id, identity.login, token, now, now)
    db.prepare('DELETE FROM github_orgs WHERE user_id=?').run(userId)
    const ins = db.prepare('INSERT INTO github_orgs(user_id, scope) VALUES(?,?)')
    for (const scope of new Set(identity.scopes)) ins.run(userId, scope)
    return githubAccountView(db, userId)
  })()
}

export function markGithubStale(db, userId, now = Date.now()) {
  db.prepare("UPDATE github_accounts SET state='stale', checked_at=? WHERE user_id=?").run(now, userId)
}

export function deleteGithubAccount(db, userId) {
  return db.prepare('DELETE FROM github_accounts WHERE user_id=?').run(userId).changes > 0
}

export function listGithubAccounts(db) {
  return db.prepare('SELECT user_id, host, token FROM github_accounts ORDER BY user_id').all()
}

export function createLinkFlow(db, { userId, deviceId, flow, deviceCode = null, state = null, ttlMs = LINK_FLOW_TTL_MS, now = Date.now() }) {
  const id = `gl_${randomBytes(8).toString('hex')}`
  db.prepare('INSERT INTO github_link_flows(id, user_id, device_id, flow, device_code, state, expires_at, created_at) VALUES(?,?,?,?,?,?,?,?)')
    .run(id, userId, deviceId, flow, deviceCode, state, now + ttlMs, now)
  return db.prepare('SELECT * FROM github_link_flows WHERE id=?').get(id)
}

// Returns the row and deletes it — a flow is finished by exactly one poll
// or one callback. Expired rows are swept on read and answer null.
export function takeLinkFlow(db, { id = null, state = null, now = Date.now() }) {
  return db.transaction(() => {
    db.prepare('DELETE FROM github_link_flows WHERE expires_at <= ?').run(now)
    const row = id != null
      ? db.prepare('SELECT * FROM github_link_flows WHERE id=?').get(id)
      : (state != null ? db.prepare("SELECT * FROM github_link_flows WHERE state=? AND flow='web'").get(state) : null)
    if (!row) return null
    db.prepare('DELETE FROM github_link_flows WHERE id=?').run(row.id)
    return row
  })()
}
