// HTTP surface of Coordinator consent approval:
//   GET  /consent/pending?convo_id=…   the parked asks, both kinds
//   POST /consent/answer {convo_id, kind, id, decision, reason}
// Agent connections only, and only when convo_id is a top-level
// conversation this device owns AND the user's Coordinator — the same gate
// session_control applies. Checks, in order (every failure is a bare error
// body): client → 403 forbidden; bad shape → 400; convo not this device's →
// 404; not the Coordinator → 403 not_coordinator; switch off → 403
// consent_disabled; then per answer: the ask must exist (404) and still be
// awaiting (409 conflict); an approval of an ask a user-only box takes part
// in is 403 user_only (declines stay allowed); a spawn approval into an
// offline, unwakeable box is 409 target_offline; an approval of the
// Coordinator's OWN ask — or of another session's ask the Coordinator had
// it make — is refused unless its cause checks out
// (src/consent-own-ask.js: own_ask_unverified, envelope, verifier,
// verifier_unavailable, routine_cap); approvals at the rolling 24 h cap are
// 409 daily_cap (a cap of 0 is no cap). Declines skip every approval check.
// An ordinary (non-private) Coordinator neither lists nor answers an ask a
// private device takes part in: such an ask is left out of the list and is
// 404 on answer, approve or decline (docs/protocol.md "Device privacy").
// Nothing here can reach a tool permission prompt or a secret request —
// those never exist as journal asks.
import { json, readBody } from './http-body.js'
import { sanitizePeerText } from './peer-text.js'
import { getCoordinatorConvoId } from './coordinator.js'
import {
  CONSENT_REASON_MAX, CONSENT_DAILY_CAP_DEFAULT, CONSENT_DAILY_WINDOW_MS, CONSENT_KINDS, CONSENT_DECISIONS,
  getConsentEnabled, listPendingAsks, parseChatAskId, coordinatorApprovalsSince, deviceState,
  isUserOnlySpawn, isUserOnlyChat, spawnAskInvolvesPrivate, chatAskInvolvesPrivate,
} from './consent.js'
import { filteredAgent } from './privacy.js'
import { answerChatAsk, answerSpawnAsk } from './consent-answer.js'
import { verifyOwnAsk, confirmOwnAsk, spawnAsk, chatAsk } from './consent-own-ask.js'
import { getSpawn } from './spawns.js'

const forbidden = (res, detail) => { json(res, 403, { error: 'forbidden', ...(detail ? { detail } : {}) }); return true }

// Ownership and role, in that order so a caller who is not the
// Coordinator learns nothing beyond "not yours".
function coordinatorCaller(db, who, convoId) {
  if (typeof convoId !== 'string' || !convoId || convoId.length > 128) return { status: 400 }
  const convo = db.prepare('SELECT owner_user_id, agent_device_id, parent_convo_id FROM conversations WHERE id=?').get(convoId)
  if (!convo || convo.owner_user_id !== who.userId || convo.agent_device_id !== who.deviceId || convo.parent_convo_id != null) return { status: 404 }
  if (getCoordinatorConvoId(db, who.userId) !== convoId) return { status: 403, detail: 'not_coordinator' }
  if (!getConsentEnabled(db, who.userId)) return { status: 403, detail: 'consent_disabled' }
  return { ok: true }
}

function refuse(res, gate) {
  if (gate.status === 400) { json(res, 400, { error: 'bad_request' }); return true }
  if (gate.status === 404) { json(res, 404, { error: 'not_found' }); return true }
  return forbidden(res, gate.detail)
}

