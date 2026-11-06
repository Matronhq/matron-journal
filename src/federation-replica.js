// Read shares across journals: the mission's contents (docs/protocol.md
// "Shares across journals"). src/federation-grants.js carries the grant;
// this is what the grant lets the grantee read.
//
//   mission.snapshot  owner → grantee  {grant, snap, page, pages, mission?, milestones, items}
//
// The owner's journal builds what crosses from the grantee view a contact
// on the same journal reads (missions.js grantedMissionExport, items.js
// grantedItemsExport), then copies only the fields listed here: nothing
// that view strips can cross, and nothing it keeps crosses unless it is
// named below. Each record is its whole current state, never a diff.
//
// A snapshot is sent in pages, in order, on the grant's own subject in the
// outbox, so a revoke jumps the queue and cancels what waits. The grantee's
// journal keeps a read-only replica: each record it holds gets an id of its
// own (the owner's is `ref`), and the last page drops whatever the snapshot
// no longer had. The replica is served only while the grant is active; a
// trigger (db.js) deletes it the moment the grant ends there.
import { newId } from './items.js'
import { enqueue } from './federation-outbox.js'
import { grantedMissionExport, activityOf } from './missions.js'
import { grantedItemsExport } from './items.js'
import { sanitizePeerText } from './peer-text.js'

export const SNAPSHOT_OP = 'mission.snapshot'

// Under the envelope's 1 MiB with room for the envelope itself.
export const PAGE_BYTES = 512 * 1024
// One item with its thread: the newest comments that fit.
export const ITEM_BYTES = 192 * 1024
// Of each kind, per replica: the newest.
export const MAX_RECORDS = 5000
const MAX_PAGES = 1000
const MAX_COMMENTS = 1000

const TITLE_CAP = 200
const NAME_CAP = 40
const BODY_CAP = 32768
const STATUS_CAP = 600
const LABEL_CAP = 40
const LABELS_MAX = 50
const LINKS_MAX = 50
const URL_CAP = 2048
const PERSON_CAP = 324

const fail = (code) => { throw new Error(code) }
const bytes = (v) => Buffer.byteLength(JSON.stringify(v))

// --- What crosses: the owner's journal ------------------------------------

const contributorOf = (c) => (c && typeof c.name === 'string' ? { name: c.name, via: c.via === 'user' ? 'user' : 'agent' } : undefined)
const statusOf = (s) => (s && typeof s === 'object' ? { state: s.state ?? null, resolution: s.resolution ?? null, awaiting: s.awaiting ?? null } : undefined)

export function wireMission(m) {
  return {
    num: m.num, title: m.title, name: m.name ?? null, body: m.body ?? null, state: m.state,
    status: m.status ?? null, status_by: m.status_by ?? null, status_updated_at: m.status_updated_at ?? null,
    close_summary: m.close_summary ?? null, closed_by: m.closed_by ?? null,
    created_by: m.created_by ?? null, created_at: m.created_at, updated_at: m.updated_at, closed_at: m.closed_at ?? null,
  }
}

export function wireMilestone(l) {
  return {
    ref: l.id, num: l.num, kind: l.kind, title: l.title, body: l.body ?? null, created_by: l.created_by ?? null, created_at: l.created_at,
    ...(l.contributor ? { contributor: contributorOf(l.contributor) } : {}),
  }
}

function wireComment(c) {
  const meta = c.meta && typeof c.meta === 'object' ? c.meta : {}
  return {
    ref: c.id, author: c.author, kind: c.kind, body: c.body ?? '', created_at: c.created_at,
    ...(c.withdrawn ? { withdrawn: true } : {}),
    ...(c.kind === 'status' && meta.from ? { from: statusOf(meta.from), to: statusOf(meta.to) } : {}),
    ...(meta.contributor ? { contributor: contributorOf(meta.contributor) } : {}),
  }
}

