// HTTP surface of the Coordinator setting (spec 2026-09-23 coordinator
// redesign §1a). Either device kind may read; only the user (a client
// token) may choose. A change is announced into both conversations through
// the ordinary append+broadcast path, so the owning bridge and every open
// app hear it live and replay it later.
import { appendAndBroadcast, CONVO_ID_MAX_CHARS } from './journal.js'
import { json, readBody } from './http-body.js'
import { senderOf, badRequest, notFound } from './http-who.js'
import { filteredAgent } from './privacy.js'
import { COORDINATOR_EVENT_TYPE, coordinatorFor, setCoordinatorConvoId } from './coordinator.js'

// Written AFTER the setting committed, never inside it — same stance as
// missions-http.js's emitMissionMarker: the setting is the truth; a failed
// announcement is logged, not rolled back.
function emitRole({ db, hub }, who, convoId, role) {
  try {
    appendAndBroadcast(db, hub, { userId: who.userId, convoId, sender: senderOf(db, who), type: COORDINATOR_EVENT_TYPE, payload: { role } })
  } catch (err) {
    console.error('coordinator: role event append failed (setting already committed)', err)
  }
}

export async function handleCoordinatorRoute(ctx, req, res, url, who) {
  if (url.pathname !== '/coordinator') return false
  const { db } = ctx
  if (req.method === 'GET') {
    json(res, 200, { convo_id: coordinatorFor(db, who.userId, { excludePrivateOwned: filteredAgent(db, who) }) })
    return true
  }
  if (req.method !== 'PUT') return false
  if (who.kind !== 'client') { json(res, 403, { error: 'forbidden' }); return true }
  const body = await readBody(req)
  if (!('convo_id' in body)) return badRequest(res)
  const convoId = body.convo_id
  if (convoId !== null && (typeof convoId !== 'string' || !convoId || convoId.length > CONVO_ID_MAX_CHARS)) return badRequest(res)
  let out
  try {
    out = setCoordinatorConvoId(db, who.userId, convoId)
  } catch (err) {
    if (err.message === 'no_convo') return notFound(res)
    throw err
  }
  if (out.changed) {
    if (out.previous) emitRole(ctx, who, out.previous, 'released')
    if (out.current) emitRole(ctx, who, out.current, 'assigned')
  }
  json(res, 200, { convo_id: out.current })
  return true
}
