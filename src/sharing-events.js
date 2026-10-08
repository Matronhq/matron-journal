// Side effects of contacts and grants (spec 2026-10-02 matron-to-matron
// sharing, phase 1): the consent cards, their tracker mirrors, the audit
// events and the live frames. src/contacts.js and src/grants.js decide what
// happened; every function here is called AFTER their transaction committed
// and is best-effort by contract — a card or an audit line that fails to
// write is logged, and the contact or grant stands.
//
// Three rules hold for everything written here:
//   1. Nothing reaches an agent. The cards and the audit events are
//      client-only (isClientOnlyEvent), the mirrors' markers carry
//      `consent`, and the People conversation has no agent at all. A card
//      that comes from another person — or sends data to one — is answered
//      by a tap on the user's own device; the Coordinator is an agent and
//      never hears of it.
//   2. Each user's log gets its own copy. One transition writes one audit
//      event into EACH side's People conversation, in that side's words.
//   3. Another person's words are peer text: single-line, capped, and
//      stripped of markdown before they sit in a sentence of the journal's.
import { appendAndBroadcast, toEventShape, PEOPLE_EVENT_TYPE } from './journal.js'
import { createItem, closeItem, TITLE_MAX } from './items.js'
import { itemMarkerPayload, ITEM_EVENT_TYPE } from './items-marker.js'
import { sanitizePeerText, plainText as plain } from './peer-text.js'
import { ensurePeopleConvo, PEOPLE_TITLE, PEOPLE_SYSTEM } from './people-convo.js'
import { setContactItem, peerRowOf } from './contacts.js'
import { setGrantItem, sharePreview, activeGranteeIds } from './grants.js'
import { CONSENT_LABEL, consentLink } from './consent-items.js'

export const CONTACT_CARD_KIND = 'contact_request'
export const SHARE_CARD_KIND = 'mission_share'
export const OWNER_ACTIONS = ['Approve', 'Decline']
export const PEER_ACTIONS = ['Accept', 'Decline']
const JOURNAL = 'journal'
const MISSION_TITLE_CAP = 120

const cut = (s, n) => (s.length > n ? `${s.slice(0, n - 1)}…` : s)
const safely = (what, fn) => { try { return fn() } catch (err) { console.error(`sharing: ${what} failed (the contact or grant stands)`, err); return null } }
// The four asks below run after the contact or grant has committed. Reaching
// the user (the People conversation, the preview, the card, its mirror) must
// never fail the request that made the row: a failure is logged and the row
// stands, still listed by GET /contacts and GET /grants.
const asking = (what, fn) => (...args) => { safely(what, () => fn(...args)) }
const userName = (db, id) => db.prepare('SELECT name FROM users WHERE id=?').get(id)?.name ?? `user ${id}`
const deviceName = (db, id) => db.prepare('SELECT name FROM devices WHERE id=?').get(id)?.name ?? null
const addressOf = (row) => (row.peer_journal ? `${row.peer_user}@${row.peer_journal}` : row.peer_user)
const titleOf = (t) => plain(sanitizePeerText(t, MISSION_TITLE_CAP))

// The user's People conversation, announced to connected clients the first
// time it exists (a client lists a conversation from its convo_meta).
export function peopleConvo({ db, hub }, userId) {
  const { id, created } = ensurePeopleConvo(db, userId)
  if (created) {
    safely('people convo announce', () => appendAndBroadcast(db, hub, {
      userId, convoId: id, sender: JOURNAL, type: 'convo_meta', payload: { title: PEOPLE_TITLE, parent_convo_id: null, system: PEOPLE_SYSTEM },
    }))
  }
  return id
}

// A card. `push`: the recipient's pocket rings for a card from another
// person (permission_request is an attention push); the asking side's own
// card rings too, like a spawn card. No sender device: nothing is excluded.
export function card({ db, hub, pushPipeline }, { userId, convoId, sender, payload }) {
  return safely('card', () => {
    const r = appendAndBroadcast(db, hub, { userId, convoId, sender, type: 'permission_request', payload })
    if (!r.duplicate && pushPipeline) {
      safely('card push', () => pushPipeline.onAppend(userId, toEventShape({ seq: r.seq, convo_id: convoId, ts: r.ts, sender, type: 'permission_request', payload }), null))
    }
    return r
  })
}

