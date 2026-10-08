// Coordinator briefings (spec 2026-10-04 latest briefing): the Coordinator
// publishes its sweep and status updates as briefings; the apps show the
// latest at the top of Projects and may ask for a fresh one. A briefing is
// also an ordinary assistant `text` message in the Coordinator conversation
// (payload.briefing_id marks it), written here in the same transaction as
// the row, so the chat keeps it, older apps still show it, and its seq is
// the "Open in chat" anchor.
import { append, broadcastAppended } from './journal.js'
import { BODY_MAX, newId } from './items.js'

export const BRIEFINGS_KEEP = 30
// A refresh is pending until a briefing is published after it, its
// delivery fails, or this long passes.
export const BRIEFING_REFRESH_TIMEOUT_MS = 10 * 60_000
// No second refresh within this long of the last one, whatever happened.
export const BRIEFING_REFRESH_COOLDOWN_MS = 2 * 60_000
export const BRIEFING_ROUTINE = Object.freeze({
  // Not a row in `routines`: a built-in, on-demand run fired through the
  // routine path (the bridge frames it `[routine briefing, …]`) whose
  // procedure lives in the Coordinator playbook's `## Routine: briefing`.
  id: 'rt_briefing',
  name: 'briefing',
  title: 'Briefing',
  prompt: 'Routine briefing: the user asked for a fresh briefing from the Projects tab. Follow the playbook\'s Routine: briefing section and publish it with briefing_publish.',
})

export function validBriefingBody(body) {
  if (typeof body !== 'string') return null
  const trimmed = body.trim()
  if (!trimmed || Buffer.byteLength(trimmed, 'utf8') > BODY_MAX) return null
  return trimmed
}

const rowView = (r) => (r ? { id: r.id, body: r.body, created_at: r.created_at, convo_id: r.convo_id, seq: r.seq } : null)

export function latestBriefing(db, userId) {
  return rowView(db.prepare('SELECT * FROM briefings WHERE user_id=? ORDER BY created_at DESC, rowid DESC LIMIT 1').get(userId))
}

// Publish: the text event and the row in one transaction, then the fan-out.
// An `idemKey` replay returns the briefing its first call made.
export function publishBriefing({ db, hub }, { userId, convoId, sender, body, idemKey = null }) {
  const result = db.transaction(() => {
    const id = newId('br')
    const payload = { body, from: 'assistant', briefing_id: id }
    const r = append(db, { userId, convoId, sender, type: 'text', payload, idemKey })
    if (r.duplicate) {
      return { briefing: rowView(db.prepare('SELECT * FROM briefings WHERE user_id=? AND convo_id=? AND seq=?').get(userId, convoId, r.seq)), duplicate: true }
    }
    db.prepare('INSERT INTO briefings(id, user_id, body, convo_id, seq, created_at) VALUES(?,?,?,?,?,?)')
      .run(id, userId, body, convoId, r.seq, r.ts)
    db.prepare(`DELETE FROM briefings WHERE user_id=? AND id NOT IN (
      SELECT id FROM briefings WHERE user_id=? ORDER BY created_at DESC, rowid DESC LIMIT ?)`).run(userId, userId, BRIEFINGS_KEEP)
    return { briefing: { id, body, created_at: r.ts, convo_id: convoId, seq: r.seq }, event: { seq: r.seq, ts: r.ts, payload }, duplicate: false }
  })()
  if (!result.duplicate) {
    const { seq, ts, payload } = result.event
    broadcastAppended(db, hub, { userId, convoId, seq, ts, sender, type: 'text', payload })
    hub.sendToClients(userId, { kind: 'briefing', action: 'published', briefing_id: result.briefing.id })
  }
  return result
}

// The refresh the apps show: null when there is none newer than the latest
// briefing. state: pending | failed | timed_out.
export function refreshView(db, userId, now = Date.now()) {
  const r = db.prepare('SELECT requested_at, outcome FROM briefing_refresh WHERE user_id=?').get(userId)
  if (!r) return null
  const latest = latestBriefing(db, userId)
  if (latest && latest.created_at >= r.requested_at) return null
  let state = 'pending'
  // Outcomes are the routine firer's: `applied …`, `failed <code>`, `no_coordinator`.
  if (r.outcome && !r.outcome.startsWith('applied')) state = 'failed'
  else if (now - r.requested_at >= BRIEFING_REFRESH_TIMEOUT_MS) state = 'timed_out'
  return {
    requested_at: r.requested_at,
    state,
    ...(state === 'pending' ? { expires_at: r.requested_at + BRIEFING_REFRESH_TIMEOUT_MS } : {}),
    ...(state === 'failed' ? { outcome: r.outcome } : {}),
  }
}

// When the next refresh may be asked for (ms), or null if now. A pending
// refresh blocks until it settles; otherwise the cooldown since the last ask.
export function nextRefreshAt(db, userId, now = Date.now()) {
  const r = db.prepare('SELECT requested_at FROM briefing_refresh WHERE user_id=?').get(userId)
  if (!r) return null
  const view = refreshView(db, userId, now)
  const cooled = r.requested_at + BRIEFING_REFRESH_COOLDOWN_MS
  const until = view?.state === 'pending' ? Math.max(cooled, view.expires_at) : cooled
  return until > now ? until : null
}

export function markRefreshRequested(db, userId, now = Date.now()) {
  db.prepare(`INSERT INTO briefing_refresh(user_id, requested_at, outcome) VALUES(?,?,NULL)
    ON CONFLICT(user_id) DO UPDATE SET requested_at=excluded.requested_at, outcome=NULL`).run(userId, now)
}

export function recordRefreshOutcome(db, userId, requestedAt, outcome) {
  db.prepare('UPDATE briefing_refresh SET outcome=? WHERE user_id=? AND requested_at=?').run(outcome, userId, requestedAt)
}
