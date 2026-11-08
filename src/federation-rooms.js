// Rooms with a contact on another journal: talk requests across journals
// (docs/protocol.md "Rooms across journals"). On one journal a room between
// two people is a person_rooms row and two conversations the journal copies
// between (src/person-rooms.js, src/talk-requests.js). Across two journals
// each journal keeps its own half (fed_rooms) and its own conversation, and
// what the journal copies on one journal goes as signed ops:
//
//   room.invite    owner → guest   {room, topic, justification, mission?: {grant}}
//   room.answer    guest → owner   {room, outcome}
//                    accepted | declined | expired      (the guest person)
//                    joined | agent_declined | agent_expired (their agent)
//   room.message   either way      {room, n, body, via}
//   room.end       either way      {room, by}
//
// `room` is always the owner journal's id for the room, and every op of one
// room rides one outbox subject (`room:<that id>`), so each side's messages
// arrive in order. The consent is the same two taps as on one journal: the
// owner's Send on their agent's ask, then the guest's choice of where their
// side talks (a new session, their Coordinator, one of their sessions) or
// Decline. Neither Coordinator can tap either. Only an existing contact can
// be asked: there is no contact-by-talk across journals.
//
// The other side's messages arrive under `person:<their address>`, exactly
// as a copy on one journal arrives under `person:<name>`, so the bridge
// starts the same restricted turn. Text only, as on one journal.
import { randomBytes } from 'node:crypto'
import { enqueue } from './federation-outbox.js'
import { append, appendAndBroadcast, toEventShape } from './journal.js'
import { newId } from './items.js'
import { remoteContactRaw, getContactRaw, isLiveRemote, OWN_ASK_TTL_MS } from './contacts.js'
import { getMission } from './missions.js'
import { isPrivateDevice } from './db.js'
import { participantIds } from './participants.js'
import { deliverPendingInvites } from './invite-delivery.js'
import { wakeIfOffline, wakeConvoAgent } from './wake.js'
import { sanitizePeerText, plainText as plain } from './peer-text.js'
import { card, fileMirror, closeMirror, audit, changed, peopleConvo, fileNotice } from './sharing-events.js'
import { ROOM_CARD_KIND, COPY_BODY_MAX, BACKFILL_MAX, roomLink, deviceName } from './person-rooms-events.js'
import { checkRoomFree, isGuestRoom, LIVE_ROOM_STATES, PERSON_SENDER_PREFIX } from './person-rooms.js'
import {
  OWNER_TALK_ACTIONS, CHOICE, TALK_GUEST_TTL_MS, TALK_START_STUCK_MS, guestChoices, coordinatorTarget, pickableSessions, sessionLabels, isTalkTarget,
} from './talk-requests.js'
import { guestQuestion, issueTalkStart, talkQuestionActions, recordFollowUpTap } from './talk-requests-events.js'

export const INVITE_OP = 'room.invite'
export const ANSWER_OP = 'room.answer'
export const MESSAGE_OP = 'room.message'
export const END_OP = 'room.end'
export const ROOM_OPS = [INVITE_OP, ANSWER_OP, MESSAGE_OP, END_OP]
const GUEST_OUTCOMES = ['accepted', 'declined', 'expired', 'joined', 'agent_declined', 'agent_expired']
const END_BY = ['owner_agent', 'guest_agent', 'owner_user', 'guest_user']
// Talk requests one contact may have waiting on this user's choice at once.
export const MAX_WAITING_PER_CONTACT = 5
// The owner side gives up on a guest who never answered a day after the
// guest's own week (their journal should have said 'expired' by then).
export const OWNER_WAIT_MS = TALK_GUEST_TTL_MS + 24 * 60 * 60 * 1000
const TOPIC_MAX = 200
const WHY_MAX = 1000

const ROOM_REF = /^fr_[A-Za-z0-9_-]{1,64}$/
const GRANT_REF = /^gr_[A-Za-z0-9_-]{1,64}$/
const JOURNAL = 'journal'
const LIVE_SQL = `('${LIVE_ROOM_STATES.join("','")}')`
const PENDING = ['awaiting_owner', 'awaiting_guest', 'starting']
const fail = (code) => { throw new Error(code) }
const hostOf = (address) => address.slice(address.indexOf('@') + 1)
const nameOf = (address) => address.slice(0, address.indexOf('@'))
const subjectOf = (ref) => `room:${ref}`
const t = (s, n = 120) => plain(sanitizePeerText(s ?? '', n))
const bodyOf = (entry) => (typeof entry.body === 'string' ? JSON.parse(entry.body) : entry.body ?? {})
// A message body keeps its lines; only control characters other than tab
// and newline go.
const cleanBody = (s) => s.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '')

const registry = new WeakMap()
// The rooms-across-journals instance a database's journal runs, or null
// while federation is off (ws.js, the HTTP routes and sharing-events.js
// reach it through this).
export const fedRoomsOf = (db) => registry.get(db) ?? null

// --- Pure reads ---------------------------------------------------------------

export const getFedRoom = (db, id) => (typeof id === 'string' && id.startsWith('fr_') ? db.prepare('SELECT * FROM fed_rooms WHERE id=?').get(id) ?? null : null)
export const addressOf = (r) => `${r.peer_name}@${r.peer_host}`

// The half a local conversation takes part in: a live one, or on the guest
// side any (a room made for another journal's agent stays theirs).
export function fedRoomOfRoom(db, roomId) {
  if (typeof roomId !== 'string' || !roomId) return null
  return db.prepare(`SELECT * FROM fed_rooms WHERE room_id=? AND (state IN ${LIVE_SQL} OR role='guest') ORDER BY updated_at DESC LIMIT 1`).get(roomId) ?? null
}
export const isFedGuestRoom = (db, roomId) => !!(typeof roomId === 'string' && db.prepare("SELECT 1 FROM fed_rooms WHERE room_id=? AND role='guest'").get(roomId))
// Holds just the two agents: no other invite, join or file.
export function fedLinked(db, roomId) {
  const r = fedRoomOfRoom(db, roomId)
  return !!r && (r.role === 'guest' || LIVE_ROOM_STATES.includes(r.state))
}
// Asks of the owner's agent still waiting on the owner (the parked-asks cap).
export const parkedFedRooms = (db, deviceId) =>
  db.prepare("SELECT COUNT(*) AS n FROM fed_rooms WHERE role='owner' AND device_id=? AND state='awaiting_owner'").get(deviceId).n

