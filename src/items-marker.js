// The 'item' marker event: what the conversation log carries about a
// tracker item (spec: Marker event). Written only by src/items-http.js;
// never publishable by an agent. Not a MESSAGE_TYPE (no unread/snippet
// column impact) — push.js and journal.js's snippetOf special-case it.
export const ITEM_EVENT_TYPE = 'item'
// 'updated' (a PATCH: retitle, relabel, or a hand-moved `awaiting`) and
// 'reordered' are the two quiet ones: both are journal-sync material, so
// neither wakes a sleeping box (WAKE_ACTIONS in items-http.js) nor pushes
// (classify() in push.js). They still get a marker so a connected client
// learns of the change without re-polling /items.
export const ITEM_ACTIONS = ['created', 'commented', 'closed', 'reopened', 'reordered', 'updated']

export function itemMarkerPayload({ item, action, by, comment = null }) {
  const payload = {
    item_id: item.id,
    num: item.num,
    kind: item.kind,
    title: item.title,
    action,
    by,
    awaiting: item.awaiting ?? null,
    resolution: item.resolution ?? null,
  }
  if (comment && (comment.body || (comment.attachments && comment.attachments.length))) {
    payload.comment = {
      id: comment.id,
      body: comment.body,
      attachments: (comment.attachments || []).map((a) => ({
        blob_ref: a.blob_ref, mime: a.mime, name: a.name, size: a.size, transcript: a.transcript ?? null,
      })),
    }
  }
  return payload
}
