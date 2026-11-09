// Weekly timeline: per-user time zone and local-week arithmetic (spec
// 2026-11-09 projects timeline). A "week" is Monday 00:00 to the next Monday
// 00:00 in the user's own zone, so a week spanning a clock change is 167 or
// 169 hours long. Every function takes and returns epoch milliseconds, except
// the week key, which is the local date of the Monday as 'YYYY-MM-DD'.

import { Cron } from 'croner'
import { DEFAULT_TZ, validTz } from './routines.js'

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
