// HTTP surface of Coordinator briefings (spec 2026-10-04 latest briefing):
// the latest briefing and refresh state the apps read, the Coordinator's
// publish, and the user's refresh, which fires the built-in on-demand
// briefing run through the routine firer. Model and rules in briefings.js.
import { json, readBody } from './http-body.js'
import { badRequest, idemKeyOf, senderOf } from './http-who.js'
import { closingConvo, refusedCloser } from './missions-http.js'
import { coordinatorDevice } from './consent.js'
import { DEFAULT_TZ } from './routines.js'
import {
  BRIEFING_ROUTINE, latestBriefing, markRefreshRequested, nextRefreshAt, publishBriefing, recordRefreshOutcome,
  refreshView, validBriefingBody,
} from './briefings.js'

const forbidden = (res) => { json(res, 403, { error: 'forbidden' }); return true }

function view(db, userId, now = Date.now()) {
  return {
    briefing: latestBriefing(db, userId),
    refresh: refreshView(db, userId, now),
    next_refresh_at: nextRefreshAt(db, userId, now),
    has_coordinator: !!coordinatorDevice(db, userId),
  }
}

export async function handleBriefingsRoute(ctx, req, res, url, who) {
  const { db, hub } = ctx
  if (url.pathname === '/briefings/latest') {
    if (req.method !== 'GET') return false
    if (who.kind !== 'client') return forbidden(res)
    json(res, 200, view(db, who.userId))
    return true
  }
  if (url.pathname === '/briefings') {
    if (req.method !== 'POST') return false
    // The Coordinator alone publishes, naming its own conversation.
    if (who.kind !== 'agent') return forbidden(res)
    const idemKey = idemKeyOf(req, who)
    if (idemKey === undefined) return badRequest(res)
    const body = await readBody(req)
    if (refusedCloser(res, closingConvo(db, who, body.convo_id, { required: true }))) return true
    const text = validBriefingBody(body.body)
    if (!text) return badRequest(res)
    const r = publishBriefing({ db, hub }, { userId: who.userId, convoId: body.convo_id, sender: senderOf(db, who), body: text, idemKey })
    json(res, r.duplicate ? 200 : 201, { briefing: r.briefing })
    return true
  }
  if (url.pathname === '/briefings/refresh') {
    if (req.method !== 'POST') return false
    // The user's button: a client token only.
    if (who.kind !== 'client') return forbidden(res)
    const now = Date.now()
    if (!coordinatorDevice(db, who.userId)) { json(res, 409, { error: 'conflict', blocked_by: 'no_coordinator' }); return true }
    const retryAt = nextRefreshAt(db, who.userId, now)
    if (retryAt) { json(res, 429, { error: 'rate_limited', retry_at: retryAt }); return true }
    const firer = ctx.routineFirer
    if (!firer || firer.busy()) { json(res, 503, { error: 'busy' }); return true }
    markRefreshRequested(db, who.userId, now)
    hub.sendToClients(who.userId, { kind: 'briefing', action: 'refreshing' })
    json(res, 202, view(db, who.userId, now))
    const routine = { ...BRIEFING_ROUTINE, user_id: who.userId, tz: DEFAULT_TZ }
    const onOutcome = (outcome) => {
      recordRefreshOutcome(db, who.userId, now, outcome)
      if (!outcome.startsWith('applied')) hub.sendToClients(who.userId, { kind: 'briefing', action: 'refresh_failed' })
    }
    void firer.fire(routine, { now, onOutcome })
      .catch((err) => console.error('briefings: refresh delivery failed', err))
    return true
  }
  return false
}
