// Participants ("grants") for agent chat rooms — the convo_agents table
// (spec: 2026-08-06 agent-to-agent chat design, Phase 2). A row means this
// agent device has been drawn into this conversation's lifecycle; only
// state='joined' confers delivery and write rights (see authorizeAgentWrite
// in auth.js and the fan-out in ws.js). initiator_device_id records who
// started the invite — the room owner (invite) or the participant itself
// (join request) — because the OTHER party is the one entitled to answer.

// Renewable states: an old outcome must not block a fresh invite, but a
// pending or accepted row must (double-invite is a caller bug worth
// surfacing, not silently resetting).
const RENEWABLE = new Set(['refused', 'left', 'expired'])

// Returns `{ok:true, prior}` where `prior` is the full row as it stood
// BEFORE this call (null if no row existed) — a caller whose delivery then
// fails needs the WHOLE prior row, not just its state, to restore it exactly
// rather than erasing it (see undoInvite below).
export function inviteParticipant(db, { convoId, agentDeviceId, initiatorDeviceId, justification = '' }) {
  const existing = db.prepare(
    'SELECT * FROM convo_agents WHERE convo_id=? AND agent_device_id=?'
  ).get(convoId, agentDeviceId)
  if (existing && !RENEWABLE.has(existing.state)) return { ok: false, state: existing.state }
  db.prepare(`
    INSERT INTO convo_agents(convo_id, agent_device_id, initiator_device_id, state, justification, created_at, answered_at)
    VALUES(?,?,?,'invited',?,?,NULL)
    ON CONFLICT(convo_id, agent_device_id) DO UPDATE SET
      initiator_device_id=excluded.initiator_device_id,
      state='invited',
      justification=excluded.justification,
      created_at=excluded.created_at,
      answered_at=NULL
  `).run(convoId, agentDeviceId, initiatorDeviceId, justification, Date.now())
  return { ok: true, prior: existing ?? null }
}

export function answerInvite(db, { convoId, agentDeviceId, accept, now = Date.now() }) {
  return db.prepare(
    "UPDATE convo_agents SET state=?, answered_at=? WHERE convo_id=? AND agent_device_id=? AND state='invited'"
  ).run(accept ? 'joined' : 'refused', now, convoId, agentDeviceId).changes > 0
}

export function leaveConvo(db, { convoId, agentDeviceId, now = Date.now() }) {
  return db.prepare(
    "UPDATE convo_agents SET state='left', answered_at=? WHERE convo_id=? AND agent_device_id=? AND state='joined'"
  ).run(now, convoId, agentDeviceId).changes > 0
}

// Unconditional delete — no restoration of any prior renewed row. Direct
// callers (tests, admin-style cleanup) that want that ought to use
// `isParticipant`/inspect the row themselves first; ws.js's own
// offline-invite-undo path uses `undoInvite` below instead, specifically
// because a bare delete here would erase a renewed row's prior history
// (see undoInvite's doc comment).
export function removeParticipant(db, convoId, agentDeviceId) {
  db.prepare('DELETE FROM convo_agents WHERE convo_id=? AND agent_device_id=?').run(convoId, agentDeviceId)
}

// Undo of an invite/join whose delivery failed (the target had no live
// socket when the request frame was sent) — the caller sees `offline` and
// the table must not keep a pending row nobody was told about. Unlike a bare
// `removeParticipant` delete, this restores whatever `prior` row
// `inviteParticipant` captured (a renewed `refused`/`left`/`expired` row)
// rather than erasing it — otherwise a refused device could wipe its own
// refusal history just by join-requesting while the room owner happens to
// be offline. `prior: null` (inviteParticipant found no earlier row at all)
// means the row it just inserted was wholly new — delete it, same as the
// old behavior.
export function undoInvite(db, convoId, agentDeviceId, prior) {
  if (prior == null) {
    removeParticipant(db, convoId, agentDeviceId)
    return
  }
  db.prepare(`
    UPDATE convo_agents SET state=?, initiator_device_id=?, justification=?, created_at=?, answered_at=?
    WHERE convo_id=? AND agent_device_id=?
  `).run(prior.state, prior.initiator_device_id, prior.justification, prior.created_at, prior.answered_at, convoId, agentDeviceId)
}

