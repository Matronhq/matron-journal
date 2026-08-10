// Durable spawn requests (spec: 2026-08-09 agent-spawned sessions). A row is
// the journal-brokered ask "may this agent start a session on that box" —
// parked across human latency, which the stateless RPC relay deliberately
// cannot do. State machine: awaiting_user → approved → started|failed,
// awaiting_user → denied|expired. The CHECK in db.js lists every state this
// file writes — the convo_agents lesson, where an unlisted value made an
// upsert fail silently.

import { randomUUID } from 'node:crypto'
import { upsertConversation, appendAndBroadcast, CONVO_ID_MAX_CHARS } from './journal.js'
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

// Stranded-`approved` recovery — the sweep's backstop for the gap between
// claimApprove flipping a row to 'approved' and the in-memory broker
// settling it (started/failed). Two ways in: (a) the process restarts
// between the claim and the broker settling — nothing left in memory will
// ever resolve the row; (b) approveSpawn throws before broker.issue (e.g. the
// room-creation writes fail) and the caller's own catch only logs. Either
// way the row would sit in 'approved' forever, breaking "every request
// resolves exactly once and the parent is told exactly once". TTL is
// measured off answered_at (the claim timestamp) and set well beyond the
// 30s default start timeout so this never races a live approveSpawn still
// legitimately in flight. State-scoped like expireSpawns above: RETURNING
// keeps flip-and-report atomic, and the WHERE state='approved' guarantees a
// row a live orchestration just resolved (started/failed) is never touched.
export function expireApproved(db, ttlMs, now = Date.now()) {
  return db.prepare(
    "UPDATE agent_spawn_requests SET state='failed', resolved_at=? WHERE state='approved' AND answered_at<=? RETURNING id, user_id, from_device_id"
  ).all(now, now - ttlMs)
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
// broker's timeout guarantees the `start` rpc itself settles; the try/catch
// below guarantees the ORCHESTRATION settles too, even if something throws
// before broker.issue is ever reached (e.g. upsertConversation/
// appendAndBroadcast hitting a DB error) — otherwise the row is left
// 'approved' forever with the caller's own `.catch(console.error)` the only
// thing that ever sees the failure. The stranded-'approved' sweep
// (expireApproved) is the remaining backstop for the case even this can't
// cover: the process dying mid-orchestration, taking this stack frame with
// it.
export async function approveSpawn({ db, hub, broker, startTimeoutMs, roomId = randomUUID() }, row) {
  // Exactly-once guard: markFailed is state-scoped (WHERE state='approved'),
  // so its changes-count tells us whether THIS call is the one resolving the
  // row out of 'approved'. A false here means someone else already did
  // (the orphan sweep, or — impossible in practice, but cheap to guard —
  // another concurrent path) and neither the epitaph nor the outcome frame
  // may be sent a second time.
  const fail = (code) => {
    if (!markFailed(db, row.id)) return 'failed'
    // Best-effort epitaph: normally the room already exists (both users can
    // see it, so it gets the same epitaph a dead chat room gets) — but a
    // throw from THIS call's own try block can land here before
    // upsertConversation ever ran, in which case there is no room row to
    // write into and appendAndBroadcast itself throws (append() requires an
    // existing, owned conversation). That must never swallow the outcome
    // frame below — telling the parent is the one thing this tail cannot
    // skip.
    try {
      appendAndBroadcast(db, hub, {
        userId: row.user_id, convoId: roomId, sender: 'journal', type: 'text',
        payload: { body: `❌ spawn failed — ${code}. This room's child session never started.` },
      })
    } catch (err) {
      console.error('approveSpawn: epitaph write failed (room likely never created)', err)
    }
    hub.sendToDevice(row.user_id, row.from_device_id, {
      kind: 'spawn', event: 'outcome', request_id: row.id, outcome: 'failed', error_code: code,
    })
    return 'failed'
  }
  try {
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
    // Bridge-returned convo_id, capped the same as every other externally-
    // supplied convo id (CONVO_ID_MAX_CHARS) — an oversized or non-string
    // reply is a bad reply, same 'bad_start_reply' the missing-field case
    // already gets below.
    if (r.ok && typeof r.result?.convo_id === 'string' && r.result.convo_id && r.result.convo_id.length <= CONVO_ID_MAX_CHARS) {
      // Exactly-once guard, mirroring fail()'s: markStarted is state-scoped
      // (WHERE state='approved'), so a false means something else — in
      // practice only the orphan sweep — already resolved this row and told
      // the parent 'failed'. A contradicting 'started' frame must not follow
      // it. Unreachable while startTimeoutMs stays under the orphan TTL, but
      // nothing enforces that relationship between the two configs.
      if (!markStarted(db, row.id, { roomId, childConvoId: r.result.convo_id })) {
        console.error('approveSpawn: start reply arrived after the row was already resolved — outcome frame suppressed')
        return 'failed'
      }
      hub.sendToDevice(row.user_id, row.from_device_id, {
        kind: 'spawn', event: 'outcome', request_id: row.id, outcome: 'started',
        room_id: roomId, child_convo_id: r.result.convo_id,
      })
      return 'started'
    }
    return fail(r.ok ? 'bad_start_reply' : (r.error?.code ?? 'unknown'))
  } catch (err) {
    console.error('approveSpawn orchestration threw before settling', err)
    return fail('internal')
  }
}