// Attachments cross in a later stage (media.fetch): until then an item and
// its comments cross without them.
export function wireItem({ item, comments }) {
  const out = {
    ref: item.id, num: item.num, kind: item.kind, state: item.state, resolution: item.resolution ?? null, awaiting: item.awaiting ?? null,
    title: item.title, body: item.body ?? '', created_by: item.created_by ?? null,
    created_at: item.created_at, updated_at: item.updated_at, closed_at: item.closed_at ?? null,
    labels: Array.isArray(item.labels) ? item.labels : [],
    links: Array.isArray(item.links) ? item.links.map((l) => ({ url: l.url, ...(l.title ? { title: l.title } : {}) })) : [],
    comment_count: item.comment_count ?? comments.length, last_comment_at: item.last_comment_at ?? null,
    ...(item.contributor ? { contributor: contributorOf(item.contributor) } : {}),
    comments: [],
  }
  // The newest comments that fit, oldest first as a thread reads.
  let room = ITEM_BYTES - bytes(out)
  const kept = []
  for (const c of comments.slice(-MAX_COMMENTS).reverse()) {
    const w = wireComment(c)
    const n = bytes(w) + 1
    if (n > room) break
    room -= n
    kept.push(w)
  }
  out.comments = kept.reverse()
  if (kept.length < comments.length) out.comments_truncated = true
  return out
}

// The pages of one snapshot of the mission grant `g` shares, in order.
// null when the mission is no longer one the grant can show.
export function snapshotPages(db, g, snap) {
  const view = grantedMissionExport(db, g.subject_id)
  if (!view) return null
  const records = [
    ...view.milestones.slice(0, MAX_RECORDS).map((l) => ['milestones', wireMilestone(l)]),
    ...grantedItemsExport(db, g.subject_id, { limit: MAX_RECORDS }).map((x) => ['items', wireItem(x)]),
  ]
  const fresh = () => ({ milestones: [], items: [] })
  const pages = [{ mission: wireMission(view.mission), ...fresh() }]
  let used = bytes(pages[0])
  for (const [kind, r] of records) {
    const n = bytes(r) + 1
    if (used + n > PAGE_BYTES) { pages.push(fresh()); used = bytes(pages.at(-1)) }
    pages.at(-1)[kind].push(r)
    used += n
  }
  return pages.map((p, page) => ({ grant: g.id, snap, page, pages: pages.length, ...p }))
}

// Queues a snapshot of grant `g` to its grantee, inside the caller's
// transaction, all its pages or none. Returns the number of pages, 0 when
// there was nothing to send. Throws outbox_full like enqueue.
export function sendSnapshot(db, g, { from, to, now }) {
  const snap = newId('sn')
  const pages = snapshotPages(db, g, snap)
  if (!pages) return 0
  db.transaction(() => {
    for (const body of pages) enqueue(db, { userId: g.owner_user_id, from, to, op: SNAPSHOT_OP, body, subject: `grant:${g.id}`, urgent: false, now })
  })()
  return pages.length
}

// --- Arrival: the grantee's journal ---------------------------------------

// Peer text kept as the owner wrote it, lines and all (it is shown as
// theirs, never in the journal's own voice): control characters other than
// newline and tab dropped, cut to the cap.
const peerBody = (v, max = BODY_CAP) => (typeof v === 'string' ? v.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '').slice(0, max) : '')
const line = (v, max) => sanitizePeerText(typeof v === 'string' ? v : '', max)
const optLine = (v, max) => (typeof v === 'string' && v.trim() ? line(v, max) : null)
const time = (v) => (Number.isSafeInteger(v) && v >= 0 ? v : null)
const num = (v) => (Number.isSafeInteger(v) && v >= 1 ? v : fail('malformed'))
const oneOf = (v, list, dflt = null) => (list.includes(v) ? v : dflt)
const BY = ['user', 'agent']
const REF = (prefix) => new RegExp(`^${prefix}_[A-Za-z0-9_-]{1,64}$`)
const MS_REF = REF('ml')
const IT_REF = REF('it')
const IC_REF = REF('ic')
const contributor = (c) => (c && typeof c === 'object' && typeof c.name === 'string' && c.name ? { name: line(c.name, PERSON_CAP), via: oneOf(c.via, BY, 'agent') } : null)
const STATES = ['open', 'closed']
const RESOLUTIONS = ['done', 'answered', 'decided', 'reversed', 'cancelled']
const status = (s) => (s && typeof s === 'object' ? { state: oneOf(s.state, STATES), resolution: oneOf(s.resolution, RESOLUTIONS), awaiting: oneOf(s.awaiting, BY) } : null)

