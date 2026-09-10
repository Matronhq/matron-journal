// Pure DB state for missions & milestones (spec 2026-09-10). No hub, push
// or wake here — src/missions-http.js owns the side effects. Same stance
// as src/items.js: every recoverable failure is a tagged Error the HTTP
// layer maps to one status; anything else is a bug and reaches the 500.
import { nextNum, newId, BODY_MAX } from './items.js'
import { milestoneMarkerPayload } from './missions-marker.js'

export const MILESTONE_KINDS = ['user_input', 'progress']
export const TITLE_MAX = 200
export const CONVOS_MAX = 200

const now = () => Date.now()

// idem_key is internal (same stance as rowToItem).
export function missionRow(row) {
  if (!row) return null
  const { idem_key: _idemKey, ...rest } = row
  const out = { ...rest, closed_over_open_items: Number(rest.closed_over_open_items || 0) }
  for (const k of ['open_items', 'needs_you', 'conversations', 'milestones']) if (k in out) out[k] = Number(out[k])
  if ('last_milestone_json' in out) {
    out.last_milestone = out.last_milestone_json ? JSON.parse(out.last_milestone_json) : null
    delete out.last_milestone_json
  }
  return out
}

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
  if (partial && Object.keys(value).length === 0) return { ok: true, value }
  return { ok: true, value }
}

const COUNTS = `
  (SELECT COUNT(*) FROM items i WHERE i.mission_id = m.id AND i.state='open') AS open_items,
  (SELECT COUNT(*) FROM items i WHERE i.mission_id = m.id AND i.state='open' AND i.awaiting='user') AS needs_you,
  (SELECT COUNT(*) FROM conversations c WHERE c.mission_id = m.id) AS conversations,
  (SELECT COUNT(*) FROM milestones l WHERE l.mission_id = m.id) AS milestones,
  (SELECT json_object('num', l.num, 'title', l.title, 'kind', l.kind, 'created_at', l.created_at)
     FROM milestones l WHERE l.mission_id = m.id ORDER BY l.created_at DESC, l.seq DESC LIMIT 1) AS last_milestone_json
`