// One line of the audit trail, in the reader's own People conversation.
// `event` is `contact.<what>` or `grant.<what>`; `summary` is the sentence
// an app that knows nothing else can still show.
export function audit(ctx, userId, { event, summary, contact = null, grant = null, by = null, extra = null }) {
  const { db, hub } = ctx
  safely('audit event', () => {
    const payload = {
      event, summary,
      ...(contact ? { contact_id: contact.id, peer: { name: contact.peer_user, address: addressOf(contact) } } : {}),
      ...(grant ? {
        grant_id: grant.id, level: grant.level, subject_kind: grant.subject_kind, subject_id: grant.subject_id,
        ...(grant.mission_num != null ? { mission: { id: grant.subject_id, num: grant.mission_num, title: sanitizePeerText(grant.mission_title, MISSION_TITLE_CAP) } } : {}),
        owner: { user_id: grant.owner_user_id, name: grant.owner_name },
      } : {}),
      ...(by ? { by } : {}),
      ...(extra ?? {}),
    }
    appendAndBroadcast(db, hub, { userId, convoId: peopleConvo(ctx, userId), sender: JOURNAL, type: PEOPLE_EVENT_TYPE, payload })
  })
}

// "Something about your contacts or grants changed": the apps' cue to
// refetch GET /contacts and GET /grants. Client sockets only.
export function changed({ hub }, userId, extra = {}) {
  safely('people frame', () => hub.sendToClients(userId, { kind: 'people', event: 'changed', ...extra }))
}

// File a consent mirror. `sender` is who the marker is from — the asking
// agent for an ask it parked, the journal for a card from another person.
// The marker carries `consent`, so no agent hears of it; it never pushes
// (the card did) and never wakes anything.
export function fileMirror({ db, hub }, { userId, convoId, deviceId, sender, consent, title, body, link, actions, idemKey }) {
  return safely('consent item', () => {
    const { item, duplicate } = createItem(db, {
      userId, kind: 'question', title: cut(title, TITLE_MAX), body, labels: [CONSENT_LABEL], links: [link], actions,
      awaiting: 'user', position: 'top', originConvoId: convoId, originDeviceId: deviceId ?? 0, createdBy: 'agent', consent, idemKey,
    })
    if (!duplicate) {
      appendAndBroadcast(db, hub, {
        userId, convoId, sender, type: ITEM_EVENT_TYPE,
        payload: itemMarkerPayload({ item, action: 'created', by: 'agent', extra: { consent } }),
      })
    }
    return item
  })
}

// Close a mirror with what happened. `author` 'user' for the user's own
// tap (attributed to the tapping device), 'agent' for everything the
// journal or the other person did. An item the user closed by hand is left
// as they left it. Returns {item, comment} or null.
export function closeMirror({ db, hub }, { userId, itemId, consent, resolution, author, deviceId = 0, comment }) {
  if (!itemId) return null
  return safely('consent item close', () => {
    const out = closeItem(db, { userId, itemId, resolution, author, deviceId: deviceId ?? 0, comment })
    if (!out) return null
    appendAndBroadcast(db, hub, {
      userId, convoId: out.item.origin_convo_id, sender: author === 'user' ? `user:${userName(db, userId)}` : JOURNAL, type: ITEM_EVENT_TYPE,
      payload: itemMarkerPayload({ item: out.item, action: 'closed', by: author, comment: out.comment, extra: { consent } }),
    })
    return out
  })
}

// --- Contacts ---------------------------------------------------------------

const contactLink = (id) => ({ url: consentLink('contact', id), title: 'Contact request' })

