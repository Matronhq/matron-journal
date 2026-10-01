// Firing Coordinator routines (spec 2026-10-01 coordinator routines): the
// once-a-minute sweep over `routines` and the delivery it shares with
// POST /routines/:key/run. Modelled on the Alertmanager relay
// (src/alerts-http.js): the Coordinator's box is woken if asleep and waited
// for, then a journal-originated session_control RPC with action 'routine'
// is issued to it — an action no agent can send through its own op
// (SESSION_CONTROL_ACTIONS does not list it), so a routine turn can only
// ever come from here.
//
// Order of operations per due routine: advanceRoutine FIRST (last_fired_at,
// next_at past now, retry cleared — one transaction), then deliver off the
// sweep's loop. A crash, a slow wake or a restart mid-delivery costs one
// fire, never a double. Deliveries are bounded process-wide; a routine
// that does not get a slot stays due for the next sweep untouched.
import { coordinatorDevice } from './consent.js'
import { wakeIfOffline } from './wake.js'
import { sanitizePeerText } from './peer-text.js'
import { dueRoutines, advanceRoutine, recordOutcome, routineRow } from './routines.js'
import { emitRoutineMarker } from './routines-marker.js'

export const ROUTINES_SWEEP_INTERVAL_MS = 60_000
export const ROUTINE_MAX_INFLIGHT = 4
export const ROUTINE_FROM_NAME = 'Routines'
// Failures the next attempt might cure: the box was asleep or slow, the
// socket dropped. A bridge's refusal (bad_request, not_coordinator, gone)
// is final for this fire.
const RETRYABLE = new Set(['agent_unreachable', 'timeout', 'send_failed', 'internal'])

// One firer per journal process (server.js): the sweep and the run route
// share it, and with it the in-flight bound.
export function makeRoutineFirer({ db, hub, broker, waker = null, wakeWaitMs = 0, timeoutMs = 30000, log = console }) {
  let inflight = 0
  const busy = () => inflight >= ROUTINE_MAX_INFLIGHT
  const userName = (userId) => db.prepare('SELECT name FROM users WHERE id=?').get(userId)?.name ?? String(userId)

  // Deliver one routine's prompt to the user's Coordinator. `routine` is the
  // row as advanced (or as-is for a run); `retry` marks the one retry so a
  // second failure is final. Resolves to the outcome string once recorded.
  async function fire(routine, { retry = false, now = Date.now() } = {}) {
    const coord = coordinatorDevice(db, routine.user_id)
    const label = `${routine.name} for ${userName(routine.user_id)}`
    if (!coord) {
      recordOutcome(db, routine.id, { outcome: 'no_coordinator', retryable: false, retry, now })
      finish(routine, 'no_coordinator')
      log.log(`routines: ${label} not delivered: no Coordinator (or it has no box)`)
      return 'no_coordinator'
    }
    const params = {
      convo_id: coord.convoId, action: 'routine', routine_id: routine.id, name: routine.name, title: routine.title,
      message: routine.prompt, fired_at: new Date(now).toISOString(), tz: routine.tz, from_name: ROUTINE_FROM_NAME,
    }
    inflight += 1
    let outcome
    let retryable = false
    let waking = false
    try {
      waking = wakeIfOffline({ db, hub, waker }, routine.user_id, coord.deviceId)
      if (waking && wakeWaitMs > 0) await hub.waitForDevice(routine.user_id, coord.deviceId, wakeWaitMs)
      const r = await broker.issue(hub, routine.user_id, coord.deviceId, 'session_control', params, { timeoutMs })
      if (r.ok) {
        outcome = `applied ${sanitizePeerText(r.result?.applied, 20) || 'now'}`
      } else {
        const code = sanitizePeerText(r.error?.code, 40) || 'unknown'
        outcome = `failed ${code}`
        retryable = RETRYABLE.has(code)
      }
    } catch (err) {
      outcome = 'failed internal'
      retryable = true
      log.error(`routines: ${label}: delivery threw`, err)
    } finally {
      inflight -= 1
    }
    try { recordOutcome(db, routine.id, { outcome, retryable, retry, now: Date.now() }) } catch (err) { log.error(`routines: ${label}: outcome not recorded`, err) }
    finish(routine, outcome)
    log.log(`routines: ${label} -> Coordinator ${coord.convoId} on device ${coord.deviceId}: ${outcome}${waking ? ' (after wake)' : ''}${retry ? ' (retry)' : ''}`)
    return outcome
  }

  function finish(routine, outcome) {
    const fresh = db.prepare('SELECT * FROM routines WHERE id=?').get(routine.id)
    if (!fresh) return
    emitRoutineMarker({ db, hub }, routine.user_id, { routine: routineRow(fresh), action: 'fired', outcome, sender: 'journal' })
  }

  return { fire, busy, inflight: () => inflight }
}

export function startRoutinesSweep({ db, firer, intervalMs = ROUTINES_SWEEP_INTERVAL_MS, enabled = true, log = console } = {}) {
  // One pass. Resolves when every delivery it started has settled, so tests
  // can await it; the timer path ignores the promise.
  async function run(now = Date.now()) {
    let due = []
    try { due = dueRoutines(db, now) } catch (err) {
      try { log.error(`routines: sweep query failed: ${err?.message || err}`) } catch { /* never throw from a timer */ }
      return { fired: 0, missed: 0 }
    }
    let fired = 0
    let missed = 0
    const deliveries = []
    for (const r of due) {
      if (firer.busy()) break
      let adv
      try { adv = advanceRoutine(db, r.id, now) } catch (err) {
        try { log.error(`routines: ${r.name}: advance failed: ${err?.message || err}`) } catch { /* never throw from a timer */ }
        continue
      }
      if (!adv) continue
      if (adv.missed) { missed += 1; continue }
      fired += 1
      // Off the loop; one routine's failure never costs the others theirs.
      deliveries.push(firer.fire({ ...r, ...adv.routine }, { retry: adv.retry, now }).catch((err) => {
        try { log.error(`routines: ${r.name}: fire failed`, err) } catch { /* never throw from a timer */ }
      }))
    }
    await Promise.all(deliveries)
    return { fired, missed }
  }
  if (!enabled) return { stop() {}, run }
  const interval = setInterval(() => { void run() }, intervalMs)
  if (typeof interval.unref === 'function') interval.unref()
  return { stop() { clearInterval(interval) }, run }
}
