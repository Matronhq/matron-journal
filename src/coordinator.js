// The user's Coordinator (spec 2026-09-23 coordinator redesign §1a): one
// conversation per user, stored here so every device and every bridge reads
// the same answer. Pure DB state — src/coordinator-http.js owns auth and the
// `coordinator` role events, the same split as missions.js / missions-http.js.
import { privateOwnedConvo } from './privacy.js'

export const COORDINATOR_EVENT_TYPE = 'coordinator'

export function getCoordinatorConvoId(db, userId) {
  return db.prepare('SELECT coordinator_convo_id FROM user_settings WHERE user_id=?').get(userId)?.coordinator_convo_id ?? null
}

// What a given caller may be told. An ordinary (filtered) agent never learns
// the id of a private-owned conversation — the same rule /snapshot and
// /roster apply — so it reads null, exactly as if no Coordinator were set.
export function coordinatorFor(db, userId, { excludePrivateOwned = false } = {}) {
  const id = getCoordinatorConvoId(db, userId)
  if (id && excludePrivateOwned && privateOwnedConvo(db, id)) return null
  return id
}

// One transaction: ownership check, read of the previous value, write. An
// unchanged value writes nothing (the route turns `changed: false` into "no
// events"). `null` clears.
export function setCoordinatorConvoId(db, userId, convoId, now = Date.now()) {
  return db.transaction(() => {
    if (convoId !== null) {
      const owned = db.prepare('SELECT 1 FROM conversations WHERE id=? AND owner_user_id=?').get(convoId, userId)
      if (!owned) throw new Error('no_convo')
    }
    const previous = getCoordinatorConvoId(db, userId)
    if (previous === convoId) return { previous, current: convoId, changed: false }
    db.prepare(`INSERT INTO user_settings(user_id, coordinator_convo_id, updated_at) VALUES(?,?,?)
      ON CONFLICT(user_id) DO UPDATE SET coordinator_convo_id=excluded.coordinator_convo_id, updated_at=excluded.updated_at`)
      .run(userId, convoId, now)
    return { previous, current: convoId, changed: true }
  })()
}
