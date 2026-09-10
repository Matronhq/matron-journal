// HTTP surface of missions & milestones (spec 2026-09-10, "HTTP API").
// Validation, auth, the privacy sieve, and the side effects the pure
// module must not know about: the 'mission' and 'milestone' marker events.
// No wake, no push: both markers are navigation, not attention.
import { append, appendAndBroadcast, broadcastAppended } from './journal.js'
import { isPrivateDevice } from './db.js'
import { authorizeAgentWrite } from './auth.js'
import { json, readBody } from './http-body.js'
import { BODY_MAX } from './items.js'
import {
  MILESTONE_KINDS, TITLE_MAX, validateMissionFields, createMission, getMission, listMissions, missionDetail,
  updateMission, joinMission, closeMission, createMilestone, listMilestones,
} from './missions.js'
import { MISSION_EVENT_TYPE, MILESTONE_EVENT_TYPE, missionMarkerPayload } from './missions-marker.js'

const STATES = ['open', 'closed']
const IDEM_KEY_MAX = 128

const badRequest = (res) => { json(res, 400, { error: 'bad_request' }); return true }
const notFound = (res) => { json(res, 404, { error: 'not_found' }); return true }
const conflict = (res, extra = {}) => { json(res, 409, { error: 'conflict', ...extra }); return true }

// Same shape as items-http.js (module-private there; duplicated on purpose
// so the two surfaces never share a hidden coupling).
const filteredAgent = (db, who) => who.kind === 'agent' && !isPrivateDevice(db, who.deviceId)
const privateOwnedConvo = (db, convoId) => {
  const owner = db.prepare('SELECT agent_device_id FROM conversations WHERE id=?').get(convoId)?.agent_device_id
  return owner != null && isPrivateDevice(db, owner)
}
const idemKeyOf = (req, who) => {
  const k = req.headers['idempotency-key']
  if (k === undefined) return null
  if (typeof k !== 'string' || !k || k.length > IDEM_KEY_MAX) return undefined
  return `${who.deviceId}:${k}`
}
function senderOf(db, who) {
  if (who.kind === 'agent') return `agent:${who.name}`
  const row = db.prepare('SELECT name FROM users WHERE id=?').get(who.userId)
  return `user:${row ? row.name : who.userId}`
}
const byOf = (who) => (who.kind === 'agent' ? 'agent' : 'user')

// Visible = owned by the caller's user and, for an ordinary agent, not born
// in a private device's conversation. Same 404 for every failure.
function visibleMission(db, who, idOrNum) {
  const m = getMission(db, who.userId, idOrNum)
  if (!m) return null
  if (filteredAgent(db, who) && privateOwnedConvo(db, m.origin_convo_id)) return null
  return m
}

// The conversation gate for the two routes that target a conversation
// rather than an already-visible mission (create, milestone, join).
function writableConvo(db, who, convoId) {
  if (typeof convoId !== 'string' || !convoId) return false
  const convo = db.prepare('SELECT owner_user_id, agent_device_id FROM conversations WHERE id=?').get(convoId)
  if (!convo || convo.owner_user_id !== who.userId) return false
  if (who.kind === 'agent' && !authorizeAgentWrite(db, who.userId, who.deviceId, convoId)) return false
  if (filteredAgent(db, who) && convo.agent_device_id != null && isPrivateDevice(db, convo.agent_device_id)) return false
  return true
}

// Mission markers are written AFTER the mission's transaction committed —
// never inside it (same stance as items' emitMarker).
function emitMissionMarker({ db, hub }, who, { mission, action, convoId, openItemNums = null }) {
  const payload = missionMarkerPayload({ mission, action, by: byOf(who), openItemNums })
  try {
    appendAndBroadcast(db, hub, { userId: who.userId, convoId, sender: senderOf(db, who), type: MISSION_EVENT_TYPE, payload })
  } catch (err) {
    console.error('missions: marker append failed (mission write already committed)', err)
  }
}

