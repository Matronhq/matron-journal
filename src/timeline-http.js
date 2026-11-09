// HTTP surface of the projects timeline (spec 2026-11-09 projects timeline).
// Five reads over projects, missions, items and milestones; nothing here
// writes. The read functions in src/timeline.js assume valid input, so every
// parameter is validated here (400) before one is called.
import { json } from './http-body.js'
import { badRequest } from './http-who.js'
import { filteredAgent } from './privacy.js'
import { parseCursor } from './projects-feed.js'
import { weeksList, weekDetail, wentQuiet, openLong, finished, parseWeekKey, userTimeZone } from './timeline.js'

const WEEKS_LIMIT = { default: 12, max: 52 }
const FINISHED_LIMIT = { default: 30, max: 100 }

// The integer `limit` query parameter: its default when absent, null when not
// an integer in 1..max.
function limitOf(url, { default: dflt, max }) {
  const raw = url.searchParams.get('limit')
  if (raw == null) return dflt
  const n = Number(raw)
  return /^\d+$/.test(raw) && Number.isInteger(n) && n >= 1 && n <= max ? n : null
}

// GET /timeline/weeks?before=<week key>&limit=<1..52>
function handleWeeks(db, res, url, who, opts) {
  const limit = limitOf(url, WEEKS_LIMIT)
  if (limit == null) return badRequest(res)
  const before = url.searchParams.get('before')
  if (before != null && parseWeekKey(before, userTimeZone(db, who.userId)) == null) return badRequest(res)
  json(res, 200, weeksList(db, who.userId, { before, limit, ...opts }))
  return true
}

// GET /timeline/finished?before=<"<finished_at>:<project id>">&limit=<1..100>
function handleFinished(db, res, url, who, opts) {
  const limit = limitOf(url, FINISHED_LIMIT)
  if (limit == null) return badRequest(res)
  const before = url.searchParams.get('before')
  if (parseCursor(before) === undefined) return badRequest(res)
  json(res, 200, finished(db, who.userId, { before, limit, ...opts }))
  return true
}

export function handleTimelineRoute(ctx, req, res, url, who) {
  const { db } = ctx
  const path = url.pathname
  if (!path.startsWith('/timeline/')) return false
  if (req.method !== 'GET') return false
  const opts = { excludePrivateOwned: filteredAgent(db, who) }
  if (path === '/timeline/weeks') return handleWeeks(db, res, url, who, opts)
  if (path === '/timeline/quiet') { json(res, 200, wentQuiet(db, who.userId, opts)); return true }
  if (path === '/timeline/long') { json(res, 200, openLong(db, who.userId, opts)); return true }
  if (path === '/timeline/finished') return handleFinished(db, res, url, who, opts)
  const m = path.match(/^\/timeline\/weeks\/([^/]+)$/)
  if (!m) return false
  let week
  try { week = decodeURIComponent(m[1]) } catch { return badRequest(res) }
  const detail = weekDetail(db, who.userId, week, opts)
  if (!detail) return badRequest(res)
  json(res, 200, detail)
  return true
}
