// Memory proposals: the side of a memory write that waits for the user
// (docs/protocol.md "Memory proposals"). src/memory-proposals.js holds the
// rows; this file decides which agent writes need the user's answer, files
// the question, acts on the user's tap, and tells the proposing session how
// it ended.
//
// Which writes wait (needsUserAnswer):
//  - an agent on a user-only or protected device (src/consent.js
//    userOnlyDevice): always;
//  - any other agent: unless the turn that made the write was started by the
//    user in that agent's own conversation — words they typed or spoke
//    there, or their comment or tap on an item it owns — and recently. The
//    bridge sends the turn's causes with the write and they are resolved by
//    the journal's own record (src/ask-cause.js), never taken on trust;
//  - the user's own apps: never.
//
// The question is a consent mirror (items.js isConsentMirror, consent
// 'memory'): an ordinary `question` item awaiting the user, with two buttons,
// that no agent — the proposing one and the Coordinator included — can read,
// edit, close or tap. Its body is rendered from the stored proposal and an
// approval applies that same row, so what the user reads is what is saved.
// The proposed text is the agent's: it is shown inside fenced blocks, never
// as part of the sentences around it.
//
// Every outcome is told to the proposing conversation by a `memory_proposal`
// event, sender `journal` (a sender no device can publish under): its bridge
// turns that into a turn for the agent.
import { appendAndBroadcast, toEventShape } from './journal.js'
import { json } from './http-body.js'
import { senderOf, conflict } from './http-who.js'
import { createItem, updateItem, closeItem, addComment, getItem, TITLE_MAX } from './items.js'
import { itemMarkerPayload, ITEM_EVENT_TYPE } from './items-marker.js'
import { CONSENT_LABEL, fenced } from './consent-items.js'
import { userOnlyDevice } from './consent.js'
import { getCoordinatorConvoId } from './coordinator.js'
import { ensurePeopleConvo, PEOPLE_TITLE, PEOPLE_SYSTEM } from './people-convo.js'
import { sanitizePeerText, plainText as plain, PEER_NAME_CAP } from './peer-text.js'
import { resolveAskCause } from './ask-cause.js'
import { getMemory, upsertMemory, deleteMemory, DEFAULT_SCOPE, DEFAULT_TYPE } from './memories.js'
import { emitMemoryMarker } from './memories-http.js'
import {
  recordProposal, setProposalItem, settleProposal, expireProposals, pruneProposals, proposalOfItem, labelsFor,
} from './memory-proposals.js'

export const MEMORY_CONSENT = 'memory'
export const MEMORY_PROPOSAL_EVENT_TYPE = 'memory_proposal'
// How old the user's words (or their comment or tap) may be for an agent's
// write to apply directly: a save follows what the user said closely.
export const MEMORY_DIRECT_WINDOW_MS = 30 * 60 * 1000
const JOURNAL = 'journal'
const TITLE_CAP = 120

const safely = (what, fn) => { try { return fn() } catch (err) { console.error(`memory proposal: ${what} failed (the proposal stands)`, err); return null } }
const t = (s, n = TITLE_CAP) => plain(sanitizePeerText(s ?? '', n))

// → null when the write may apply now, else why it waits for the user.
// `causes` is the normalised list from the request (null = none sent),
// `convoId` the conversation the write names (null = none).
export function needsUserAnswer(db, who, { convoId, causes, now = Date.now() }) {
  if (who.kind !== 'agent') return null
  if (userOnlyDevice(db, who.userId, who.deviceId)) return 'this box takes changes only on the user\'s own say'
  if (!convoId) return 'the write names no conversation'
  // A spawn outcome stands for the turn that asked for the spawn, which may
  // be long over: it does not carry the user's words to a memory.
  if (Array.isArray(causes) && causes.some((c) => c.kind === 'spawn_outcome')) return 'started by spawn_outcome'
  const r = resolveAskCause(db, { who, userId: who.userId, causes, createdAt: now, fromConvoId: convoId })
  if (!r.ok) return r.why
  if (r.root.kind !== 'user' && r.root.kind !== 'item') return `started by a ${r.root.kind}`
  if (r.root.at < now - MEMORY_DIRECT_WINDOW_MS) return 'the user\'s input is older than 30 minutes'
  return null
}

// --- The item ----------------------------------------------------------------

