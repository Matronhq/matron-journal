// HTTP surface of contacts and grants (spec 2026-10-02 matron-to-matron
// sharing, phase 1; docs/protocol.md "Contacts and grants").
//
//   GET    /contacts/users                 this journal's other users, names only
//   GET    /contacts[?state=]              my contacts
//   POST   /contacts {user, convo_id?}     ask someone to be a contact
//   POST   /contacts/:id/answer {decision} approve | decline       (client only)
//   POST   /contacts/:id/block             DELETE /contacts/:id    (remove / withdraw)
//   POST   /contacts/:id/unblock                                   (client only)
//   GET    /contacts/:id/activity          the audit events for one contact
//   POST   /missions/:id/shares {contact, level, convo_id?}
//   GET    /missions/:id/shares            the owner's grants on one mission
//   GET    /grants[?direction=in|out][&state=]
//   POST   /grants/:id/answer {decision}   approve | decline       (client only)
//   DELETE /grants/:id                     revoke (owner) / leave (grantee)
//
// Who may do what:
//   - An AGENT asking (POST /contacts, POST …/shares) never sends anything:
//     the ask is parked, a card and its tracker mirror go to the agent's
//     own user, and only that user's tap sends it on. A CLIENT asking is the
//     user's own tap, and goes straight out.
//   - Every answer is a client's. An agent — the Coordinator included — gets
//     403 on both answer routes and on unblock, and these asks are not in
//     /consent/pending: a card from another person, or one that sends data
//     to another person, is the user's alone.
//   - Agents may remove, block and revoke: those only ever reduce access.
import { json, readBody } from './http-body.js'
import { badRequest, notFound, conflict } from './http-who.js'
import { PEOPLE_EVENT_TYPE } from './journal.js'
import {
  DECISIONS, CONTACT_STATES, contactRow, listJournalUsers, getContactRaw, listContacts, requestContact, answerContact,
  removeContact, blockContact, unblockContact,
} from './contacts.js'
import { grantRow, getGrantRaw, shareMission, answerGrant, revokeGrant, listGrants, GRANT_LEVELS, GRANT_STATES } from './grants.js'
import { onContactOutcome, onContactEnded, onContactUnblocked, onGrantOutcome, onGrantRevoked } from './sharing-events.js'
import { visibleMission, writableConvo } from './missions-http.js'
import { getItem } from './items.js'
import { USERNAME_RE } from './users-http.js'
import { revokeSharesBetween } from './person-rooms.js'
import { onContactEndedRooms, onGrantEndedRooms, onShareEnded } from './person-rooms-events.js'

// Phase 2's share of a contact ending: every room between the two people
// ends on both sides, and every session either one shared with the other
// stops being offered. After onContactEnded, best-effort like it.
function endPeopleRooms(ctx, out) {
  const own = out.contact
  if (own.peer_user_id == null) return
  try {
    onContactEndedRooms(ctx, own.user_id, own.peer_user_id)
    for (const s of revokeSharesBetween(ctx.db, [own.id, out.peer?.id ?? ctx.db.prepare('SELECT id FROM contacts WHERE user_id=? AND peer_user_id=? AND peer_journal IS NULL').get(own.peer_user_id, own.user_id)?.id])) onShareEnded(ctx, s)
  } catch (err) {
    console.error('person rooms: contact end failed (the contact change stands)', err)
  }
}

const forbidden = (res) => { json(res, 403, { error: 'forbidden' }); return true }
const blocked = (res, by, extra = {}) => conflict(res, { blocked_by: by, ...extra })
const CONTACT_CONFLICTS = new Set(['already_contact', 'pending', 'pending_in', 'blocked', 'too_many_asks', 'not_pending', 'not_active', 'not_blocked'])
const GRANT_CONFLICTS = new Set(['not_contact', 'level_unavailable', 'private_mission', 'pending', 'too_many_asks', 'not_pending', 'not_active'])

// The conversation an agent's ask is parked in — where its card goes. Same
// gate as every other agent-authored append. A client names none.
function askConvo(db, who, convoId) {
  if (who.kind !== 'agent') return { convoId: null }
  if (typeof convoId !== 'string' || !convoId) return { status: 400 }
  if (!writableConvo(db, who, convoId)) return { status: 404 }
  return { convoId }
}