const contactOwnerAsk = asking('contact approval card', (ctx, who, own) => {
  const peer = plain(own.peer_user)
  const box = plain(sanitizePeerText(who.name, 80))
  const payload = {
    kind: CONTACT_CARD_KIND, direction: 'out', contact_id: own.id,
    peer: { name: own.peer_user, address: addressOf(own) },
    from_device_id: who.deviceId, from_name: sanitizePeerText(who.name, 80), from_convo_id: own.origin_convo_id,
  }
  card(ctx, { userId: own.user_id, convoId: own.origin_convo_id, sender: `agent:${who.name}`, payload })
  const item = fileMirror(ctx, {
    userId: own.user_id, convoId: own.origin_convo_id, deviceId: who.deviceId, sender: `agent:${who.name}`, consent: 'contact',
    title: `Approve contact request to ${peer}`,
    body: [
      `**${box}** asks to add **${peer}**, another user on this journal, as your contact.`,
      '',
      `If you approve, ${peer} gets one card to accept or decline. Being contacts shares nothing by itself: every mission share is asked for separately, and you can remove or block a contact at any time.`,
      '',
      '**To answer:** tap **Approve** or **Decline**. Unanswered, the request expires 24 h after it was made and nothing is sent.',
    ].join('\n'),
    link: contactLink(own.id), actions: OWNER_ACTIONS, idemKey: `consent:contact:${own.id}:${own.updated_at}`,
  })
  if (item) setContactItem(ctx.db, own.id, item.id)
})

const contactPeerAsk = asking('contact request card', (ctx, peerRow) => {
  const from = plain(peerRow.peer_user)
  const convoId = peopleConvo(ctx, peerRow.user_id)
  card(ctx, {
    userId: peerRow.user_id, convoId, sender: JOURNAL,
    payload: { kind: CONTACT_CARD_KIND, direction: 'in', contact_id: peerRow.id, peer: { name: peerRow.peer_user, address: addressOf(peerRow) } },
  })
  const item = fileMirror(ctx, {
    userId: peerRow.user_id, convoId, deviceId: 0, sender: JOURNAL, consent: 'contact',
    title: `${from} wants to add you as a contact`,
    body: [
      `**${from}**, another user on this journal, asks to be your contact.`,
      '',
      'Accepting lets the two of you offer each other missions to read. Nothing is shared by accepting: every share is asked for separately, and you can remove or block a contact at any time.',
      '',
      '**To answer:** tap **Accept** or **Decline**.',
    ].join('\n'),
    link: contactLink(peerRow.id), actions: PEER_ACTIONS, idemKey: `consent:contact:${peerRow.id}:${peerRow.updated_at}`,
  })
  if (item) setContactItem(ctx.db, peerRow.id, item.id)
})

// After requestContact or answerContact. `who` is the caller (the asking
// agent, or the client that tapped); `out` is what the pure layer returned.
// Returns the closed mirror ({item, comment}) of the card the caller just
// answered, when there was one — the item-tap route answers with it.
export function onContactOutcome(ctx, who, out) {
  const own = out.contact
  const peer = plain(own.peer_user)
  const before = out.before ?? null
  const tapped = (comment, resolution = 'decided') => closeMirror(ctx, {
    userId: own.user_id, itemId: before?.item_id, consent: 'contact', resolution, author: 'user', deviceId: who.deviceId, comment,
  })
  let closed = null
  switch (out.outcome) {
    case 'parked':
      contactOwnerAsk(ctx, who, own)
      break
    case 'sent':
    case 'silent':
      closed = tapped(`Approved — the request went to ${peer}.`)
      audit(ctx, own.user_id, { event: 'contact.requested', summary: `You asked ${peer} to be your contact`, contact: own, by: own.requested_by })
      if (out.outcome === 'sent' && out.peer) {
        // Their own agent's parked ask is overtaken by this request: one
        // card for them, the accept card.
        if (out.superseded) {
          closeMirror(ctx, {
            userId: out.peer.user_id, itemId: out.superseded.item_id, consent: 'contact', resolution: 'cancelled', author: 'agent',
            comment: `${plain(out.peer.peer_user)} asked you first — answer their request instead.`,
          })
        }
        contactPeerAsk(ctx, out.peer)
        audit(ctx, out.peer.user_id, { event: 'contact.received', summary: `${plain(out.peer.peer_user)} asked to be your contact`, contact: out.peer })
        changed(ctx, out.peer.user_id, { contact_id: out.peer.id })
      }
      break
    case 'crossed':
    case 'accepted':
      closed = tapped(out.outcome === 'accepted' ? `Accepted — ${peer} is now a contact.` : `Approved — ${peer} had already asked you, so you are now contacts.`)
      audit(ctx, own.user_id, { event: 'contact.accepted', summary: `You and ${peer} are now contacts`, contact: own })
      if (out.peer) {
        audit(ctx, out.peer.user_id, { event: 'contact.accepted', summary: `You and ${plain(out.peer.peer_user)} are now contacts`, contact: out.peer })
        changed(ctx, out.peer.user_id, { contact_id: out.peer.id })
      }
      break
    case 'withdrawn':
      closed = tapped('Declined — nothing was sent.')
      break
    case 'declined':
      closed = tapped('Declined.')
      audit(ctx, own.user_id, { event: 'contact.declined', summary: `You declined ${peer}'s contact request`, contact: own })
      if (out.peer) {
        audit(ctx, out.peer.user_id, { event: 'contact.declined', summary: `${plain(out.peer.peer_user)} declined your contact request`, contact: out.peer })
        changed(ctx, out.peer.user_id, { contact_id: out.peer.id })
      }
      break
    case 'expired':
      closeMirror(ctx, { userId: own.user_id, itemId: before?.item_id, consent: 'contact', resolution: 'cancelled', author: 'agent', deviceId: before?.origin_device_id, comment: 'Expired — no answer within 24 h. Nothing was sent.' })
      break
    default: break
  }
  changed(ctx, own.user_id, { contact_id: own.id })
  return closed
}

