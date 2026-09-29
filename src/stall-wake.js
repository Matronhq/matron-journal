// Stall wake sweep (spec: matron-bridge
// 2026-09-29-coordinator-session-control-design.md, "Decisions" → journal).
// A session that hit its usage limit reports `stall.resets_at` in its
// persisted status (conversation_status). Its bridge carries the session
// on by itself once that time passes — but only if the box is awake, and a
// box that stalled hours ago has usually idle-stopped. So once a minute the
// journal looks for stalled conversations whose reset time has passed and
// whose box has no live socket, and wakes the box (debounced by the waker,
// same call every message and invite uses). The bridge's next status frame
// drops the stall, which ends the loop; a bridge that never clears it costs
// one debounced wake attempt per sweep, never a storm.
import { wakeIfOffline } from './wake.js'

export const STALL_WAKE_INTERVAL_MS = 60_000

// Boxes owed a wake: one row per (user, device) with at least one stalled
// conversation whose resets_at is at or before `now`. Unparseable reset
// times are ignored (never a wake for a bad timestamp); a stall without a
// reset time cannot be acted on.
export function dueStalledBoxes(db, now = Date.now()) {
  const rows = db.prepare(`
    SELECT s.user_id, c.agent_device_id AS device_id, json_extract(s.status, '$.stall.resets_at') AS resets_at
    FROM conversation_status s JOIN conversations c ON c.id = s.convo_id
    WHERE json_extract(s.status, '$.stall.kind') IS NOT NULL AND c.agent_device_id IS NOT NULL`).all()
  const seen = new Set()
  const out = []
  for (const r of rows) {
    const at = typeof r.resets_at === 'string' ? Date.parse(r.resets_at) : NaN
    if (!Number.isFinite(at) || at > now) continue
    const key = `${r.user_id}:${r.device_id}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push({ user_id: r.user_id, device_id: r.device_id })
  }
  return out
}

export function startStallWakeSweep({ db, hub, waker, intervalMs = STALL_WAKE_INTERVAL_MS, log = console } = {}) {
  if (!waker || !waker.enabled) return { stop() {}, run() { return 0 } }
  function run(now = Date.now()) {
    let woken = 0
    try {
      for (const { user_id: userId, device_id: deviceId } of dueStalledBoxes(db, now)) {
        if (wakeIfOffline({ db, hub, waker }, userId, deviceId)) woken += 1
      }
    } catch (err) {
      try { log.warn(`stall-wake: sweep failed: ${err?.message || err}`) } catch { /* never throw from a timer */ }
    }
    return woken
  }
  const interval = setInterval(run, intervalMs)
  if (typeof interval.unref === 'function') interval.unref()
  return { stop() { clearInterval(interval) }, run }
}