async function handleCreate(ctx, req, res, who) {
  const { db } = ctx
  const body = await readBody(req)
  const v = validateMissionFields(body)
  if (!v.ok) return badRequest(res)
  const idemKey = idemKeyOf(req, who)
  if (idemKey === undefined) return badRequest(res)
  if (!writableConvo(db, who, body.convo_id)) return notFound(res)
  const out = createMission(db, {
    userId: who.userId, deviceId: who.deviceId, createdBy: byOf(who), convoId: body.convo_id,
    title: v.value.title, body: v.value.body ?? '', idemKey,
  })
  if (out.existing) { json(res, 200, { mission: out.mission, existing: true }); return true }
  if (out.duplicate) { json(res, 200, { mission: out.mission }); return true }
  emitMissionMarker(ctx, who, { mission: out.mission, action: 'created', convoId: body.convo_id })
  json(res, 201, { mission: out.mission })
  return true
}

function handleList(ctx, res, url, who) {
  const { db } = ctx
  const state = url.searchParams.get('state')
  if (state != null && !STATES.includes(state)) return badRequest(res)
  let since = null
  if (url.searchParams.has('since')) {
    since = Number(url.searchParams.get('since'))
    if (!Number.isFinite(since) || since < 0) return badRequest(res)
  }
  json(res, 200, { missions: listMissions(db, who.userId, { state, since, excludePrivateOwned: filteredAgent(db, who) }) })
  return true
}

async function handlePatch(ctx, req, res, who, mission) {
  const { db } = ctx
  const body = await readBody(req)
  const v = validateMissionFields(body, { partial: true })
  if (!v.ok || Object.keys(v.value).length === 0) return badRequest(res)
  let updated
  try { updated = updateMission(db, { userId: who.userId, missionId: mission.id, fields: v.value }) }
  catch (err) { if (err.message === 'closed') return conflict(res, { blocked_by: 'closed' }); throw err }
  if (!updated) return notFound(res)
  emitMissionMarker(ctx, who, { mission: updated, action: 'updated', convoId: updated.origin_convo_id })
  json(res, 200, { mission: updated })
  return true
}

async function handleJoin(ctx, req, res, who, mission) {
  const { db } = ctx
  const body = await readBody(req)
  if (!writableConvo(db, who, body.convo_id)) return notFound(res)
  const already = db.prepare('SELECT mission_id FROM conversations WHERE id=?').get(body.convo_id)?.mission_id
  let joined
  try { joined = joinMission(db, { userId: who.userId, missionId: mission.id, convoId: body.convo_id }) }
  catch (err) {
    if (err.message === 'closed' || err.message === 'other_mission') return conflict(res, { blocked_by: err.message })
    if (err.message === 'too_many_convos') return badRequest(res)
    throw err
  }
  if (already !== joined.id) emitMissionMarker(ctx, who, { mission: joined, action: 'joined', convoId: body.convo_id })
  json(res, 200, { mission: joined })
  return true
}

async function handleClose(ctx, req, res, who, mission) {
  const { db } = ctx
  const body = await readBody(req)
  if (typeof body.summary !== 'string' || !body.summary.trim() || Buffer.byteLength(body.summary, 'utf8') > BODY_MAX) return badRequest(res)
  let out
  try { out = closeMission(db, { userId: who.userId, missionId: mission.id, by: byOf(who), summary: body.summary }) }
  catch (err) {
    if (err.message === 'closed') return conflict(res, { blocked_by: 'closed' })
    if (err.message === 'user_items' || err.message === 'agent_items') return conflict(res, { blocked_by: err.message, items: err.items })
    throw err
  }
  emitMissionMarker(ctx, who, {
    mission: out.mission, action: 'closed', convoId: out.mission.origin_convo_id,
    openItemNums: who.kind === 'agent' ? null : out.openItemNums,
  })
  json(res, 200, { mission: out.mission })
  return true
}