// Owner-leave dissolution (ws.js agent_leave): the recorded owner has no
// convo_agents row of its own, so an owner leaving means the whole room
// winds down — every LIVE row (state 'joined' or 'invited') flips to
// 'left'. Scoped to those two states on purpose: 'refused'/'expired' are
// terminal outcomes, i.e. history, and rewriting them to 'left' would
// destroy the record of a refusal (and make a later `already refused`
// conflict read as `already left`).
//
// Returns both halves of the notification duty, because the two are owed
// DIFFERENT frames:
//   - `joined`: device ids that were in the room, owed `event:'left'`.
//   - `pending`: still-`invited` rows as {agent_device_id,
//     initiator_device_id}. Whoever INITIATED such a row is blocked
//     waiting for an answer that this dissolve has just made impossible
//     (the expiry sweep can't rescue it either — its predicate is
//     state='invited', which the flip has erased). ws.js turns each row
//     whose initiator is not the leaving owner into a synthetic refusal.
//
// SELECT-then-UPDATE instead of a single RETURNING statement because
// RETURNING reports post-update values, which can't tell a
// previously-joined row from a previously-invited one; the two statements
// can't interleave (better-sqlite3 is synchronous). Idempotent: a room
// with nothing to flip returns empty lists.
export function leaveAllParticipants(db, convoId, now = Date.now()) {
  const live = db.prepare(
    "SELECT agent_device_id, initiator_device_id, state FROM convo_agents WHERE convo_id=? AND state IN ('invited','joined')"
  ).all(convoId)
  db.prepare(
    "UPDATE convo_agents SET state='left', answered_at=? WHERE convo_id=? AND state IN ('invited','joined')"
  ).run(now, convoId)
  return {
    joined: live.filter((r) => r.state === 'joined').map((r) => r.agent_device_id),
    pending: live.filter((r) => r.state === 'invited')
      .map(({ agent_device_id, initiator_device_id }) => ({ agent_device_id, initiator_device_id })),
  }
}

// "Is this conversation a room at all?" — ANY convo_agents row, any state.
// The owner-dissolve branch of agent_leave needs this because convo_upsert
// stamps agent_device_id on EVERY agent-created conversation, so "caller is
// the recorded owner" alone would catch plain solo convos that never had a
// participant and turn their leave into a silent success. Deliberately
// state-agnostic (not just live rows) so a dissolved room stays idempotent
// on a repeat owner-leave. Same predicate convo_upsert's room-ownership
// gate uses.
export function hasParticipants(db, convoId) {
  return !!db.prepare('SELECT 1 FROM convo_agents WHERE convo_id=? LIMIT 1').get(convoId)
}

export function joinedAgentIds(db, convoId) {
  return db.prepare(
    "SELECT agent_device_id FROM convo_agents WHERE convo_id=? AND state='joined'"
  ).all(convoId).map((r) => r.agent_device_id)
}

export function getParticipant(db, convoId, agentDeviceId) {
  return db.prepare(
    'SELECT state, initiator_device_id, justification, topic, created_at, answered_at, delivered_at FROM convo_agents WHERE convo_id=? AND agent_device_id=?'
  ).get(convoId, agentDeviceId) ?? null
}

export function isParticipant(db, convoId, agentDeviceId) {
  return !!db.prepare(
    'SELECT 1 FROM convo_agents WHERE convo_id=? AND agent_device_id=?'
  ).get(convoId, agentDeviceId)
}

// Sweep half of invite expiry (ws.js owns the timer and the caller
// notification): flip stale pending rows and report them. RETURNING keeps
// flip-and-report atomic — no separate SELECT that a concurrent answer
// could race.
export function expireInvites(db, ttlMs, now = Date.now()) {
  return db.prepare(
    "UPDATE convo_agents SET state='expired', answered_at=? WHERE state='invited' AND created_at<=? RETURNING convo_id, agent_device_id, initiator_device_id"
  ).all(now, now - ttlMs)
}
