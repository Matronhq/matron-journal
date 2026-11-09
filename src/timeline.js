// Weekly timeline: per-user time zone and local-week arithmetic (spec
// 2026-11-09 projects timeline). A "week" is Monday 00:00 to the next Monday
// 00:00 in the user's own zone, so a week spanning a clock change is 167 or
// 169 hours long. Every function takes and returns epoch milliseconds, except
// the week key, which is the local date of the Monday as 'YYYY-MM-DD'.

import { Cron } from 'croner'
import { DEFAULT_TZ, validTz } from './routines.js'
import { ORIGIN_SIEVE } from './missions.js'
import { privateDevice, privateConvo } from './projects-feed.js'

const MONDAY_MIDNIGHT = '0 0 * * 1'
const KEY_RE = /^(\d{4})-(\d{2})-(\d{2})$/

const zoneOf = (tz) => (validTz(tz) ? tz : DEFAULT_TZ)
const mondays = (tz) => new Cron(MONDAY_MIDNIGHT, { timezone: zoneOf(tz) })

export function userTimeZone(db, userId) {
  const row = db.prepare('SELECT time_zone FROM users WHERE id = ?').get(userId)
  return row && validTz(row.time_zone) ? row.time_zone : DEFAULT_TZ
}

// The local Monday 00:00 at or before `ms`. croner counts in whole seconds and
// returns runs strictly before its reference, so the reference is a second on.
export function weekStartOf(ms, tz) {
  return mondays(tz).previousRuns(1, new Date(ms + 1000))[0].getTime()
}

// The next local Monday 00:00 after `weekStart`.
export function weekEndOf(weekStart, tz) {
  return mondays(tz).nextRun(new Date(weekStart)).getTime()
}

export function previousWeekStart(weekStart, tz) {
  return weekStartOf(weekStart - 1, tz)
}

// The local calendar date of the instant, 'YYYY-MM-DD'.
export function formatWeekKey(weekStart, tz) {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: zoneOf(tz), year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(new Date(weekStart))
  const get = (type) => parts.find((p) => p.type === type).value
  return `${get('year')}-${get('month')}-${get('day')}`
}

// The Monday-00:00 instant a week key names, or null when the key is not a
// real calendar date or not a Monday in `tz`.
export function parseWeekKey(key, tz) {
  const m = typeof key === 'string' ? KEY_RE.exec(key) : null
  if (!m) return null
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])]
  const noon = new Date(Date.UTC(y, mo - 1, d, 12))
  if (noon.getUTCFullYear() !== y || noon.getUTCMonth() !== mo - 1 || noon.getUTCDate() !== d) return null
  // UTC noon of the date lies inside that date's local week in every zone
  // (local time is between 00:00 that day and 02:00 the next), so the week
  // start found from it is the key's Monday exactly when the key is a Monday.
  const start = weekStartOf(noon.getTime(), tz)
  return formatWeekKey(start, tz) === key ? start : null
}

// What counts as a project "moving" in a window (spec 2026-11-09 projects
// timeline): a milestone posted, an item created or closed, a user-visible
// comment on an item, a mission created or closed. Chat traffic and a project
// status edit are not moves. Each move is credited to the surviving project
// when the mission's project was merged into another (merges flatten, so one
// hop reaches the survivor). `excludePrivateOwned` applies the same two sieves
// as the project feed: a private device's conversation or comment, and a
// mission born in a private device's conversation.
function movesSql(excludePrivateOwned) {
  const convoSieve = excludePrivateOwned ? `AND NOT ${privateConvo('c')} AND ${ORIGIN_SIEVE}` : ''
  const commentSieve = excludePrivateOwned ? `AND NOT ${privateDevice('ic.device_id')}` : ''
  const originSieve = excludePrivateOwned ? `AND ${ORIGIN_SIEVE}` : ''
  const of = 'COALESCE(p.merged_into, p.id)'
  const joinProject = 'JOIN projects p ON p.id = m.project_id AND p.user_id = m.user_id'
  return `SELECT ${of} AS project_id, l.created_at AS at
      FROM milestones l JOIN missions m ON m.id = l.mission_id ${joinProject}
      JOIN conversations c ON c.id = l.convo_id
      WHERE m.user_id = @userId ${convoSieve}
    UNION ALL
    SELECT ${of}, i.created_at
      FROM items i JOIN missions m ON m.id = i.mission_id ${joinProject}
      JOIN conversations c ON c.id = i.origin_convo_id
      WHERE m.user_id = @userId AND i.consent IS NULL ${convoSieve}
    UNION ALL
    SELECT ${of}, i.closed_at
      FROM items i JOIN missions m ON m.id = i.mission_id ${joinProject}
      JOIN conversations c ON c.id = i.origin_convo_id
      WHERE m.user_id = @userId AND i.consent IS NULL AND i.closed_at IS NOT NULL ${convoSieve}
    UNION ALL
    SELECT ${of}, ic.created_at
      FROM item_comments ic JOIN items i ON i.id = ic.item_id
      JOIN missions m ON m.id = i.mission_id ${joinProject}
      JOIN conversations c ON c.id = i.origin_convo_id
      WHERE m.user_id = @userId AND i.consent IS NULL AND ic.kind = 'comment' AND ic.withdrawn_at IS NULL
        ${convoSieve} ${commentSieve}
    UNION ALL
    SELECT ${of}, m.created_at
      FROM missions m ${joinProject}
      WHERE m.user_id = @userId ${originSieve}
    UNION ALL
    SELECT ${of}, m.closed_at
      FROM missions m ${joinProject}
      WHERE m.user_id = @userId AND m.closed_at IS NOT NULL ${originSieve}`
}

// Every move in [from, to) as {project_id, at}.
const moveRows = (db, userId, { from, to, excludePrivateOwned }) =>
  db.prepare(`SELECT project_id, at FROM (${movesSql(excludePrivateOwned)}) WHERE at >= @from AND at < @to`)
    .all({ userId, from, to })

// Moves per project with at least one in [from, to).
export function projectMoves(db, userId, { from, to, excludePrivateOwned = false }) {
  const rows = db.prepare(`SELECT project_id, COUNT(*) AS n FROM (${movesSql(excludePrivateOwned)})
      WHERE at >= @from AND at < @to GROUP BY project_id`).all({ userId, from, to })
  return new Map(rows.map((r) => [r.project_id, r.n]))
}

// One count per requested project and week start, oldest first (the order of
// `weekStarts`); a quiet week, or a project with no moves, is 0. One pass over
// the whole span: each move is placed in the week whose [start, end) holds it,
// with the ends from the zone's own calendar so a 167 or 169 hour week fits.
export function projectWeeklyMoves(db, userId, projectIds, weekStarts, tz, { excludePrivateOwned = false } = {}) {
  const out = new Map(projectIds.map((id) => [id, new Array(weekStarts.length).fill(0)]))
  if (!weekStarts.length) return out
  const weeks = weekStarts.map((start) => ({ start, end: weekEndOf(start, tz) }))
  const from = Math.min(...weeks.map((w) => w.start))
  const to = Math.max(...weeks.map((w) => w.end))
  for (const { project_id: id, at } of moveRows(db, userId, { from, to, excludePrivateOwned })) {
    const counts = out.get(id)
    if (!counts) continue
    const i = weeks.findIndex((w) => at >= w.start && at < w.end)
    if (i >= 0) counts[i] += 1
  }
  return out
}