async function handleMilestoneCreate(ctx, req, res, who) {
  const { db, hub } = ctx
  const body = await readBody(req)
  if (!body || typeof body !== 'object' || Array.isArray(body)) return badRequest(res)
  if (!MILESTONE_KINDS.includes(body.kind)) return badRequest(res)
  if (typeof body.title !== 'string' || !body.title.trim() || body.title.trim().length > TITLE_MAX) return badRequest(res)
  if (body.body !== undefined && (typeof body.body !== 'string' || Buffer.byteLength(body.body, 'utf8') > BODY_MAX)) return badRequest(res)
  const idemKey = idemKeyOf(req, who)
  if (idemKey === undefined) return badRequest(res)
  if (!writableConvo(db, who, body.convo_id)) return notFound(res)
  const sender = senderOf(db, who)
  let out
  try {
    out = createMilestone(db, {
      userId: who.userId, deviceId: who.deviceId, createdBy: byOf(who), convoId: body.convo_id,
      kind: body.kind, title: body.title.trim(), body: body.body ?? '', idemKey,
      appendMarker: (payload) => append(db, { userId: who.userId, convoId: body.convo_id, sender, type: MILESTONE_EVENT_TYPE, payload }),
    })
  } catch (err) {
    if (err.message === 'no_mission' || err.message === 'closed') return conflict(res, { blocked_by: err.message })
    if (err.message === 'idem_key_conflict') return conflict(res, { blocked_by: 'idem_key' })
    if (err.message === 'marker_append_failed') {
      console.error('missions: milestone marker append failed — milestone not created', err.cause)
      json(res, 502, { error: 'marker_append_failed' }); return true
    }
    throw err
  }
  if (out.duplicate) { json(res, 200, { milestone: out.milestone, mission: out.mission }); return true }
  // Broadcast only now: the marker committed with the row.
  try {
    broadcastAppended(db, hub, {
      userId: who.userId, convoId: body.convo_id, seq: out.seq, ts: out.ts, sender, type: MILESTONE_EVENT_TYPE,
      payload: { milestone_id: out.milestone.id, num: out.milestone.num, kind: out.milestone.kind, title: out.milestone.title, body: out.milestone.body,
        mission_id: out.mission.id, mission_num: out.mission.num, mission_title: out.mission.title, by: byOf(who) },
    })
  } catch (err) { console.error('missions: milestone broadcast failed (row and marker already committed)', err) }
  json(res, 201, { milestone: out.milestone, mission: out.mission })
  return true
}

function handleMilestoneList(ctx, res, url, who) {
  const { db } = ctx
  const convoId = url.searchParams.get('convo')
  if (!convoId) return badRequest(res)
  const convo = db.prepare('SELECT owner_user_id FROM conversations WHERE id=?').get(convoId)
  if (!convo || convo.owner_user_id !== who.userId) return notFound(res)
  if (filteredAgent(db, who) && privateOwnedConvo(db, convoId)) return notFound(res)
  json(res, 200, { milestones: listMilestones(db, who.userId, { convoId, excludePrivateOwned: filteredAgent(db, who) }) })
  return true
}

export async function handleMissionsRoute(ctx, req, res, url, who) {
  const { db } = ctx
  const path = url.pathname
  if (path === '/milestones') {
    if (req.method === 'POST') return handleMilestoneCreate(ctx, req, res, who)
    if (req.method === 'GET') return handleMilestoneList(ctx, res, url, who)
    return false
  }
  if (path !== '/missions' && !path.startsWith('/missions/')) return false
  if (path === '/missions') {
    if (req.method === 'POST') return handleCreate(ctx, req, res, who)
    if (req.method === 'GET') return handleList(ctx, res, url, who)
    return false
  }
  // Nested sub segment on purpose (see items-http.js): /missions/:id/junk must not match.
  const m = path.match(/^\/missions\/([^/]+)(?:\/(join|close))?$/)
  if (!m) return false
  let idOrNum
  try { idOrNum = decodeURIComponent(m[1]) } catch { return badRequest(res) }
  const sub = m[2] || null
  const mission = visibleMission(db, who, idOrNum)
  if (!mission) return notFound(res)
  if (!sub) {
    if (req.method === 'GET') {
      json(res, 200, missionDetail(db, who.userId, mission.id, { excludePrivateOwned: filteredAgent(db, who) })); return true
    }
    if (req.method === 'PATCH') return handlePatch(ctx, req, res, who, mission)
    return false
  }
  if (req.method !== 'POST') return false
  if (sub === 'join') return handleJoin(ctx, req, res, who, mission)
  return handleClose(ctx, req, res, who, mission)
}