// The mission a room is attached to, as this side may see it now: the
// owner's own mission while it is still shared with the contact; on the
// guest side the copy of it while that share lasts. null otherwise.
function missionOf(db, r) {
  if (!r.mission_id) return null
  if (r.role === 'owner') {
    const m = db.prepare('SELECT id, num, title FROM missions WHERE id=? AND user_id=?').get(r.mission_id, r.user_id)
    const g = m && db.prepare("SELECT 1 FROM grants WHERE subject_kind='mission' AND subject_id=? AND contact_id=? AND state='active' AND level <> 'owner'").get(m.id, r.contact_id)
    return g ? { id: m.id, num: m.num, title: m.title, owner: db.prepare('SELECT name FROM users WHERE id=?').get(r.user_id)?.name ?? null } : null
  }
  const m = db.prepare(`SELECT rm.id, rm.num, rm.title, fg.level FROM fed_replica_missions rm JOIN fed_grants_in fg ON fg.id = rm.fg_id
    WHERE rm.id=? AND rm.user_id=? AND fg.state='active'`).get(r.mission_id, r.user_id)
  return m ? { id: m.id, num: m.num, title: m.title, owner: addressOf(r), level: m.level } : null
}

// The wire shape GET /person-rooms serves, the same as a room on one
// journal: `person` is the other side's address.
export function fedRoomRow(db, r) {
  if (!r) return null
  return {
    id: r.id, role: r.role, room_id: r.room_id, person: addressOf(r), state: r.state, kind: 'talk', topic: r.topic,
    mission: missionOf(db, r), remote: true, created_at: r.created_at, updated_at: r.updated_at,
  }
}

export function listFedRooms(db, userId) {
  return db.prepare(`SELECT * FROM fed_rooms WHERE user_id=? AND state IN ${LIVE_SQL} ORDER BY updated_at DESC`).all(userId).map((r) => fedRoomRow(db, r))
}

// --- The instance -------------------------------------------------------------