// After removeContact / blockContact. `verb` is 'removed' or 'blocked'.
// The other person is told only that the contact ended — never that it was
// a block (spec: a block must not be an oracle).
export function onContactEnded(ctx, who, out, verb) {
  const own = out.contact
  const peer = plain(own.peer_user)
  const pendingIn = out.before.state === 'pending_in'
  const awaiting = out.before.state === 'awaiting_user'
  // A card of mine that was still open is answered by this.
  if (pendingIn || awaiting) {
    closeMirror(ctx, {
      userId: own.user_id, itemId: out.before.item_id, consent: 'contact', resolution: 'cancelled',
      author: who.kind === 'agent' ? 'agent' : 'user', deviceId: who.deviceId,
      comment: verb === 'blocked' ? `Blocked ${peer}.` : (awaiting ? 'Withdrawn — nothing was sent.' : 'Declined.'),
    })
  }
  audit(ctx, own.user_id, {
    event: `contact.${verb}`, contact: own, by: who.kind === 'agent' ? 'agent' : 'user',
    summary: verb === 'blocked' ? `You blocked ${peer}` : `You removed ${peer} from your contacts`,
  })
  if (out.peer) {
    const me = plain(out.peer.peer_user)
    // Their open accept card (we withdrew our request) closes with us.
    if (out.peerBefore.state === 'pending_in') {
      closeMirror(ctx, { userId: out.peer.user_id, itemId: out.peerBefore.item_id, consent: 'contact', resolution: 'cancelled', author: 'agent', comment: `${me} withdrew the request.` })
    }
    audit(ctx, out.peer.user_id, {
      event: 'contact.removed', contact: out.peer, by: 'peer',
      summary: out.peerBefore.state === 'active' ? `${me} is no longer your contact` : `${me}'s contact request ended`,
    })
    changed(ctx, out.peer.user_id, { contact_id: out.peer.id })
  }
  for (const g of out.revokedGrants) onGrantRevoked(ctx, g, 'contact_removed')
  changed(ctx, own.user_id, { contact_id: own.id })
}

export function onContactUnblocked(ctx, out) {
  audit(ctx, out.contact.user_id, { event: 'contact.unblocked', summary: `You unblocked ${plain(out.contact.peer_user)}`, contact: out.contact, by: 'user' })
  changed(ctx, out.contact.user_id, { contact_id: out.contact.id })
}

// --- Grants -----------------------------------------------------------------

const shareLink = (id) => ({ url: consentLink('share', id), title: 'Mission share' })
const ownerContact = (db, g) => db.prepare('SELECT * FROM contacts WHERE id=?').get(g.contact_id)

const WHAT_CROSSES = "the mission's title, description and status, its milestones as text, and its items with their comments and attachments"
const WHAT_NEVER = 'Conversation transcripts, tool output, memories, secrets and box names never cross, and anything from a private box stays hidden.'