export async function handleConsentRoute(ctx, req, res, url, who) {
  if (url.pathname !== '/consent/pending' && url.pathname !== '/consent/answer') return false
  const { db, hub, waker } = ctx
  if (who.kind !== 'agent') return forbidden(res)
  if (req.method === 'GET' && url.pathname === '/consent/pending') {
    const gate = coordinatorCaller(db, who, url.searchParams.get('convo_id'))
    if (!gate.ok) return refuse(res, gate)
    json(res, 200, { pending: listPendingAsks({ db, hub, waker }, who.userId, { excludePrivate: filteredAgent(db, who) }) })
    return true
  }
  if (req.method !== 'POST' || url.pathname !== '/consent/answer') return false
  const body = await readBody(req)
  const gate = coordinatorCaller(db, who, body.convo_id)
  if (!gate.ok) return refuse(res, gate)
  if (!CONSENT_KINDS.has(body.kind) || !CONSENT_DECISIONS.has(body.decision)) { json(res, 400, { error: 'bad_request' }); return true }
  if (typeof body.reason !== 'string' || body.reason.length > CONSENT_REASON_MAX) { json(res, 400, { error: 'bad_request' }); return true }
  const reason = sanitizePeerText(body.reason, CONSENT_REASON_MAX)
  if (!reason) { json(res, 400, { error: 'bad_request' }); return true }
  const decidedBy = { kind: 'coordinator', deviceId: who.deviceId, convoId: body.convo_id, reason }
  const ordinary = filteredAgent(db, who)
  // Every refusal comes BEFORE any state changes, so a refused answer
  // leaves the ask exactly as it was — for the user.
  if (body.kind === 'spawn') {
    if (typeof body.id !== 'string' || !body.id || body.id.length > 128) { json(res, 400, { error: 'bad_request' }); return true }
    if (ordinary) {
      const row = getSpawn(db, body.id)
      if (row && row.user_id === who.userId && spawnAskInvolvesPrivate(db, row)) { json(res, 404, { error: 'not_found' }); return true }
    }
    if (body.decision === 'approve') {
      const row = getSpawn(db, body.id)
      if (!row || row.user_id !== who.userId) { json(res, 404, { error: 'not_found' }); return true }
      if (row.state !== 'awaiting_user') { json(res, 409, { error: 'conflict' }); return true }
      if (isUserOnlySpawn(db, who.userId, row)) return forbidden(res, 'user_only')
      if (deviceState({ db, hub, waker }, who.userId, row.target_device_id) === 'offline') {
        json(res, 409, { error: 'conflict', detail: 'target_offline' }); return true
      }
      const ask = spawnAsk(db, who, body, row)
      const verdict = await verifyOwnAsk(ctx, { who, convoId: body.convo_id, reason, ask })
      if (!approvalAllowed(ctx, res, who, ask, verdict, decidedBy)) return true
    }
    const r = answerSpawnAsk(ctx, { userId: who.userId, requestId: body.id, decision: body.decision, decidedBy })
    json(res, r.status, r.body); return true
  }
  const key = parseChatAskId(body.id)
  if (!key) { json(res, 400, { error: 'bad_request' }); return true }
  if (ordinary && chatAskInvolvesPrivate(db, who.userId, key.roomId, key.targetDeviceId)) { json(res, 404, { error: 'not_found' }); return true }
  if (body.decision === 'approve') {
    if (isUserOnlyChat(db, who.userId, key.roomId, key.targetDeviceId)) return forbidden(res, 'user_only')
    const ask = chatAsk(db, who, body, key)
    const verdict = ask ? await verifyOwnAsk(ctx, { who, convoId: body.convo_id, reason, ask }) : null
    if (!approvalAllowed(ctx, res, who, ask, verdict, decidedBy)) return true
  }
  const r = answerChatAsk(ctx, { userId: who.userId, roomId: key.roomId, targetDeviceId: key.targetDeviceId, decision: body.decision, decidedBy })
  json(res, r.status, r.body)
  return true
}

// The last checks on an approval, run synchronously right before the
// answer writes anything: for the Coordinator's own ask (or one it had
// another session make) the verdict of
// verifyOwnAsk (src/consent-own-ask.js) and its re-checks after the wait,
// its root landing on decidedBy for the decision row; then the daily cap
// (0 = unlimited, MATRON_COORDINATOR_CONSENT_DAILY_CAP=0). `ask` is null
// for a chat ask that is not awaiting — the answer path gives its own
// 404 / 409 then. → false once a refusal is sent.
function approvalAllowed(ctx, res, who, ask, verdict, decidedBy) {
  if (verdict) {
    const refused = verdict.ok ? confirmOwnAsk(ctx, { who, ask, verdict }) : verdict
    if (refused) { json(res, refused.status, refused.body); return false }
    Object.assign(decidedBy, verdict.cause)
  }
  const cap = Number.isInteger(ctx.consentDailyCap) && ctx.consentDailyCap >= 0 ? ctx.consentDailyCap : CONSENT_DAILY_CAP_DEFAULT
  if (cap > 0 && coordinatorApprovalsSince(ctx.db, who.userId, Date.now() - CONSENT_DAILY_WINDOW_MS) >= cap) {
    json(res, 409, { error: 'conflict', detail: 'daily_cap', cap }); return false
  }
  return true
}
