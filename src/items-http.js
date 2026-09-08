// HTTP surface of the task & decision tracker (spec: HTTP API). Validation,
// auth, and the three side effects the pure module must not know about:
// the 'item' marker event on the origin conversation, wake-on-message for
// user-authored writes, and the push pipeline.
import { appendAndBroadcast, toEventShape } from './journal.js'
import { isPrivateDevice } from './db.js'
import { authorizeAgentWrite } from './auth.js'
import { wakeConvoAgent } from './wake.js'
import { json, readBody } from './http-body.js'
import { ITEM_KINDS, AWAITING, validateItemFields, createItem, getItem, listItems, listComments, updateItem } from './items.js'
import { itemMarkerPayload, ITEM_EVENT_TYPE, ITEM_ACTIONS } from './items-marker.js'

const SORTS = ['rank', 'updated']
const STATES = ['open', 'closed']
const POSITIONS = ['top', 'bottom']
const ID_MAX = 128
const IDEM_KEY_MAX = 128
// The item transitions in items.js signal their one recoverable failure by
// throwing a tagged Error; each maps to exactly one of the existing error
// shapes. Anything else is a bug and must reach http.js's 500.
const ERROR_STATUS = { bad_after_before: 400, bad_supersedes: 400, idem_key_conflict: 409 }
// Wake keys off the ACTION as well as the writer: a reorder is bookkeeping,
// not something a sleeping box needs to be booted for.
const WAKE_ACTIONS = new Set(['created', 'commented', 'closed', 'reopened'])

const badRequest = (res) => { json(res, 400, { error: 'bad_request' }); return true }
const notFound = (res) => { json(res, 404, { error: 'not_found' }); return true }
const conflict = (res) => { json(res, 409, { error: 'conflict' }); return true }

// Answers `true` when `err` is one of the known transition failures above.
function answerKnownError(res, err) {
  const status = ERROR_STATUS[err && err.message]
  if (!status) return false
  return status === 409 ? conflict(res) : badRequest(res)
}

// null = header absent, undefined = header present but unusable (→ 400).
// Never silently ignored: a client that believes its retry is being deduped
// would otherwise create a second item and never know.
const idemKeyOf = (req, who) => {
  const k = req.headers['idempotency-key']
  if (k === undefined) return null
  if (typeof k !== 'string' || !k || k.length > IDEM_KEY_MAX) return undefined
  // Scoped to the calling device: two devices replaying the same key are two
  // different intents, and a key is only unique per (user_id, idem_key).
  return `${who.deviceId}:${k}`
}

function senderOf(db, who) {
  if (who.kind === 'agent') return `agent:${who.name}`
  const row = db.prepare('SELECT name FROM users WHERE id=?').get(who.userId)
  // The `user:` prefix is load-bearing (push.js's own-event rule, journal.js's
  // unread predicate), so it survives even the impossible missing-row case.
  return `user:${row ? row.name : who.userId}`
}

// Ordinary-agent predicate shared with /roster, /search, /snapshot.
const filteredAgent = (db, who) => who.kind === 'agent' && !isPrivateDevice(db, who.deviceId)

const privateOwnedConvo = (db, convoId) => {
  const owner = db.prepare('SELECT agent_device_id FROM conversations WHERE id=?').get(convoId)?.agent_device_id
  return owner != null && isPrivateDevice(db, owner)
}

// Visible = owned by the caller's user and, for an ordinary agent, not born
// in a private device's conversation. Same 404 for every failure.
function visibleItem(db, who, idOrNum) {
  const item = getItem(db, who.userId, idOrNum)
  if (!item) return null
  if (filteredAgent(db, who) && privateOwnedConvo(db, item.origin_convo_id)) return null
  return item
}

