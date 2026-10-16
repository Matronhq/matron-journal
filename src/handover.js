// Hand-over (spec 2026-10-02 matron-to-matron sharing, "Hand-over"): an
// owner gives a mission, or a project with its open missions, to a contact.
// Pure DB state, like src/grants.js, which calls in here: what a hand-over
// would carry (the card's preview) and the one transaction that carries it
// out when the recipient accepts. No hub, cards or audit events here —
// src/sharing-events.js announces what applyHandover returns.
//
// A hand-over COPIES. Even on one journal the recipient gets new rows in
// their own log, under their own numbering, so a later hand-over between
// journals takes the same path; the original is closed, not moved. What
// crosses is the tracker record as an ordinary agent of the owner would see
// it — milestones and items from a private box, consent mirrors and a
// privately written status stay behind — with nothing that names one of the
// owner's conversations or devices: copied rows hang off the recipient's
// People conversation (src/people-convo.js), with device 0 and no marker.
// Milestones therefore cross as text (their jump target is a transcript
// that does not cross), and every copied comment is the agent's, attributed
// in words ("alice", "alice's agent"), so nothing the owner wrote reads as
// the recipient's own words.
import fs from 'node:fs'
import path from 'node:path'
import { randomBytes } from 'node:crypto'
import { newId, nextNum, resolveRank, closeItem } from './items.js'
import { ORIGIN_SIEVE, statusPrivateSql, leaveMission } from './missions.js'
import { PROJECT_ORIGIN_SIEVE } from './projects.js'
import { insertDefaultProject } from './default-project.js'
import { ensurePeopleConvo } from './people-convo.js'
import { shardedPath } from './media.js'
import { INLINE_REF_RE } from './inline-refs.js'

export const BRIEF_MAX = 16000
// The owner's unticked attachments: a list of media ids, bounded so a
// request cannot make the row arbitrarily large.
export const EXCLUDE_MEDIA_MAX = 1000

const fail = (code) => { throw new Error(code) }
const parseJson = (s, fallback) => { try { return JSON.parse(s) } catch { return fallback } }
const PRIVATE_CONVO = (col) => `EXISTS (SELECT 1 FROM conversations pc JOIN private_devices pd ON pd.id = pc.agent_device_id WHERE pc.id = ${col})`

// A brief is required for a hand-over: trimmed, 1..BRIEF_MAX characters.
// null = not a valid brief.
export function validBrief(v) {
  if (typeof v !== 'string') return null
  const s = v.trim()
  return s && s.length <= BRIEF_MAX ? s : null
}

// undefined = absent, null = malformed, else the de-duplicated ids.
export function validExcludeMedia(v) {
  if (v === undefined) return undefined
  if (!Array.isArray(v) || v.length > EXCLUDE_MEDIA_MAX) return null
  if (!v.every((x) => typeof x === 'string' && x && x.length <= 128)) return null
  return [...new Set(v)]
}

// The missions a hand-over of this subject carries: the mission itself, or
// a project's OPEN missions. Each row carries `status_hidden`, the private
// sieve's verdict on its status.
function subjectMissions(db, { kind, id, ownerUserId }) {
  const cols = `m.*, ${statusPrivateSql('m')} AS status_hidden, (${ORIGIN_SIEVE}) AS shareable`
  if (kind === 'mission') return db.prepare(`SELECT ${cols} FROM missions m WHERE m.id=? AND m.user_id=?`).all(id, ownerUserId)
  return db.prepare(`SELECT ${cols} FROM missions m WHERE m.project_id=? AND m.user_id=? AND m.state='open' ORDER BY m.num`).all(id, ownerUserId)
}

// The project row a project hand-over is about, with the same two sieve
// verdicts. null when it is not the owner's.
export function subjectProject(db, ownerUserId, projectId) {
  return db.prepare(`SELECT p.*, ${statusPrivateSql('p')} AS status_hidden, ${PROJECT_ORIGIN_SIEVE} AS shareable
    FROM projects p WHERE p.id=? AND p.user_id=?`).get(projectId, ownerUserId) ?? null
}

// Whether this subject can be handed over now. Throws the refusal the
// routes name: private_mission, mission_closed, project_closed,
// empty_project. Used when the ask is made and again on accept.
export function checkHandoverSubject(db, { kind, id, ownerUserId }) {
  if (kind === 'project') {
    const p = subjectProject(db, ownerUserId, id)
    if (!p) fail('no_project')
    if (!p.shareable) fail('private_mission')
    if (p.state === 'closed') fail('project_closed')
  }
  const missions = subjectMissions(db, { kind, id, ownerUserId })
  if (!missions.length) fail(kind === 'project' ? 'empty_project' : 'no_mission')
  // A project with a private-born mission in it is refused whole: leaving
  // that mission behind in a closed project would strand it.
  if (missions.some((m) => !m.shareable)) fail('private_mission')
  if (missions.some((m) => m.state !== 'open')) fail('mission_closed')
  return missions
}

