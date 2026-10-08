// Pinned desk chats: the user's own sidebar entries for standing
// conversations (an inbox desk, a help desk, an ops desk), drawn
// under the Coordinator in every app. Pure reads and writes over convo_pins;
// src/pins-http.js owns auth, validation and the live frame.
//
// A pin follows a CONVERSATION. A desk's conversation id survives idle reaps,
// restarts, /switch and the box sleeping; only a deliberate new session gets a
// new id. For that case each pin carries a `successor` hint — the newest
// top-level session started on the pinned conversation's box after it last
// spoke — which the apps offer as "move pin here?". Nothing moves on its own:
// a box often runs more than one session.
import { MESSAGE_TYPES, MESSAGE_TYPES_SQL } from './message-types.js'
import { sanitizePeerText } from './peer-text.js'

export const PIN_LIMIT = 5
export const PIN_LABEL_MAX = 24
export const PIN_EMOJI_MAX = 16

// Label: one clean line of 1..24 characters (code points, so an emoji in a
// label counts once, as the apps count it). Returns '' when unusable.
export function cleanLabel(s) {
  if (typeof s !== 'string' || s.length > 4 * PIN_LABEL_MAX) return ''
  const label = sanitizePeerText(s, 4 * PIN_LABEL_MAX)
  return Array.from(label).length <= PIN_LABEL_MAX ? label : ''
}
// Emoji: one short token, no whitespace. '' clears it (the apps draw the
// label's first letter instead). Returns null when unusable.
export function cleanEmoji(s) {
  if (s === '') return ''
  if (typeof s !== 'string' || s.length > PIN_EMOJI_MAX || /[\s\u0000-\u001f\u007f]/.test(s)) return null
  return s
}

const ownedConvo = (db, userId, convoId) =>
  db.prepare('SELECT id, agent_device_id, session_state, created_at FROM conversations WHERE id=? AND owner_user_id=?').get(convoId, userId)

const lastMessageTs = (db, convoId) =>
  db.prepare(`SELECT ts FROM events WHERE convo_id=? AND type IN (${MESSAGE_TYPES_SQL}) ORDER BY seq DESC LIMIT 1`).get(convoId)?.ts ?? null

// The newest session on `deviceId` that could have replaced the pinned one:
// top-level, not a system conversation, not an agent room or a guest room,
// not itself pinned, started after both the pin and the pinned
// conversation's last message, and not the one the user dismissed.
function successorFor(db, userId, pin, convo) {
  const deviceId = convo?.agent_device_id ?? pin.device_id
  if (deviceId == null) return null
  const since = Math.max(pin.created_at, convo ? (lastMessageTs(db, convo.id) ?? convo.created_at) : 0)
  const row = db.prepare(
    `SELECT c.id, c.title, c.created_at FROM conversations c
     WHERE c.owner_user_id=? AND c.agent_device_id=? AND c.id<>?
       AND c.parent_convo_id IS NULL AND c.system IS NULL AND c.created_at>?
       AND NOT EXISTS(SELECT 1 FROM convo_agents ca WHERE ca.convo_id=c.id)
       AND NOT EXISTS(SELECT 1 FROM person_rooms pr WHERE pr.guest_room_id=c.id)
       AND NOT EXISTS(SELECT 1 FROM convo_pins p WHERE p.user_id=? AND p.convo_id=c.id)
     ORDER BY c.created_at DESC LIMIT 1`
  ).get(userId, deviceId, pin.convo_id, since, userId)
  if (!row || row.id === pin.hint_dismissed_id) return null
  return { convo_id: row.id, title: row.title, created_at: row.created_at }
}

// The whole list, in the user's order, as every app and GET /pins see it.
// `missing` marks a pin whose conversation row no longer exists (the apps
// grey it out with Move pin… and Unpin rather than dropping it silently).
export function listPins(db, userId) {
  const pins = db.prepare('SELECT * FROM convo_pins WHERE user_id=? ORDER BY position, created_at').all(userId)
  return pins.map((p) => {
    const convo = ownedConvo(db, userId, p.convo_id)
    const successor = successorFor(db, userId, p, convo)
    return {
      convo_id: p.convo_id,
      label: p.label,
      emoji: p.emoji,
      position: p.position,
      device_id: convo?.agent_device_id ?? p.device_id ?? null,
      ...(convo ? {} : { missing: true }),
      ...(successor ? { successor } : {}),
      created_at: p.created_at,
      updated_at: p.updated_at,
    }
  })
}

// convo_id → {label, emoji}, for decorating roster rows.
export function pinLabels(db, userId) {
  const out = new Map()
  for (const r of db.prepare('SELECT convo_id, label, emoji FROM convo_pins WHERE user_id=?').all(userId)) out.set(r.convo_id, { label: r.label, emoji: r.emoji })
  return out
}