function readMission(m) {
  if (!m || typeof m !== 'object') fail('malformed')
  return {
    num: num(m.num), title: line(m.title, TITLE_CAP) || 'Untitled', name: optLine(m.name, NAME_CAP), body: m.body == null ? null : peerBody(m.body),
    state: oneOf(m.state, STATES, 'open'), status: m.status == null ? null : peerBody(m.status, STATUS_CAP), status_by: oneOf(m.status_by, BY),
    status_updated_at: time(m.status_updated_at), close_summary: m.close_summary == null ? null : peerBody(m.close_summary), closed_by: oneOf(m.closed_by, BY),
    created_by: oneOf(m.created_by, BY), created_at: time(m.created_at) ?? 0, updated_at: time(m.updated_at) ?? 0, closed_at: time(m.closed_at),
  }
}

function readMilestone(l) {
  if (!l || typeof l !== 'object' || typeof l.ref !== 'string' || !MS_REF.test(l.ref)) fail('malformed')
  const c = contributor(l.contributor)
  return {
    ref: l.ref, num: num(l.num), kind: oneOf(l.kind, ['user_input', 'progress'], 'progress'), title: line(l.title, TITLE_CAP) || 'Untitled',
    body: l.body == null ? null : peerBody(l.body), created_by: oneOf(l.created_by, BY), created_at: time(l.created_at) ?? 0,
    contributor_name: c?.name ?? null, contributor_via: c?.via ?? null,
  }
}

function readComment(c) {
  if (!c || typeof c !== 'object' || typeof c.ref !== 'string' || !IC_REF.test(c.ref)) fail('malformed')
  const kind = oneOf(c.kind, ['comment', 'status'], 'comment')
  const by = contributor(c.contributor)
  const meta = {}
  if (kind === 'status' && c.from) Object.assign(meta, { from: status(c.from), to: status(c.to) })
  if (by) meta.contributor = by
  return {
    id: newId('ic'), ref: c.ref, author: oneOf(c.author, BY, 'agent'), kind, body: c.withdrawn ? '' : peerBody(c.body), created_at: time(c.created_at) ?? 0,
    meta: Object.keys(meta).length ? meta : null, ...(c.withdrawn ? { withdrawn: true } : {}),
  }
}

function readLinks(v) {
  if (!Array.isArray(v)) return []
  const out = []
  for (const l of v.slice(0, LINKS_MAX)) {
    if (!l || typeof l.url !== 'string' || l.url.length > URL_CAP) continue
    let u
    try { u = new URL(l.url) } catch { continue }
    if (u.protocol !== 'https:' && u.protocol !== 'http:') continue
    out.push({ url: l.url, ...(typeof l.title === 'string' && l.title.trim() ? { title: line(l.title, TITLE_CAP) } : {}) })
  }
  return out
}

