// Pure DB state for missions & milestones (spec 2026-09-10). No hub, push
// or wake here — src/missions-http.js owns the side effects. Same stance
// as src/items.js: every recoverable failure is a tagged Error the HTTP
// layer maps to one status; anything else is a bug and reaches the 500.
import { nextNum, newId, BODY_MAX } from './items.js'
import { milestoneMarkerPayload } from './missions-marker.js'
import { markerTitleAllowed } from './privacy.js'
import { sharedConvoSql } from './visibility.js'
import { activateLink, endLink, linkRow, nextCurrent, topLevelActiveCount } from './mission-links.js'

export const MILESTONE_KINDS = ['user_input', 'progress']
export const TITLE_MAX = 200
export const CONVOS_MAX = 200
export const STATUS_MAX = 600
// Status (spec 2026-09-28 missions dashboard §1) is markdown, so \n and \t
// stay; every other C0/C1 control and U+2028/2029 is refused — the set
// items' action labels refuse (ACTION_BAD_CHARS), minus the two a
// paragraph needs. CRLF is folded to \n before this runs, so only a LONE
// \r is refused.
const STATUS_BAD_CHARS = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u2028\u2029]/
const STATUS_FIELDS = ['status', 'status_by', 'status_convo_id', 'status_updated_at']

const now = () => Date.now()

// idem_key is internal (same stance as rowToItem). `sieved_last_milestone_at`
// (fix round 3, B2) is a sort key countsSql computes for listMissions' ORDER
// BY — never part of the wire shape. `status_device_id` (spec 2026-09-28
// missions dashboard §1) is internal too: the device that wrote the status,
// kept only so the privacy sieve can key on it. `status_hidden` is the
// per-caller sieve verdict countsSql/sharedCountsSql compute — never on the wire.
export function missionRow(row) {
  if (!row) return null
  const {
    idem_key: _idemKey, sieved_last_milestone_at: _sievedLastMilestoneAt,
    status_device_id: _statusDeviceId, status_hidden: statusHidden, ...rest
  } = row
  const { closed_hidden: closedHidden, ...bare } = rest
  const out = { ...bare, closed_over_open_items: Number(bare.closed_over_open_items || 0) }
  // Same sieve for the closing conversation (CLOSED_PRIVATE): a private
  // Coordinator's conversation id must not reach an ordinary agent through
  // the mission row it closed. Null reads exactly as "none named".
  if (Number(closedHidden || 0) && 'closed_convo_id' in out) out.closed_convo_id = null
  for (const k of ['open_items', 'needs_you', 'conversations', 'milestones']) if (k in out) out[k] = Number(out[k])
  if ('last_milestone_json' in out) {
    out.last_milestone = out.last_milestone_json ? JSON.parse(out.last_milestone_json) : null
    delete out.last_milestone_json
  }
  // The sieve's verdict (STATUS_PRIVATE, below) — computed per caller by
  // countsSql / sharedCountsSql. A withheld status reads as four nulls, the
  // same shape as "never set", so its absence says nothing.
  if (Number(statusHidden || 0)) for (const k of STATUS_FIELDS) out[k] = null
  return out
}

// `idem_key` is internal, and so is `user_id` (fix round 2, minor 2): it is
// always the caller's own id — no route hands back another user's milestone —
// so returning it only widened the wire shape for nothing.
export function milestoneRow(row) {
  if (!row) return null
  const { idem_key: _idemKey, user_id: _userId, ...rest } = row
  return rest
}

export function validateMissionFields(body, { partial = false } = {}) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { ok: false }
  const value = {}
  if (body.title !== undefined) {
    if (typeof body.title !== 'string') return { ok: false }
    const t = body.title.trim()
    if (!t || t.length > TITLE_MAX) return { ok: false }
    value.title = t
  } else if (!partial) return { ok: false }
  if (body.body !== undefined) {
    if (typeof body.body !== 'string' || Buffer.byteLength(body.body, 'utf8') > BODY_MAX) return { ok: false }
    value.body = body.body
  }
  // PATCH only: POST /missions ignores a status rather than storing one.
  // null is the explicit clear; a string is trimmed, then 1–STATUS_MAX
  // UTF-16 code units (JS .length, like TITLE_MAX).
  if (partial && body.status !== undefined) {
    if (body.status === null) value.status = null
    else {
      if (typeof body.status !== 'string') return { ok: false }
      const s = body.status.replace(/\r\n/g, '\n').trim()
      if (!s || s.length > STATUS_MAX || STATUS_BAD_CHARS.test(s)) return { ok: false }
      value.status = s
    }
  }
  return { ok: true, value }
}