const by = (who) => (who.kind === 'agent' ? 'agent' : 'user')

// --- Contacts ---------------------------------------------------------------

async function handleContactRequest(ctx, req, res, who) {
  const { db } = ctx
  const body = await readBody(req)
  if (typeof body.user !== 'string' || !USERNAME_RE.test(body.user)) return badRequest(res)
  const convo = askConvo(db, who, body.convo_id)
  if (convo.status === 400) return badRequest(res)
  if (convo.status === 404) return notFound(res)
  let out
  try {
    out = requestContact(db, { userId: who.userId, peerName: body.user, by: by(who), convoId: convo.convoId, deviceId: who.deviceId })
  } catch (err) {
    // Unknown user and "yourself" are one 404.
    if (err.message === 'no_user') return notFound(res)
    if (CONTACT_CONFLICTS.has(err.message)) return blocked(res, err.message)
    throw err
  }
  onContactOutcome(ctx, who, out)
  // `pending`: whose yes is still needed. A request the other person has
  // blocked answers exactly like one they have not seen yet.
  const pending = out.outcome === 'parked' ? 'owner' : (out.contact.state === 'active' ? null : 'peer')
  json(res, out.outcome === 'parked' ? 202 : 201, { contact: contactRow(out.contact), ...(pending ? { pending } : {}) })
  return true
}

// Shared by POST /contacts/:id/answer and a tap on the mirror's button.
// Returns {status, body} for the caller to send, plus `closed` (the mirror
// that the answer closed) for the item route.
export function applyContactAnswer(ctx, who, contactId, decision) {
  const { db } = ctx
  let out
  try {
    out = answerContact(db, { userId: who.userId, contactId, decision })
  } catch (err) {
    if (CONTACT_CONFLICTS.has(err.message)) return { status: 409, body: { error: 'conflict', blocked_by: err.message } }
    throw err
  }
  if (!out) return { status: 404, body: { error: 'not_found' } }
  const closed = onContactOutcome(ctx, who, out)
  if (out.outcome === 'expired') return { status: 409, body: { error: 'conflict', blocked_by: 'expired' }, closed }
  return { status: 200, body: { contact: contactRow(out.contact) }, closed }
}

async function handleContactSub(ctx, req, res, url, who, id, sub) {
  const { db } = ctx
  const own = getContactRaw(db, who.userId, id)
  if (!own) return notFound(res)
  if (!sub) {
    if (req.method === 'GET') { json(res, 200, { contact: contactRow(own) }); return true }
    if (req.method === 'DELETE') {
      let out
      try { out = removeContact(db, { userId: who.userId, contactId: own.id }) } catch (err) {
        if (CONTACT_CONFLICTS.has(err.message)) return blocked(res, err.message)
        throw err
      }
      if (!out) return notFound(res)
      onContactEnded(ctx, who, out, 'removed')
      endPeopleRooms(ctx, out)
      json(res, 200, { contact: contactRow(out.contact) })
      return true
    }
    return false
  }
  if (sub === 'activity' && req.method === 'GET') {
    json(res, 200, { events: contactActivity(db, who.userId, own.id) })
    return true
  }
  if (req.method !== 'POST') return false
  if (sub === 'answer') {
    if (who.kind !== 'client') return forbidden(res)
    const body = await readBody(req)
    if (!DECISIONS.includes(body.decision)) return badRequest(res)
    const r = applyContactAnswer(ctx, who, own.id, body.decision)
    json(res, r.status, r.body)
    return true
  }
  if (sub === 'block') {
    let out
    try { out = blockContact(db, { userId: who.userId, contactId: own.id }) } catch (err) {
      if (CONTACT_CONFLICTS.has(err.message)) return blocked(res, err.message)
      throw err
    }
    if (!out) return notFound(res)
    onContactEnded(ctx, who, out, 'blocked')
    endPeopleRooms(ctx, out)
    json(res, 200, { contact: contactRow(out.contact) })
    return true
  }
  if (sub === 'unblock') {
    if (who.kind !== 'client') return forbidden(res)
    let out
    try { out = unblockContact(db, { userId: who.userId, contactId: own.id }) } catch (err) {
      if (CONTACT_CONFLICTS.has(err.message)) return blocked(res, err.message)
      throw err
    }
    if (!out) return notFound(res)
    onContactUnblocked(ctx, out)
    json(res, 200, { contact: contactRow(out.contact) })
    return true
  }
  return false
}