function readItem(i) {
  if (!i || typeof i !== 'object' || typeof i.ref !== 'string' || !IT_REF.test(i.ref)) fail('malformed')
  const comments = Array.isArray(i.comments) ? i.comments.slice(-MAX_COMMENTS).map(readComment) : []
  const c = contributor(i.contributor)
  return {
    ref: i.ref, num: num(i.num), kind: oneOf(i.kind, ['task', 'question', 'decision', 'notice'], 'task'),
    state: oneOf(i.state, STATES, 'open'), resolution: oneOf(i.resolution, RESOLUTIONS), awaiting: oneOf(i.awaiting, BY),
    title: line(i.title, TITLE_CAP) || 'Untitled', body: peerBody(i.body), created_by: oneOf(i.created_by, BY),
    created_at: time(i.created_at) ?? 0, updated_at: time(i.updated_at) ?? 0, closed_at: time(i.closed_at),
    labels: Array.isArray(i.labels) ? i.labels.filter((s) => typeof s === 'string').slice(0, LABELS_MAX).map((s) => line(s, LABEL_CAP)).filter(Boolean) : [],
    links: readLinks(i.links),
    comment_count: Number.isSafeInteger(i.comment_count) && i.comment_count >= comments.length ? i.comment_count : comments.length,
    last_comment_at: time(i.last_comment_at),
    contributor_name: c?.name ?? null, contributor_via: c?.via ?? null,
    comments, comments_truncated: i.comments_truncated === true,
  }
}

const SNAP = /^sn_[A-Za-z0-9_-]{1,64}$/

