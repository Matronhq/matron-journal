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

export function inviteParticipant(db, { convoId, agentDeviceId, initiatorDeviceId, justification = '' }) {
  const existing = db.prepare(
    'SELECT state FROM convo_agents WHERE convo_id=? AND agent_device_id=?'
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
  return { ok: true }
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

// Undo of a just-created invite whose delivery failed (the target had no
// live socket when the request frame was sent) — the caller sees `offline`
// and the table must not keep a pending row nobody was told about.
export function removeParticipant(db, convoId, agentDeviceId) {
  db.prepare('DELETE FROM convo_agents WHERE convo_id=? AND agent_device_id=?').run(convoId, agentDeviceId)
}

export function joinedAgentIds(db, convoId) {
  return db.prepare(
    "SELECT agent_device_id FROM convo_agents WHERE convo_id=? AND state='joined'"
  ).all(convoId).map((r) => r.agent_device_id)
}

export function getParticipant(db, convoId, agentDeviceId) {
  return db.prepare(
    'SELECT state, initiator_device_id, justification, created_at, answered_at FROM convo_agents WHERE convo_id=? AND agent_device_id=?'
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
