// Daily re-read of every linked user's GitHub org memberships (spec
// 2026-09-23 tracker web/teams, "Refresh"). Same shape as scheduleRetention:
// run once at start, then on an unref'd interval; every failure is logged
// and never throws out of the tick.
import { listGithubAccounts } from './github-accounts.js'
import { refreshGithubAccount } from './github-http.js'

export const GITHUB_REFRESH_INTERVAL_MS = 24 * 60 * 60 * 1000

export async function runGithubRefresh(db, github, { now = Date.now(), log = console.log } = {}) {
  const out = { refreshed: 0, stale: 0, unchanged: 0 }
  for (const acct of listGithubAccounts(db)) {
    let r
    try {
      r = await refreshGithubAccount(db, github, acct.user_id, now)
    } catch (err) {
      log(`github-refresh: user=${acct.user_id} failed: ${err.message}`)
      out.unchanged++
      continue
    }
    if (!r) continue
    if (r.outcome === 'ok') out.refreshed++
    else if (r.outcome === 'stale') { out.stale++; log(`github-refresh: user=${acct.user_id} token refused, link marked stale`) }
    else { out.unchanged++; log(`github-refresh: user=${acct.user_id} unreachable (${r.error && r.error.code}), memberships kept`) }
  }
  return out
}

export function scheduleGithubRefresh(db, github, { intervalMs = GITHUB_REFRESH_INTERVAL_MS, log = console.log } = {}) {
  if (!github || !github.enabled) return null
  const run = () => { runGithubRefresh(db, github, { log }).catch((err) => console.error('github-refresh: run failed', err)) }
  run()
  const interval = setInterval(run, intervalMs)
  interval.unref()
  return interval
}