// Pin, or rename/re-icon an existing pin. A new pin goes last. Throws
// 'no_convo' for a conversation the user does not own, 'pin_limit' past the cap.
export function upsertPin(db, userId, convoId, { label, emoji }, now = Date.now()) {
  return db.transaction(() => {
    const existing = db.prepare('SELECT * FROM convo_pins WHERE user_id=? AND convo_id=?').get(userId, convoId)
    if (existing) {
      db.prepare('UPDATE convo_pins SET label=COALESCE(?, label), emoji=COALESCE(?, emoji), updated_at=? WHERE user_id=? AND convo_id=?')
        .run(label ?? null, emoji ?? null, now, userId, convoId)
      return
    }
    const convo = ownedConvo(db, userId, convoId)
    if (!convo) throw new Error('no_convo')
    if (label == null) throw new Error('no_label')
    const { n, top } = db.prepare('SELECT COUNT(*) AS n, MAX(position) AS top FROM convo_pins WHERE user_id=?').get(userId)
    if (n >= PIN_LIMIT) throw new Error('pin_limit')
    db.prepare(`INSERT INTO convo_pins(user_id, convo_id, label, emoji, position, device_id, created_at, updated_at)
      VALUES(?,?,?,?,?,?,?,?)`).run(userId, convoId, label, emoji ?? '', (top ?? -1) + 1, convo.agent_device_id ?? null, now, now)
  })()
}

// Returns false when there was no such pin.
export function removePin(db, userId, convoId) {
  const r = db.prepare('DELETE FROM convo_pins WHERE user_id=? AND convo_id=?').run(userId, convoId)
  return r.changes > 0
}

// `order` must name every pin exactly once. Throws 'bad_order' otherwise.
export function reorderPins(db, userId, order, now = Date.now()) {
  db.transaction(() => {
    const have = db.prepare('SELECT convo_id FROM convo_pins WHERE user_id=?').all(userId).map((r) => r.convo_id)
    if (order.length !== have.length || new Set(order).size !== order.length || order.some((id) => !have.includes(id))) throw new Error('bad_order')
    const set = db.prepare('UPDATE convo_pins SET position=?, updated_at=? WHERE user_id=? AND convo_id=?')
    order.forEach((id, i) => set.run(i, now, userId, id))
  })()
}

// Re-point a pin at another conversation (the new session on a desk box),
// keeping label, emoji and position. Throws 'no_pin', 'no_convo', or
// 'already_pinned' when the target already has its own pin.
export function movePin(db, userId, fromConvoId, toConvoId, now = Date.now()) {
  db.transaction(() => {
    const pin = db.prepare('SELECT 1 FROM convo_pins WHERE user_id=? AND convo_id=?').get(userId, fromConvoId)
    if (!pin) throw new Error('no_pin')
    if (fromConvoId === toConvoId) return
    const convo = ownedConvo(db, userId, toConvoId)
    if (!convo) throw new Error('no_convo')
    if (db.prepare('SELECT 1 FROM convo_pins WHERE user_id=? AND convo_id=?').get(userId, toConvoId)) throw new Error('already_pinned')
    db.prepare(`UPDATE convo_pins SET convo_id=?, device_id=?, hint_dismissed_id=NULL, created_at=?, updated_at=?
      WHERE user_id=? AND convo_id=?`).run(toConvoId, convo.agent_device_id ?? null, now, now, userId, fromConvoId)
  })()
}

// "Not this one": hide the current successor hint until a newer session starts.
export function dismissSuccessor(db, userId, convoId, successorId, now = Date.now()) {
  const r = db.prepare('UPDATE convo_pins SET hint_dismissed_id=?, updated_at=? WHERE user_id=? AND convo_id=?')
    .run(successorId, now, userId, convoId)
  if (!r.changes) throw new Error('no_pin')
}

// The successor hint a pin on `convoId` shows right now: its id, null when
// the pin shows none, undefined when the conversation is not pinned. Read
// before a message lands in a pinned conversation — the message can retract
// the hint (a successor must start after the desk last spoke), and ws.js then
// sends a fresh `pins` frame. One primary-key lookup for an unpinned convo.
export function pinSuccessorId(db, userId, convoId) {
  const pin = db.prepare('SELECT * FROM convo_pins WHERE user_id=? AND convo_id=?').get(userId, convoId)
  if (!pin) return undefined
  return successorFor(db, userId, pin, ownedConvo(db, userId, convoId))?.convo_id ?? null
}

// Every append path that can land a message wraps it in these two: read
// before the append whether a pin on `convoId` shows a hint (the message may
// retract it), then, after a non-duplicate append, send the apps a fresh list
// when it did. Best-effort on both sides — never blocks or fails the append.
export function pinHintBeforeAppend(db, userId, convoId, type) {
  if (!MESSAGE_TYPES.includes(type)) return false
  try { return Boolean(pinSuccessorId(db, userId, convoId)) } catch (err) { console.error('pins: hint check failed', err); return false }
}
export function sendPinsFrame(db, hub, userId) {
  try { hub.sendToClients(userId, { kind: 'pins', pins: listPins(db, userId) }) } catch (err) { console.error('pins: live frame failed (saved)', err) }
}

// After a conversation is created or retitled on `deviceId`: does any of the
// user's pins now suggest it as a successor? (ws.js sends a fresh `pins`
// frame when so.) Cheap when the box has no pins.
export function isSuccessorOfAPin(db, userId, deviceId, convoId) {
  const onBox = db.prepare(
    `SELECT 1 FROM convo_pins p LEFT JOIN conversations c ON c.id=p.convo_id
     WHERE p.user_id=? AND COALESCE(c.agent_device_id, p.device_id)=? LIMIT 1`
  ).get(userId, deviceId)
  if (!onBox) return false
  return listPins(db, userId).some((p) => p.successor?.convo_id === convoId)
}