// What crosses for one mission, through the private sieve. Comments are
// every row of each item's thread (the item body's attachment row included)
// except the item-handover lines, which name the owner's conversations.
function missionContents(db, missionId) {
  const milestones = db.prepare(`SELECT * FROM milestones l WHERE l.mission_id=? AND NOT ${PRIVATE_CONVO('l.convo_id')}
    ORDER BY l.created_at, l.seq`).all(missionId)
  const items = db.prepare(`SELECT * FROM items i WHERE i.mission_id=? AND i.consent IS NULL AND NOT ${PRIVATE_CONVO('i.origin_convo_id')}
    ORDER BY i.num`).all(missionId)
  const comments = db.prepare('SELECT * FROM item_comments WHERE item_id=? ORDER BY created_at, rowid')
  for (const it of items) it.comments = comments.all(it.id).filter((c) => !parseJson(c.meta, null)?.handover)
  return { milestones, items }
}

// Attachments that can actually be copied: a live blob of the owner's.
const liveBlob = (db, ownerUserId, id) => db.prepare('SELECT * FROM blobs WHERE id=? AND owner_user_id=?').get(id, ownerUserId)

// The card's preview. `attachments` lists each copyable file once (the
// first item it is on), for the owner to untick.
export function handoverPreview(db, { kind, id, ownerUserId }) {
  const missions = subjectMissions(db, { kind, id, ownerUserId })
  const out = { missions: missions.length, milestones: 0, items: 0, comments: 0, attachments: [] }
  const seen = new Set()
  for (const m of missions) {
    const c = missionContents(db, m.id)
    out.milestones += c.milestones.length
    out.items += c.items.length
    for (const it of c.items) {
      for (const cm of it.comments) {
        if (cm.kind === 'comment') out.comments++
        for (const a of parseJson(cm.attachments, [])) {
          if (!a?.blob_ref || a.expired || seen.has(a.blob_ref) || !liveBlob(db, ownerUserId, a.blob_ref)) continue
          seen.add(a.blob_ref)
          out.attachments.push({ media_id: a.blob_ref, name: a.name ?? '', mime: a.mime ?? '', size: a.size ?? 0, item_num: it.num })
        }
      }
    }
  }
  return out
}

// A copy of one blob for the recipient: a new file beside the original
// (same media root, derived from its own path) and a new row they own. A
// copy, not a second row on the same file: retention deletes a blob's file
// with its row, and either side's retention must never take the other's.
// The path goes on `files` so a rolled-back hand-over can remove it. null
// when the original's file cannot be read.
function copyBlob(db, b, toUserId, files) {
  const id = randomBytes(16).toString('hex')
  const dest = shardedPath(path.dirname(path.dirname(b.disk_path)), id)
  try {
    fs.mkdirSync(path.dirname(dest), { recursive: true })
    fs.copyFileSync(b.disk_path, dest, fs.constants.COPYFILE_EXCL)
  } catch (err) {
    console.error(`handover: could not copy blob ${b.id} (the attachment crosses as expired)`, err)
    return null
  }
  files.push(dest)
  db.prepare(`INSERT INTO blobs(id, owner_user_id, content_type, size, sha256, disk_path, created_at, width, height, transcript, transcript_status, transcribed_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`).run(id, toUserId, b.content_type, b.size, b.sha256, dest, Date.now(), b.width, b.height, b.transcript, b.transcript_status, b.transcribed_at)
  return id
}

// Rewrites inline refs (`![caption](attachment:<id>)`) to the copied ids;
// a ref to a file that did not cross becomes its caption.
const rewriteRefs = (text, map) => (typeof text === 'string' && text.includes('attachment:')
  ? text.replace(INLINE_REF_RE, (whole, caption, ref) => (map.has(ref) ? (map.get(ref) ? `![${caption}](attachment:${map.get(ref)})` : caption) : whole))
  : text)