function shareCardPayload(db, g, direction) {
  return {
    kind: SHARE_CARD_KIND, direction, grant_id: g.id, level: g.level,
    owner: { user_id: g.owner_user_id, name: g.owner_name },
    grantee: { name: g.grantee_name, address: g.grantee_journal ? `${g.grantee_name}@${g.grantee_journal}` : g.grantee_name },
    mission: { id: g.subject_id, num: g.mission_num, title: sanitizePeerText(g.mission_title, MISSION_TITLE_CAP) },
    preview: sharePreview(db, g.subject_id),
  }
}

const shareOwnerAsk = asking('share approval card', (ctx, who, g) => {
  const { db } = ctx
  const to = plain(g.grantee_name)
  const p = sharePreview(db, g.subject_id)
  card(ctx, {
    userId: g.owner_user_id, convoId: g.origin_convo_id, sender: `agent:${who.name}`,
    payload: { ...shareCardPayload(db, g, 'out'), from_device_id: who.deviceId, from_name: sanitizePeerText(who.name, 80), from_convo_id: g.origin_convo_id },
  })
  const item = fileMirror(ctx, {
    userId: g.owner_user_id, convoId: g.origin_convo_id, deviceId: who.deviceId, sender: `agent:${who.name}`, consent: 'share',
    title: `Approve sharing mission #${g.mission_num} with ${to} (read-only) — ${titleOf(g.mission_title)}`,
    body: [
      `**${plain(sanitizePeerText(who.name, 80))}** asks to share mission **#${g.mission_num} ${titleOf(g.mission_title)}** with your contact **${to}**, read-only.`,
      '',
      `- **What ${to} will be able to read:** ${WHAT_CROSSES}.`,
      `- **Right now that is:** ${p.milestones} milestone(s), ${p.items} item(s), ${p.comments} comment(s), ${p.attachments} attachment(s).`,
      `- **Live:** new milestones, items and comments appear for ${to} as they happen, until you or ${to} end the share.`,
      `- **Read-only:** ${to} cannot change anything.`,
      '',
      WHAT_NEVER,
      '',
      `**To answer:** tap **Approve** or **Decline**. If you approve, ${to} gets a card to accept. Unanswered, the request expires 24 h after it was made and nothing is shared.`,
    ].join('\n'),
    link: shareLink(g.id), actions: OWNER_ACTIONS, idemKey: `consent:share:${g.id}:owner:${g.updated_at}`,
  })
  if (item) setGrantItem(db, g.id, 'owner', item.id)
})

const shareGranteeAsk = asking('share offer card', (ctx, g) => {
  const { db } = ctx
  const from = plain(g.owner_name)
  const convoId = peopleConvo(ctx, g.grantee_user_id)
  card(ctx, { userId: g.grantee_user_id, convoId, sender: JOURNAL, payload: shareCardPayload(db, g, 'in') })
  const item = fileMirror(ctx, {
    userId: g.grantee_user_id, convoId, deviceId: 0, sender: JOURNAL, consent: 'share',
    title: `${from} wants to share a mission with you — ${titleOf(g.mission_title)}`,
    body: [
      `Your contact **${from}** offers you mission **${titleOf(g.mission_title)}** to read.`,
      '',
      `- **You will see:** ${WHAT_CROSSES}, live, under "shared by ${from}".`,
      '- **Read-only:** you cannot change it, and nothing of yours is shared back.',
      `- Either of you can end the share at any time.`,
      '',
      '**To answer:** tap **Accept** or **Decline**.',
    ].join('\n'),
    link: shareLink(g.id), actions: PEER_ACTIONS, idemKey: `consent:share:${g.id}:grantee:${g.updated_at}`,
  })
  if (item) setGrantItem(db, g.id, 'grantee', item.id)
})

const missionWords = (g) => `mission #${g.mission_num} ${titleOf(g.mission_title)}`
// The grantee never uses the owner's number as if it were their own: the
// title names the mission in their log.
const missionWordsFor = (g) => `mission "${titleOf(g.mission_title)}"`

