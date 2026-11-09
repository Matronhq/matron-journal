// Weekly timeline: per-user time zone and local-week arithmetic (spec
// 2026-11-09 projects timeline). A "week" is Monday 00:00 to the next Monday
// 00:00 in the user's own zone, so a week spanning a clock change is 167 or
// 169 hours long. Every function takes and returns epoch milliseconds, except
// the week key, which is the local date of the Monday as 'YYYY-MM-DD'.

import { Cron } from 'croner'
import { DEFAULT_TZ, validTz } from './routines.js'
import { ORIGIN_SIEVE } from './missions.js'
import { privateDevice, privateConvo, filesSql, parseCursor } from './projects-feed.js'
import { PROJECT_ORIGIN_SIEVE } from './projects.js'

const MONDAY_MIDNIGHT = '0 0 * * 1'
const KEY_RE = /^(\d{4})-(\d{2})-(\d{2})$/

// Week maths runs on the request path of a synchronous server, and a list
// read asks for the same few boundaries hundreds of times, so the zone check,
// the per-zone Cron and every computed boundary are memoised (each map is
// cleared when it grows past its cap; a boundary never changes for a zone).
const CACHE_MAX = 50_000
const remember = (map, key, compute) => {
  if (map.has(key)) return map.get(key)
  if (map.size >= CACHE_MAX) map.clear()
  const value = compute()
  map.set(key, value)
  return value
}
const zoneChecks = new Map()
const crons = new Map()
const boundaries = new Map()
let cronRuns = 0
// Test seam: how many croner run computations have happened so far.
export const cronRunsForTest = () => cronRuns

const zoneOf = (tz) => (remember(zoneChecks, tz, () => validTz(tz)) ? tz : DEFAULT_TZ)
const mondays = (zone) => remember(crons, zone, () => new Cron(MONDAY_MIDNIGHT, { timezone: zone }))

export function userTimeZone(db, userId) {
  const row = db.prepare('SELECT time_zone FROM users WHERE id = ?').get(userId)
  return row ? zoneOf(row.time_zone) : DEFAULT_TZ
}

// The local Monday 00:00 at or before `ms`. croner counts in whole seconds and
// returns runs strictly before its reference, so the reference is a second on.
// Not memoised by `ms` (any instant); week starts themselves go through the
// cached boundaries below.
export function weekStartOf(ms, tz) {
  cronRuns += 1
  return mondays(zoneOf(tz)).previousRuns(1, new Date(ms + 1000))[0].getTime()
}

// The next local Monday 00:00 after `weekStart`.
export function weekEndOf(weekStart, tz) {
  const zone = zoneOf(tz)
  return remember(boundaries, `${zone}|end|${weekStart}`, () => {
    cronRuns += 1
    return mondays(zone).nextRun(new Date(weekStart)).getTime()
  })
}

