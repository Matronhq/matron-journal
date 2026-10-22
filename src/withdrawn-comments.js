// Withdrawn replies. A user's reply on an item reaches the agent as a turn.
// When the session is busy the bridge holds that turn on its queue and posts
// a `queued_release` card for it, naming the reply (`item: {item_id,
// comment_id}`). If the user cancels the card, the bridge drops the turn and
// publishes its release with `action: 'cancel'`. The reply was never sent to
// the agent, so from then on no agent may read it by any other route either:
//
//   - the comment row is marked `withdrawn_at`; agents reading the thread get
//     it without its words (presentWithdrawn), and search drops it;
//   - the conversation log is scrubbed of the words: the item markers that
//     carried the comment, the old-client fallback text after the
//     `commented` one, and the queue card itself, which held the whole turn.
//
// The user's own apps still read the comment in full on the item, so the
// thread shows what was cancelled and "Edit and resend" has the text.
import { ITEM_EVENT_TYPE } from './items-marker.js'

export const WITHDRAWN_NOTE = '(a reply the user cancelled before it was sent)'

// How far after an item marker its old-client fallback text can sit: the two
// are appended back to back (src/items-http.js emitMarker), so in practice
// the next seq.
const FALLBACK_WINDOW = 4

const parse = (s) => { try { return JSON.parse(s) } catch { return null } }

// A comment as an agent, or another person, may see it once withdrawn: who
// wrote it and when, never what it said.
export function presentWithdrawn(c) {
  if (!c || c.withdrawn_at == null) return c
  return { ...c, body: '', attachments: [], withdrawn: true }
}

// The bridge's cancel release for one of its queue cards (a `prompt_reply`
// it published): withdraw the item reply the card held, if it held one.
// Returns the withdrawn comment's id, or null when there was nothing to do.
export function withdrawForQueuedCancel(db, { userId, convoId, payload, now = Date.now() }) {
  if (!payload || payload.kind !== 'queued_release' || payload.action !== 'cancel') return null
  const promptId = payload.prompt_id
  if (typeof promptId !== 'string' || !promptId) return null
  const card = db.prepare(`SELECT seq, payload FROM events
    WHERE user_id=? AND convo_id=? AND type='prompt' AND sender LIKE 'agent:%'
      AND json_extract(payload, '$.kind')='queued_release' AND json_extract(payload, '$.prompt_id')=?
    ORDER BY seq DESC LIMIT 1`).get(userId, convoId, promptId)
  if (!card) return null
  const p = parse(card.payload)
  const itemId = p?.item?.item_id
  const commentId = p?.item?.comment_id
  if (typeof itemId !== 'string' || typeof commentId !== 'string' || !itemId || !commentId) return null
  return withdrawComment(db, { userId, itemId, commentId, cardSeq: card.seq, now })
}

// Mark one user reply withdrawn and scrub its words from the conversation
// log. Idempotent: a second call finds it withdrawn and does nothing. Only
// the user's own replies qualify; anything else returns null untouched.
export function withdrawComment(db, { userId, itemId, commentId, cardSeq = null, now = Date.now() }) {
  return db.transaction(() => {
    const c = db.prepare(`SELECT c.id, c.withdrawn_at, i.origin_convo_id FROM item_comments c JOIN items i ON i.id = c.item_id
      WHERE c.id=? AND c.item_id=? AND c.user_id=? AND c.author='user' AND c.kind='comment'`).get(commentId, itemId, userId)
    if (!c || c.withdrawn_at != null) return null
    db.prepare('UPDATE item_comments SET withdrawn_at=? WHERE id=?').run(now, commentId)
    // The search triggers drop it too (search-docs.js); this covers a
    // database whose triggers predate the rule until they are recreated.
    db.prepare("DELETE FROM search_docs WHERE kind='comment' AND ref_id=?").run(commentId)
    scrubEvents(db, { userId, itemId, commentId, cardSeq })
    return commentId
  })()
}

function scrubEvents(db, { userId, itemId, commentId, cardSeq }) {
  const update = db.prepare('UPDATE events SET payload=? WHERE user_id=? AND seq=?')
  const markers = db.prepare(`SELECT seq, convo_id, sender, payload FROM events
    WHERE user_id=? AND type=? AND json_extract(payload, '$.item_id')=? AND json_extract(payload, '$.comment.id')=?`)
    .all(userId, ITEM_EVENT_TYPE, itemId, commentId)
  const fallbackAfter = db.prepare(`SELECT seq, payload FROM events
    WHERE user_id=? AND convo_id=? AND sender=? AND type='text' AND seq>? AND seq<=?
      AND json_extract(payload, '$.fallback_for')='item' AND json_extract(payload, '$.item_id')=?
      AND json_extract(payload, '$.action')='commented'
    ORDER BY seq LIMIT 1`)
  for (const m of markers) {
    const p = parse(m.payload)
    if (!p?.comment) continue
    p.comment = { ...p.comment, body: '', attachments: [], withdrawn: true }
    update.run(JSON.stringify(p), userId, m.seq)
    if (p.action !== 'commented') continue
    const fb = fallbackAfter.get(userId, m.convo_id, m.sender, m.seq, m.seq + FALLBACK_WINDOW, itemId)
    const fp = fb && parse(fb.payload)
    if (!fp || typeof fp.body !== 'string') continue
    // Keep the heading line ("📌 Task #12 "…" — alice commented:"), drop the words.
    fp.body = `${fp.body.split('\n')[0]}\n${WITHDRAWN_NOTE}`
    update.run(JSON.stringify(fp), userId, fb.seq)
  }
  if (cardSeq != null) {
    const card = db.prepare('SELECT payload FROM events WHERE user_id=? AND seq=?').get(userId, cardSeq)
    const p = card && parse(card.payload)
    if (p && Array.isArray(p.items)) {
      p.items = p.items.map((it) => (it && typeof it === 'object' ? { ...it, text: WITHDRAWN_NOTE } : it))
      update.run(JSON.stringify(p), userId, cardSeq)
    }
  }
}
