// The Coordinator's own asks. An ask the Coordinator made itself — a spawn
// asked for from its own conversation, a chat it opened from it — is not
// its to approve on its own say-so: an injected turn could otherwise ask
// for anything and wave it through. POST /consent/answer approves one only
// when the ask's causes resolve (src/ask-cause.js) to a root the journal
// can vouch for:
//  - the user's words, or a reply or tap of theirs on one of the asking
//    conversation's items: approved as any other ask;
//  - a fire of one of the user's routines: only inside that routine's
//    envelope (spawns per fire, chats, boxes), only when the verifier
//    (src/verifier.js) finds the ask within the routine's remit and not
//    injected, and only under the rolling 24 h routine cap.
// Every check is a read; nothing is written until all of them pass.
// Declines are never gated and never come here.
import { resolveAskCause } from './ask-cause.js'
import { parseCauses } from './ask-causes.js'
import { getParticipant } from './participants.js'
import {
  approvalsForFire, coordinatorRoutineApprovalsSince, CONSENT_ROUTINE_CAP_DEFAULT, CONSENT_DAILY_WINDOW_MS,
} from './consent.js'

// The asking conversation is the Coordinator's: a spawn asked for from it,
// or a chat ask made from it (a bridge that predates from_convo_id names
// none, and then the asking box being the Coordinator's decides).
export function isOwnAsk(who, body, row) {
  if (body.kind === 'spawn') return row.from_convo_id === body.convo_id
  return row.initiator_convo_id === body.convo_id || (row.initiator_convo_id == null && row.initiator_device_id === who.deviceId)
}

const deviceName = (db, userId, deviceId) =>
  (Number.isInteger(deviceId) ? db.prepare('SELECT name FROM devices WHERE id=? AND user_id=?').get(deviceId, userId)?.name : null) ?? ''

// The ask as the gate needs it: whether it is the Coordinator's own, its
// causes and time, the box it reaches, and the fields the verifier judges.
export function spawnAsk(db, who, body, row) {
  const targetBox = deviceName(db, who.userId, row.target_device_id)
  return {
    kind: 'spawn', own: isOwnAsk(who, body, row), causes: row.causes, createdAt: row.created_at, targetBox,
    verifier: { kind: 'spawn', task: row.task, target_box: targetBox, workdir: row.workdir, topic: row.topic || '' },
  }
}

// A chat ask still awaiting the user in one of the user's rooms, or null —
// the answer path then gives its own 404 / 409. The box it reaches is the
// invitee, or for a join the room's owner.
export function chatAsk(db, who, body, { roomId, targetDeviceId }) {
  const room = db.prepare('SELECT owner_user_id, agent_device_id FROM conversations WHERE id=?').get(roomId)
  if (!room || room.owner_user_id !== who.userId) return null
  const row = getParticipant(db, roomId, targetDeviceId)
  if (!row || row.state !== 'awaiting_user') return null
  const isJoin = row.initiator_device_id === targetDeviceId
  const targetBox = deviceName(db, who.userId, isJoin ? room.agent_device_id : targetDeviceId)
  return {
    kind: 'chat', own: isOwnAsk(who, body, row), causes: row.causes, createdAt: row.created_at, targetBox,
    verifier: { kind: 'chat', justification: row.justification, target_box: targetBox, topic: row.topic || '' },
  }
}

const refusal = (status, detail, extra) => ({
  ok: false, status, body: { error: status === 403 ? 'forbidden' : 'conflict', detail, ...extra },
})

// → why the ask falls outside the fire's envelope, or null.
function outsideEnvelope(db, userId, root, ask) {
  const env = root.routine.envelope
  if (!env) return `the routine "${root.routine.name}" has no envelope`
  if (ask.kind === 'chat' && !env.chats) return `the routine "${root.routine.name}" may not open chats`
  if (ask.kind === 'spawn' && approvalsForFire(db, userId, root.ref, 'spawn') >= env.spawns_per_fire) {
    return `the routine "${root.routine.name}" may start ${env.spawns_per_fire} spawn(s) per fire, and this fire has used them`
  }
  if (env.boxes && !env.boxes.includes(ask.targetBox)) return `the routine "${root.routine.name}" may not reach the box "${ask.targetBox}"`
  return null
}

async function askVerifier(verifier, args) {
  if (!verifier?.verify) return { ok: false, reason: 'disabled' }
  try {
    return (await verifier.verify(args)) ?? { ok: false, reason: 'error' }
  } catch {
    return { ok: false, reason: 'error' }
  }
}

// → { ok: true, cause: {causeKind, causeRef, verifierNote?} } to go ahead,
//   or { ok: false, status, body } to refuse, in the documented order:
//   own_ask_unverified, envelope, verifier_unavailable / verifier,
//   routine_cap. `who` is the route's authenticated caller.
export async function checkOwnAsk(ctx, { who, convoId, reason, ask }) {
  const { db } = ctx
  const res = resolveAskCause(db, { who, userId: who.userId, causes: parseCauses(ask.causes), createdAt: ask.createdAt, fromConvoId: convoId })
  if (!res.ok) return refusal(403, 'own_ask_unverified', { why: res.why })
  const { root } = res
  if (root.kind !== 'routine') return { ok: true, cause: { causeKind: root.kind, causeRef: root.ref } }
  const outside = outsideEnvelope(db, who.userId, root, ask)
  if (outside) return refusal(403, 'envelope', { why: outside })
  const { name, title, prompt } = root.routine
  const verdict = await askVerifier(ctx.verifier, { routine: { name, title, prompt }, ask: ask.verifier, reason })
  if (!verdict.ok) {
    const why = verdict.reason === 'disabled' ? 'no verifier is configured' : `the verifier could not answer${verdict.note ? ` (${verdict.note})` : ''}`
    return refusal(409, 'verifier_unavailable', { why })
  }
  if (!verdict.approve) return refusal(403, 'verifier', { why: verdict.note || 'the verifier refused the ask' })
  // Again: another approval of the same fire may have landed while the
  // verifier was answering. From here to the decision row nothing awaits.
  const late = outsideEnvelope(db, who.userId, root, ask)
  if (late) return refusal(403, 'envelope', { why: late })
  const cap = Number.isInteger(ctx.consentRoutineCap) && ctx.consentRoutineCap >= 0 ? ctx.consentRoutineCap : CONSENT_ROUTINE_CAP_DEFAULT
  if (cap > 0 && coordinatorRoutineApprovalsSince(db, who.userId, Date.now() - CONSENT_DAILY_WINDOW_MS) >= cap) {
    return refusal(409, 'routine_cap', { cap })
  }
  return { ok: true, cause: { causeKind: 'routine', causeRef: root.ref, verifierNote: verdict.note ?? '' } }
}
