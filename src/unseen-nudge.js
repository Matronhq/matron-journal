// The unseen nudge (spec 2026-09-30 read state §6): tell the user's
// Coordinator when something important has gone unseen for a while, so it
// can decide whether to raise it. Modelled on the consent nudge: one
// ephemeral frame to the Coordinator's bridge, never journaled.
//
// Rules, per user with a Coordinator:
//   - only between 07:00 and 22:00 UK time;
//   - at most one nudge an hour;
//   - only for important entries unseen for 2 h or more, not yet raised
//     (unseen_flags) and newer than anything an earlier nudge covered — an
//     entry is nudged about once, whatever the Coordinator then decides;
//   - only when the Coordinator's bridge is connected; otherwise the next
//     tick tries again (nothing is recorded as covered).
// Also prunes raised-flags older than 30 days.
import { listUnseen, pruneFlags } from './seen.js'
import { getCoordinatorConvoId } from './coordinator.js'
import { isPrivateDevice } from './db.js'

export const UNSEEN_NUDGE_INTERVAL_MS = 10 * 60000
export const UNSEEN_NUDGE_AFTER_MS = 2 * 3600000
const NUDGE_GAP_MS = 3600000
const FLAG_TTL_MS = 30 * 86400000
const HOURS = { from: 7, to: 22 }
const FRAME_ENTRIES = 5

const ukHour = (now) => Number(new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London', hour: 'numeric', hourCycle: 'h23' }).format(now))

export function inNudgeHours(now) {
  const h = ukHour(now)
  return h >= HOURS.from && h < HOURS.to
}

function coordinatorOf(db, userId) {
  const convoId = getCoordinatorConvoId(db, userId)
  if (!convoId) return null
  const row = db.prepare('SELECT agent_device_id FROM conversations WHERE id=? AND owner_user_id=?').get(convoId, userId)
  return row?.agent_device_id != null ? { convoId, deviceId: row.agent_device_id } : null
}

const online = (hub, userId, deviceId) =>
  hub.connsOf(userId).some((c) => c.deviceId === deviceId && c.ws.readyState === 1)

// One pass over every user. Returns the number of nudges sent.
export function runUnseenNudge({ db, hub }, now = Date.now()) {
  try { pruneFlags(db, FLAG_TTL_MS, now) } catch (err) { console.error('unseen-nudge: flag prune failed', err) }
  if (!inNudgeHours(now)) return 0
  let sent = 0
  const users = db.prepare('SELECT user_id FROM user_settings WHERE coordinator_convo_id IS NOT NULL').all()
  for (const { user_id: userId } of users) {
    try {
      const coord = coordinatorOf(db, userId)
      if (!coord || !online(hub, userId, coord.deviceId)) continue
      const prev = db.prepare('SELECT last_at, covered_ts FROM unseen_nudges WHERE user_id=?').get(userId)
      if (prev && now - prev.last_at < NUDGE_GAP_MS) continue
      const { entries } = listUnseen(db, userId, {
        now, olderThanMs: UNSEEN_NUDGE_AFTER_MS, importance: 'important', limit: 200,
        excludePrivateOwned: !isPrivateDevice(db, coord.deviceId),
      })
      const fresh = entries.filter((e) => e.ts > (prev?.covered_ts ?? 0))
      if (fresh.length === 0) continue
      hub.sendToDevice(userId, coord.deviceId, {
        kind: 'unseen', event: 'pending', convo_id: coord.convoId, count: fresh.length,
        entries: fresh.slice(0, FRAME_ENTRIES).map((e) => ({
          ref: e.ref, kind: e.kind, convo_id: e.convo_id, convo_title: e.convo_title,
          ...(e.item_num != null ? { item_num: e.item_num } : {}),
          ts: e.ts, reasons: e.reasons, snippet: e.snippet.slice(0, 160),
        })),
      })
      const covered = Math.max(prev?.covered_ts ?? 0, ...entries.map((e) => e.ts))
      db.prepare(
        `INSERT INTO unseen_nudges(user_id, last_at, covered_ts) VALUES(?,?,?)
         ON CONFLICT(user_id) DO UPDATE SET last_at=excluded.last_at, covered_ts=excluded.covered_ts`
      ).run(userId, now, covered)
      sent += 1
    } catch (err) {
      // One user's failure must not cost the others their nudge.
      console.error(`unseen-nudge: user ${userId} failed`, err)
    }
  }
  return sent
}

export function startUnseenNudge({ db, hub, intervalMs = UNSEEN_NUDGE_INTERVAL_MS, enabled = true } = {}) {
  if (!enabled) return { stop() {}, run: (now) => runUnseenNudge({ db, hub }, now) }
  const interval = setInterval(() => runUnseenNudge({ db, hub }), intervalMs)
  if (typeof interval.unref === 'function') interval.unref()
  return { stop() { clearInterval(interval) }, run: (now) => runUnseenNudge({ db, hub }, now) }
}