// A memory's text is many lines, and consent-items.js `fenced` holds only
// a single line safely (a fence closes on a line of its own). So before the
// text goes in the fence: line separators other than \n become \n, other
// control characters are dropped, and a line that itself starts with a fence
// gets a zero-width space in front. The fence is still longer than any run
// in the text; the last step covers a renderer that closes on any fence.
export function fencedBlock(text) {
  return fenced(String(text ?? '')
    .replace(/\r\n?|[\u2028\u2029\u0085\u000b\u000c]/g, '\n')
    .replace(/[\u0000-\u0009\u000e-\u001f\u007f-\u009f]/g, '')
    .replace(/^(\s*)(`{3,}|~{3,})/gm, '$1\u200b$2'))
}

const boxName = (db, userId, deviceId) => db.prepare('SELECT name FROM devices WHERE id=? AND user_id=?').get(deviceId, userId)?.name ?? 'an agent'
const convoTitle = (db, userId, convoId) => (convoId ? db.prepare('SELECT title FROM conversations WHERE id=? AND owner_user_id=?').get(convoId, userId)?.title ?? '' : '')

// Title, body and buttons of the question, from the proposal row and the
// memory as it stands now.
export function proposalItemFields(db, p) {
  const box = t(boxName(db, p.user_id, p.from_device_id), PEER_NAME_CAP)
  const title = t(convoTitle(db, p.user_id, p.from_convo_id))
  const where = p.from_convo_id ? `, from the conversation "${title || 'untitled'}"` : ''
  const current = getMemory(db, p.user_id, p.memory_id ?? p.name)
  const [yes, no] = labelsFor(p.action)
  const lines = []
  if (p.action === 'delete') {
    lines.push(`**${box}** proposes to delete a memory${where}.`, '')
    lines.push(`- **Name:** \`${p.name}\``)
    if (current) {
      lines.push(`- **Scope:** ${current.scope}`, `- **Type:** ${current.type}`, '', '**The memory as it stands — description:**', '', fencedBlock(current.description), '', '**Body:**', '', fencedBlock(current.body || '(empty)'))
    } else {
      lines.push('', 'That memory no longer exists.')
    }
    lines.push('', `**To answer:** tap **${yes}** to delete it, or **${no}**. Nothing is deleted unless you approve. Unanswered, the proposal lapses after 7 days.`)
  } else {
    lines.push(`**${box}** proposes to ${current ? 'change' : 'save'} a memory${where}.`, '')
    lines.push(`- **Name:** \`${p.name}\``)
    lines.push(`- **Scope:** ${p.scope ?? current?.scope ?? DEFAULT_SCOPE}${current && p.scope && p.scope !== current.scope ? ` (now ${current.scope})` : ''}`)
    lines.push(`- **Type:** ${p.type ?? current?.type ?? DEFAULT_TYPE}${current && p.type && p.type !== current.type ? ` (now ${current.type})` : ''}`)
    lines.push('', '**Proposed description:**', '', fencedBlock(p.description))
    if (current) lines.push('', '**Current description:**', '', fencedBlock(current.description))
    lines.push('', '**Proposed body:**', '', fencedBlock(p.body || '(empty)'))
    lines.push('', `**To answer:** tap **${yes}** to ${current ? 'replace the memory with this' : 'save it as shown'}, or **${no}**. Nothing is saved unless you approve. Unanswered, the proposal lapses after 7 days.`)
  }
  const head = p.action === 'delete' ? `Delete the memory "${p.name}"?` : `${current ? 'Change' : 'Save'} the memory "${p.name}"?`
  return { title: `${head} — proposed by ${box}`.slice(0, TITLE_MAX), body: lines.join('\n'), actions: [yes, no] }
}

// Where the question lives: the proposing conversation, else the user's
// Coordinator conversation, else their People conversation.
function homeConvo({ db, hub }, userId, convoId) {
  if (convoId) return convoId
  const coord = getCoordinatorConvoId(db, userId)
  if (coord) return coord
  const { id, created } = ensurePeopleConvo(db, userId)
  if (created) {
    safely('people convo announce', () => appendAndBroadcast(db, hub, {
      userId, convoId: id, sender: JOURNAL, type: 'convo_meta', payload: { title: PEOPLE_TITLE, parent_convo_id: null, system: PEOPLE_SYSTEM },
    }))
  }
  return id
}

// An item marker for the mirror: client-only (it carries `consent`). A new
// or changed question also pushes, as an item an agent files for the user
// does — there is no card beside it to do that.
function itemMarker({ db, hub, pushPipeline }, { userId, sender, item, action, by, comment = null, push = false }) {
  safely('item marker', () => {
    const payload = itemMarkerPayload({ item, action, by, comment, extra: { consent: MEMORY_CONSENT } })
    const r = appendAndBroadcast(db, hub, { userId, convoId: item.origin_convo_id, sender, type: ITEM_EVENT_TYPE, payload })
    if (push && pushPipeline && !r.duplicate) {
      safely('push', () => pushPipeline.onAppend(userId, toEventShape({ seq: r.seq, convo_id: item.origin_convo_id, ts: r.ts, sender, type: ITEM_EVENT_TYPE, payload }), null))
    }
  })
}

// What the proposing conversation hears. `outcome`: approved | declined |
// replaced | expired. Nothing of the memory's text travels: the name only.
function tellProposer({ db, hub }, p, outcome, item) {
  if (!p.from_convo_id) return
  safely('outcome event', () => appendAndBroadcast(db, hub, {
    userId: p.user_id, convoId: p.from_convo_id, sender: JOURNAL, type: MEMORY_PROPOSAL_EVENT_TYPE,
    payload: { proposal_id: p.id, name: p.name, action: p.action, outcome, item: item ? { id: item.id, num: item.num } : null },
  }))
}

function closeMirror(ctx, p, { resolution, author, deviceId = 0, comment, sender = JOURNAL }) {
  if (!p.item_id) return null
  return safely('item close', () => {
    const out = closeItem(ctx.db, { userId: p.user_id, itemId: p.item_id, resolution, author, deviceId, comment })
    if (out) itemMarker(ctx, { userId: p.user_id, sender, item: out.item, action: 'closed', by: author, comment: out.comment })
    return out
  })
}

const view = (p) => ({ id: p.id, name: p.name, action: p.action, state: p.state, expires_at: p.expires_at })

// Record an agent's write as a proposal and put the question in front of the
// user. The proposal and its item are one write; the markers follow it.
// → { proposal, item }.
export function fileProposal(ctx, who, { name, action, fields, memoryId = null, convoId = null }) {
  const { db } = ctx
  const userId = who.userId
  const sender = senderOf(db, who)
  const out = db.transaction(() => {
    const r = recordProposal(db, { userId, name, action, fields, memoryId, fromDeviceId: who.deviceId, fromConvoId: convoId })
    const f = proposalItemFields(db, r.proposal)
    let item
    let note = null
    if (r.inPlace) {
      item = updateItem(db, { userId, itemId: r.proposal.item_id, fields: { title: f.title, body: f.body, actions: f.actions, awaiting: 'user' } })
      note = addComment(db, { userId, itemId: item.id, author: 'agent', deviceId: 0, body: 'The proposal changed: the item now shows the newer one.', keepStatus: true })?.comment ?? null
      item = getItem(db, userId, item.id)
    } else {
      item = createItem(db, {
        userId, kind: 'question', title: f.title, body: f.body, labels: [CONSENT_LABEL], actions: f.actions,
        awaiting: 'user', position: 'top', originConvoId: homeConvo(ctx, userId, convoId), originDeviceId: who.deviceId, createdBy: 'agent', consent: MEMORY_CONSENT,
      }).item
      setProposalItem(db, r.proposal.id, item.id)
    }
    return { ...r, proposal: { ...r.proposal, item_id: item.id }, item, note }
  })()
  if (out.replaced) {
    const closed = closeMirror(ctx, out.replaced, { resolution: 'cancelled', author: 'agent', comment: 'Set aside: a newer proposal for this memory took its place. Nothing was changed.' })
    tellProposer(ctx, out.replaced, 'replaced', closed?.item ?? null)
  }
  itemMarker(ctx, { userId, sender, item: out.item, action: out.inPlace ? 'commented' : 'created', by: 'agent', comment: out.note, push: true })
  return { proposal: out.proposal, item: out.item }
}

// The 202 an agent's parked write is answered with.
export function answerPending(res, { proposal, item }) {
  json(res, 202, { pending: 'owner', proposal: view(proposal), item: { id: item.id, num: item.num } })
  return true
}

// --- The user's answer -------------------------------------------------------

// Apply an approved proposal as a direct write would have: the memory records
// the proposing conversation and device as its origin and the agent as its
// author; the marker says the user decided it.
// → { line, marker }: the thread line, and the marker to emit once the
// write has committed (null when there was nothing left to delete).
function applyProposal(db, p) {
  const extra = { proposal: { id: p.id, proposed_by: 'agent' } }
  if (p.action === 'delete') {
    const gone = p.memory_id ? deleteMemory(db, p.user_id, p.memory_id) : null
    return gone
      ? { line: 'Deleted.', marker: { memory: gone, action: 'deleted', created: false, writerConvoId: p.from_convo_id, extra } }
      : { line: 'That memory was already gone; nothing to delete.', marker: null }
  }
  const out = upsertMemory(db, {
    userId: p.user_id, name: p.name, description: p.description, body: p.body, type: p.type ?? undefined, scope: p.scope ?? undefined,
    originConvoId: p.from_convo_id, originDeviceId: p.from_device_id, by: 'agent',
  })
  return {
    line: out.created ? 'Saved.' : 'Saved: the memory now reads as proposed.',
    marker: { memory: out.memory, action: 'saved', created: out.created, writerConvoId: p.from_convo_id, extra },
  }
}

// A tap on a memory proposal's item (POST /items/:id/comments {action}) IS
// the answer. Client only: items-http refuses an agent's `action` before it
// gets here, and no agent can see the item at all.
export function handleMemoryProposalTap(ctx, res, who, item, action, replyTo = null) {
  const { db } = ctx
  if (who.kind === 'agent') { json(res, 403, { error: 'forbidden' }); return true }
  if (replyTo != null || !item.actions.includes(action)) { json(res, 400, { error: 'unknown_action' }); return true }
  const p = proposalOfItem(db, who.userId, item.id)
  if (!p || p.state !== 'pending' || item.state !== 'open') return conflict(res)
  const approve = action === labelsFor(p.action)[0]
  let settled
  let applied = null
  try {
    db.transaction(() => {
      settled = settleProposal(db, { userId: who.userId, id: p.id, state: approve ? 'approved' : 'declined' })
      if (settled && approve) applied = applyProposal(db, settled)
    })()
  } catch (err) {
    // At the cap: the proposal stays for the user to answer once there is room.
    if (err?.message === 'too_many') { json(res, 409, { error: 'too_many' }); return true }
    throw err
  }
  if (!settled) return conflict(res)
  if (applied?.marker) emitMemoryMarker(ctx, who, applied.marker)
  const closed = closeMirror(ctx, settled, {
    resolution: 'decided', author: 'user', deviceId: who.deviceId, sender: senderOf(db, who),
    comment: approve ? applied.line : (settled.action === 'delete' ? 'Kept: the memory was not deleted.' : 'Declined: nothing was saved.'),
  })
  tellProposer(ctx, settled, approve ? 'approved' : 'declined', closed?.item ?? item)
  json(res, 200, { item: closed?.item ?? getItem(db, who.userId, item.id) ?? item, comment: closed?.comment ?? null, proposal: view(settled) })
  return true
}

// The user closed the question by hand: that is a "no". Called by the close
// route after its own write; never throws.
export function declineOnClose(ctx, userId, item) {
  if (item?.consent !== MEMORY_CONSENT) return
  safely('decline on close', () => {
    const p = proposalOfItem(ctx.db, userId, item.id)
    if (!p || p.state !== 'pending') return
    const settled = settleProposal(ctx.db, { userId: p.user_id, id: p.id, state: 'declined' })
    if (settled) tellProposer(ctx, settled, 'declined', item)
  })
}

// Does this memory mirror live on the conversation that proposed it? Then the
// user's typed reply on it reaches that agent as a turn (items-http.js
// replyReachesAsker), which is how they say "word it differently".
export function proposerOwnsMirror(db, item) {
  const p = db.prepare('SELECT from_convo_id FROM memory_proposals WHERE item_id=? ORDER BY created_at DESC LIMIT 1').get(item.id)
  return !!p && p.from_convo_id != null && p.from_convo_id === item.origin_convo_id
}

// The sweep's half (src/ws.js): proposals nobody answered in 7 days.
export function sweepMemoryProposals(ctx, now = Date.now()) {
  for (const p of expireProposals(ctx.db, now)) {
    const closed = closeMirror(ctx, p, { resolution: 'cancelled', author: 'agent', comment: 'Lapsed: no answer within 7 days. Nothing was changed.' })
    tellProposer(ctx, p, 'expired', closed?.item ?? null)
  }
  pruneProposals(ctx.db, now)
}
