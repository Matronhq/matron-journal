// HTTP surface of pinned desk chats (src/pins.js). Client tokens only, like
// PUT /coordinator: agents see a pin's label on /roster and nothing else.
// Every change answers with the whole list and sends it live to the user's
// open apps ({kind:'pins'}), so the Mac, the iPhone and the web stay in step.
//
//   GET    /pins                        → {pins, limit}
//   PUT    /pins                        {order: [convo_id…]} — every pin once
//   PUT    /pins/:convo_id              {label?, emoji?} — pin (label required) or edit
//   DELETE /pins/:convo_id              unpin
//   POST   /pins/:convo_id/move         {to_convo_id} — keep label, emoji, position
//   POST   /pins/:convo_id/dismiss      {successor_id} — hide that "new session" hint
import { json, readBody } from './http-body.js'
import { badRequest, notFound, conflict } from './http-who.js'
import { CONVO_ID_MAX_CHARS } from './journal.js'
import {
  PIN_LIMIT, cleanLabel, cleanEmoji,
  listPins, upsertPin, removePin, reorderPins, movePin, dismissSuccessor, sendPinsFrame,
} from './pins.js'

const isConvoId = (s) => typeof s === 'string' && !!s && s.length <= CONVO_ID_MAX_CHARS
const isObject = (b) => !!b && typeof b === 'object' && !Array.isArray(b)

export function pinsView(db, userId) {
  return { pins: listPins(db, userId), limit: PIN_LIMIT }
}

export { sendPinsFrame }

const ERRORS = {
  no_convo: (res) => notFound(res),
  no_pin: (res) => notFound(res),
  no_label: (res) => badRequest(res),
  bad_order: (res) => badRequest(res),
  pin_limit: (res) => conflict(res, { detail: 'pin_limit', limit: PIN_LIMIT }),
  already_pinned: (res) => conflict(res, { detail: 'already_pinned' }),
}

export async function handlePinsRoute(ctx, req, res, url, who) {
  const m = url.pathname.match(/^\/pins(?:\/([^/]+)(?:\/(move|dismiss))?)?$/)
  if (!m) return false
  const { db, hub } = ctx
  if (who.kind !== 'client') { json(res, 403, { error: 'forbidden' }); return true }
  let convoId = null
  try { convoId = m[1] != null ? decodeURIComponent(m[1]) : null } catch { return badRequest(res) }
  const action = m[2] ?? null
  if (convoId != null && !isConvoId(convoId)) return badRequest(res)

  if (req.method === 'GET' && convoId == null) {
    json(res, 200, pinsView(db, who.userId))
    return true
  }

  let run
  if (req.method === 'PUT' && convoId == null) {
    const body = await readBody(req)
    if (!isObject(body) || !Array.isArray(body.order) || !body.order.every(isConvoId)) return badRequest(res)
    run = () => reorderPins(db, who.userId, body.order)
  } else if (req.method === 'PUT' && action == null) {
    const body = await readBody(req)
    if (!isObject(body) || (!('label' in body) && !('emoji' in body))) return badRequest(res)
    let label
    if ('label' in body) {
      label = cleanLabel(body.label)
      if (!label) return badRequest(res)
    }
    let emoji
    if ('emoji' in body) {
      emoji = cleanEmoji(body.emoji)
      if (emoji == null) return badRequest(res)
    }
    run = () => upsertPin(db, who.userId, convoId, { label, emoji })
  } else if (req.method === 'DELETE' && action == null && convoId != null) {
    run = () => { if (!removePin(db, who.userId, convoId)) throw new Error('no_pin') }
  } else if (req.method === 'POST' && action === 'move') {
    const body = await readBody(req)
    if (!isObject(body) || !isConvoId(body.to_convo_id)) return badRequest(res)
    run = () => movePin(db, who.userId, convoId, body.to_convo_id)
  } else if (req.method === 'POST' && action === 'dismiss') {
    const body = await readBody(req)
    if (!isObject(body) || !isConvoId(body.successor_id)) return badRequest(res)
    run = () => dismissSuccessor(db, who.userId, convoId, body.successor_id)
  } else {
    return false
  }

  try {
    run()
  } catch (err) {
    const h = ERRORS[err.message]
    if (h) return h(res)
    throw err
  }
  sendPinsFrame(db, hub, who.userId)
  json(res, 200, pinsView(db, who.userId))
  return true
}
