// Triggered routines (spec 2026-10-01 coordinator routines, "Triggers"):
// a routine with a trigger instead of a schedule fires the moment a rule
// trips — a live session's context gauge past a threshold, a session
// stalled on a usage limit with a far (or unknown) reset, an agent box
// under a disk threshold — using the status the journal already holds
// (conversation_status, device_status). Once per subject per crossing:
// routine_trigger_state remembers the subjects a routine has fired for and
// forgets them when the condition clears, so the next crossing fires again.
// The turn carries the specifics ("Tripped by:" lines) after the prompt.
import { coordinatorDevice } from './consent.js'
import { convoStatuses } from './convo-status.js'
import { deviceStatuses, isPrivateDevice } from './db.js'
import { privateOwnedConvo } from './privacy.js'
import { sanitizePeerText } from './peer-text.js'
import { triggeredRoutines, RETRY_AFTER_MS } from './routines.js'

const LIVE_STATES = new Set(['running', 'waiting'])
const TITLE_CAP = 80
const GB = 1024 ** 3

// A title inside a markdown link label: brackets and parens dropped so it
// cannot close the label; one line, capped.
const linkLabel = (title) => (sanitizePeerText(String(title || ''), TITLE_CAP) || 'untitled').replace(/[[\]()]/g, '').trim() || 'untitled'
const inWords = (ms) => {
  const m = Math.round(ms / 60000)
  if (m < 60) return `${m} min`
  const h = Math.round(m / 60)
  return h < 48 ? `${h} h` : `${Math.round(h / 24)} d`
}
const gb = (bytes) => `${(bytes / GB).toFixed(1)} GB`

export function describeTrigger(t) {
  if (!t || typeof t !== 'object') return 'no trigger'
  if (t.kind === 'context_over') return `when a session passes ${t.pct}% of its context window`
  if (t.kind === 'disk_under') return `when a box drops under ${t.pct}% free disk`
  if (t.kind === 'stalled') return t.reset_minutes > 0 ? `when a session stalls on a usage limit with no reset within ${inWords(t.reset_minutes * 60000)}` : 'when a session stalls on a usage limit'
  return 'no trigger'
}

// The subjects a trigger matches right now: [{subject, line}], ordered by
// subject so two sweeps agree. The Coordinator's own conversation never
// counts (it cannot act on itself), nor do done/archived sessions. With
// excludePrivateOwned (the Coordinator sits on an ordinary box), sessions
// on private devices and private boxes are invisible, as everywhere else.
export function evaluateTrigger(db, userId, trigger, { now = Date.now(), coordinatorConvoId = null, excludePrivateOwned = false } = {}) {
  const out = []
  if (trigger.kind === 'context_over' || trigger.kind === 'stalled') {
    const statuses = convoStatuses(db, userId)
    const rows = db.prepare('SELECT id, title, session_state FROM conversations WHERE owner_user_id=? AND agent_device_id IS NOT NULL').all(userId)
    for (const c of rows) {
      if (c.id === coordinatorConvoId || !LIVE_STATES.has(c.session_state)) continue
      const st = statuses.get(c.id)
      if (!st) continue
      if (excludePrivateOwned && privateOwnedConvo(db, c.id)) continue
      const title = linkLabel(c.title)
      if (trigger.kind === 'context_over') {
        const pct = st.context?.pct
        if (!Number.isInteger(pct) || pct < trigger.pct) continue
        out.push({ subject: `convo:${c.id}`, line: `- [${title}](matron://convo/${c.id}) at ${pct}% of its window${st.model ? ` (${st.model})` : ''}` })
      } else {
        const stall = st.stall
        if (!stall || stall.kind !== 'usage_limit') continue
        const resetAt = typeof stall.resets_at === 'string' ? Date.parse(stall.resets_at) : NaN
        const known = Number.isFinite(resetAt)
        if (known && resetAt - now < trigger.reset_minutes * 60000) continue
        const model = stall.model || st.model
        const when = known ? `resets ${stall.resets_at} (${resetAt > now ? `in ${inWords(resetAt - now)}` : 'passed'})` : 'no reset time'
        out.push({ subject: `convo:${c.id}`, line: `- [${title}](matron://convo/${c.id}) stalled${model ? ` on ${model}` : ''}, ${when}` })
      }
    }
  } else if (trigger.kind === 'disk_under') {
    const statuses = deviceStatuses(db, userId)
    const devices = db.prepare("SELECT id, name, private FROM devices WHERE user_id=? AND kind='agent'").all(userId)
    for (const d of devices) {
      if (excludePrivateOwned && d.private) continue
      const disk = statuses.get(d.id)?.disk
      if (!disk || !(disk.total_bytes > 0)) continue
      const pct = Math.floor((disk.free_bytes / disk.total_bytes) * 100)
      if (pct >= trigger.pct) continue
      out.push({ subject: `device:${d.id}`, line: `- ${sanitizePeerText(d.name, 64) || `device ${d.id}`}: ${pct}% free (${gb(disk.free_bytes)} of ${gb(disk.total_bytes)})` })
    }
  }
  return out.sort((a, b) => (a.subject < b.subject ? -1 : a.subject > b.subject ? 1 : 0))
}