// The grantee's contact row for the owner — what their audit lines hang on.
const granteeContact = (db, g) => peerRowOf(db, ownerContact(db, g))

// After shareMission or answerGrant. Returns the closed mirror of the card
// the caller just answered, when there was one.
export function onGrantOutcome(ctx, who, out) {
  const { db, hub } = ctx
  const g = out.grant
  const before = out.before ?? null
  const to = plain(g.grantee_name)
  const from = plain(g.owner_name)
  const oc = ownerContact(db, g)
  const gc = granteeContact(db, g)
  const ownerTap = (comment) => closeMirror(ctx, { userId: g.owner_user_id, itemId: before?.owner_item_id, consent: 'share', resolution: 'decided', author: 'user', deviceId: who.deviceId, comment })
  const granteeTap = (comment) => closeMirror(ctx, { userId: g.grantee_user_id, itemId: before?.grantee_item_id, consent: 'share', resolution: 'decided', author: 'user', deviceId: who.deviceId, comment })
  let closed = null
  switch (out.outcome) {
    case 'parked':
      shareOwnerAsk(ctx, who, g)
      break
    case 'sent':
      closed = ownerTap(`Approved — ${to} has been asked to accept.`)
      audit(ctx, g.owner_user_id, { event: 'grant.offered', summary: `You offered ${to} ${missionWords(g)} to read`, contact: oc, grant: g, by: g.requested_by })
      shareGranteeAsk(ctx, g)
      audit(ctx, g.grantee_user_id, { event: 'grant.received', summary: `${from} offered you ${missionWordsFor(g)} to read`, contact: gc, grant: g })
      changed(ctx, g.grantee_user_id, { grant_id: g.id })
      break
    case 'withdrawn':
      closed = ownerTap('Declined — nothing was shared.')
      break
    case 'unavailable':
      closed = ownerTap(`Approved, but ${to} is no longer a contact — nothing was shared.`)
      break
    case 'expired':
      closeMirror(ctx, { userId: g.owner_user_id, itemId: before?.owner_item_id, consent: 'share', resolution: 'cancelled', author: 'agent', deviceId: before?.origin_device_id, comment: 'Expired — no answer within 24 h. Nothing was shared.' })
      break
    case 'accepted':
      closed = granteeTap(`Accepted — the mission is now in your shared list, shared by ${from}.`)
      audit(ctx, g.grantee_user_id, { event: 'grant.accepted', summary: `You accepted ${missionWordsFor(g)} from ${from}`, contact: gc, grant: g })
      audit(ctx, g.owner_user_id, { event: 'grant.accepted', summary: `${to} accepted ${missionWords(g)} — shared read-only`, contact: oc, grant: g })
      safely('shared frame', () => hub.sendToClients(g.grantee_user_id, { kind: 'shared', event: 'mission_added', mission_id: g.subject_id, grant_id: g.id, owner: { user_id: g.owner_user_id, name: g.owner_name } }))
      changed(ctx, g.owner_user_id, { grant_id: g.id })
      break
    case 'declined':
      closed = granteeTap('Declined.')
      audit(ctx, g.grantee_user_id, { event: 'grant.declined', summary: `You declined ${missionWordsFor(g)} from ${from}`, contact: gc, grant: g })
      audit(ctx, g.owner_user_id, { event: 'grant.declined', summary: `${to} declined ${missionWords(g)}`, contact: oc, grant: g })
      changed(ctx, g.owner_user_id, { grant_id: g.id })
      break
    default: break
  }
  changed(ctx, out.outcome === 'accepted' || out.outcome === 'declined' ? g.grantee_user_id : g.owner_user_id, { grant_id: g.id })
  return closed
}