// The one place an 'item' marker is written. Called AFTER the item's own
// transaction has committed — never inside it, so a broadcast can never
// advertise a write that then rolls back.
function emitMarker({ db, hub, pushPipeline, waker }, who, { item, action, comment = null, by = null }) {
  // A typo'd action would ship a marker no client knows how to render;
  // that's a programmer error, not a request error, so it throws.
  if (!ITEM_ACTIONS.includes(action)) throw new Error(`unknown item action: ${action}`)
  const author = by == null ? (who.kind === 'agent' ? 'agent' : 'user') : by
  const payload = itemMarkerPayload({ item, action, by: author, comment })
  const sender = senderOf(db, who)
  let r
  try {
    r = appendAndBroadcast(db, hub, { userId: who.userId, convoId: item.origin_convo_id, sender, type: ITEM_EVENT_TYPE, payload })
  } catch (err) {
    // The table write already committed; a marker on a since-deleted
    // conversation must not fail the request (same stance as spawns.js).
    console.error('items: marker append failed (item write already committed)', err)
    return
  }
  try {
    pushPipeline.onAppend(who.userId, toEventShape({ seq: r.seq, convo_id: item.origin_convo_id, ts: r.ts, sender, type: ITEM_EVENT_TYPE, payload }), who.deviceId)
  } catch (err) {
    console.error('items: push onAppend failed', err)
  }
  // Wake keys off the WRITER's device kind, not `by`: an agent filing on
  // behalf of the user is already awake.
  if (who.kind !== 'agent' && WAKE_ACTIONS.has(action)) wakeConvoAgent({ db, hub, waker }, who.userId, item.origin_convo_id)
}

// null = absent, undefined = present but not in `list` (i.e. reject).
const oneOf = (v, list) => (v == null ? null : (list.includes(v) ? v : undefined))

function handleList(db, res, url, who) {
  const q = url.searchParams
  const kind = oneOf(q.get('kind'), ITEM_KINDS)
  const state = oneOf(q.get('state'), STATES)
  const awaiting = oneOf(q.get('awaiting'), AWAITING)
  const sort = q.has('sort') ? oneOf(q.get('sort'), SORTS) : 'rank'
  if (kind === undefined || state === undefined || awaiting === undefined || sort === undefined) return badRequest(res)
  let since = null
  if (q.has('since')) {
    since = Number(q.get('since'))
    if (!Number.isInteger(since) || since < 0) return badRequest(res)
  }
  // listItems clamps `limit` itself; the route still rejects nonsense rather
  // than silently serving a default page for `limit=abc`.
  const limit = q.has('limit') ? Number(q.get('limit')) : 100
  if (!Number.isInteger(limit) || limit < 1) return badRequest(res)
  const label = q.get('label')
  if (label != null && (!label || label.length > 40)) return badRequest(res)
  const convoId = q.get('convo')
  if (convoId != null && (!convoId || convoId.length > ID_MAX)) return badRequest(res)
  const r = listItems(db, who.userId, {
    convoId, kind, state, awaiting, label, sort, since,
    limit, cursor: q.get('cursor'), excludePrivateOwned: filteredAgent(db, who),
  })
  // An undecodable cursor is a malformed request, not an empty page.
  if (r.badCursor) return badRequest(res)
  json(res, 200, { items: r.items, next_cursor: r.next_cursor })
  return true
}