// Spec 2026-09-28 missions dashboard §1, privacy: a status written from a
// private-owned conversation is withheld from an ordinary agent the way that
// conversation's milestones are. Keyed on the writing DEVICE too: a private
// agent that named no conversation (or a public one) wrote it all the same.
// Evaluated at read time against the current private flag, like every other
// private-owned sieve here.
const STATUS_PRIVATE = `(
  EXISTS (SELECT 1 FROM devices sd WHERE sd.id = m.status_device_id AND sd.private = 1)
  OR EXISTS (SELECT 1 FROM conversations sc JOIN devices sd ON sd.id = sc.agent_device_id
             WHERE sc.id = m.status_convo_id AND sd.private = 1)
)`

// The closing conversation (closed_convo_id) is withheld from an ordinary
// agent when it is private-owned, as status_convo_id is above.
const CLOSED_PRIVATE = `EXISTS (SELECT 1 FROM conversations cc JOIN devices cd ON cd.id = cc.agent_device_id
             WHERE cc.id = m.closed_convo_id AND cd.private = 1)`

// Review fix (Task 7, Critical 1): every COUNTS subquery must apply the same
// private-owned-conversation sieve the caller's OWN arrays get in
// missionDetail — otherwise an ordinary agent that can't see a private
// convo's milestones/items/conversation still sees their totals (and the
// last milestone's TITLE, in last_milestone_json) leak through the summary
// row. Three separate joins because each subquery's own conversation
// column differs: items by origin_convo_id, milestones by convo_id,
// conversations are their own row.
function countsSql(excludePrivateOwned) {
  const itemSieve = excludePrivateOwned
    ? `AND NOT EXISTS (SELECT 1 FROM conversations oc JOIN devices d ON d.id = oc.agent_device_id WHERE oc.id = i.origin_convo_id AND d.private = 1)`
    : ''
  const milestoneSieve = excludePrivateOwned
    ? `AND NOT EXISTS (SELECT 1 FROM conversations mc JOIN devices d ON d.id = mc.agent_device_id WHERE mc.id = l.convo_id AND d.private = 1)`
    : ''
  const convoSieve = excludePrivateOwned
    ? `AND NOT EXISTS (SELECT 1 FROM devices d WHERE d.id = c.agent_device_id AND d.private = 1)`
    : ''
  return `
    (SELECT COUNT(*) FROM items i WHERE i.mission_id = m.id AND i.state='open' ${itemSieve}) AS open_items,
    (SELECT COUNT(*) FROM items i WHERE i.mission_id = m.id AND i.state='open' AND i.awaiting='user' ${itemSieve}) AS needs_you,
    (SELECT COUNT(*) FROM conversations c WHERE c.mission_id = m.id ${convoSieve}) AS conversations,
    (SELECT COUNT(*) FROM milestones l WHERE l.mission_id = m.id ${milestoneSieve}) AS milestones,
    (SELECT json_object('num', l.num, 'title', l.title, 'kind', l.kind, 'created_at', l.created_at)
       FROM milestones l WHERE l.mission_id = m.id ${milestoneSieve} ORDER BY l.created_at DESC, l.seq DESC LIMIT 1) AS last_milestone_json,
    (SELECT l.created_at FROM milestones l WHERE l.mission_id = m.id ${milestoneSieve}
       ORDER BY l.created_at DESC, l.seq DESC LIMIT 1) AS sieved_last_milestone_at,
    ${excludePrivateOwned ? STATUS_PRIVATE : '0'} AS status_hidden,
    ${excludePrivateOwned ? CLOSED_PRIVATE : '0'} AS closed_hidden
  `
}

// Final review (C1): the ORIGIN sieve — a mission born in a private device's
// conversation is invisible to an ordinary agent — belongs here, not only in
// missions-http.js's visibleMission wrapper. Two routes resolve a mission
// from a CONVERSATION rather than from an already-visible mission (POST
// /missions on a convo that already has one, POST /milestones), and both
// used to hand back (and, for milestones, write into) the unsieved row.
// Same predicate listMissions applies to its WHERE clause; one caller
// passing `excludePrivateOwned` now gets one consistent answer everywhere.
const ORIGIN_SIEVE = `NOT EXISTS (SELECT 1 FROM conversations cv JOIN devices d ON d.id = cv.agent_device_id
  WHERE cv.id = m.origin_convo_id AND d.private = 1)`

// Cross-user variant of ORIGIN_SIEVE: fails closed when the origin
// conversation's device row is gone (revoked), matching sharedConvoSql.
const ORIGIN_SHARED_SIEVE = `EXISTS (SELECT 1 FROM conversations cv LEFT JOIN devices d
    ON d.id = cv.agent_device_id AND d.user_id = cv.owner_user_id
  WHERE cv.id = m.origin_convo_id AND (cv.agent_device_id IS NULL OR d.private = 0))`