// The audit trail for one contact, newest first: the `people` events in the
// caller's own People conversation that name this contact row. Clients
// only see it through this route or their own timeline; an agent may read
// it (it is its user's record of what was shared with whom).
const ACTIVITY_MAX = 200
function contactActivity(db, userId, contactId) {
  return db.prepare(`SELECT e.seq, e.ts, e.payload FROM events e
      JOIN conversations c ON c.id = e.convo_id AND c.owner_user_id = e.user_id AND c.system = 'people'
    WHERE e.user_id = ? AND e.type = ? AND json_extract(e.payload, '$.contact_id') = ?
    ORDER BY e.seq DESC LIMIT ${ACTIVITY_MAX}`).all(userId, PEOPLE_EVENT_TYPE, contactId)
    .map((r) => ({ seq: r.seq, ts: r.ts, ...JSON.parse(r.payload) }))
}

// --- Grants -----------------------------------------------------------------

async function handleShareCreate(ctx, req, res, who, mission) {
  const { db } = ctx
  const body = await readBody(req)
  if (typeof body.contact !== 'string' || !body.contact || body.contact.length > 128) return badRequest(res)
  const level = body.level ?? 'read'
  if (!GRANT_LEVELS.includes(level)) return badRequest(res)
  const convo = askConvo(db, who, body.convo_id)
  if (convo.status === 400) return badRequest(res)
  if (convo.status === 404) return notFound(res)
  let out
  try {
    out = shareMission(db, { ownerUserId: who.userId, missionId: mission.id, contact: body.contact, level, by: by(who), convoId: convo.convoId, deviceId: who.deviceId })
  } catch (err) {
    if (err.message === 'no_mission') return notFound(res)
    if (GRANT_CONFLICTS.has(err.message)) return blocked(res, err.message)
    throw err
  }
  if (out.existing) { json(res, 200, { grant: grantRow(out.grant, who.userId), existing: true }); return true }
  const parked = out.grant.state === 'awaiting_owner'
  onGrantOutcome(ctx, who, { outcome: parked ? 'parked' : 'sent', grant: out.grant })
  json(res, parked ? 202 : 201, { grant: grantRow(out.grant, who.userId), pending: parked ? 'owner' : 'peer' })
  return true
}

export function applyGrantAnswer(ctx, who, grantId, decision) {
  const { db } = ctx
  let out
  try {
    out = answerGrant(db, { userId: who.userId, grantId, decision })
  } catch (err) {
    if (GRANT_CONFLICTS.has(err.message)) return { status: 409, body: { error: 'conflict', blocked_by: err.message } }
    throw err
  }
  if (!out) return { status: 404, body: { error: 'not_found' } }
  const closed = onGrantOutcome(ctx, who, out)
  if (out.outcome === 'expired') return { status: 409, body: { error: 'conflict', blocked_by: 'expired' }, closed }
  if (out.outcome === 'unavailable') return { status: 409, body: { error: 'conflict', blocked_by: 'not_contact' }, closed }
  return { status: 200, body: { grant: grantRow(out.grant, who.userId) }, closed }
}

async function handleGrantRoute(ctx, req, res, url, who) {
  const { db } = ctx
  const path = url.pathname
  if (path === '/grants') {
    if (req.method !== 'GET') return false
    const direction = url.searchParams.get('direction')
    if (direction != null && direction !== 'in' && direction !== 'out') return badRequest(res)
    const state = url.searchParams.get('state')
    if (state != null && !GRANT_STATES.includes(state)) return badRequest(res)
    json(res, 200, { grants: listGrants(db, who.userId, { direction, state }) })
    return true
  }
  const m = path.match(/^\/grants\/([^/]+)(?:\/(answer))?$/)
  if (!m) return false
  let id
  try { id = decodeURIComponent(m[1]) } catch { return badRequest(res) }
  // Not a party — or the grantee of an ask its owner has not approved yet —
  // is the same 404 as an unknown id.
  const g = getGrantRaw(db, id)
  const party = g && (g.owner_user_id === who.userId || (g.grantee_user_id === who.userId && g.state !== 'awaiting_owner'))
  if (!party) return notFound(res)
  if (!m[2]) {
    if (req.method === 'GET') { json(res, 200, { grant: grantRow(g, who.userId) }); return true }
    if (req.method === 'DELETE') {
      let out
      try { out = revokeGrant(db, { userId: who.userId, grantId: g.id }) } catch (err) {
        if (GRANT_CONFLICTS.has(err.message)) return blocked(res, err.message)
        throw err
      }
      if (!out) return notFound(res)
      onGrantRevoked(ctx, out.before, out.by, who)
      if (out.before.subject_kind === 'mission') onGrantEndedRooms(ctx, out.before.subject_id, out.before.contact_id)
      json(res, 200, { grant: grantRow(out.grant, who.userId) })
      return true
    }
    return false
  }
  if (req.method !== 'POST') return false
  if (who.kind !== 'client') return forbidden(res)
  const body = await readBody(req)
  if (!DECISIONS.includes(body.decision)) return badRequest(res)
  const r = applyGrantAnswer(ctx, who, g.id, body.decision)
  json(res, r.status, r.body)
  return true
}