async function handleCreate(ctx, req, res, who) {
  const { db } = ctx
  const body = await readBody(req)
  if (!ITEM_KINDS.includes(body.kind)) return badRequest(res)
  const v = validateItemFields(body)
  if (!v.ok) return badRequest(res)
  if (body.awaiting !== undefined && body.awaiting !== null && !AWAITING.includes(body.awaiting)) return badRequest(res)
  if (body.position !== undefined && !POSITIONS.includes(body.position)) return badRequest(res)
  for (const k of ['after', 'before', 'supersedes', 'convo_id']) {
    if (body[k] !== undefined && (typeof body[k] !== 'string' || !body[k] || body[k].length > ID_MAX)) return badRequest(res)
  }
  if (typeof body.convo_id !== 'string') return badRequest(res)
  // on_behalf_of:'user' lets the bridge file a task the USER asked for (the
  // queued-card "Make task" tap) as user-created: created_by and the
  // marker's `by` read 'user', so the apps show who really filed it. The
  // marker's sender stays the agent device (no wake, no self-prompt).
  if (body.on_behalf_of !== undefined && (body.on_behalf_of !== 'user' || who.kind !== 'agent')) return badRequest(res)
  const idemKey = idemKeyOf(req, who)
  if (idemKey === undefined) return badRequest(res)
  // Every body-only rule is settled above, so a malformed field answers 400
  // even when the conversation is one this caller may not see.
  //
  // The origin conversation must be the caller's user's; an AGENT must
  // additionally clear the same gate every other agent-authored append does
  // (ws.js publish/prompt/stream, /convo/:id/messages): it owns the
  // conversation or has joined it. 404, never 403 — a refusal must be
  // indistinguishable from a conversation that isn't there. Then the sieve:
  // an ordinary agent cannot file into a private-owned convo even if joined.
  const convo = db.prepare('SELECT owner_user_id, agent_device_id FROM conversations WHERE id=?').get(body.convo_id)
  if (!convo || convo.owner_user_id !== who.userId) return notFound(res)
  if (who.kind === 'agent' && !authorizeAgentWrite(db, who.userId, who.deviceId, body.convo_id)) return notFound(res)
  if (filteredAgent(db, who) && convo.agent_device_id != null && isPrivateDevice(db, convo.agent_device_id)) return notFound(res)
  const createdBy = body.on_behalf_of === 'user' || who.kind !== 'agent' ? 'user' : 'agent'
  let out
  try {
    out = createItem(db, {
      userId: who.userId, kind: body.kind, ...v.value,
      awaiting: body.awaiting,
      position: body.position, after: body.after, before: body.before,
      originConvoId: body.convo_id, originDeviceId: who.deviceId,
      createdBy,
      supersedes: body.supersedes ?? null, idemKey,
    })
  } catch (err) {
    if (answerKnownError(res, err)) return true
    throw err
  }
  // A replayed idempotency key must not fan a second marker out.
  if (!out.duplicate) emitMarker(ctx, who, { item: out.item, action: 'created', by: createdBy })
  json(res, out.duplicate ? 200 : 201, { item: out.item })
  return true
}

async function handlePatch(db, req, res, who, item) {
  const body = await readBody(req)
  const v = validateItemFields(body, { partial: true })
  if (!v.ok) return badRequest(res)
  const fields = { ...v.value }
  delete fields.attachments // body attachments are set at create only (v1)
  if (body.awaiting !== undefined) {
    if (body.awaiting !== null && !AWAITING.includes(body.awaiting)) return badRequest(res)
    // A closed item awaits nobody (the close cleared it): handing the ball
    // back means reopening first, so this is a state conflict, not a bad
    // field. Clearing it (null) agrees with the closed state and is allowed.
    if (body.awaiting !== null && item.state === 'closed') return conflict(res)
    fields.awaiting = body.awaiting
  }
  if (Object.keys(fields).length === 0) return badRequest(res)
  const updated = updateItem(db, { userId: who.userId, itemId: item.id, fields })
  // Only reachable if the item vanished between the read and the write.
  if (!updated) return notFound(res)
  // No marker: a pure edit is not a transition, and the apps re-read the
  // item rather than being told about a retitle.
  json(res, 200, { item: updated })
  return true
}

export async function handleItemsRoute(ctx, req, res, url, who) {
  const { db } = ctx
  const path = url.pathname
  if (path !== '/items' && !path.startsWith('/items/')) return false

  if (path === '/items') {
    if (req.method === 'GET') return handleList(db, res, url, who)
    if (req.method === 'POST') return handleCreate(ctx, req, res, who)
    return false
  }

  // The trailing id is nested inside the sub segment on purpose: flattened,
  // `/items/:id/<junk>` matched as [id, null, junk] and served/mutated the
  // item as if the junk weren't there.
  const m = path.match(/^\/items\/([^/]+)(?:\/(comments|close|reopen|rank)(?:\/([^/]+))?)?$/)
  if (!m) return false
  let idOrNum
  try { idOrNum = decodeURIComponent(m[1]) } catch { return badRequest(res) }
  const sub = m[2] || null
  const subId = m[3] || null

  // Unknown id, another user's id, and a private-owned one all answer the
  // same 404 — nothing here is an enumeration oracle.
  const item = visibleItem(db, who, idOrNum)
  if (!item) return notFound(res)

  if (!sub) {
    if (req.method === 'GET') { json(res, 200, { item, comments: listComments(db, item.id) }); return true }
    if (req.method === 'PATCH') return handlePatch(db, req, res, who, item)
    return false
  }

  // Sub-routes land in Task 8.
  return handleItemSubRoute(ctx, req, res, who, item, sub, subId)
}

async function handleItemSubRoute() { return false }
