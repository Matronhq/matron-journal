// Durable spawn requests (spec: 2026-08-09 agent-spawned sessions). A row is
// the journal-brokered ask "may this agent start a session on that box" —
// parked across human latency, which the stateless RPC relay deliberately
// cannot do. State machine: awaiting_user → approved → started|failed,
// awaiting_user → denied|expired. The CHECK in db.js lists every state this
// file writes — the convo_agents lesson, where an unlisted value made an
// upsert fail silently.

import { randomUUID } from 'node:crypto'
import { upsertConversation, appendAndBroadcast } from './journal.js'
import { recordJoined } from './participants.js'

export function createSpawnRequest(db, { id, userId, fromDeviceId, fromConvoId, targetDeviceId, workdir, task, topic = '', now = Date.now() }) {
  db.prepare(`
    INSERT INTO agent_spawn_requests(id, user_id, from_device_id, from_convo_id, target_device_id,
      workdir, task, topic, state, created_at)
    VALUES(?,?,?,?,?,?,?,?,'awaiting_user',?)
  `).run(id, userId, fromDeviceId, fromConvoId, targetDeviceId, workdir, task, topic, now)
  return { id }
}

export function getSpawn(db, id) {
  return db.prepare('SELECT * FROM agent_spawn_requests WHERE id=?').get(id)
}

// The user's "no", reported to the parent plainly as 'declined' (spec: no
// peer to hide behind here, unlike chat's 'refused' masking).
export function denySpawn(db, id, now = Date.now()) {
  return db.prepare(
    "UPDATE agent_spawn_requests SET state='denied', answered_at=?, resolved_at=? WHERE id=? AND state='awaiting_user'"
  ).run(now, now, id).changes > 0
}

// The approve tap CLAIMS the row — state-scoped so exactly one caller wins
// and everything expensive (room, live agent on another box) starts at most
// once. The loser's zero row-count is the 409 the failure table promises.
export function claimApprove(db, id, now = Date.now()) {
  return db.prepare(
    "UPDATE agent_spawn_requests SET state='approved', answered_at=? WHERE id=? AND state='awaiting_user'"
  ).run(now, id).changes > 0
}

export function markStarted(db, id, { roomId, childConvoId, now = Date.now() }) {
  return db.prepare(
    "UPDATE agent_spawn_requests SET state='started', room_id=?, child_convo_id=?, resolved_at=? WHERE id=? AND state='approved'"
  ).run(roomId, childConvoId, now, id).changes > 0
}

export function markFailed(db, id, now = Date.now()) {
  return db.prepare(
    "UPDATE agent_spawn_requests SET state='failed', resolved_at=? WHERE id=? AND state='approved'"
  ).run(now, id).changes > 0
}

// Sweep-driven 24h TTL, mirroring participants.expireAwaiting: flip stale
// parked rows and report them so the sweep can tell each parent its ask
// timed out. RETURNING keeps flip-and-report atomic. user_id/from_device_id
// ride along so the caller needs no per-row lookups.
export function expireSpawns(db, ttlMs, now = Date.now()) {
  return db.prepare(
    "UPDATE agent_spawn_requests SET state='expired', answered_at=?, resolved_at=? WHERE state='awaiting_user' AND created_at<=? RETURNING id, user_id, from_device_id, from_convo_id"
  ).all(now, now, now - ttlMs)
}

// The shared attention throttle (spec: cap on outstanding asks). Counts BOTH
// tables — pending spawn rows live here, pending chat asks in convo_agents —
// because what the user is being protected from is cards, not any one
// table's cards. An agent that exhausted its chat budget must not spawn
// freely, or vice versa. Checked against MAX_AWAITING_PER_REQUESTER on all
// three ask surfaces (agent_invite, agent_join, spawn_request).
export function countPendingAsks(db, fromDeviceId) {
  return db.prepare(`
    SELECT
      (SELECT COUNT(*) FROM convo_agents WHERE state='awaiting_user' AND initiator_device_id=?)
      + (SELECT COUNT(*) FROM agent_spawn_requests WHERE state='awaiting_user' AND from_device_id=?) AS c
  `).get(fromDeviceId, fromDeviceId).c
}

// Spec step 4/5 — everything after the user's tap. Ordering is load-bearing:
// room first, then spawn. Spawning first would, on a room-creation failure,
// leave a live agent on another box with no channel and no provenance. The
// broker's timeout guarantees this settles; every path resolves the row and
// tells the parent exactly once.
export async function approveSpawn({ db, hub, broker, startTimeoutMs, roomId = randomUUID() }, row) {
  const title = row.topic || row.task.slice(0, 80)
  // The parent owns the room (conversations.agent_device_id), the target is
  // its joined participant — the same shape an accepted chat invite leaves.
  upsertConversation(db, { id: roomId, ownerUserId: row.user_id, title, sessionState: 'running', agentDeviceId: row.from_device_id })
  recordJoined(db, { convoId: roomId, agentDeviceId: row.target_device_id, initiatorDeviceId: row.from_device_id })
  // Live clients learn the room exists now, not at their next /snapshot —
  // the same two frames convo_upsert fans for a fresh conversation.
  appendAndBroadcast(db, hub, { userId: row.user_id, convoId: roomId, sender: 'journal', type: 'session_status', payload: { state: 'running' } })
  appendAndBroadcast(db, hub, { userId: row.user_id, convoId: roomId, sender: 'journal', type: 'convo_meta', payload: { title, parent_convo_id: null } })
  const r = await broker.issue(hub, row.user_id, row.target_device_id, 'start',
    { workdir: row.workdir, prompt: row.task, room_id: roomId }, { timeoutMs: startTimeoutMs })
  if (r.ok && typeof r.result?.convo_id === 'string' && r.result.convo_id) {
    markStarted(db, row.id, { roomId, childConvoId: r.result.convo_id })
    hub.sendToDevice(row.user_id, row.from_device_id, {
      kind: 'spawn', event: 'outcome', request_id: row.id, outcome: 'started',
      room_id: roomId, child_convo_id: r.result.convo_id,
    })
    return 'started'
  }
  const code = r.ok ? 'bad_start_reply' : (r.error?.code ?? 'unknown')
  markFailed(db, row.id)
  // The room already exists and both users can see it — it gets the same
  // epitaph a dead chat room gets, then the parent hears failed, once.
  appendAndBroadcast(db, hub, {
    userId: row.user_id, convoId: roomId, sender: 'journal', type: 'text',
    payload: { body: `❌ spawn failed — ${code}. This room's child session never started.` },
  })
  hub.sendToDevice(row.user_id, row.from_device_id, {
    kind: 'spawn', event: 'outcome', request_id: row.id, outcome: 'failed', error_code: code,
  })
  return 'failed'
}