// A grant ended: `before` is the row as it stood (with RAW's joined names),
// `by` is 'owner' | 'grantee' | 'contact_removed'. Closes whichever card
// was still open, writes both audit lines, and tells the grantee's apps to
// drop the mission at once.
export function onGrantRevoked(ctx, before, by, who = null) {
  const { db, hub } = ctx
  // revokeGrantsBetween hands back bare grants rows; the names come from
  // the same join every other path uses.
  const g = before.owner_name ? before : (db.prepare(`SELECT g.*, oc.peer_user_id AS grantee_user_id, oc.peer_user AS grantee_name, oc.peer_journal AS grantee_journal,
      ou.name AS owner_name, m.num AS mission_num, m.title AS mission_title
    FROM grants g JOIN contacts oc ON oc.id = g.contact_id JOIN users ou ON ou.id = g.owner_user_id
    LEFT JOIN missions m ON m.id = g.subject_id WHERE g.id=?`).get(before.id) ?? before)
  const state = before.state
  const to = plain(g.grantee_name)
  const from = plain(g.owner_name)
  const oc = ownerContact(db, g)
  const gc = oc ? granteeContact(db, g) : null
  const why = by === 'contact_removed' ? 'The contact ended, so this share ended with it.' : (by === 'owner' ? 'Withdrawn.' : 'Ended.')
  const actor = (side) => (by === side && who?.kind !== 'agent' ? { author: 'user', deviceId: who?.deviceId } : { author: 'agent' })
  if (state === 'awaiting_owner') {
    closeMirror(ctx, { userId: g.owner_user_id, itemId: before.owner_item_id, consent: 'share', resolution: 'cancelled', comment: `${why} Nothing was shared.`, ...actor('owner') })
  }
  if (state === 'pending') {
    closeMirror(ctx, { userId: g.grantee_user_id, itemId: before.grantee_item_id, consent: 'share', resolution: 'cancelled', comment: by === 'grantee' ? 'Declined.' : `${from} withdrew the offer.`, ...actor('grantee') })
  }
  // The grantee was never told of an ask its owner had not approved.
  if (state !== 'awaiting_owner') {
    audit(ctx, g.grantee_user_id, {
      event: 'grant.revoked', contact: gc, grant: g, by: by === 'grantee' ? 'you' : 'peer',
      summary: by === 'grantee' ? `You ended the share of ${missionWordsFor(g)} from ${from}` : `${from} ended the share of ${missionWordsFor(g)}`,
    })
    safely('shared frame', () => hub.sendToClients(g.grantee_user_id, { kind: 'shared', event: 'mission_removed', mission_id: g.subject_id, grant_id: g.id }))
    changed(ctx, g.grantee_user_id, { grant_id: g.id })
  }
  audit(ctx, g.owner_user_id, {
    event: 'grant.revoked', contact: oc, grant: g, by: by === 'owner' ? 'you' : 'peer',
    summary: by === 'grantee' ? `${to} ended the share of ${missionWords(g)}` : `You stopped sharing ${missionWords(g)} with ${to}`,
  })
  changed(ctx, g.owner_user_id, { grant_id: g.id })
}

// --- Live -------------------------------------------------------------------

// A write landed on a mission: tell every active grantee's apps, so the
// shared view follows the owner's as it happens. An invalidation, not the
// content — the grantee refetches through the sieved reads, so nothing
// here can leak what those reads would withhold. `what` is 'mission' |
// 'milestone' | 'item'. Client sockets only; never throws.
export function notifyGrantees({ db, hub }, missionId, what) {
  if (!missionId) return
  safely('live frame', () => {
    const ids = activeGranteeIds(db, missionId)
    if (!ids.length) return
    const owner = db.prepare('SELECT u.id AS user_id, u.name FROM missions m JOIN users u ON u.id = m.user_id WHERE m.id=?').get(missionId)
    for (const id of ids) hub.sendToClients(id, { kind: 'shared', event: 'mission_changed', mission_id: missionId, what, owner })
  })
}

// The sweep's half: asks an agent parked that nobody answered in 24 h.
export function onContactAskExpired(ctx, before) {
  const row = ctx.db.prepare('SELECT * FROM contacts WHERE id=?').get(before.id)
  onContactOutcome(ctx, { kind: 'agent', deviceId: before.origin_device_id, name: deviceName(ctx.db, before.origin_device_id) ?? 'agent' }, { outcome: 'expired', contact: row, before })
}

export function onGrantAskExpired(ctx, before) {
  const g = { ...before, state: 'expired' }
  onGrantOutcome(ctx, { kind: 'agent', deviceId: before.origin_device_id, name: 'agent' }, { outcome: 'expired', grant: g, before })
}