// `ctx` {db, hub, pushPipeline, waker}; `federation` the loaded identity.
// → {inbound, outbound, setOutbox, ...the calls ws.js and the routes make}
export function makeRoomFederation({ db, hub = null, pushPipeline = null, waker = null, federation, now: clock = Date.now, log = console }) {
  const base = { db, hub, pushPipeline, waker }
  let outbox = null
  const pending = new WeakMap()
  const kick = () => { try { outbox?.kick() } catch (err) { log.error?.('federation: outbox kick failed', err) } }
  const safely = (what, fn) => { try { return fn() } catch (err) { log.error?.(`federation rooms: ${what} failed (the room stands)`, err); return null } }
  const userName = (userId) => db.prepare('SELECT name FROM users WHERE id=?').get(userId)?.name ?? ''
  const myAddress = (r) => `${userName(r.user_id)}@${federation.host}`
  const setState = (d, id, state, at, extra = '') => d.prepare(`UPDATE fed_rooms SET state=?, updated_at=? ${extra} WHERE id=?`).run(state, at, id)
  const reread = (d, id) => d.prepare('SELECT * FROM fed_rooms WHERE id=?').get(id)
  const contactOf = (d, r) => d.prepare('SELECT * FROM contacts WHERE id=?').get(r.contact_id)
  const contactLive = (d, r) => isLiveRemote(d, contactOf(d, r))

  // Queue one op of a room to the other side. A full outbox or a body too
  // big to send loses the op; the caller has already changed its own half.
  function send(r, op, body) {
    try {
      enqueue(db, { userId: r.user_id, from: myAddress(r), to: addressOf(r), op, subject: subjectOf(r.ref), body: { room: r.ref, ...body }, now: clock() })
      kick()
      return true
    } catch (err) {
      if (err.message === 'outbox_full' || err.message === 'too_large') { log.error?.(`federation rooms: ${op} not queued (${err.message})`); return false }
      throw err
    }
  }

  function toDevice(userId, deviceId, frame) {
    safely('agent frame', () => hub?.sendToDevice(userId, deviceId, frame))
  }
  // The owner's agent hears its ask failed, as a refused invite.
  function refuseToOwner(r, reason, { expiry = false } = {}) {
    if (r.role !== 'owner' || r.device_id == null) return
    toDevice(r.user_id, r.device_id, {
      kind: 'invite', event: 'answer', room_id: r.room_id, accept: false, reason, person: { name: addressOf(r) },
      ...(expiry ? {} : { from_device_id: 0 }),
    })
  }
  const roomAudit = (ctx, r, event, summary, by = null) => audit(ctx, r.user_id, {
    event, summary, by, extra: { room_link_id: r.id, person: { name: addressOf(r) }, room_id: r.room_id },
  })
  const scope = (r) => {
    const m = missionOf(db, r)
    if (r.role === 'owner') {
      return m
        ? `In a turn started by ${t(addressOf(r))}'s side, your agent may only reply in the room and use the tracker on mission #${m.num} ${t(m.title)}. Anything more needs your tap.`
        : `In a turn started by ${t(addressOf(r))}'s side, your agent may only reply in the room. Anything more needs your tap.`
    }
    return m
      ? `In a turn started by ${t(addressOf(r))}'s side, your agent may only reply in the room and read the shared mission "${t(m.title)}". Anything more needs your tap.`
      : `In a turn started by ${t(addressOf(r))}'s side, your agent may only reply in the room. Anything more needs your tap.`
  }
  const topicSuffix = (r) => (r.topic ? ` — ${t(r.topic, 80)}` : '')

  // --- The owner's side: the ask ---------------------------------------------

  // The owner's agent asks to talk with `person` (an address) in its room.
  // Throws as parkTalk on one journal: not_found (not a live contact on that
  // journal), pending, room_busy, not_fresh, too_many_asks, no_mission,
  // mission_not_shared, private_box. Returns the parked row.
  function parkTalk({ ownerUserId, roomId, ownerDeviceId, ownerSender, ownerConvoId = null, person, missionRef = null, topic = '', justification = '', now = clock() }) {
    return db.transaction(() => {
      if (isPrivateDevice(db, ownerDeviceId)) fail('private_box')
      const own = getContactRaw(db, ownerUserId, person)
      if (!own?.peer_journal || !isLiveRemote(db, own)) fail('not_found')
      if (db.prepare(`SELECT 1 FROM fed_rooms WHERE role='owner' AND device_id=? AND contact_id=? AND state IN ${LIVE_SQL}`).get(ownerDeviceId, own.id)) fail('pending')
      if (isGuestRoom(db, roomId) || fedLinked(db, roomId)) fail('room_busy')
      if (db.prepare(`SELECT 1 FROM person_rooms WHERE owner_room_id=? AND state IN ${LIVE_SQL}`).get(roomId)) fail('room_busy')
      // An earlier ask from this room that never left this journal (Cancel,
      // or no answer) is what a new ask replaces, as on one journal; one
      // that was sent keeps the room (checkRoomFree).
      checkRoomFree(db, { ownerUserId, roomId, ownerDeviceId, ownerSender })
      db.prepare(`DELETE FROM fed_rooms WHERE room_id=? AND role='owner' AND sent_at IS NULL AND state NOT IN ${LIVE_SQL}`).run(roomId)
      let missionId = null
      if (missionRef != null) {
        const m = getMission(db, ownerUserId, missionRef, { excludePrivateOwned: true })
        if (!m) fail('no_mission')
        const g = db.prepare("SELECT 1 FROM grants WHERE subject_kind='mission' AND subject_id=? AND contact_id=? AND state='active' AND level <> 'owner'").get(m.id, own.id)
        if (!g) fail('mission_not_shared')
        missionId = m.id
      }
      const id = newId('fr')
      db.prepare(`INSERT INTO fed_rooms(id, user_id, role, contact_id, peer_host, peer_name, ref, room_id, device_id, convo_id, mission_id, state, topic, justification, created_at, updated_at)
        VALUES(?,?,'owner',?,?,?,?,?,?,?,?,'awaiting_owner',?,?,?,?)`)
        .run(id, ownerUserId, own.id, own.peer_journal, own.peer_user, id, roomId, ownerDeviceId, ownerConvoId, missionId, topic ?? '', justification ?? '', now, now)
      return reread(db, id)
    })()
  }

  // The owner's card and its mirror, in the asking room.
  function ownerAsk(ctx, r) {
    const box = deviceName(db, r.device_id)
    const to = t(addressOf(r))
    const m = missionOf(db, r)
    safely('owner card', () => {
      card(ctx, {
        userId: r.user_id, convoId: r.room_id, sender: `agent:${box}`,
        payload: {
          kind: ROOM_CARD_KIND, direction: 'out', room_link_id: r.id, person: { name: addressOf(r) }, session_title: null,
          topic: sanitizePeerText(r.topic, TOPIC_MAX), justification: sanitizePeerText(r.justification, WHY_MAX),
          mission: m ? { num: m.num, title: sanitizePeerText(m.title, 120) } : null,
          talk: true, contact_pending: false, choices: OWNER_TALK_ACTIONS, remote: true,
          from_device_id: r.device_id, from_name: sanitizePeerText(box, 80),
        },
      })
      const item = fileMirror(ctx, {
        userId: r.user_id, convoId: r.room_id, deviceId: r.device_id, sender: `agent:${box}`, consent: 'room',
        title: `Ask ${to} to talk${topicSuffix(r)}`,
        body: [
          `**${t(box, 80)}** asks to talk with **${to}**'s agent in this room. ${to} is on another Matron journal.`,
          '',
          ...(r.topic ? [`- **Topic:** ${t(r.topic, TOPIC_MAX)}`] : []),
          `- **Why:** ${t(r.justification, WHY_MAX)}`,
          ...(m ? [`- **Attached to:** mission #${m.num} ${t(m.title)}, which ${to} can already read.`] : []),
          `- **What happens:** ${to} gets one card on their journal and chooses where their side talks: a new session, their Coordinator, or one of their sessions.`,
          `- **What crosses:** the room's messages, both ways, to ${t(r.peer_host)}. Files do not.`,
          `- ${scope(r)}`,
          '',
          '**To answer:** tap **Send** or **Cancel**. Unanswered, the request expires 24 h after it was made.',
        ].join('\n'),
        link: roomLink(r.id), actions: OWNER_TALK_ACTIONS, idemKey: `consent:fedroom:${r.id}:owner:${r.updated_at}`,
      })
      if (item) db.prepare('UPDATE fed_rooms SET item_id=? WHERE id=?').run(item.id, r.id)
    })
  }

  // The owner's tap. → {status, body, closed}
  function answerOwner(ctx, who, r, decision) {
    const at = clock()
    const out = db.transaction(() => {
      const cur = reread(db, r.id)
      if (cur.state !== 'awaiting_owner') fail('not_pending')
      if (at - cur.updated_at > OWN_ASK_TTL_MS) { setState(db, cur.id, 'expired', at); return 'expired' }
      if (decision === 'decline') { setState(db, cur.id, 'declined', at, `, answered_at=${Number(at)}, ended_by='owner'`); return 'withdrawn' }
      if (!contactLive(db, cur)) { setState(db, cur.id, 'withdrawn', at, ", ended_by='contact_removed'"); return 'unavailable' }
      setState(db, cur.id, 'awaiting_guest', at, `, answered_at=${Number(at)}, sent_at=${Number(at)}`)
      const m = cur.mission_id ? db.prepare("SELECT id FROM grants WHERE subject_kind='mission' AND subject_id=? AND contact_id=? AND state='active' AND level <> 'owner'").get(cur.mission_id, cur.contact_id) : null
      enqueue(db, {
        userId: cur.user_id, from: myAddress(cur), to: addressOf(cur), op: INVITE_OP, subject: subjectOf(cur.ref), now: at,
        body: { room: cur.ref, topic: cur.topic, justification: cur.justification, ...(m ? { mission: { grant: m.id } } : {}) },
      })
      return 'sent'
    })()
    const after = reread(db, r.id)
    const to = t(addressOf(after))
    const tap = (comment, resolution = 'decided') => closeMirror(ctx, { userId: after.user_id, itemId: r.item_id, consent: 'room', resolution, author: who ? 'user' : 'agent', deviceId: who?.deviceId ?? 0, comment })
    let closed = null
    if (out === 'sent') {
      kick()
      closed = tap(`Sent — ${to} has been asked to choose where to talk.`)
      roomAudit(ctx, after, 'room.offered', `You asked ${to} to talk`, 'you')
    } else if (out === 'withdrawn') {
      closed = tap('Declined — nothing was sent.')
      refuseToOwner(after, 'refused')
    } else if (out === 'unavailable') {
      closed = tap('This can no longer go ahead: the contact has ended.', 'cancelled')
      refuseToOwner(after, 'refused')
    } else {
      closeMirror(ctx, { userId: after.user_id, itemId: r.item_id, consent: 'room', resolution: 'cancelled', author: 'agent', deviceId: after.device_id, comment: 'Expired — no answer within 24 h. Nothing was sent.' })
      refuseToOwner(after, 'expired', { expiry: true })
    }
    changed(ctx, after.user_id, { room_link_id: after.id })
    if (out === 'expired') return { status: 409, body: { error: 'conflict', blocked_by: 'expired' } }
    return { status: 200, body: { person_room: fedRoomRow(db, after) }, closed }
  }

  // --- The guest's side: the card and the choice ------------------------------

  const choicesFor = (r, opts) => guestChoices(db, { guest_user_id: r.user_id }, opts)

  function guestAsk(ctx, r) {
    const from = t(addressOf(r))
    const choices = choicesFor(r)
    const m = missionOf(db, r)
    safely('guest card', () => {
      const convoId = peopleConvo(ctx, r.user_id)
      card(ctx, {
        userId: r.user_id, convoId, sender: JOURNAL,
        payload: {
          kind: ROOM_CARD_KIND, direction: 'in', room_link_id: r.id, person: { name: addressOf(r) }, session_title: null,
          topic: sanitizePeerText(r.topic, TOPIC_MAX), justification: sanitizePeerText(r.justification, WHY_MAX),
          mission: m ? { num: null, title: sanitizePeerText(m.title, 120) } : null,
          talk: true, contact_pending: false, choices, remote: true,
        },
      })
      const item = fileMirror(ctx, {
        userId: r.user_id, convoId, deviceId: 0, sender: JOURNAL, consent: 'room',
        title: `${from}'s agent wants to talk${topicSuffix(r)}`,
        body: [
          `**${from}**, on another Matron journal, asks for their agent to talk with one of your agents.`,
          '',
          ...(r.topic ? [`- **Topic:** ${t(r.topic, TOPIC_MAX)}`] : []),
          `- **Why, in their agent's words:** ${t(r.justification, WHY_MAX)}`,
          ...(m ? [`- **Attached to:** their mission "${t(m.title)}", which they share with you.`] : []),
          `- **What crosses:** the room's messages, both ways, to ${t(r.peer_host)}. Files do not.`,
          `- ${scope(r)}`,
          '- Either of you can end it at any time, and removing the contact ends it too.',
          '',
          `**To answer:** choose where your side talks${choices.includes(CHOICE.new) ? ' (**New session** starts a fresh session just for this talk)' : ''}, or tap **Decline**. Unanswered, it expires after ${Math.round(TALK_GUEST_TTL_MS / 86400000)} days.`,
        ].join('\n'),
        link: roomLink(r.id), actions: choices, idemKey: `consent:fedroom:${r.id}:guest:${r.created_at}`,
      })
      if (item) db.prepare('UPDATE fed_rooms SET item_id=? WHERE id=?').run(item.id, r.id)
    })
  }

  const asLink = (r) => ({ guest_user_id: r.user_id, guest_item_id: r.item_id, owner_name: addressOf(r), topic: r.topic, id: r.id })

  // The guest's room for this talk, and their agent's invite into it, in
  // one transaction. The conversation has no agent of its own (the other
  // side's agent is on another journal); the guest agent is invited by
  // device 0, the journal, as a twin on one journal is by the owner's agent.
  function acceptOnto(r, target, at) {
    return db.transaction(() => {
      const cur = reread(db, r.id)
      if (!['awaiting_guest', 'starting'].includes(cur.state)) fail('not_pending')
      if (!isTalkTarget(db, cur.user_id, target.convoId, target.deviceId)) fail('not_available')
      if (!contactLive(db, cur)) {
        setState(db, cur.id, 'withdrawn', at, ", ended_by='contact_removed'")
        return 'unavailable'
      }
      const roomId = `room_${randomBytes(12).toString('hex')}`
      const title = `${addressOf(cur)}${cur.topic ? ` — ${cur.topic}` : ''}`.slice(0, 200)
      db.prepare("INSERT INTO conversations(id, owner_user_id, title, session_state, created_at) VALUES(?,?,?,'running',?)").run(roomId, cur.user_id, title, at)
      db.prepare(`INSERT INTO convo_agents(convo_id, agent_device_id, initiator_device_id, state, justification, topic, target_convo_id, created_at)
        VALUES(?,?,0,'invited',?,?,?,?)`).run(roomId, target.deviceId, cur.justification, cur.topic, target.convoId, at)
      db.prepare("UPDATE fed_rooms SET state='invited', room_id=?, device_id=?, convo_id=?, spawn_id=NULL, updated_at=?, answered_at=? WHERE id=?")
        .run(roomId, target.deviceId, target.convoId, at, at, cur.id)
      return 'accepted'
    })()
  }

  function afterAccepted(ctx, who, r, outcome) {
    const after = reread(db, r.id)
    if (outcome === 'unavailable') {
      send(after, ANSWER_OP, { outcome: 'declined' })
      return closeMirror(ctx, { userId: after.user_id, itemId: after.item_id, consent: 'room', resolution: 'cancelled', author: who ? 'user' : 'agent', deviceId: who?.deviceId ?? 0, comment: 'This can no longer go ahead: the contact has ended.' })
    }
    send(after, ANSWER_OP, { outcome: 'accepted' })
    const title = db.prepare('SELECT title FROM conversations WHERE id=?').get(after.room_id)?.title ?? ''
    const closed = closeMirror(ctx, { userId: after.user_id, itemId: after.item_id, consent: 'room', resolution: 'decided', author: who ? 'user' : 'agent', deviceId: who?.deviceId ?? 0, comment: `Accepted — your agent is being asked to join. The room is listed as "${t(title, 120)}" in your chats.` })
    safely('room announce', () => appendAndBroadcast(db, hub, {
      userId: after.user_id, convoId: after.room_id, sender: JOURNAL, type: 'convo_meta',
      payload: { title, parent_convo_id: null, person: { name: addressOf(after) } },
    }))
    roomAudit(ctx, after, 'room.accepted', `You let ${t(addressOf(after))}'s agent talk with yours`, 'you')
    safely('invite delivery', () => deliverPendingInvites(db, hub, { deviceId: after.device_id }))
    safely('wake', () => wakeIfOffline(ctx, after.user_id, after.device_id))
    changed(ctx, after.user_id, { room_link_id: after.id })
    return closed
  }

  // A new session for the talk, on the guest's Coordinator box.
  async function startSession(ctx, who, r, target, spawnId) {
    const { convoId, code } = await issueTalkStart(ctx, asLink(r), target)
    const cur = reread(db, r.id)
    if (!cur || cur.state !== 'starting' || cur.spawn_id !== spawnId) return 'stale'
    if (convoId) {
      let out
      try { out = acceptOnto(cur, { deviceId: target.deviceId, convoId }, clock()) } catch (err) {
        if (err.message !== 'not_available') throw err
        out = null
      }
      if (out) { afterAccepted(ctx, who, cur, out); return 'started' }
    }
    db.prepare("UPDATE fed_rooms SET state='awaiting_guest', spawn_id=NULL, updated_at=? WHERE id=? AND state='starting' AND spawn_id=?").run(clock(), cur.id, spawnId)
    offerAgain(ctx, reread(db, cur.id), `Couldn't start a session: ${code ?? 'bad_start_reply'}. Pick another option.`)
    return 'failed'
  }
  const offerAgain = (ctx, r, body) => guestQuestion(ctx, asLink(r), body, choicesFor(r, { withNew: false }))

  // The guest's choice. `choice`: 'decline' | 'coordinator' | 'pick' | 'new'
  // | {convoId}. → {status, body, closed?, comment?}
  function answerGuest(ctx, who, r, choice) {
    const at = clock()
    if (r.state !== 'awaiting_guest') return { status: 409, body: { error: 'conflict', blocked_by: 'not_pending' } }
    if (at - r.updated_at > TALK_GUEST_TTL_MS) {
      expireGuest(ctx, r, at)
      return { status: 409, body: { error: 'conflict', blocked_by: 'expired' } }
    }
    const ok = (extra = {}) => ({ status: 200, body: { person_room: fedRoomRow(db, reread(db, r.id)) }, ...extra })
    if (choice === 'decline') {
      setState(db, r.id, 'refused', at, `, answered_at=${Number(at)}, ended_by='guest'`)
      send(r, ANSWER_OP, { outcome: 'declined' })
      const closed = closeMirror(ctx, { userId: r.user_id, itemId: r.item_id, consent: 'room', resolution: 'decided', author: 'user', deviceId: who.deviceId, comment: 'Declined.' })
      roomAudit(ctx, r, 'room.declined', `You declined ${t(addressOf(r))}'s room`, 'you')
      changed(ctx, r.user_id, { room_link_id: r.id })
      return ok({ closed, comment: closed?.comment ?? null })
    }
    if (choice === 'pick') {
      const options = sessionLabels(pickableSessions(db, r.user_id))
      if (!Object.keys(options).length) return { status: 409, body: { error: 'conflict', blocked_by: 'not_available' } }
      db.prepare('UPDATE fed_rooms SET pick_options=? WHERE id=?').run(JSON.stringify(options), r.id)
      const q = guestQuestion(ctx, asLink(r), 'Which session should talk with them?', [...Object.keys(options), CHOICE.decline])
      return ok({ comment: q?.comment ?? null })
    }
    if (choice === 'new') {
      const coord = coordinatorTarget(db, r.user_id)
      if (!coord) return { status: 409, body: { error: 'conflict', blocked_by: 'not_available' } }
      const spawnId = newId('tsp')
      db.prepare("UPDATE fed_rooms SET state='starting', spawn_id=?, updated_at=? WHERE id=?").run(spawnId, at, r.id)
      const q = guestQuestion(ctx, asLink(r), `Starting a new session on ${t(deviceName(db, coord.deviceId), 80)} for this talk…`, [])
      startSession(ctx, who, reread(db, r.id), coord, spawnId).catch((err) => log.error?.('federation rooms: new session failed', err))
      return ok({ comment: q?.comment ?? null })
    }
    let target
    if (choice === 'coordinator') target = coordinatorTarget(db, r.user_id)
    else if (choice?.convoId) {
      const c = db.prepare('SELECT agent_device_id FROM conversations WHERE id=?').get(choice.convoId)
      target = c ? { deviceId: c.agent_device_id, convoId: choice.convoId } : null
    }
    if (!target) return { status: 409, body: { error: 'conflict', blocked_by: 'not_available' } }
    let out
    try { out = acceptOnto(r, target, at) } catch (err) {
      if (err.message === 'not_available' || err.message === 'not_pending') return { status: 409, body: { error: 'conflict', blocked_by: err.message } }
      throw err
    }
    const closed = afterAccepted(ctx, who, r, out)
    return ok({ closed, comment: closed?.comment ?? null })
  }

  function expireGuest(ctx, r, at) {
    setState(db, r.id, 'expired', at, ", ended_by='guest'")
    send(r, ANSWER_OP, { outcome: 'expired' })
    closeMirror(ctx, { userId: r.user_id, itemId: r.item_id, consent: 'room', resolution: 'cancelled', author: 'agent', comment: `Expired — no answer within ${Math.round(TALK_GUEST_TTL_MS / 86400000)} days.` })
    changed(ctx, r.user_id, { room_link_id: r.id })
  }

  // A tap on a room mirror that is one of these rooms (items-http routes
  // every room mirror through person-rooms-http, which hands these here).
  // → true when it answered.
  function handleTap(ctx, res, who, item, action, replyTo, send200) {
    const r = db.prepare('SELECT * FROM fed_rooms WHERE user_id=? AND item_id=?').get(who.userId, item.id)
    if (!r) return null
    let choice
    if (r.role === 'owner') {
      if (replyTo != null || !OWNER_TALK_ACTIONS.includes(action) || !item.actions.includes(action)) return { status: 400, body: { error: 'unknown_action' } }
      let out
      try { out = answerOwner(ctx, who, r, action === 'Cancel' ? 'decline' : 'approve') } catch (err) {
        if (err.message === 'not_pending') return { status: 409, body: { error: 'conflict', blocked_by: 'not_pending' } }
        throw err
      }
      return out
    }
    if (replyTo != null) {
      const offered = talkQuestionActions(db, item.id, replyTo)
      if (!offered || !offered.includes(action)) return { status: 400, body: { error: 'unknown_action' } }
    } else if (!item.actions.includes(action)) return { status: 400, body: { error: 'unknown_action' } }
    if (action === CHOICE.decline) choice = 'decline'
    else if (action === CHOICE.coordinator) choice = 'coordinator'
    else if (action === CHOICE.pick) choice = 'pick'
    else if (action === CHOICE.new) choice = 'new'
    else {
      let convoId = null
      try { convoId = JSON.parse(r.pick_options ?? '{}')?.[action] ?? null } catch { convoId = null }
      choice = convoId ? { convoId } : null
    }
    if (!choice) return { status: 400, body: { error: 'unknown_action' } }
    const out = answerGuest(ctx, who, r, choice)
    if (out.status === 200 && replyTo != null) recordFollowUpTap(ctx, who, item.id, action, replyTo)
    return out
  }

  // --- Both sides: the agents ------------------------------------------------

  // The guest agent answered its invite into the room made for the talk.
  function onGuestAgentAnswer(roomId, accept) {
    const r = db.prepare("SELECT * FROM fed_rooms WHERE room_id=? AND role='guest' AND state='invited'").get(roomId)
    if (!r) return
    const at = clock()
    if (accept) {
      setState(db, r.id, 'joined', at)
      send(r, ANSWER_OP, { outcome: 'joined' })
      roomAudit(base, r, 'room.joined', `Your agent joined ${t(addressOf(r))}'s room`)
    } else {
      setState(db, r.id, 'refused', at, ", ended_by='guest_agent'")
      send(r, ANSWER_OP, { outcome: 'agent_declined' })
    }
    changed(base, r.user_id, { room_link_id: r.id })
  }

  // The guest agent's invite expired unanswered.
  function onGuestInviteExpired(roomId) {
    const r = db.prepare("SELECT * FROM fed_rooms WHERE room_id=? AND role='guest' AND state='invited'").get(roomId)
    if (!r) return
    setState(db, r.id, 'expired', clock(), ", ended_by='guest_agent'")
    send(r, ANSWER_OP, { outcome: 'agent_expired' })
    changed(base, r.user_id, { room_link_id: r.id })
  }

  // --- Ending ------------------------------------------------------------------

  const ENDED = {
    owner_agent: (r) => (r.role === 'owner' ? 'Your agent ended the room.' : `${t(addressOf(r))}'s agent ended the room.`),
    guest_agent: (r) => (r.role === 'owner' ? `${t(addressOf(r))}'s agent left the room.` : 'Your agent left the room.'),
    owner_user: (r) => (r.role === 'owner' ? 'You ended the room.' : `${t(addressOf(r))} ended the room.`),
    guest_user: (r) => (r.role === 'owner' ? `${t(addressOf(r))} ended the room.` : 'You ended the room.'),
    contact_removed: () => 'The contact ended, so the room ended with it.',
    unreachable: (r) => `The room ended: ${t(r.peer_host)} could not take it.`,
  }

  // End this side's half and tell this side's people and agent. `by` who
  // ended it; `tell` sends room.end to the other side. → the row as it stood.
  function endLocal(r, by, { tell = false, reason = null } = {}) {
    if (!r || !LIVE_ROOM_STATES.includes(r.state)) return null
    const at = clock()
    const to = PENDING.includes(r.state) ? 'withdrawn' : 'left'
    db.prepare('UPDATE fed_rooms SET state=?, updated_at=?, ended_by=? WHERE id=?').run(to, at, by, r.id)
    if (r.role === 'guest' && r.room_id) {
      db.prepare("UPDATE convo_agents SET state='left', answered_at=? WHERE convo_id=? AND state IN ('invited','joined')").run(at, r.room_id)
    }
    const words = reason ?? (ENDED[by] ?? (() => 'The room ended.'))(r)
    if (PENDING.includes(r.state) || r.state === 'invited') {
      closeMirror(base, { userId: r.user_id, itemId: r.item_id, consent: 'room', resolution: 'cancelled', author: 'agent', comment: words })
    }
    if (r.role === 'owner' && by !== 'owner_agent') {
      if (r.state === 'joined') toDevice(r.user_id, r.device_id, { kind: 'invite', event: 'left', room_id: r.room_id, from_device_id: 0, person: { name: addressOf(r) } })
      else refuseToOwner(r, 'left')
    }
    if (r.role === 'guest' && by !== 'guest_agent' && r.device_id != null && ['invited', 'joined'].includes(r.state)) {
      safely('participants meta', () => appendAndBroadcast(db, hub, {
        userId: r.user_id, convoId: r.room_id, sender: JOURNAL, type: 'convo_meta',
        payload: { participants: participantIds(db, r.room_id) },
      }))
      toDevice(r.user_id, r.device_id, { kind: 'invite', event: 'left', room_id: r.room_id, from_device_id: 0, person: { name: addressOf(r) } })
    }
    if (r.role === 'owner' || r.state !== 'awaiting_guest' || r.item_id) roomAudit(base, r, 'room.ended', words)
    changed(base, r.user_id, { room_link_id: r.id })
    if (tell) send(r, END_OP, { by })
    return r
  }

  // An agent left (ws agent_leave): the owner's agent leaving its room, or
  // the guest agent leaving the room made for it. → true when it was one.
  function onAgentLeft(roomId, deviceId) {
    const r = fedRoomOfRoom(db, roomId)
    if (!r || !LIVE_ROOM_STATES.includes(r.state) || r.device_id !== deviceId) return false
    endLocal(r, r.role === 'owner' ? 'owner_agent' : 'guest_agent', { tell: r.role === 'guest' || r.state !== 'awaiting_owner' })
    return true
  }

  // A client of this side ended it (DELETE /person-rooms/:id).
  function endByUser(r) {
    return endLocal(r, r.role === 'owner' ? 'owner_user' : 'guest_user', { tell: !(r.role === 'owner' && r.state === 'awaiting_owner') })
  }

  // The contact ended: every room with them ends here. Their journal ends
  // its half when it hears the contact ended, so nothing is sent.
  function onContactEnded(contactId) {
    for (const r of db.prepare(`SELECT * FROM fed_rooms WHERE contact_id=? AND state IN ${LIVE_SQL}`).all(contactId)) {
      safely('end on contact', () => endLocal(r, 'contact_removed'))
      safely('cancel queued', () => db.prepare("UPDATE fed_outbox SET state='cancelled', ended_at=?, last_error='contact_ended' WHERE user_id=? AND peer_host=? AND subject=? AND state='queued'")
        .run(clock(), r.user_id, r.peer_host, subjectOf(r.ref)))
    }
  }

  // --- Messages ---------------------------------------------------------------

  // A message just landed in `convoId` in `userId`'s log (ws.js, after every
  // append): when the room is one of these and the other side is in it, the
  // text goes to them. A copy is never copied back.
  function copyOut({ userId, convoId, sender, type, payload, seq }) {
    if (type !== 'text' || typeof sender !== 'string') return
    if (sender === JOURNAL || sender.startsWith(PERSON_SENDER_PREFIX)) return
    const r = fedRoomOfRoom(db, convoId)
    if (!r || r.user_id !== userId || !['invited', 'joined'].includes(r.state)) return
    const raw = typeof payload?.body === 'string' ? payload.body : ''
    if (!raw.trim()) return
    const body = raw.length > COPY_BODY_MAX ? `${raw.slice(0, COPY_BODY_MAX)}… [cut at ${COPY_BODY_MAX} characters]` : raw
    safely('send message', () => send(r, MESSAGE_OP, { n: seq, body, via: sender.startsWith('user:') ? 'user' : 'agent' }))
  }

  // What the owner's room said before the guest accepted, sent once on
  // their accept (the room is FRESH, so this is never older history).
  function backfill(r) {
    const rows = db.prepare(`SELECT seq, sender, payload FROM events WHERE +user_id=? AND convo_id=? AND type='text'
      AND sender <> 'journal' AND sender NOT LIKE 'person:%' ORDER BY seq DESC LIMIT ?`).all(r.user_id, r.room_id, BACKFILL_MAX).reverse()
    for (const e of rows) {
      let p = null
      try { p = JSON.parse(e.payload) } catch { p = null }
      copyOut({ userId: r.user_id, convoId: r.room_id, sender: e.sender, type: 'text', payload: p, seq: e.seq })
    }
  }

  // The other side's message, into this side's room.
  function deliverIn(r, { n, body, via }) {
    const sender = `${PERSON_SENDER_PREFIX}${addressOf(r)}`
    const payload = { body, person: { name: addressOf(r) }, via }
    const a = append(db, { userId: r.user_id, convoId: r.room_id, sender, type: 'text', payload, idemKey: `fedroom:${r.id}:${n}` })
    if (a.duplicate) return
    const event = toEventShape({ seq: a.seq, convo_id: r.room_id, ts: a.ts, sender, type: 'text', payload })
    safely('broadcast', () => hub?.broadcastJournal(r.user_id, { kind: 'journal', ...event }, new Set(participantIds(db, r.room_id))))
    if (pushPipeline) safely('push', () => pushPipeline.onAppend(r.user_id, event, null))
    if (waker) safely('wake', () => wakeConvoAgent(base, r.user_id, r.room_id))
  }

  // --- Sweep ------------------------------------------------------------------

  function sweep(ctx, at = clock()) {
    for (const r of db.prepare("SELECT * FROM fed_rooms WHERE role='owner' AND state='awaiting_owner' AND updated_at < ?").all(at - OWN_ASK_TTL_MS)) {
      setState(db, r.id, 'expired', at)
      closeMirror(ctx, { userId: r.user_id, itemId: r.item_id, consent: 'room', resolution: 'cancelled', author: 'agent', deviceId: r.device_id, comment: 'Expired — no answer within 24 h. Nothing was sent.' })
      refuseToOwner(r, 'expired', { expiry: true })
    }
    for (const r of db.prepare("SELECT * FROM fed_rooms WHERE role='guest' AND state='awaiting_guest' AND updated_at < ?").all(at - TALK_GUEST_TTL_MS)) {
      safely('guest expiry', () => expireGuest(ctx, r, at))
    }
    for (const r of db.prepare("SELECT * FROM fed_rooms WHERE role='guest' AND state='starting' AND updated_at < ?").all(at - TALK_START_STUCK_MS)) {
      setState(db, r.id, 'awaiting_guest', at, ', spawn_id=NULL')
      offerAgain(ctx, reread(db, r.id), "Couldn't start a session: it did not report back. Pick another option.")
    }
    for (const r of db.prepare("SELECT * FROM fed_rooms WHERE role='owner' AND state='awaiting_guest' AND updated_at < ?").all(at - OWNER_WAIT_MS)) {
      setState(db, r.id, 'expired', at, ", ended_by='guest'")
      refuseToOwner(r, 'expired', { expiry: true })
      roomAudit(ctx, r, 'room.expired', `${t(addressOf(r))} did not answer the talk request`)
    }
  }

  // --- Inbound ----------------------------------------------------------------

  function party(d, envelope, peer) {
    const user = d.prepare('SELECT id, name FROM users WHERE name=?').get(nameOf(envelope.to))
    const contact = user ? remoteContactRaw(d, user.id, nameOf(envelope.from), hostOf(envelope.from)) : null
    if (!contact || contact.state !== 'active' || contact.peer_journal_key !== peer.key_pub) fail('not_contact')
    return { user, contact }
  }
  const roomRef = (v) => { if (typeof v !== 'string' || !ROOM_REF.test(v)) fail('malformed'); return v }
  // This side's half the op is about, from the sender's own address: an
  // owner's ops name the guest's half by (host, ref); a guest's the
  // owner's by its id.
  function halfFor(d, user, envelope, ref, role) {
    const r = role === 'guest'
      ? d.prepare("SELECT * FROM fed_rooms WHERE role='guest' AND user_id=? AND peer_host=? AND ref=?").get(user.id, hostOf(envelope.from), ref)
      : d.prepare("SELECT * FROM fed_rooms WHERE role='owner' AND user_id=? AND id=?").get(user.id, ref)
    if (!r || addressOf(r) !== envelope.from) return null
    return r
  }

  const inbound = {
    // The guest's journal: the owner sent their talk request.
    [INVITE_OP]: {
      apply({ db: d, envelope, peer, now }) {
        const b = envelope.body ?? {}
        const ref = roomRef(b.room)
        if (b.topic != null && typeof b.topic !== 'string') fail('malformed')
        if (typeof b.justification !== 'string') fail('malformed')
        const { user, contact } = party(d, envelope, peer)
        if (halfFor(d, user, envelope, ref, 'guest')) return {}
        const waiting = d.prepare("SELECT COUNT(*) AS n FROM fed_rooms WHERE role='guest' AND contact_id=? AND state IN ('awaiting_guest','starting')").get(contact.id).n
        if (waiting >= MAX_WAITING_PER_CONTACT) fail('too_many_asks')
        let missionId = null
        let grantRef = null
        if (b.mission != null) {
          if (typeof b.mission !== 'object' || typeof b.mission.grant !== 'string' || !GRANT_REF.test(b.mission.grant)) fail('malformed')
          grantRef = b.mission.grant
          const rm = d.prepare(`SELECT rm.id FROM fed_grants_in fg JOIN fed_replica_missions rm ON rm.fg_id = fg.id
            WHERE fg.user_id=? AND fg.peer_host=? AND fg.peer_grant_ref=? AND fg.owner_name=? AND fg.state='active'`).get(user.id, hostOf(envelope.from), grantRef, nameOf(envelope.from))
          missionId = rm?.id ?? null
        }
        const id = newId('fr')
        d.prepare(`INSERT INTO fed_rooms(id, user_id, role, contact_id, peer_host, peer_name, ref, mission_id, grant_ref, state, topic, justification, created_at, updated_at)
          VALUES(?,?,'guest',?,?,?,?,?,?,'awaiting_guest',?,?,?,?)`)
          .run(id, user.id, contact.id, hostOf(envelope.from), nameOf(envelope.from), ref, missionId, grantRef,
            sanitizePeerText(b.topic ?? '', TOPIC_MAX), sanitizePeerText(b.justification, WHY_MAX), now, now)
        pending.set(envelope, { id })
        return {}
      },
      after({ envelope }) {
        const p = pending.get(envelope)
        if (!p) return
        const r = reread(db, p.id)
        guestAsk(base, r)
        roomAudit(base, r, 'room.received', `${t(addressOf(r))} asked for their agent to talk with yours`)
        changed(base, r.user_id, { room_link_id: r.id })
      },
      errors: { malformed: 400, not_contact: 403, too_many_asks: 429 },
    },
    // The owner's journal: the guest person, or their agent, answered.
    [ANSWER_OP]: {
      apply({ db: d, envelope, peer, now }) {
        const b = envelope.body ?? {}
        const ref = roomRef(b.room)
        if (!GUEST_OUTCOMES.includes(b.outcome)) fail('malformed')
        const { user } = party(d, envelope, peer)
        const r = halfFor(d, user, envelope, ref, 'owner')
        if (!r) fail('not_active')
        const from = { accepted: ['awaiting_guest'], declined: ['awaiting_guest', 'invited'], expired: ['awaiting_guest'], joined: ['invited'], agent_declined: ['invited'], agent_expired: ['invited'] }[b.outcome]
        // A late or repeated answer to a room that moved on changes nothing.
        if (!from.includes(r.state)) return {}
        const to = { accepted: 'invited', declined: 'refused', expired: 'expired', joined: 'joined', agent_declined: 'refused', agent_expired: 'expired' }[b.outcome]
        setState(d, r.id, to, now, b.outcome === 'joined' || b.outcome === 'accepted' ? '' : `, ended_by='${b.outcome.startsWith('agent_') ? 'guest_agent' : 'guest'}'`)
        pending.set(envelope, { r, outcome: b.outcome })
        return {}
      },
      after({ envelope }) {
        const p = pending.get(envelope)
        if (!p) return
        const r = reread(db, p.r.id)
        const who = t(addressOf(r))
        switch (p.outcome) {
          case 'accepted':
            roomAudit(base, r, 'room.accepted', `${who} accepted — their agent is being asked to join`)
            safely('backfill', () => backfill(r))
            break
          case 'joined':
            toDevice(r.user_id, r.device_id, { kind: 'invite', event: 'answer', room_id: r.room_id, accept: true, from_device_id: 0, person: { name: addressOf(r) } })
            roomAudit(base, r, 'room.joined', `${who}'s agent joined the room`)
            break
          case 'declined':
          case 'agent_declined':
            if (p.r.state === 'awaiting_guest') roomAudit(base, r, 'room.declined', `${who} declined the room`)
            refuseToOwner(r, 'refused')
            break
          default:
            roomAudit(base, r, 'room.expired', `${who} did not answer the talk request`)
            refuseToOwner(r, 'expired', { expiry: true })
        }
        changed(base, r.user_id, { room_link_id: r.id })
      },
      errors: { malformed: 400, not_contact: 403, not_active: 409 },
    },
    // Either side: the other side's message.
    [MESSAGE_OP]: {
      apply({ db: d, envelope, peer }) {
        const b = envelope.body ?? {}
        const ref = roomRef(b.room)
        if (!Number.isInteger(b.n) || b.n < 0) fail('malformed')
        if (typeof b.body !== 'string' || !b.body.trim() || b.body.length > COPY_BODY_MAX + 64) fail('malformed')
        const { user } = party(d, envelope, peer)
        const r = halfFor(d, user, envelope, ref, 'guest') ?? halfFor(d, user, envelope, ref, 'owner')
        if (!r || !['invited', 'joined'].includes(r.state) || !r.room_id) fail('not_active')
        pending.set(envelope, { r, n: b.n, body: cleanBody(b.body), via: b.via === 'user' ? 'user' : 'agent' })
        return {}
      },
      after({ envelope }) {
        const p = pending.get(envelope)
        if (p) safely('deliver', () => deliverIn(p.r, p))
      },
      errors: { malformed: 400, not_contact: 403, not_active: 409 },
    },
    // Either side: the other side ended it.
    [END_OP]: {
      apply({ db: d, envelope, peer }) {
        const b = envelope.body ?? {}
        const ref = roomRef(b.room)
        if (!END_BY.includes(b.by)) fail('malformed')
        const { user } = party(d, envelope, peer)
        const r = halfFor(d, user, envelope, ref, 'guest') ?? halfFor(d, user, envelope, ref, 'owner')
        // The sender's side may only end as itself.
        if (r && (b.by.startsWith('owner_') ? r.role !== 'guest' : r.role !== 'owner')) fail('malformed')
        if (r && LIVE_ROOM_STATES.includes(r.state)) pending.set(envelope, { r, by: b.by })
        return {}
      },
      after({ envelope }) {
        const p = pending.get(envelope)
        if (p) safely('end', () => endLocal(reread(db, p.r.id), p.by))
      },
      errors: { malformed: 400, not_contact: 403 },
    },
  }

  // --- Outbox hooks -----------------------------------------------------------

  const halfOfEntry = (d, entry) => {
    const ref = bodyOf(entry).room
    return d.prepare("SELECT * FROM fed_rooms WHERE user_id=? AND peer_host=? AND ref=?").get(entry.user_id, entry.peer_host, ref) ?? null
  }
  const REASONS = {
    unknown_op: 'does not take rooms with other journals yet', expired: 'could not be reached for 7 days',
    journal_not_allowed: 'is not one this journal federates with any more', peer_key_changed: 'changed its key',
    not_contact: 'no longer has you as a contact', too_many_asks: 'has too many talk requests from you waiting',
  }
  const live = (d, entry) => {
    const r = halfOfEntry(d, entry)
    return !!r && LIVE_ROOM_STATES.includes(r.state) && contactLive(d, r)
  }
  // An op of a room that could not be delivered ends the room here, once,
  // with a notice saying why. One already over needs nothing.
  function onDead(d, entry, { error }) {
    const r = halfOfEntry(d, entry)
    if (r && LIVE_ROOM_STATES.includes(r.state)) {
      const why = REASONS[error] ?? 'refused it'
      const ended = endLocal(r, 'unreachable', { reason: `The room ended: the journal at ${t(r.peer_host)} ${why}.` })
      if (ended) {
        fileNotice(base, {
          userId: r.user_id, title: `Room with ${t(addressOf(r))} ended`,
          body: `The journal at ${t(r.peer_host)} ${why}, so the room with \`${plain(addressOf(r))}\`${r.topic ? ` (${t(r.topic, 80)})` : ''} could not go on.`,
          idemKey: `fed-room-dead:${r.id}`,
        })
      }
    }
    return 'discard'
  }
  const outbound = {
    [INVITE_OP]: { stillAllowed: live, onDead },
    // An answer often ends the guest's half (a decline, an expiry): it goes
    // while the contact lasts.
    [ANSWER_OP]: { stillAllowed: (d, entry) => { const r = halfOfEntry(d, entry); return !!r && contactLive(d, r) }, onDead },
    [MESSAGE_OP]: { stillAllowed: live, onDead },
    // The end goes even though the room is over here, while the contact lasts.
    [END_OP]: { stillAllowed: (d, entry) => { const r = halfOfEntry(d, entry); return !!r && contactLive(d, r) }, onDead: () => 'discard' },
  }

  const api = {
    inbound, outbound, setOutbox: (o) => { outbox = o },
    parkTalk, ownerAsk, handleTap, answerOwner, answerGuest, onGuestAgentAnswer, onGuestInviteExpired,
    onAgentLeft, endByUser, onContactEnded, copyOut, sweep, endLocal,
  }
  registry.set(db, api)
  return api
}