// One page, inside the inbound transaction. `incoming` the grantee's live
// fed_grants_in row. → {done: 'added'|'changed'|null, missionId}
export function applySnapshotPage(d, incoming, body, now) {
  const { snap, page, pages } = body
  if (typeof snap !== 'string' || !SNAP.test(snap) || !Number.isSafeInteger(pages) || pages < 1 || pages > MAX_PAGES
    || !Number.isSafeInteger(page) || page < 0 || page >= pages) fail('malformed')
  if (!Array.isArray(body.milestones ?? []) || !Array.isArray(body.items ?? [])) fail('malformed')
  const milestones = (body.milestones ?? []).map(readMilestone)
  const items = (body.items ?? []).map(readItem)
  let rep = d.prepare('SELECT * FROM fed_replica_missions WHERE fg_id=?').get(incoming.id)
  if (page === 0) {
    const m = readMission(body.mission)
    // The same local id across every snapshot of this grant, and again if
    // it ends and is accepted anew.
    const id = rep?.id ?? incoming.replica_mission_id ?? newId('ms')
    if (incoming.replica_mission_id !== id) d.prepare('UPDATE fed_grants_in SET replica_mission_id=? WHERE id=?').run(id, incoming.id)
    const cols = [m.num, m.title, m.name, m.body, m.state, m.status, m.status_by, m.status_updated_at, m.close_summary, m.closed_by, m.created_by, m.created_at, m.updated_at, m.closed_at]
    if (rep) {
      d.prepare(`UPDATE fed_replica_missions SET num=?, title=?, name=?, body=?, state=?, status=?, status_by=?, status_updated_at=?, close_summary=?, closed_by=?,
        created_by=?, created_at=?, updated_at=?, closed_at=?, loading_snap=?, loaded_pages=1, received_at=? WHERE fg_id=?`).run(...cols, snap, now, incoming.id)
    } else {
      d.prepare(`INSERT INTO fed_replica_missions(id, fg_id, user_id, num, title, name, body, state, status, status_by, status_updated_at, close_summary, closed_by,
        created_by, created_at, updated_at, closed_at, loading_snap, loaded_pages, complete, received_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,1,0,?)`)
        .run(id, incoming.id, incoming.user_id, ...cols, snap, now)
    }
    rep = d.prepare('SELECT * FROM fed_replica_missions WHERE fg_id=?').get(incoming.id)
  } else if (!rep || rep.loading_snap !== snap) {
    // A page of a snapshot that is not the one being loaded (one a newer
    // snapshot replaced, or one given up on below): nothing to do.
    return { done: null, missionId: rep?.id ?? null }
  } else if (page !== rep.loaded_pages) {
    // A page missing before this one (refused, and dropped from the
    // owner's outbox): this snapshot can never be whole, so it is given up
    // on, and the copy stays as the last whole one left it.
    d.prepare('UPDATE fed_replica_missions SET loading_snap=NULL WHERE fg_id=?').run(incoming.id)
    return { done: null, missionId: rep.id }
  } else {
    d.prepare('UPDATE fed_replica_missions SET loaded_pages=loaded_pages+1 WHERE fg_id=?').run(incoming.id)
  }
  const countOf = (table) => d.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE fg_id=? AND seen_snap=?`).get(incoming.id, snap).n
  let room = MAX_RECORDS - countOf('fed_replica_milestones')
  for (const l of milestones) {
    if (room-- <= 0) break
    d.prepare(`INSERT INTO fed_replica_milestones(id, fg_id, ref, num, kind, title, body, created_by, created_at, contributor_name, contributor_via, seen_snap)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(fg_id, ref) DO UPDATE SET num=excluded.num, kind=excluded.kind, title=excluded.title, body=excluded.body,
      created_by=excluded.created_by, created_at=excluded.created_at, contributor_name=excluded.contributor_name, contributor_via=excluded.contributor_via, seen_snap=excluded.seen_snap`)
      .run(newId('ml'), incoming.id, l.ref, l.num, l.kind, l.title, l.body, l.created_by, l.created_at, l.contributor_name, l.contributor_via, snap)
  }
  room = MAX_RECORDS - countOf('fed_replica_items')
  for (const i of items) {
    if (room-- <= 0) break
    d.prepare(`INSERT INTO fed_replica_items(id, fg_id, user_id, ref, num, kind, state, resolution, awaiting, title, body, created_by, created_at, updated_at, closed_at,
      labels, links, comment_count, last_comment_at, contributor_name, contributor_via, comments, comments_truncated, seen_snap)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(fg_id, ref) DO UPDATE SET num=excluded.num, kind=excluded.kind, state=excluded.state,
      resolution=excluded.resolution, awaiting=excluded.awaiting, title=excluded.title, body=excluded.body, created_by=excluded.created_by,
      created_at=excluded.created_at, updated_at=excluded.updated_at, closed_at=excluded.closed_at, labels=excluded.labels, links=excluded.links,
      comment_count=excluded.comment_count, last_comment_at=excluded.last_comment_at, contributor_name=excluded.contributor_name,
      contributor_via=excluded.contributor_via, comments=excluded.comments, comments_truncated=excluded.comments_truncated, seen_snap=excluded.seen_snap`)
      .run(newId('it'), incoming.id, incoming.user_id, i.ref, i.num, i.kind, i.state, i.resolution, i.awaiting, i.title, i.body, i.created_by, i.created_at,
        i.updated_at, i.closed_at, JSON.stringify(i.labels), JSON.stringify(i.links), i.comment_count, i.last_comment_at, i.contributor_name, i.contributor_via,
        JSON.stringify(i.comments), i.comments_truncated ? 1 : 0, snap)
  }
  if (page < pages - 1) return { done: null, missionId: rep.id }
  // The last page: whatever this snapshot did not carry is gone.
  d.prepare('DELETE FROM fed_replica_milestones WHERE fg_id=? AND seen_snap IS NOT ?').run(incoming.id, snap)
  d.prepare('DELETE FROM fed_replica_items WHERE fg_id=? AND seen_snap IS NOT ?').run(incoming.id, snap)
  d.prepare('UPDATE fed_replica_missions SET loading_snap=NULL, applied_snap=?, complete=1, received_at=? WHERE fg_id=?').run(snap, now, incoming.id)
  return { done: rep.complete ? 'changed' : 'added', missionId: rep.id }
}

// --- Reads: the grantee's journal -----------------------------------------

// A replica is read only while its grant is active and its contact live,
// and only once a whole snapshot has arrived.
const LIVE = `JOIN fed_grants_in g ON g.id = r.fg_id AND g.state = 'active'
  JOIN contacts c ON c.id = g.contact_id AND c.state = 'active'`
const MISSIONS = `SELECT r.*, g.id AS grant_id, g.level AS grant_level, g.owner_name || '@' || g.peer_host AS owner_address
  FROM fed_replica_missions r ${LIVE} WHERE r.complete = 1`

const ownerOf = (address) => ({ user_id: 0, name: address, address, github_login: null })
const parse = (s, dflt) => { try { return JSON.parse(s) } catch { return dflt } }

function missionOut(d, r) {
  const counts = d.prepare(`SELECT
      (SELECT COUNT(*) FROM fed_replica_items i WHERE i.fg_id = @fg AND i.state = 'open') AS open_items,
      (SELECT COUNT(*) FROM fed_replica_milestones l WHERE l.fg_id = @fg) AS milestones`).get({ fg: r.fg_id })
  const last = d.prepare('SELECT num, title, kind, created_at FROM fed_replica_milestones WHERE fg_id=? ORDER BY created_at DESC, num DESC LIMIT 1').get(r.fg_id) ?? null
  const lastActivityAt = Math.max(...[r.created_at, last?.created_at, r.status_updated_at].filter((v) => v != null))
  return {
    id: r.id, user_id: 0, num: r.num, state: r.state, title: r.title, body: r.body, close_summary: r.close_summary, closed_by: r.closed_by,
    closed_over_open_items: 0, origin_convo_id: '', origin_device_id: 0, created_by: r.created_by, created_at: r.created_at, updated_at: r.updated_at,
    last_milestone_at: last?.created_at ?? null, closed_at: r.closed_at, status: r.status, status_by: r.status_by, status_convo_id: null,
    status_updated_at: r.status_updated_at, closed_convo_id: null, project_id: null, name: r.name,
    open_items: counts.open_items, needs_you: 0, conversations: 0, milestones: counts.milestones, project_num: null, last_milestone: last,
    last_activity_at: lastActivityAt,
    activity: activityOf({ state: r.state, running: 0, waiting: 0, needsYou: 0, lastActivityAt }),
    owner: ownerOf(r.owner_address), shared_via: 'grant', grant: { id: r.grant_id, level: r.grant_level },
  }
}

export function listReplicaMissions(d, userId) {
  return d.prepare(`${MISSIONS} AND g.user_id = ? ORDER BY r.received_at DESC`).all(userId).map((r) => missionOut(d, r))
}

export function getReplicaMission(d, userId, id) {
  if (typeof id !== 'string' || !id.startsWith('ms_')) return null
  const r = d.prepare(`${MISSIONS} AND g.user_id = ? AND r.id = ?`).get(userId, id)
  return r ? missionOut(d, r) : null
}

const milestoneOut = (missionId) => (l) => ({
  id: l.id, mission_id: missionId, num: l.num, kind: l.kind, title: l.title, body: l.body, created_by: l.created_by, created_at: l.created_at,
  ...(l.contributor_name ? { contributor: { name: l.contributor_name, via: l.contributor_via ?? 'agent' } } : {}),
})

// GET /missions/:id for a replica: the shape grantedMissionDetail gives.
export function replicaMissionDetail(d, mission) {
  const fg = mission.grant.id
  const milestones = d.prepare('SELECT * FROM fed_replica_milestones WHERE fg_id=? ORDER BY created_at DESC, num DESC').all(fg).map(milestoneOut(mission.id))
  const items = d.prepare(`SELECT id, num, kind, state, awaiting, title, '' AS origin_convo_id, updated_at FROM fed_replica_items
    WHERE fg_id=? AND state='open' ORDER BY (awaiting = 'user') DESC, updated_at DESC`).all(fg)
  return { mission, milestones, items, conversations: [] }
}

const ITEMS = `SELECT r.*, m.id AS mission_id, m.num AS mission_num, g.owner_name || '@' || g.peer_host AS owner_address
  FROM fed_replica_items r JOIN fed_replica_missions m ON m.fg_id = r.fg_id AND m.complete = 1 ${LIVE}`

function itemOut(r) {
  return {
    id: r.id, user_id: 0, num: r.num, kind: r.kind, state: r.state, resolution: r.resolution, awaiting: r.awaiting, rank: 0,
    title: r.title, body: r.body, supersedes: null, origin_convo_id: '', origin_device_id: 0, created_by: r.created_by,
    created_at: r.created_at, updated_at: r.updated_at, closed_at: r.closed_at, mission_id: r.mission_id, consent: null, chosen_action: null,
    private: false, filed_convo_id: null, device_name: null, comment_count: r.comment_count, last_comment_at: r.last_comment_at,
    last_user_input_at: null, has_image: false, mission_num: r.mission_num, origin_convo_title: null, handover: null, repo: null,
    labels: parse(r.labels, []), links: parse(r.links, []), attachments: [], actions: [],
    ...(r.contributor_name ? { contributor: { name: r.contributor_name, via: r.contributor_via ?? 'agent' } } : {}),
    owner: ownerOf(r.owner_address), shared_via: 'grant',
  }
}

function commentsOut(r) {
  return parse(r.comments, []).map((c) => ({
    id: c.id, item_id: r.id, author: c.author, device_id: 0, kind: c.kind, body: c.body, created_at: c.created_at,
    chosen_action: null, convo_id: null, device_name: null, convo_title: null, attachments: [], meta: c.meta ?? null,
    action: null, reply_to: null, actions: [], ...(c.withdrawn ? { withdrawn: true } : {}),
  }))
}

export function getReplicaItem(d, userId, id) {
  if (typeof id !== 'string' || !id.startsWith('it_')) return null
  const r = d.prepare(`${ITEMS} WHERE g.user_id = ? AND r.id = ?`).get(userId, id)
  return r ? { item: itemOut(r), comments: commentsOut(r) } : null
}

// GET /items?scope=shared: the replica's items under the same filters and
// cursor as listSharedItems ([updated_at, id], newest first). `limit` + 1
// rows so the caller can merge the two lists and still see a next page.
export function listReplicaItems(d, userId, { kind = null, state = null, awaiting = null, limit = 100, cursor = null } = {}) {
  const where = ['g.user_id = @user']
  const args = { user: userId }
  if (Array.isArray(kind)) { where.push(`r.kind IN (${kind.map((_, i) => `@kind${i}`).join(',')})`); kind.forEach((k, i) => { args[`kind${i}`] = k }) }
  else if (kind != null) { where.push('r.kind = @kind'); args.kind = kind }
  if (state != null) { where.push('r.state = @state'); args.state = state }
  if (awaiting != null) { where.push('r.awaiting = @awaiting'); args.awaiting = awaiting }
  if (cursor) { where.push('(r.updated_at < @cu OR (r.updated_at = @cu AND r.id < @cid))'); args.cu = cursor[0]; args.cid = cursor[1] }
  return d.prepare(`${ITEMS} WHERE ${where.join(' AND ')} ORDER BY r.updated_at DESC, r.id DESC LIMIT @lim`).all({ ...args, lim: limit + 1 }).map(itemOut)
}

// GET /lookup?user=<name@host>&num=N: a mission or item of a replica.
export function lookupReplica(d, userId, address, n) {
  const at = address.lastIndexOf('@')
  if (at < 1) return null
  const [name, host] = [address.slice(0, at), address.slice(at + 1)]
  const own = `AND g.user_id = @user AND g.owner_name = @name AND g.peer_host = @host`
  const args = { user: userId, name, host, n }
  const m = d.prepare(`${MISSIONS} ${own} AND r.num = @n`).get(args)
  if (m) return { kind: 'mission', id: m.id, num: m.num, title: m.title, owner: ownerOf(address) }
  const i = d.prepare(`${ITEMS} WHERE r.num = @n ${own}`).get(args)
  if (i) return { kind: 'item', id: i.id, num: i.num, title: i.title, owner: ownerOf(address) }
  return null
}

// The local mission id a grant's replica has, for the frame that says it
// went away (the trigger has deleted the row by then).
export const replicaMissionId = (d, fgId) => d.prepare('SELECT replica_mission_id FROM fed_grants_in WHERE id=?').get(fgId)?.replica_mission_id ?? null