export function getMission(db, userId, idOrNum) {
  let row
  if (typeof idOrNum === 'string' && idOrNum.startsWith('ms_')) {
    row = db.prepare(`SELECT m.*, ${COUNTS} FROM missions m WHERE m.id=? AND m.user_id=?`).get(idOrNum, userId)
  } else {
    const n = Number(String(idOrNum).replace(/^#/, ''))
    if (!Number.isInteger(n) || n < 1) return null
    row = db.prepare(`SELECT m.*, ${COUNTS} FROM missions m WHERE m.num=? AND m.user_id=?`).get(n, userId)
  }
  return missionRow(row)
}

// Whenever a conversation GAINS a mission its unassigned items follow it.
export function repointItems(db, userId, convoId, missionId) {
  db.prepare('UPDATE items SET mission_id=? WHERE user_id=? AND origin_convo_id=? AND mission_id IS NULL').run(missionId, userId, convoId)
}

function attachConversation(db, userId, convoId, missionId) {
  db.prepare('UPDATE conversations SET mission_id=? WHERE id=? AND owner_user_id=? AND mission_id IS NULL').run(missionId, convoId, userId)
  repointItems(db, userId, convoId, missionId)
}

export function createMission(db, { userId, deviceId, createdBy, convoId, title, body = '', idemKey = null }) {
  return db.transaction(() => {
    if (idemKey) {
      const dup = db.prepare('SELECT id FROM missions WHERE user_id=? AND idem_key=?').get(userId, idemKey)
      if (dup) return { mission: getMission(db, userId, dup.id), duplicate: true, existing: false }
    }
    const convo = db.prepare('SELECT mission_id FROM conversations WHERE id=? AND owner_user_id=?').get(convoId, userId)
    if (!convo) throw new Error('no_convo')
    if (convo.mission_id) return { mission: getMission(db, userId, convo.mission_id), duplicate: false, existing: true }
    const id = newId('ms')
    const num = nextNum(db, userId)
    const ts = now()
    try {
      db.prepare(`INSERT INTO missions(id,user_id,num,state,title,body,origin_convo_id,origin_device_id,created_by,idem_key,created_at,updated_at)
        VALUES(?,?,?,'open',?,?,?,?,?,?,?,?)`).run(id, userId, num, title, body, convoId, deviceId, createdBy, idemKey, ts, ts)
    } catch (err) {
      if (idemKey && err.code === 'SQLITE_CONSTRAINT_UNIQUE') {
        const dup = db.prepare('SELECT id FROM missions WHERE user_id=? AND idem_key=?').get(userId, idemKey)
        if (dup) return { mission: getMission(db, userId, dup.id), duplicate: true, existing: false }
      }
      throw err
    }
    attachConversation(db, userId, convoId, id)
    return { mission: getMission(db, userId, id), duplicate: false, existing: false }
  })()
}

export function listMissions(db, userId, { state = null, since = null, excludePrivateOwned = false } = {}) {
  const where = ['m.user_id = ?']
  const args = [userId]
  if (state) { where.push('m.state = ?'); args.push(state) }
  if (since != null) { where.push('m.updated_at >= ?'); args.push(since) }
  if (excludePrivateOwned) {
    // Same shape as listItems' excludePrivateOwned: a mission born in a
    // private device's conversation is invisible to an ordinary agent.
    where.push(`NOT EXISTS (SELECT 1 FROM conversations cv JOIN devices d ON d.id = cv.agent_device_id
      WHERE cv.id = m.origin_convo_id AND d.private = 1)`)
  }
  const rows = db.prepare(`SELECT m.*, ${COUNTS} FROM missions m WHERE ${where.join(' AND ')}
    ORDER BY (m.last_milestone_at IS NULL), m.last_milestone_at DESC, m.created_at DESC`).all(...args)
  return rows.map(missionRow)
}

const PRIVATE_CONVO = `EXISTS (SELECT 1 FROM devices d WHERE d.id = c.agent_device_id AND d.private = 1)`

export function missionDetail(db, userId, missionId, { excludePrivateOwned = false } = {}) {
  const mission = getMission(db, userId, missionId)
  if (!mission) return null
  const sieve = excludePrivateOwned ? `AND NOT ${PRIVATE_CONVO}` : ''
  const milestones = db.prepare(`SELECT l.* FROM milestones l JOIN conversations c ON c.id = l.convo_id
    WHERE l.mission_id=? ${sieve} ORDER BY l.created_at DESC, l.seq DESC`).all(mission.id).map(milestoneRow)
  const items = db.prepare(`SELECT i.id, i.num, i.kind, i.state, i.awaiting, i.title, i.origin_convo_id, i.updated_at
    FROM items i JOIN conversations c ON c.id = i.origin_convo_id
    WHERE i.mission_id=? AND i.state='open' ${sieve}
    ORDER BY (i.awaiting = 'user') DESC, i.updated_at DESC`).all(mission.id)
  const conversations = db.prepare(`SELECT c.id, c.title, c.session_state AS state, d.name AS box
    FROM conversations c LEFT JOIN devices d ON d.id = c.agent_device_id
    WHERE c.mission_id=? ${sieve} ORDER BY c.created_at`).all(mission.id)
  return { mission, milestones, items, conversations }
}

export function updateMission(db, { userId, missionId, fields }) {
  return db.transaction(() => {
    const cur = db.prepare('SELECT state FROM missions WHERE id=? AND user_id=?').get(missionId, userId)
    if (!cur) return null
    if (cur.state === 'closed') throw new Error('closed')
    const sets = []; const args = []
    if (fields.title !== undefined) { sets.push('title=?'); args.push(fields.title) }
    if (fields.body !== undefined) { sets.push('body=?'); args.push(fields.body) }
    sets.push('updated_at=?'); args.push(now())
    db.prepare(`UPDATE missions SET ${sets.join(', ')} WHERE id=? AND user_id=?`).run(...args, missionId, userId)
    return getMission(db, userId, missionId)
  })()
}

export function joinMission(db, { userId, missionId, convoId }) {
  return db.transaction(() => {
    const m = db.prepare('SELECT id, state FROM missions WHERE id=? AND user_id=?').get(missionId, userId)
    if (!m) throw new Error('no_mission')
    if (m.state === 'closed') throw new Error('closed')
    const convo = db.prepare('SELECT mission_id FROM conversations WHERE id=? AND owner_user_id=?').get(convoId, userId)
    if (!convo) throw new Error('no_convo')
    if (convo.mission_id && convo.mission_id !== m.id) throw new Error('other_mission')
    if (!convo.mission_id) {
      const n = db.prepare('SELECT COUNT(*) AS n FROM conversations WHERE mission_id=?').get(m.id).n
      if (n >= CONVOS_MAX) throw new Error('too_many_convos')
      attachConversation(db, userId, convoId, m.id)
      db.prepare('UPDATE missions SET updated_at=? WHERE id=?').run(now(), m.id)
    }
    return getMission(db, userId, m.id)
  })()
}

export function closeMission(db, { userId, missionId, by, summary }) {
  return db.transaction(() => {
    const m = db.prepare('SELECT id, state FROM missions WHERE id=? AND user_id=?').get(missionId, userId)
    if (!m) throw new Error('no_mission')
    if (m.state === 'closed') throw new Error('closed')
    const open = db.prepare(`SELECT num, title, awaiting FROM items WHERE mission_id=? AND state='open' ORDER BY num`).all(m.id)
    if (by === 'agent') {
      const user = open.filter((i) => i.awaiting === 'user').map(({ num, title }) => ({ num, title }))
      if (user.length) { const e = new Error('user_items'); e.items = user; throw e }
      if (open.length) { const e = new Error('agent_items'); e.items = open.map(({ num, title }) => ({ num, title })); throw e }
    }
    const ts = now()
    db.prepare(`UPDATE missions SET state='closed', close_summary=?, closed_by=?, closed_over_open_items=?, closed_at=?, updated_at=?
      WHERE id=?`).run(summary, by, open.length, ts, ts, m.id)
    return { mission: getMission(db, userId, m.id), openItemNums: open.map((i) => i.num) }
  })()
}

// The milestone row and its marker are one write: appendMarker runs INSIDE
// this transaction (append() is itself a sync better-sqlite3 transaction,
// nested as a savepoint) and the returned seq is the row's anchor. If the
// append throws, nothing — not even the number — survives.
export function createMilestone(db, { userId, deviceId, createdBy, convoId, kind, title, body = '', idemKey = null, appendMarker }) {
  return db.transaction(() => {
    if (!MILESTONE_KINDS.includes(kind)) throw new Error('bad_kind')
    if (idemKey) {
      const dup = db.prepare('SELECT id, mission_id FROM milestones WHERE user_id=? AND idem_key=?').get(userId, idemKey)
      if (dup) {
        return { milestone: milestoneRow(db.prepare('SELECT * FROM milestones WHERE id=?').get(dup.id)), mission: getMission(db, userId, dup.mission_id), duplicate: true }
      }
    }
    const convo = db.prepare('SELECT mission_id FROM conversations WHERE id=? AND owner_user_id=?').get(convoId, userId)
    if (!convo) throw new Error('no_convo')
    if (!convo.mission_id) throw new Error('no_mission')
    const mission = getMission(db, userId, convo.mission_id)
    if (mission.state === 'closed') throw new Error('closed')
    const id = newId('ml')
    const num = nextNum(db, userId)
    const ts = now()
    const milestone = { id, num, kind, title, body }
    let r
    try {
      r = appendMarker(milestoneMarkerPayload({ milestone, mission, by: createdBy }))
    } catch (err) {
      const e = new Error('marker_append_failed'); e.cause = err; throw e
    }
    try {
      db.prepare(`INSERT INTO milestones(id,mission_id,user_id,num,kind,title,body,convo_id,seq,device_id,created_by,idem_key,created_at)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(id, mission.id, userId, num, kind, title, body, convoId, r.seq, deviceId, createdBy, idemKey, ts)
    } catch (err) {
      if (idemKey && err.code === 'SQLITE_CONSTRAINT_UNIQUE') throw new Error('idem_key_conflict')
      throw err
    }
    db.prepare('UPDATE missions SET last_milestone_at=?, updated_at=? WHERE id=?').run(ts, ts, mission.id)
    return { milestone: milestoneRow({ ...milestone, mission_id: mission.id, convo_id: convoId, seq: r.seq, device_id: deviceId, created_by: createdBy, created_at: ts }), mission: getMission(db, userId, mission.id), duplicate: false, seq: r.seq, ts: r.ts }
  })()
}

export function listMilestones(db, userId, { convoId, excludePrivateOwned = false }) {
  const sieve = excludePrivateOwned ? `AND NOT ${PRIVATE_CONVO}` : ''
  return db.prepare(`SELECT l.* FROM milestones l JOIN conversations c ON c.id = l.convo_id
    WHERE l.user_id=? AND l.convo_id=? ${sieve} ORDER BY l.created_at DESC, l.seq DESC`).all(userId, convoId).map(milestoneRow)
}