// The recipient's mission for one of the owner's. `projectId` is the
// project it is filed in.
function copyMission(db, { m, toUserId, ownerName, brief, peopleConvo, projectId, ownerUserId, exclude, blobMap, files, now }) {
  const id = newId('ms')
  const num = nextNum(db, toUserId)
  const status = m.status_hidden ? null : m.status
  db.prepare(`INSERT INTO missions(id,user_id,num,state,title,name,body,status,status_by,status_updated_at,origin_convo_id,origin_device_id,created_by,created_at,updated_at,project_id)
    VALUES(?,?,?,'open',?,?,?,?,?,?,?,0,'user',?,?,?)`).run(
    id, toUserId, num, m.title, m.name ?? null, m.body ?? '', status, status == null ? null : 'agent', status == null ? null : m.status_updated_at,
    peopleConvo, now, now, projectId)
  const { milestones, items } = missionContents(db, m.id)
  const insMilestone = db.prepare(`INSERT INTO milestones(id,mission_id,user_id,num,kind,title,body,convo_id,seq,device_id,created_by,created_at)
    VALUES(?,?,?,?,?,?,?,?,0,0,'agent',?)`)
  // The brief first, so it carries the copy's lowest milestone number; its
  // time is the hand-over's, so it is also the copy's latest milestone.
  insMilestone.run(newId('ml'), id, toUserId, nextNum(db, toUserId), 'progress', `Handed over by ${ownerName}`, brief, peopleConvo, now)
  for (const l of milestones) insMilestone.run(newId('ml'), id, toUserId, nextNum(db, toUserId), l.kind, l.title, l.body, peopleConvo, l.created_at)
  db.prepare('UPDATE missions SET last_milestone_at=? WHERE id=?').run(now, id)

  // The same blob attached twice is copied once.
  const mapBlob = (ref) => {
    if (blobMap.has(ref)) return blobMap.get(ref)
    let to = null
    if (!exclude.has(ref)) {
      const b = liveBlob(db, ownerUserId, ref)
      if (b) to = copyBlob(db, b, toUserId, files)
    }
    blobMap.set(ref, to)
    return to
  }
  const mapAttachments = (list) => {
    const out = []
    for (const a of list) {
      if (!a?.blob_ref) continue
      if (exclude.has(a.blob_ref)) { blobMap.set(a.blob_ref, null); continue }
      const to = a.expired ? null : mapBlob(a.blob_ref)
      // Not copyable (already expired, or its file is gone): kept as the
      // retention tombstone shape, so the thread still says a file was here.
      out.push(to ? { ...a, blob_ref: to } : { ...a, expired: true })
    }
    return out
  }
  const itemIds = new Map()
  const insItem = db.prepare(`INSERT INTO items(id,user_id,num,kind,state,resolution,awaiting,rank,title,body,labels,links,supersedes,
      origin_convo_id,origin_device_id,created_by,created_at,updated_at,closed_at,mission_id,actions,chosen_action)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,0,'agent',?,?,?,?,?,?)`)
  const insComment = db.prepare(`INSERT INTO item_comments(id,item_id,user_id,author,device_id,convo_id,kind,body,attachments,meta,created_at,actions,chosen_action)
    VALUES(?,?,?,'agent',0,NULL,?,?,?,?,?,?,?)`)
  const copied = []
  for (const it of items) {
    const itemId = newId('it')
    itemIds.set(it.id, itemId)
    // Attachments are copied before the item's own body is written, so the
    // body's inline refs can follow them.
    const threads = it.comments.map((c) => ({ c, attachments: mapAttachments(parseJson(c.attachments, [])) }))
    insItem.run(itemId, toUserId, nextNum(db, toUserId), it.kind, it.state, it.resolution, it.awaiting,
      resolveRank(db, toUserId, { position: 'bottom' }), it.title, rewriteRefs(it.body, blobMap), it.labels, it.links,
      it.supersedes ? itemIds.get(it.supersedes) ?? null : null, peopleConvo, it.created_at, now, it.closed_at, id, it.actions ?? '[]', it.chosen_action ?? null)
    const commentIds = new Map()
    for (const { c, attachments } of threads) {
      const cid = newId('ic')
      commentIds.set(c.id, cid)
      const meta = { ...(parseJson(c.meta, null) ?? {}), attribution: c.author === 'user' ? ownerName : `${ownerName}'s agent` }
      if (meta.reply_to) meta.reply_to = commentIds.get(meta.reply_to) ?? null
      insComment.run(cid, itemId, toUserId, c.kind, rewriteRefs(c.body, blobMap), JSON.stringify(attachments), JSON.stringify(meta), c.created_at, c.actions ?? '[]', c.chosen_action ?? null)
    }
    copied.push({ from: it.id, to: itemId })
  }
  return { id, num, title: m.title, original: m, items: copied }
}