export function getMission(db, userId, idOrNum, { excludePrivateOwned = false } = {}) {
  const counts = countsSql(excludePrivateOwned)
  const sieve = excludePrivateOwned ? `AND ${ORIGIN_SIEVE}` : ''
  let row
  if (typeof idOrNum === 'string' && idOrNum.startsWith('ms_')) {
    row = db.prepare(`SELECT m.*, ${counts} FROM missions m WHERE m.id=? AND m.user_id=? ${sieve}`).get(idOrNum, userId)
  } else {
    const n = Number(String(idOrNum).replace(/^#/, ''))
    if (!Number.isInteger(n) || n < 1) return null
    row = db.prepare(`SELECT m.*, ${counts} FROM missions m WHERE m.num=? AND m.user_id=? ${sieve}`).get(n, userId)
  }
  return missionRow(row)
}

// Whenever a conversation GAINS a mission its unassigned items follow it.
// Fix round 3, B1: repointing an item must bump ITS OWN updated_at (the
// caller's `ts`, not a fresh now() — one moment for the whole transaction)
// or `GET /items?since=` and any client syncing on updated_at never learn
// the item gained a mission after its conversation was created/joined.
export function repointItems(db, userId, convoId, missionId, ts) {
  db.prepare('UPDATE items SET mission_id=?, updated_at=? WHERE user_id=? AND origin_convo_id=? AND mission_id IS NULL').run(missionId, ts, userId, convoId)
}

function attachConversation(db, userId, convoId, missionId, ts) {
  const r = db.prepare('UPDATE conversations SET mission_id=? WHERE id=? AND owner_user_id=? AND mission_id IS NULL').run(missionId, convoId, userId)
  if (r.changes) activateLink(db, { missionId, convoId, userId, how: 'origin', ts })
  repointItems(db, userId, convoId, missionId, ts)
}

export function createMission(db, { userId, deviceId, createdBy, convoId, title, body = '', idemKey = null, excludePrivateOwned = false, attach = true }) {
  return db.transaction(() => {
    if (idemKey) {
      const dup = db.prepare('SELECT id FROM missions WHERE user_id=? AND idem_key=?').get(userId, idemKey)
      if (dup) return { mission: getMission(db, userId, dup.id, { excludePrivateOwned }), duplicate: true, existing: false }
    }
    const convo = db.prepare('SELECT mission_id FROM conversations WHERE id=? AND owner_user_id=?').get(convoId, userId)
    if (!convo) throw new Error('no_convo')
    // attach:false (spec 2026-09-23 coordinator redesign §1b) creates an
    // UNASSIGNED mission: the conversation is only its provenance
    // (origin_convo_id), so whether it already belongs to a mission is
    // irrelevant — no short-circuit, and nothing below attaches it.
    if (attach && convo.mission_id) return { mission: getMission(db, userId, convo.mission_id, { excludePrivateOwned }), duplicate: false, existing: true }
    const id = newId('ms')
    const num = nextNum(db, userId)
    const ts = now()
    try {
      db.prepare(`INSERT INTO missions(id,user_id,num,state,title,body,origin_convo_id,origin_device_id,created_by,idem_key,created_at,updated_at)
        VALUES(?,?,?,'open',?,?,?,?,?,?,?,?)`).run(id, userId, num, title, body, convoId, deviceId, createdBy, idemKey, ts, ts)
    } catch (err) {
      if (idemKey && err.code === 'SQLITE_CONSTRAINT_UNIQUE') {
        const dup = db.prepare('SELECT id FROM missions WHERE user_id=? AND idem_key=?').get(userId, idemKey)
        if (dup) return { mission: getMission(db, userId, dup.id, { excludePrivateOwned }), duplicate: true, existing: false }
      }
      throw err
    }
    if (attach) attachConversation(db, userId, convoId, id, ts)
    return { mission: getMission(db, userId, id, { excludePrivateOwned }), duplicate: false, existing: false }
  })()
}

export function listMissions(db, userId, { state = null, since = null, excludePrivateOwned = false } = {}) {
  const where = ['m.user_id = ?']
  const args = [userId]
  if (state) { where.push('m.state = ?'); args.push(state) }
  if (since != null) { where.push('m.updated_at >= ?'); args.push(since) }
  // Same shape as listItems' excludePrivateOwned: a mission born in a private
  // device's conversation is invisible to an ordinary agent. One predicate,
  // shared with getMission (see ORIGIN_SIEVE) so the list and the single-row
  // read can never disagree about what is hidden.
  if (excludePrivateOwned) where.push(ORIGIN_SIEVE)
  // Fix round 3, B2: the stored m.last_milestone_at (and updated_at) are
  // bumped by EVERY milestone, including one posted on a private-owned
  // conversation the ordinary agent can't see — ordering on it would jump a
  // mission to the top of a list that shows last_milestone: null,
  // milestones: 0 for it, disagreeing with the row it displays. When
  // excludePrivateOwned, order by the SIEVED last-milestone timestamp
  // (sieved_last_milestone_at, the same sieved subquery countsSql uses for
  // last_milestone) so the list order always agrees with what's shown. The
  // owner/private-agent path is unchanged (stored column, unsieved).
  const orderCol = excludePrivateOwned ? 'sieved_last_milestone_at' : 'm.last_milestone_at'
  const rows = db.prepare(`SELECT m.*, ${countsSql(excludePrivateOwned)} FROM missions m WHERE ${where.join(' AND ')}
    ORDER BY (${orderCol} IS NULL), ${orderCol} DESC, m.created_at DESC`).all(...args)
  return rows.map(missionRow)
}

const PRIVATE_CONVO = `EXISTS (SELECT 1 FROM devices d WHERE d.id = c.agent_device_id AND d.private = 1)`

// Fold the LEFT JOINed conversation_status columns into one `status` block
// (omitted when the session never reported), the shape GET /roster serves
// (spec 2026-09-29 coordinator session control §1). Own-user detail only:
// sharedMissionDetail deliberately carries no session header.
function withConvoStatus({ status_reported_at, status_json, ...row }) {
  if (status_json == null) return row
  try { return { ...row, status: { reported_at: status_reported_at, ...JSON.parse(status_json) } } } catch { return row }
}

export function missionDetail(db, userId, missionId, { excludePrivateOwned = false } = {}) {
  const mission = getMission(db, userId, missionId, { excludePrivateOwned })
  if (!mission) return null
  const sieve = excludePrivateOwned ? `AND NOT ${PRIVATE_CONVO}` : ''
  const milestones = db.prepare(`SELECT l.* FROM milestones l JOIN conversations c ON c.id = l.convo_id
    WHERE l.mission_id=? ${sieve} ORDER BY l.created_at DESC, l.seq DESC`).all(mission.id).map(milestoneRow)
  const items = db.prepare(`SELECT i.id, i.num, i.kind, i.state, i.awaiting, i.title, i.origin_convo_id, i.updated_at
    FROM items i JOIN conversations c ON c.id = i.origin_convo_id
    WHERE i.mission_id=? AND i.state='open' ${sieve}
    ORDER BY (i.awaiting = 'user') DESC, i.updated_at DESC`).all(mission.id)
  const conversations = db.prepare(`SELECT c.id, c.title, c.session_state AS state, d.name AS box,
      s.reported_at AS status_reported_at, s.status AS status_json
    FROM conversations c LEFT JOIN devices d ON d.id = c.agent_device_id
    LEFT JOIN conversation_status s ON s.convo_id = c.id
    WHERE c.mission_id=? ${sieve} ORDER BY c.created_at`).all(mission.id).map(withConvoStatus)
  return { mission, milestones, items, conversations }
}

// `statusWriter` {by, convoId, deviceId} (spec 2026-09-28 missions dashboard
// §1) is required whenever fields.status is a string: the status columns are
// always written as one set, never one of them alone, with the same `ts` as
// updated_at. A null status clears all of them, status_device_id included.
export function updateMission(db, { userId, missionId, fields, statusWriter = null, excludePrivateOwned = false }) {
  return db.transaction(() => {
    const cur = db.prepare('SELECT state FROM missions WHERE id=? AND user_id=?').get(missionId, userId)
    if (!cur) return null
    if (cur.state === 'closed') throw new Error('closed')
    const ts = now()
    const sets = []; const args = []
    if (fields.title !== undefined) { sets.push('title=?'); args.push(fields.title) }
    if (fields.body !== undefined) { sets.push('body=?'); args.push(fields.body) }
    if (fields.status !== undefined) {
      if (fields.status !== null && !statusWriter) throw new Error('status_writer_required')
      const w = fields.status === null ? { by: null, convoId: null, deviceId: null } : statusWriter
      sets.push('status=?', 'status_by=?', 'status_convo_id=?', 'status_device_id=?', 'status_updated_at=?')
      args.push(fields.status, w.by, w.convoId ?? null, w.deviceId ?? null, fields.status === null ? null : ts)
    }
    sets.push('updated_at=?'); args.push(ts)
    db.prepare(`UPDATE missions SET ${sets.join(', ')} WHERE id=? AND user_id=?`).run(...args, missionId, userId)
    return getMission(db, userId, missionId, { excludePrivateOwned })
  })()
}

// Spec 2026-09-30 §3: join adds (or reactivates) a link and makes it
// CURRENT. The previous current mission stays active ("also on") — a
// conversation on another mission is no longer refused. `action` tells the
// HTTP layer which marker to write: 'joined' (a new or reactivated link),
// 'current_changed' (an already-active link became current) or null (it
// already was current: a no-op, no marker). The cap counts active
// top-level links; a sub-chat never fills a mission.
export function joinMission(db, { userId, missionId, convoId, how = 'joined', excludePrivateOwned = false }) {
  return db.transaction(() => {
    const m = db.prepare('SELECT id, state FROM missions WHERE id=? AND user_id=?').get(missionId, userId)
    if (!m) throw new Error('no_mission')
    if (m.state === 'closed') throw new Error('closed')
    const convo = db.prepare('SELECT mission_id, parent_convo_id FROM conversations WHERE id=? AND owner_user_id=?').get(convoId, userId)
    if (!convo) throw new Error('no_convo')
    const link = linkRow(db, m.id, convoId)
    const active = !!link && link.ended_at == null
    if (active && convo.mission_id === m.id) return { mission: getMission(db, userId, m.id, { excludePrivateOwned }), action: null }
    if (!active && convo.parent_convo_id == null && topLevelActiveCount(db, m.id) >= CONVOS_MAX) throw new Error('too_many_convos')
    const ts = now()
    activateLink(db, { missionId: m.id, convoId, userId, how, ts })
    db.prepare('UPDATE conversations SET mission_id=? WHERE id=? AND owner_user_id=?').run(m.id, convoId, userId)
    repointItems(db, userId, convoId, m.id, ts)
    db.prepare('UPDATE missions SET updated_at=? WHERE id=?').run(ts, m.id)
    if (convo.mission_id && convo.mission_id !== m.id) db.prepare('UPDATE missions SET updated_at=? WHERE id=?').run(ts, convo.mission_id)
    return { mission: getMission(db, userId, m.id, { excludePrivateOwned }), action: active ? 'current_changed' : 'joined' }
  })()
}

// Spec 2026-09-30 §3: leave ends a link (kept as history). Leaving the
// CURRENT one moves current to the most recently joined remaining active
// link on an open mission, else to none (nextCurrent). An already-ended
// link is a no-op (left:false) so a retried leave is safe; no link at all
// is 'no_link'. Items stay where they are. A closed mission may be left.
export function leaveMission(db, { userId, missionId, convoId, excludePrivateOwned = false }) {
  return db.transaction(() => {
    const m = db.prepare('SELECT id FROM missions WHERE id=? AND user_id=?').get(missionId, userId)
    if (!m) throw new Error('no_mission')
    const convo = db.prepare('SELECT mission_id FROM conversations WHERE id=? AND owner_user_id=?').get(convoId, userId)
    if (!convo) throw new Error('no_convo')
    const link = linkRow(db, m.id, convoId)
    if (!link) throw new Error('no_link')
    if (link.ended_at != null) {
      return { mission: getMission(db, userId, m.id, { excludePrivateOwned }), left: false, currentChanged: false, currentMissionId: convo.mission_id ?? null }
    }
    const ts = now()
    endLink(db, { missionId: m.id, convoId, ts })
    let current = convo.mission_id ?? null
    const wasCurrent = current === m.id
    if (wasCurrent) {
      current = nextCurrent(db, convoId)
      db.prepare('UPDATE conversations SET mission_id=? WHERE id=? AND owner_user_id=?').run(current, convoId, userId)
    }
    db.prepare('UPDATE missions SET updated_at=? WHERE id=?').run(ts, m.id)
    return {
      mission: getMission(db, userId, m.id, { excludePrivateOwned }),
      left: true, currentChanged: wasCurrent && current !== null, currentMissionId: current,
    }
  })()
}

// Review fix (Task 7, Critical 2): a hidden open item (on a private-owned
// conversation the caller can't see) still BLOCKS the close — it exists and
// is open, whether or not this caller can see it — but the `items` array on
// the thrown error is filtered to what the caller may actually see, so an
// ordinary agent's 409 never names a private item or its title.
// `by === 'agent'` covers both an ordinary and a private agent; only the
// ordinary one passes excludePrivateOwned true.
// `closedConvoId` is the conversation the closing agent named (validated by
// the HTTP layer: on the mission, or the Coordinator) — stored for the
// record and echoed on the marker; null when none was named.
export function closeMission(db, { userId, missionId, by, summary, closedConvoId = null, excludePrivateOwned = false }) {
  return db.transaction(() => {
    const m = db.prepare('SELECT id, state FROM missions WHERE id=? AND user_id=?').get(missionId, userId)
    if (!m) throw new Error('no_mission')
    if (m.state === 'closed') throw new Error('closed')
    const open = db.prepare(`
      SELECT i.num, i.title, i.awaiting,
        EXISTS (SELECT 1 FROM conversations oc JOIN devices d ON d.id = oc.agent_device_id
                WHERE oc.id = i.origin_convo_id AND d.private = 1) AS is_private
      FROM items i WHERE i.mission_id=? AND i.state='open' ORDER BY i.num
    `).all(m.id)
    const visible = (i) => !excludePrivateOwned || !i.is_private
    if (by === 'agent') {
      const user = open.filter((i) => i.awaiting === 'user')
      if (user.length) { const e = new Error('user_items'); e.items = user.filter(visible).map(({ num, title }) => ({ num, title })); throw e }
      if (open.length) { const e = new Error('agent_items'); e.items = open.filter(visible).map(({ num, title }) => ({ num, title })); throw e }
    }
    const ts = now()
    db.prepare(`UPDATE missions SET state='closed', close_summary=?, closed_by=?, closed_convo_id=?, closed_over_open_items=?, closed_at=?, updated_at=?
      WHERE id=?`).run(summary, by, closedConvoId, open.length, ts, ts, m.id)
    return { mission: getMission(db, userId, m.id, { excludePrivateOwned }), openItemNums: open.map((i) => i.num) }
  })()
}

// The milestone row and its marker are one write: appendMarker runs INSIDE
// this transaction (append() is itself a sync better-sqlite3 transaction,
// nested as a savepoint) and the returned seq is the row's anchor. If the
// append throws, nothing — not even the number — survives.
export function createMilestone(db, { userId, deviceId, createdBy, convoId, kind, title, body = '', idemKey = null, appendMarker, excludePrivateOwned = false }) {
  return db.transaction(() => {
    if (!MILESTONE_KINDS.includes(kind)) throw new Error('bad_kind')
    if (idemKey) {
      const dup = db.prepare('SELECT id, mission_id FROM milestones WHERE user_id=? AND idem_key=?').get(userId, idemKey)
      if (dup) {
        const mission = getMission(db, userId, dup.mission_id, { excludePrivateOwned })
        // Hidden to this caller (C1) — answer exactly as a fresh post would,
        // never a 200 carrying a null mission.
        if (!mission) throw new Error('no_mission')
        return { milestone: milestoneRow(db.prepare('SELECT * FROM milestones WHERE id=?').get(dup.id)), mission, duplicate: true }
      }
    }
    const convo = db.prepare('SELECT mission_id FROM conversations WHERE id=? AND owner_user_id=?').get(convoId, userId)
    if (!convo) throw new Error('no_convo')
    if (!convo.mission_id) throw new Error('no_mission')
    // Resolved THROUGH the caller's own sieve (C1): a conversation the user
    // joined to a private-origin mission must not become a write path into
    // it for an ordinary agent. Refused before the marker append, so nothing
    // — not the row, not the number, not the event — is written.
    const mission = getMission(db, userId, convo.mission_id, { excludePrivateOwned })
    if (!mission) throw new Error('no_mission')
    if (mission.state === 'closed') throw new Error('closed')
    const id = newId('ml')
    const num = nextNum(db, userId)
    const ts = now()
    const milestone = { id, num, kind, title, body }
    // Numbers, never words, across the privacy boundary (fix round 2,
    // Critical): the user may post a milestone on a PUBLIC conversation they
    // joined to a private-origin mission, and that conversation's ordinary
    // agents replay this stored marker verbatim. The milestone's own fields
    // stay — it is this conversation's own content — but the mission title
    // does not travel with it.
    const markerWithTitle = markerTitleAllowed(db, mission.origin_convo_id, convoId)
    let r
    try {
      r = appendMarker(milestoneMarkerPayload({ milestone, mission, by: createdBy, withTitle: markerWithTitle }))
    } catch (err) {
      const e = new Error('marker_append_failed'); e.cause = err; throw e
    }
    try {
      db.prepare(`INSERT INTO milestones(id,mission_id,user_id,num,kind,title,body,convo_id,seq,device_id,created_by,idem_key,created_at)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(id, mission.id, userId, num, kind, title, body, convoId, r.seq, deviceId, createdBy, idemKey, ts)
    } catch (err) {
      // Review fix (Task 7, Important #4): the marker was appended INSIDE
      // this transaction (its seq is the row's anchor — see the comment
      // above), so a colliding idem_key at INSERT time must roll the WHOLE
      // transaction back, marker included. Returning a "duplicate" here
      // instead (the previous fix) committed a milestone event whose
      // milestone_id pointed at a row that was never written — verified
      // over real HTTP by the reviewer (one marker event, backing row
      // absent). The caller (missions-http.js) recovers by re-querying the
      // winner's row AFTER this transaction has rolled back, exactly the
      // way createMission's INSERT-race catch already recovers a mission —
      // but that recovery cannot safely live inside this transaction, only
      // after it.
      throw err.code === 'SQLITE_CONSTRAINT_UNIQUE' && idemKey ? new Error('idem_key_conflict') : err
    }
    db.prepare('UPDATE missions SET last_milestone_at=?, updated_at=? WHERE id=?').run(ts, ts, mission.id)
    return { milestone: milestoneRow({ ...milestone, mission_id: mission.id, user_id: userId, convo_id: convoId, seq: r.seq, device_id: deviceId, created_by: createdBy, created_at: ts }), mission: getMission(db, userId, mission.id, { excludePrivateOwned }), duplicate: false, seq: r.seq, ts: r.ts, markerWithTitle }
  })()
}

export function listMilestones(db, userId, { convoId, excludePrivateOwned = false }) {
  const sieve = excludePrivateOwned ? `AND NOT ${PRIVATE_CONVO}` : ''
  return db.prepare(`SELECT l.* FROM milestones l JOIN conversations c ON c.id = l.convo_id
    WHERE l.user_id=? AND l.convo_id=? ${sieve} ORDER BY l.created_at DESC, l.seq DESC`).all(userId, convoId).map(milestoneRow)
}

// Cross-user reads (spec 2026-09-23 tracker web/teams). A mission is shared
// with @viewer when its origin conversation is not private-owned
// (ORIGIN_SHARED_SIEVE — otherwise a colleague who later joins a shared
// public conversation to a private-born mission would see its title/body,
// review round 2, Finding 2; it fails closed on a revoked device, unlike
// ORIGIN_SIEVE, which the owner's own private-owned filtering still uses)
// AND its origin conversation, or any conversation carrying its mission_id,
// passes the shared rule; its detail lists only those conversations'
// milestones and items.
const MISSION_SHARED = `(
  ${ORIGIN_SHARED_SIEVE}
  AND (
    EXISTS (SELECT 1 FROM conversations cv WHERE cv.id = m.origin_convo_id AND ${sharedConvoSql('cv')})
    OR EXISTS (SELECT 1 FROM conversations cv WHERE cv.mission_id = m.id AND ${sharedConvoSql('cv')})
  )
)`
const OWNER_JSON = `json_object('user_id', u.id, 'name', u.name, 'github_login', ga.login) AS owner_json`
const OWNER_FROM = `JOIN users u ON u.id = m.user_id LEFT JOIN github_accounts ga ON ga.user_id = m.user_id`

// Review round 2, Finding 1: countsSql(true) only sieves private-DEVICE
// conversations — it still counts (and takes last_milestone from) a
// conversation that carries this mission's id but fails the SHARED rule for
// THIS viewer (no repo, or a repo whose org this viewer isn't in). That let
// a foreign viewer's summary/detail counts disagree with what
// sharedMissionDetail actually lists, and leaked a milestone TITLE from a
// conversation the viewer cannot otherwise read. Every subquery here is
// sieved by sharedConvoSql for @viewer instead — the same predicate
// sharedMissionDetail's own three queries use — so the counts, the ordering
// key (sieved_last_milestone_at) and the detail arrays can never disagree.
// Items also exclude consent mirrors (i.consent IS NULL), matching
// sharedMissionDetail's own items query — a consent ask is the mission
// owner's alone and must never surface to a colleague, not even as a count.
// Status: hidden when privately written, written from a conversation this
// viewer cannot read, or written by an agent that named NO conversation at
// all — a status is a synthesis across the mission's conversations, which
// may include ones this colleague can't read, so an unattributed agent
// write fails closed rather than being taken on faith. A client write with
// no conversation is still shared like the title and body: the owner's own
// device vouches for it the way it vouches for everything else it writes.
function sharedCountsSql() {
  return `
    (SELECT COUNT(*) FROM items i JOIN conversations ic ON ic.id = i.origin_convo_id
       WHERE i.mission_id = m.id AND i.state='open' AND i.consent IS NULL AND ${sharedConvoSql('ic')}) AS open_items,
    (SELECT COUNT(*) FROM items i JOIN conversations ic ON ic.id = i.origin_convo_id
       WHERE i.mission_id = m.id AND i.state='open' AND i.awaiting='user' AND i.consent IS NULL AND ${sharedConvoSql('ic')}) AS needs_you,
    (SELECT COUNT(*) FROM conversations cc WHERE cc.mission_id = m.id AND ${sharedConvoSql('cc')}) AS conversations,
    (SELECT COUNT(*) FROM milestones l JOIN conversations mc ON mc.id = l.convo_id
       WHERE l.mission_id = m.id AND ${sharedConvoSql('mc')}) AS milestones,
    (SELECT json_object('num', l.num, 'title', l.title, 'kind', l.kind, 'created_at', l.created_at)
       FROM milestones l JOIN conversations mc ON mc.id = l.convo_id
       WHERE l.mission_id = m.id AND ${sharedConvoSql('mc')} ORDER BY l.created_at DESC, l.seq DESC LIMIT 1) AS last_milestone_json,
    (SELECT l.created_at FROM milestones l JOIN conversations mc ON mc.id = l.convo_id
       WHERE l.mission_id = m.id AND ${sharedConvoSql('mc')}
       ORDER BY l.created_at DESC, l.seq DESC LIMIT 1) AS sieved_last_milestone_at,
    (${STATUS_PRIVATE}
      OR (m.status_by = 'agent' AND m.status_convo_id IS NULL)
      OR (m.status_convo_id IS NOT NULL
          AND NOT EXISTS (SELECT 1 FROM conversations sc WHERE sc.id = m.status_convo_id AND ${sharedConvoSql('sc')}))) AS status_hidden,
    (m.closed_convo_id IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM conversations cc WHERE cc.id = m.closed_convo_id AND ${sharedConvoSql('cc')})) AS closed_hidden
  `
}

function sharedMissionRow(row) {
  if (!row) return null
  const { owner_json: ownerJson, ...rest } = row
  const mission = missionRow(rest)
  mission.owner = JSON.parse(ownerJson)
  return mission
}

export function listSharedMissions(db, viewerUserId) {
  return db.prepare(`SELECT m.*, ${sharedCountsSql()}, ${OWNER_JSON} FROM missions m ${OWNER_FROM}
    WHERE ${MISSION_SHARED}
    ORDER BY (sieved_last_milestone_at IS NULL), sieved_last_milestone_at DESC, m.created_at DESC`)
    .all({ viewer: viewerUserId }).map(sharedMissionRow)
}

export function getSharedMission(db, viewerUserId, missionId) {
  if (typeof missionId !== 'string' || !missionId.startsWith('ms_')) return null
  return sharedMissionRow(db.prepare(`SELECT m.*, ${sharedCountsSql()}, ${OWNER_JSON} FROM missions m ${OWNER_FROM}
    WHERE m.id = @id AND ${MISSION_SHARED}`).get({ viewer: viewerUserId, id: missionId }))
}

export function sharedMissionDetail(db, viewerUserId, mission) {
  const args = { viewer: viewerUserId, mid: mission.id }
  const milestones = db.prepare(`SELECT l.* FROM milestones l JOIN conversations cv ON cv.id = l.convo_id
    WHERE l.mission_id = @mid AND ${sharedConvoSql('cv')} ORDER BY l.created_at DESC, l.seq DESC`).all(args).map(milestoneRow)
  const items = db.prepare(`SELECT i.id, i.num, i.kind, i.state, i.awaiting, i.title, i.origin_convo_id, i.updated_at
    FROM items i JOIN conversations cv ON cv.id = i.origin_convo_id
    WHERE i.mission_id = @mid AND i.state='open' AND i.consent IS NULL AND ${sharedConvoSql('cv')}
    ORDER BY (i.awaiting = 'user') DESC, i.updated_at DESC`).all(args)
  const conversations = db.prepare(`SELECT cv.id, cv.title, cv.session_state AS state, cv.repo, d.name AS box
    FROM conversations cv LEFT JOIN devices d ON d.id = cv.agent_device_id
    WHERE cv.mission_id = @mid AND ${sharedConvoSql('cv')} ORDER BY cv.created_at`).all(args)
  return { mission, milestones, items, conversations }
}

export function listSharedMilestones(db, viewerUserId, convoId) {
  return db.prepare(`SELECT l.* FROM milestones l JOIN conversations cv ON cv.id = l.convo_id
    WHERE l.convo_id = @cid AND ${sharedConvoSql('cv')} ORDER BY l.created_at DESC, l.seq DESC`)
    .all({ viewer: viewerUserId, cid: convoId }).map(milestoneRow)
}