export function previousWeekStart(weekStart, tz) {
  const zone = zoneOf(tz)
  return remember(boundaries, `${zone}|prev|${weekStart}`, () => weekStartOf(weekStart - 1, zone))
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

// ---- The five reads (weeks list, one week, went quiet, open a long time,
// finished). Every read takes `{ excludePrivateOwned, now }` last; the zone is
// the user's own. A project merged into another never appears as a row (its
// moves already count for the survivor); a filtered caller also loses
// private-origin projects, and its missions and moves go through the same
// sieves as the project feed.

// The thresholds, in one place.
export const TIMELINE = {
  storiesMax: 8, // data-only stories per week; the rest are "also"
  weeksPage: 12, // weeks per weeksList page by default
  listTop: 10, // rows shown by went quiet and open a long time
  sparkWeeks: 8, // the activity chart: weeks ending with the current one
  quietDays: 14, // went quiet: no move for this long ...
  quietWeeks: 8, // ... after moving in at least quietMovedWeeks of the
  quietMovedWeeks: 2, //   quietWeeks weeks ending with its last move's week
  openLongDays: 21, // open a long time: created at least this long ago
  finishedPage: 30,
}
const DAY_MS = 86400e3

const openMissionSql = (excludePrivateOwned) => `EXISTS (SELECT 1 FROM missions m
  WHERE m.project_id = p.id AND m.user_id = p.user_id AND m.state = 'open' ${excludePrivateOwned ? `AND ${ORIGIN_SIEVE}` : ''})`

// Every project the caller may see as a row, with whether it is live (open,
// with at least one open mission), whether it has any mission at all, and,
// when it is not live, when it finished: its close, else its newest mission
// close, else (no mission ever) its creation.
function rowProjects(db, userId, excludePrivateOwned) {
  const originSieve = excludePrivateOwned ? `AND ${ORIGIN_SIEVE}` : ''
  return db.prepare(`SELECT p.id, p.num, p.title, p.state, p.created_at,
      (p.state = 'open' AND ${openMissionSql(excludePrivateOwned)}) AS live,
      EXISTS (SELECT 1 FROM missions m WHERE m.project_id = p.id AND m.user_id = p.user_id ${originSieve}) AS has_mission,
      COALESCE(p.closed_at,
        (SELECT MAX(m.closed_at) FROM missions m WHERE m.project_id = p.id AND m.user_id = p.user_id ${originSieve}),
        p.created_at) AS finished_at
    FROM projects p
    WHERE p.user_id = ? AND p.merged_into IS NULL ${excludePrivateOwned ? `AND ${PROJECT_ORIGIN_SIEVE}` : ''}`)
    .all(userId).map((r) => ({ ...r, live: Boolean(r.live), has_mission: Boolean(r.has_mission) }))
}
const refOf = (p) => ({ id: p.id, num: p.num, title: p.title })

// The projects that moved, most moves first (ties by number), as
// [{ project, moved }]; projects the caller cannot see as rows are dropped.
function ranked(moves, byId) {
  return [...moves].filter(([id, n]) => n > 0 && byId.has(id))
    .map(([id, moved]) => ({ project: byId.get(id), moved }))
    .sort((a, b) => (b.moved - a.moved) || (a.project.num - b.project.num))
}

function weekSentence(moved) {
  const names = moved.slice(0, 3).map((r) => r.project.title)
  const rest = moved.length - names.length
  if (!names.length) return 'A quiet week.'
  if (rest > 0) return `${names.join(', ')} and ${rest} more moved.`
  if (names.length === 1) return `${names[0]} moved.`
  return `${names.slice(0, -1).join(', ')} and ${names.at(-1)} moved.`
}

// `count` week starts ending with the week of `lastStart`, oldest first.
function weeksEndingWith(lastStart, count, tz) {
  const out = [lastStart]
  while (out.length < count) out.unshift(previousWeekStart(out[0], tz))
  return out
}

// The newest move ever per project.
const lastMoves = (db, userId, excludePrivateOwned) => new Map(
  db.prepare(`SELECT project_id, MAX(at) AS at FROM (${movesSql(excludePrivateOwned)}) GROUP BY project_id`)
    .all({ userId }).map((r) => [r.project_id, r.at]))

// Weeks newest first from the current week (or from the week before
// `before`, a week key), down to the week of the user's earliest mission;
// quiet weeks included. null when `before` is not a week key.
export function weeksList(db, userId, { before = null, limit = TIMELINE.weeksPage, excludePrivateOwned = false, now = Date.now() } = {}) {
  const tz = userTimeZone(db, userId)
  const current = weekStartOf(now, tz)
  let first = current
  if (before != null) {
    const b = parseWeekKey(before, tz)
    if (b == null) return null
    first = Math.min(previousWeekStart(b, tz), current)
  }
  const earliest = db.prepare(`SELECT MIN(m.created_at) AS at FROM missions m
    WHERE m.user_id = ? ${excludePrivateOwned ? `AND ${ORIGIN_SIEVE}` : ''}`).get(userId).at
  const floor = Math.min(weekStartOf(earliest ?? now, tz), current)
  const starts = []
  for (let s = first; starts.length < limit && s >= floor; s = previousWeekStart(s, tz)) starts.push(s)
  const projects = rowProjects(db, userId, excludePrivateOwned)
  const byId = new Map(projects.map((p) => [p.id, p]))
  const weekly = projectWeeklyMoves(db, userId, [...byId.keys()], starts, tz, { excludePrivateOwned })
  const weeks = starts.map((start, i) => {
    const moved = ranked([...weekly].map(([id, counts]) => [id, counts[i]]), byId)
    return { week: formatWeekKey(start, tz), start, end: weekEndOf(start, tz), sentence: weekSentence(moved), moved: moved.length }
  })
  const oldest = starts.at(-1)
  return { weeks, next_before: oldest != null && oldest > floor ? formatWeekKey(oldest, tz) : null }
}

// One week's data-only page: a story per project that moved, most moves
// first, at most TIMELINE.storiesMax; the rest under `also`. null when
// `weekKey` is not a week key.
export function weekDetail(db, userId, weekKey, { excludePrivateOwned = false, now = Date.now() } = {}) {
  const tz = userTimeZone(db, userId)
  const start = parseWeekKey(weekKey, tz)
  if (start == null) return null
  const end = weekEndOf(start, tz)
  const byId = new Map(rowProjects(db, userId, excludePrivateOwned).map((p) => [p.id, p]))
  const moved = ranked(projectMoves(db, userId, { from: start, to: end, excludePrivateOwned }), byId)
  const shown = moved.slice(0, TIMELINE.storiesMax)
  const convoSieve = excludePrivateOwned ? `AND NOT ${privateConvo('c')} AND ${ORIGIN_SIEVE}` : ''
  // The project's missions and those still filed under a project merged into it.
  const inProject = 'm.project_id IN (SELECT q.id FROM projects q WHERE q.id = @projectId OR q.merged_into = @projectId)'
  const ofProject = `m.user_id = @userId AND ${inProject}`
  const sentence = db.prepare(`SELECT l.title FROM milestones l JOIN missions m ON m.id = l.mission_id
      JOIN conversations c ON c.id = l.convo_id
    WHERE ${ofProject} AND l.created_at >= @start AND l.created_at < @end ${convoSieve}
    ORDER BY l.created_at DESC, l.seq DESC LIMIT 1`)
  // Unlike projectDetail's needs-you: consent cards are left out, newest created first,
  // and only items created before the week ended.
  const needsYou = db.prepare(`SELECT i.id, i.num, i.title FROM items i JOIN missions m ON m.id = i.mission_id
      JOIN conversations c ON c.id = i.origin_convo_id
    WHERE ${ofProject} AND i.state = 'open' AND i.awaiting = 'user' AND i.consent IS NULL AND i.created_at < @end ${convoSieve}
    ORDER BY i.created_at DESC, i.num DESC`)
  // The project feed's files roll-up, narrowed to the week's pictures and videos.
  const media = db.prepare(`SELECT f.blob_id, f.content_type, f.name FROM (${filesSql(excludePrivateOwned, inProject)}) f
    WHERE f.at >= @start AND f.at < @end AND (f.content_type LIKE 'image/%' OR f.content_type LIKE 'video/%')
    ORDER BY f.at DESC, f.sort_key DESC LIMIT 1`)
  const stories = shown.map(({ project }) => {
    const args = { userId, projectId: project.id, start, end }
    return {
      project: refOf(project),
      sentence: sentence.get(args)?.title ?? null,
      next: null,
      needs_you: needsYou.all(args),
      media: media.get(args) ?? null,
    }
  })
  return {
    week: formatWeekKey(start, tz), start, end, final: end <= now, lede: null,
    stories,
    also: moved.slice(TIMELINE.storiesMax).map(({ project, moved: n }) => ({ ...refOf(project), moved: n })),
  }
}

// The activity chart for each row: TIMELINE.sparkWeeks counts ending with
// the current week, oldest first.
function withSparklines(db, userId, rows, tz, now, excludePrivateOwned) {
  const weeks = weeksEndingWith(weekStartOf(now, tz), TIMELINE.sparkWeeks, tz)
  const weekly = projectWeeklyMoves(db, userId, rows.map((r) => r.project.id), weeks, tz, { excludePrivateOwned })
  return rows.map((r) => ({ ...r, weekly: weekly.get(r.project.id) }))
}

// Live projects that moved in at least TIMELINE.quietMovedWeeks of the
// TIMELINE.quietWeeks weeks ending with their last move's week, and not for
// TIMELINE.quietDays since. Most moves in those weeks first; the top
// TIMELINE.listTop, with `total` the full count.
export function wentQuiet(db, userId, { excludePrivateOwned = false, now = Date.now() } = {}) {
  const tz = userTimeZone(db, userId)
  const last = lastMoves(db, userId, excludePrivateOwned)
  const candidates = rowProjects(db, userId, excludePrivateOwned)
    .filter((p) => p.live && last.has(p.id) && now - last.get(p.id) >= TIMELINE.quietDays * DAY_MS)
    .map((p) => {
      const weeks = weeksEndingWith(weekStartOf(last.get(p.id), tz), TIMELINE.quietWeeks, tz)
      return { project: p, last: last.get(p.id), weeks: weeks.map((s) => ({ start: s, end: weekEndOf(s, tz) })), counts: new Array(weeks.length).fill(0) }
    })
  if (candidates.length) {
    // One pass over every candidate's window.
    const byId = new Map(candidates.map((c) => [c.project.id, c]))
    const from = Math.min(...candidates.map((c) => c.weeks[0].start))
    const to = Math.max(...candidates.map((c) => c.weeks.at(-1).end))
    for (const { project_id: id, at } of moveRows(db, userId, { from, to, excludePrivateOwned })) {
      const c = byId.get(id)
      const i = c ? c.weeks.findIndex((w) => at >= w.start && at < w.end) : -1
      if (i >= 0) c.counts[i] += 1
    }
  }
  const quiet = candidates
    .filter((c) => c.counts.filter((n) => n > 0).length >= TIMELINE.quietMovedWeeks)
    .map((c) => ({ ...c, moves: c.counts.reduce((a, b) => a + b, 0) }))
    .sort((a, b) => (b.moves - a.moves) || (b.last - a.last) || (a.project.num - b.project.num))
  const rows = quiet.slice(0, TIMELINE.listTop)
    .map((c) => ({ project: refOf(c.project), last_moved_at: c.last, note: null }))
  return { total: quiet.length, rows: withSparklines(db, userId, rows, tz, now, excludePrivateOwned) }
}

// Live projects created at least TIMELINE.openLongDays ago, oldest first;
// the top TIMELINE.listTop, with `total` the full count.
export function openLong(db, userId, { excludePrivateOwned = false, now = Date.now() } = {}) {
  const tz = userTimeZone(db, userId)
  const long = rowProjects(db, userId, excludePrivateOwned)
    .filter((p) => p.live && now - p.created_at >= TIMELINE.openLongDays * DAY_MS)
    .sort((a, b) => (a.created_at - b.created_at) || (a.num - b.num))
  const last = lastMoves(db, userId, excludePrivateOwned)
  const rows = long.slice(0, TIMELINE.listTop).map((p) => ({
    project: refOf(p), created_at: p.created_at, last_moved_at: last.get(p.id) ?? null, note: null,
  }))
  return { total: long.length, rows: withSparklines(db, userId, rows, tz, now, excludePrivateOwned) }
}

// Projects with no open mission, or closed, newest finish first, paged by
// a "<finished_at>:<project id>" cursor. An open project that never had a
// mission (a filing leftover, e.g. emptied by a move) is not finished work
// and is left out. null when `before` is not a cursor.
export function finished(db, userId, { before = null, limit = TIMELINE.finishedPage, excludePrivateOwned = false } = {}) {
  const cursor = parseCursor(before)
  if (cursor === undefined) return null
  const rows = rowProjects(db, userId, excludePrivateOwned)
    .filter((p) => !p.live && (p.state === 'closed' || p.has_mission))
    .filter((p) => !cursor || p.finished_at < cursor.at || (p.finished_at === cursor.at && p.id < cursor.key))
    .sort((a, b) => (b.finished_at - a.finished_at) || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0))
  const shown = rows.slice(0, limit)
  const lastRow = shown.at(-1)
  return {
    rows: shown.map((p) => ({ project: refOf(p), finished_at: p.finished_at })),
    next_before: rows.length > limit ? `${lastRow.finished_at}:${lastRow.id}` : null,
  }
}