// Close the owner's original: every open item (a consent mirror is the
// user's own and is left alone) is cancelled with a line saying where the
// work went, the mission closes with a summary naming the copy, and every
// conversation still on it leaves. `copiedItems` tells which of its items
// crossed. Returns what the events layer needs for markers.
function closeOriginal(db, { m, copy, granteeName, copiedItems, now }) {
  const crossed = new Set(copiedItems.map((x) => x.from))
  const open = db.prepare("SELECT id FROM items WHERE mission_id=? AND user_id=? AND state='open' AND consent IS NULL ORDER BY num").all(m.id, m.user_id)
  const closedItems = []
  for (const { id } of open) {
    const comment = crossed.has(id) ? `Handed over to ${granteeName}.` : `The mission was handed over to ${granteeName}; this item stayed here.`
    const out = closeItem(db, { userId: m.user_id, itemId: id, resolution: 'cancelled', author: 'agent', deviceId: 0, comment, now })
    if (out) closedItems.push(out)
  }
  const summary = `Handed to ${granteeName}: now ${granteeName}'s mission #${copy.num} (/u/${encodeURIComponent(granteeName)}/${copy.num}).`
  db.prepare(`UPDATE missions SET state='closed', close_summary=?, closed_by='user', closed_convo_id=NULL, closed_over_open_items=0, closed_at=?, updated_at=?
    WHERE id=?`).run(summary, now, now, m.id)
  const left = []
  for (const { convo_id: convoId } of db.prepare('SELECT convo_id FROM mission_conversations WHERE mission_id=? AND ended_at IS NULL').all(m.id)) {
    const out = leaveMission(db, { userId: m.user_id, missionId: m.id, convoId })
    if (out.left) left.push({ convoId, currentMissionId: out.currentChanged ? out.currentMissionId : null, retitled: out.retitled })
  }
  return { missionId: m.id, closedItems, left }
}

// The accept. Runs INSIDE answerGrant's transaction: either all of it
// happens or none. `g` is the grant as RAW reads it. `files` collects the
// blob files written, for the caller to remove if the transaction rolls
// back. Throws the subject refusals (checkHandoverSubject) and not_contact.
export function applyHandover(db, { g, files, now = Date.now() }) {
  const kind = g.subject_kind
  const ownerUserId = g.owner_user_id
  const toUserId = g.grantee_user_id
  const missions = checkHandoverSubject(db, { kind, id: g.subject_id, ownerUserId })
  // The recipient's own contact row for the owner: what their read grant on
  // the copy hangs on.
  const theirs = db.prepare("SELECT id FROM contacts WHERE user_id=? AND peer_user_id=? AND peer_journal IS NULL AND state='active'").get(toUserId, ownerUserId)
  if (!theirs) fail('not_contact')
  const people = ensurePeopleConvo(db, toUserId, now)
  const exclude = new Set(parseJson(g.exclude_media ?? '[]', []))
  const blobMap = new Map()
  const ctx = { toUserId, ownerUserId, ownerName: g.owner_name, brief: g.brief ?? '', peopleConvo: people.id, exclude, blobMap, files, now }

  let project = null
  if (kind === 'project') {
    const p = subjectProject(db, ownerUserId, g.subject_id)
    const status = p.status_hidden ? null : p.status
    project = { id: newId('pj'), num: nextNum(db, toUserId), original: p }
    db.prepare(`INSERT INTO projects(id,user_id,num,state,title,body,status,status_by,status_updated_at,origin_convo_id,origin_device_id,created_by,created_at,updated_at)
      VALUES(?,?,?,'open',?,?,?,?,?,?,0,'user',?,?)`).run(project.id, toUserId, project.num, p.title, p.body ?? '', status,
      status == null ? null : 'agent', status == null ? null : p.status_updated_at, people.id, now, now)
  }
  const copies = []
  const originals = []
  for (const m of missions) {
    const projectId = project ? project.id
      : insertDefaultProject(db, { userId: toUserId, deviceId: 0, createdBy: 'user', convoId: people.id, title: m.title, body: m.body ?? '', ts: now })
    const copy = copyMission(db, { m, projectId, ...ctx })
    copies.push(copy)
    originals.push(closeOriginal(db, { m, copy, granteeName: g.grantee_name, copiedItems: copy.items, now }))
  }
  if (project) {
    db.prepare(`UPDATE projects SET state='closed', close_summary=?, closed_by='user', closed_over_open_missions=0, closed_at=?, updated_at=? WHERE id=?`)
      .run(`Handed to ${g.grantee_name}: now ${g.grantee_name}'s project #${project.num}.`, now, now, g.subject_id)
  }
  // The old owner keeps reading what they handed over (spec decision 9):
  // both people have already said yes, so it is active at once, and the
  // new owner may revoke it like any share of theirs.
  const reverse = copies.map((c) => {
    const id = newId('gr')
    db.prepare(`INSERT INTO grants(id,owner_user_id,subject_kind,subject_id,contact_id,level,state,requested_by,created_at,updated_at,answered_at)
      VALUES(?,?,'mission',?,?,'read','active','user',?,?,?)`).run(id, toUserId, c.id, theirs.id, now, now, now)
    return { id, missionId: c.id }
  })
  const copyId = project ? project.id : copies[0].id
  db.prepare(`UPDATE grants SET state='active', level='owner', pending_level=NULL, pending_state=NULL, copy_subject_id=?, answered_at=?, updated_at=? WHERE id=?`)
    .run(copyId, now, now, g.id)
  return { copyId, project, copies, originals, reverse, peopleConvo: people }
}
