// Memory proposals — pure DB state. A memory write an agent may not make on
// its own say (src/memories-http.js decides which) is kept here until the
// user answers the question the journal files for it; the HTTP surface, the
// item, the markers and the sweep live in src/memory-proposals-http.js.
//
//   pending   — waits for the user's tap on its item. At most one per
//               (user, memory name): a newer proposal for the name replaces
//               the older one.
//   approved  — the user tapped the approving button; the change was applied
//               as proposed.
//   declined  — the user tapped the other button, or closed the item.
//   replaced  — a newer proposal for the same name took its place.
//   expired   — nobody answered within PROPOSAL_TTL_MS.
//
// The row holds the change exactly as proposed. What the user reads on the
// item is rendered from it, and what an approval applies is read from it, so
// the two cannot differ.
import { randomBytes } from 'node:crypto'

export const PROPOSAL_TTL_MS = 7 * 24 * 60 * 60 * 1000
export const PROPOSAL_ACTIONS = ['save', 'delete']
export const SAVE_LABELS = ['Save it', 'Decline']
export const DELETE_LABELS = ['Delete it', 'Keep it']
export const labelsFor = (action) => (action === 'delete' ? DELETE_LABELS : SAVE_LABELS)

const newId = () => `mp_${randomBytes(8).toString('hex')}`

const rowToProposal = (r) => (r ? {
  id: r.id, user_id: r.user_id, name: r.name, action: r.action,
  description: r.description, body: r.body, type: r.type, scope: r.scope, memory_id: r.memory_id,
  from_device_id: r.from_device_id, from_convo_id: r.from_convo_id, item_id: r.item_id,
  state: r.state, created_at: r.created_at, updated_at: r.updated_at, expires_at: r.expires_at,
} : null)

export function getProposal(db, userId, id) {
  return rowToProposal(db.prepare('SELECT * FROM memory_proposals WHERE id=? AND user_id=?').get(id, userId))
}

export function pendingProposalFor(db, userId, name) {
  return rowToProposal(db.prepare("SELECT * FROM memory_proposals WHERE user_id=? AND name=? AND state='pending'").get(userId, name))
}

// The proposal an item asks about, whatever its state.
export function proposalOfItem(db, userId, itemId) {
  return rowToProposal(db.prepare('SELECT * FROM memory_proposals WHERE user_id=? AND item_id=? ORDER BY created_at DESC LIMIT 1').get(userId, itemId))
}

// Record a proposal. `fields` is {description, body, type, scope} for a save
// (type and scope undefined = keep or default, as on a direct write) and
// ignored for a delete; `memoryId` is the memory a delete names.
// Returns { proposal, inPlace, replaced }:
//  - inPlace: the pending proposal for this name came from the same device
//    and conversation and its item is still open, so the same row (and the
//    same item) now carries the new change;
//  - replaced: an older pending proposal that was set aside instead (another
//    device or conversation made it, or its item is gone). The caller files a
//    new item and tells the older one's conversation.
export function recordProposal(db, { userId, name, action, fields = {}, memoryId = null, fromDeviceId, fromConvoId = null, now = Date.now() }) {
  return db.transaction(() => {
    const save = action === 'save'
    const vals = {
      description: save ? fields.description : '', body: save ? (fields.body ?? '') : '',
      type: save ? (fields.type ?? null) : null, scope: save ? (fields.scope ?? null) : null,
    }
    const old = pendingProposalFor(db, userId, name)
    if (old) {
      const itemOpen = old.item_id && db.prepare("SELECT 1 FROM items WHERE id=? AND user_id=? AND state='open'").get(old.item_id, userId)
      if (itemOpen && old.from_device_id === fromDeviceId && old.from_convo_id === fromConvoId) {
        db.prepare('UPDATE memory_proposals SET action=?, description=?, body=?, type=?, scope=?, memory_id=?, updated_at=?, expires_at=? WHERE id=?')
          .run(action, vals.description, vals.body, vals.type, vals.scope, memoryId, now, now + PROPOSAL_TTL_MS, old.id)
        return { proposal: getProposal(db, userId, old.id), inPlace: true, replaced: null }
      }
      db.prepare("UPDATE memory_proposals SET state='replaced', updated_at=? WHERE id=?").run(now, old.id)
    }
    const id = newId()
    db.prepare(`INSERT INTO memory_proposals(id, user_id, name, action, description, body, type, scope, memory_id, from_device_id, from_convo_id, state, created_at, updated_at, expires_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,'pending',?,?,?)`)
      .run(id, userId, name, action, vals.description, vals.body, vals.type, vals.scope, memoryId, fromDeviceId, fromConvoId, now, now, now + PROPOSAL_TTL_MS)
    return { proposal: getProposal(db, userId, id), inPlace: false, replaced: old ? { ...old, state: 'replaced' } : null }
  })()
}

export function setProposalItem(db, id, itemId) {
  db.prepare('UPDATE memory_proposals SET item_id=? WHERE id=?').run(itemId, id)
}

// pending → `state`, once. Returns the row as it now stands, or null when it
// was not pending (answered, replaced or expired already) or has run out and
// only waits for the sweep.
export function settleProposal(db, { userId, id, state, now = Date.now() }) {
  const live = state === 'expired' ? '' : 'AND expires_at > ?'
  const args = state === 'expired' ? [state, now, id, userId] : [state, now, id, userId, now]
  const r = db.prepare(`UPDATE memory_proposals SET state=?, updated_at=? WHERE id=? AND user_id=? AND state='pending' ${live}`).run(...args)
  return r.changes ? getProposal(db, userId, id) : null
}

// The sweep: proposals nobody answered in time, each flipped to 'expired'.
export function expireProposals(db, now = Date.now()) {
  const rows = db.prepare("SELECT id, user_id FROM memory_proposals WHERE state='pending' AND expires_at <= ?").all(now)
  const out = []
  for (const r of rows) {
    const p = settleProposal(db, { userId: r.user_id, id: r.id, state: 'expired', now })
    if (p) out.push(p)
  }
  return out
}

// Settled rows are kept a while for the record, then dropped.
export function pruneProposals(db, now = Date.now(), keepMs = 30 * 24 * 60 * 60 * 1000) {
  return db.prepare("DELETE FROM memory_proposals WHERE state != 'pending' AND updated_at < ?").run(now - keepMs).changes
}