// A tap on a contact/share mirror's action button (POST /items/:id/comments
// {action}) IS the answer to its card — the path today's apps already have.
// Called by items-http.js ahead of the generic comment path, for a client
// only. The reply has the comment route's shape: the closed item and the
// status row that closed it.
export function handleConsentTap(ctx, res, who, item, action) {
  const { db } = ctx
  if (!item.actions.includes(action)) { json(res, 400, { error: 'unknown_action' }); return true }
  const decision = action === 'Decline' ? 'decline' : 'approve'
  let r
  if (item.consent === 'contact') {
    const row = db.prepare('SELECT id FROM contacts WHERE user_id=? AND item_id=?').get(who.userId, item.id)
    if (!row) return conflict(res)
    r = applyContactAnswer(ctx, who, row.id, decision)
  } else {
    const row = db.prepare('SELECT id FROM grants WHERE owner_item_id=? OR grantee_item_id=?').get(item.id, item.id)
    if (!row) return conflict(res)
    r = applyGrantAnswer(ctx, who, row.id, decision)
  }
  if (r.status !== 200) { json(res, r.status, r.body); return true }
  json(res, 200, { item: getItem(db, who.userId, item.id) ?? item, comment: r.closed?.comment ?? null, ...r.body })
  return true
}

export const isSharingMirror = (item) => item?.consent === 'contact' || item?.consent === 'share'

export async function handleSharingRoute(ctx, req, res, url, who) {
  const { db } = ctx
  const path = url.pathname
  if (path === '/grants' || path.startsWith('/grants/')) return handleGrantRoute(ctx, req, res, url, who)

  const sm = path.match(/^\/missions\/([^/]+)\/shares$/)
  if (sm) {
    let idOrNum
    try { idOrNum = decodeURIComponent(sm[1]) } catch { return badRequest(res) }
    // The owner's mission, through the caller's own sieve: a mission an
    // ordinary agent cannot see cannot be shared by it, or probed for.
    const mission = visibleMission(db, who, idOrNum)
    if (!mission) return notFound(res)
    if (req.method === 'GET') { json(res, 200, { grants: listGrants(db, who.userId, { direction: 'out', missionId: mission.id }) }); return true }
    if (req.method === 'POST') return handleShareCreate(ctx, req, res, who, mission)
    return false
  }

  if (path !== '/contacts' && !path.startsWith('/contacts/')) return false
  if (path === '/contacts') {
    if (req.method === 'GET') {
      const state = url.searchParams.get('state')
      if (state != null && !CONTACT_STATES.includes(state)) return badRequest(res)
      json(res, 200, { contacts: listContacts(db, who.userId, { state }) })
      return true
    }
    if (req.method === 'POST') return handleContactRequest(ctx, req, res, who)
    return false
  }
  if (path === '/contacts/users') {
    if (req.method !== 'GET') return false
    json(res, 200, { users: listJournalUsers(db, who.userId) })
    return true
  }
  const m = path.match(/^\/contacts\/([^/]+)(?:\/(answer|block|unblock|activity))?$/)
  if (!m) return false
  let id
  try { id = decodeURIComponent(m[1]) } catch { return badRequest(res) }
  return handleContactSub(ctx, req, res, url, who, id, m[2] || null)
}