export function trigMessage(prompt, subjects) {
  if (!subjects.length) return prompt
  return `${prompt}\n\nTripped by:\n${subjects.map((s) => s.line).join('\n')}`
}

function viewFor(db, routine) {
  const coord = coordinatorDevice(db, routine.user_id)
  return { coordinatorConvoId: coord?.convoId ?? null, excludePrivateOwned: coord ? !isPrivateDevice(db, coord.deviceId) : true }
}

// What a `run` by hand reports: everything matching now, state untouched.
export function currentSubjects(db, routine, { now = Date.now() } = {}) {
  if (!routine.trigger) return []
  return evaluateTrigger(db, routine.user_id, routine.trigger, { now, ...viewFor(db, routine) })
}

// The sweep's step for one routine, in one transaction: subjects that no
// longer match are forgotten; subjects that match and are not yet recorded
// are recorded now (before delivery — a crash mid-delivery costs one
// fire, never a double) and returned as `fresh`.
export function trippedSubjects(db, routine, { now = Date.now(), coordinatorConvoId = null, excludePrivateOwned = false } = {}) {
  return db.transaction(() => {
    const matching = evaluateTrigger(db, routine.user_id, routine.trigger, { now, coordinatorConvoId, excludePrivateOwned })
    const known = new Set(db.prepare('SELECT subject FROM routine_trigger_state WHERE routine_id=?').all(routine.id).map((r) => r.subject))
    const live = new Set(matching.map((s) => s.subject))
    const forget = db.prepare('DELETE FROM routine_trigger_state WHERE routine_id=? AND subject=?')
    for (const s of known) if (!live.has(s)) forget.run(routine.id, s)
    const fresh = matching.filter((s) => !known.has(s.subject))
    const mark = db.prepare('INSERT OR IGNORE INTO routine_trigger_state(routine_id, subject, tripped_at) VALUES(?,?,?)')
    for (const s of fresh) mark.run(routine.id, s.subject, now)
    return { fresh, matching }
  })()
}

// One pass over every enabled triggered routine. A delivery failure the
// next attempt might cure forgets the fresh subjects (so they re-trip) and
// backs the routine off for RETRY_AFTER_MS; a refusal keeps them recorded
// (nothing until the condition clears and trips again). Returns {fired}.
export async function runTriggerSweep({ db, firer, log = console }, now = Date.now()) {
  let routines = []
  try { routines = triggeredRoutines(db, now) } catch (err) {
    try { log.error(`routines: trigger sweep query failed: ${err?.message || err}`) } catch { /* never throw from a timer */ }
    return { fired: 0 }
  }
  let fired = 0
  const deliveries = []
  for (const r of routines) {
    if (firer.busy()) break
    let fresh
    try {
      ({ fresh } = trippedSubjects(db, r, { now, ...viewFor(db, r) }))
    } catch (err) {
      try { log.error(`routines: ${r.name}: trigger evaluation failed: ${err?.message || err}`) } catch { /* never throw from a timer */ }
      continue
    }
    if (!fresh.length) continue
    fired += 1
    db.prepare('UPDATE routines SET last_fired_at=?, retry_at=NULL WHERE id=?').run(now, r.id)
    const onOutcome = (outcome, retryable) => {
      db.transaction(() => {
        db.prepare('UPDATE routines SET last_outcome=?, retry_at=? WHERE id=?').run(outcome, retryable ? Date.now() + RETRY_AFTER_MS : null, r.id)
        if (retryable) {
          const forget = db.prepare('DELETE FROM routine_trigger_state WHERE routine_id=? AND subject=?')
          for (const s of fresh) forget.run(r.id, s.subject)
        }
      })()
    }
    deliveries.push(firer.fire(r, { now, message: trigMessage(r.prompt, fresh), onOutcome }).catch((err) => {
      try { log.error(`routines: ${r.name}: trigger fire failed`, err) } catch { /* never throw from a timer */ }
    }))
  }
  await Promise.all(deliveries)
  return { fired }
}
