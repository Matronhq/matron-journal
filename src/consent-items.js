// Consent asks mirrored into the task & decision tracker (spec:
// docs/superpowers/specs/2026-09-22-consent-items-design.md). The consent
// card lives in one conversation's timeline and is easy to lose; the
// Decisions list is where the user looks for things needing an answer. So
// every parked spawn ask also files a `question` item on the parent
// conversation, and the spawn's terminal outcome closes it — the item is
// a MIRROR of the spawn row, never a second source of truth: answering
// still happens on the card (POST /agent-spawn/answer), and the row's
// state machine decides what the item says.
//
// The pure half (fields, closing text) is here; the two side-effecting
// halves (file, close) live below and are best-effort by contract: the
// consent flow must never fail because the tracker did.
import { createItem, closeItem, TITLE_MAX } from './items.js'
import { emitMarker } from './items-http.js'
import { sanitizePeerText, PEER_NAME_CAP } from './peer-text.js'

export const CONSENT_LABEL = 'consent'
// Titles are capped at TITLE_MAX; the box name (PEER_NAME_CAP) plus the
// prefix leaves room for a short topic or the head of the task.
const TITLE_TAIL_MAX = 100

export const consentLink = (kind, id) => `matron://consent/${kind}/${id}`

const cut = (s, n) => (s.length > n ? `${s.slice(0, n - 1)}…` : s)
// Peer text lands inside markdown of the journal's own voice: a backtick in
// a workdir would close the code span and let the rest render as markup.
const codeSpan = (s) => `\`${String(s).replace(/`/g, '')}\``

// The item's writable fields, from the consent card's payload (already
// sanitised at the ws boundary: single-line, capped peer text).
export function spawnConsentItemFields(card) {
  const tail = card.topic || cut(card.task, TITLE_TAIL_MAX)
  const title = cut(`Approve spawn on ${card.target_name} — ${tail}`, TITLE_MAX)
  const lines = [
    `**${card.from_name}** asks to start a new agent session on **${card.target_name}**.`,
    '',
    `- **Box:** ${card.target_name}`,
    `- **Directory:** ${codeSpan(card.workdir)}`,
    ...(card.model ? [`- **Model:** ${codeSpan(card.model)}`] : []),
    ...(card.link ? [`- **Chat room back to ${card.from_name}:** yes — approving also opens a room between the two sessions.`] : []),
    '',
    '**Task the new session will be given, verbatim:**',
    '',
    `> ${card.task}`,
    '',
    `**To answer:** open the conversation "${card.from_convo_title}" and tap **Approve** or **Decline** on the spawn card there. Unanswered, the request expires 24 h after it was made.`,
  ]
  return {
    title,
    body: lines.join('\n'),
    labels: [CONSENT_LABEL],
    links: [{ url: consentLink('spawn', card.request_id), title: `Spawn request ${card.request_id}` }],
  }
}

// How each terminal spawn outcome closes the item (item #162: approve and
// deny are the user's decision; expiry and failure are the ask lapsing).
// `author` is who the closing status row is attributed to — the user for
// the two outcomes only a tap produces, the asking agent otherwise.
export function spawnConsentClosing({ outcome, errorCode, roomId }, { targetName, link = false }) {
  switch (outcome) {
    case 'started':
      return {
        resolution: 'decided', author: 'user',
        comment: `Approved — the session started on ${targetName}.${link && roomId ? ` A chat room between the two sessions was opened.` : ''}`,
      }
    case 'declined':
      return { resolution: 'decided', author: 'user', comment: 'Declined.' }
    case 'expired':
      return { resolution: 'cancelled', author: 'agent', comment: 'Expired — no answer within 24 h.' }
    default:
      return {
        resolution: 'cancelled', author: 'agent',
        comment: `Approved, but the session could not be started (${errorCode || 'unknown'}).`,
      }
  }
}

// The item's markers never push and never wake: the consent card already
// rang the pocket for the ask (permission_request is an attention push),
// and the parent bridge already hears the resolution as a spawn_outcome.
// They are written under the ASKING agent's device — the same sender as
// the card — never as a user:* event, which is what a bridge turns into a
// session turn.
const quietPush = { onAppend() {} }
const agentWho = (db, userId, deviceId) => {
  const name = db.prepare('SELECT name FROM devices WHERE id=?').get(deviceId)?.name
  return name ? { kind: 'agent', userId, deviceId, name } : null
}

// File the mirror of a freshly parked spawn ask. Best-effort by contract —
// the card is already journaled and the row parked, so a tracker failure
// is logged and the ask proceeds without an item (the row's item_id stays
// NULL and every outcome path tolerates that). `card` is the consent
// card's payload, already sanitised. Returns the item, or null.
export function fileSpawnConsentItem({ db, hub }, { userId, fromDeviceId, fromConvoId, spawnId, card }) {
  try {
    const fields = spawnConsentItemFields(card)
    const { item } = createItem(db, {
      userId, kind: 'question', ...fields, awaiting: 'user',
      // A time-limited ask belongs at the top of the list, not under
      // everything the user has been putting off.
      position: 'top',
      originConvoId: fromConvoId, originDeviceId: fromDeviceId, createdBy: 'agent',
      // Namespaced apart from HTTP idempotency keys, which are always
      // `<device id>:<key>` (http-who.js idemKeyOf).
      idemKey: `consent:spawn:${spawnId}`,
    })
    db.prepare('UPDATE agent_spawn_requests SET item_id=? WHERE id=? AND item_id IS NULL').run(item.id, spawnId)
    const who = agentWho(db, userId, fromDeviceId)
    if (who) emitMarker({ db, hub, pushPipeline: quietPush, waker: null }, who, { item, action: 'created', by: 'agent', fallback: false })
    return item
  } catch (err) {
    console.error('consent item: filing failed (the card and the spawn row stand)', err)
    return null
  }
}

// Close the mirror from the spawn's terminal outcome. Called from
// emitSpawnOutcome, so every path that resolves a row — answer route,
// orchestration, both sweeps — keeps the item honest without knowing about
// it. `answeredByDeviceId` is the client device whose tap resolved the row
// (deny/approve routes); absent for the sweeps. An item the user already
// closed by hand is left as they left it (closeItem returns null). Never
// throws — telling the parent is the caller's one job and must not be
// blocked by the tracker.
export function closeSpawnConsentItem({ db, hub }, row, { outcome, errorCode, roomId, answeredByDeviceId = null }) {
  if (!row || !row.item_id) return false
  try {
    const targetName = sanitizePeerText(db.prepare('SELECT name FROM devices WHERE id=?').get(row.target_device_id)?.name, PEER_NAME_CAP)
      || `box ${row.target_device_id}`
    const c = spawnConsentClosing({ outcome, errorCode, roomId }, { targetName, link: !!row.link })
    const deviceId = c.author === 'user' && answeredByDeviceId != null ? answeredByDeviceId : row.from_device_id
    const out = closeItem(db, { userId: row.user_id, itemId: row.item_id, resolution: c.resolution, author: c.author, deviceId, comment: c.comment })
    if (!out) return false
    const who = agentWho(db, row.user_id, row.from_device_id)
    if (who) emitMarker({ db, hub, pushPipeline: quietPush, waker: null }, who, { item: out.item, action: 'closed', comment: out.comment, by: c.author, fallback: false })
    return true
  } catch (err) {
    console.error('consent item: close failed (the spawn outcome stands)', err)
    return false
  }
}
