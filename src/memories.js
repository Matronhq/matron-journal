// Memories — pure DB state (spec: 2026-09-27 memories). The user's shared
// agent memory: one row per name, overwritten by PUT. No hub, no marker,
// no auth here: src/memories-http.js owns those, the items.js split.
import { randomBytes } from 'node:crypto'
import { isPrivateDevice } from './db.js'

export const MEMORY_TYPES = ['user', 'feedback', 'project', 'reference']
export const DEFAULT_TYPE = 'feedback'
export const NAME_RE = /^[a-z0-9][a-z0-9-]{0,63}$/
export const DESCRIPTION_MAX = 200
export const BODY_MAX = 8192 // bytes
export const MEMORIES_MAX = 200
// Scopes (spec 2026-10-01 memory scopes): who a memory is for. `global` is
// every session (how every memory worked before scopes), `coordinator` the
// user's Coordinator only, `repo:<name>` the sessions whose working
// directory is a checkout of that repo — the bare repo name, as the bridge
// derives it from the git remote (or the directory). The name part is the
// `name` segment of src/repo-identity.js's canonical form.
export const DEFAULT_SCOPE = 'global'
export const SCOPE_MAX = 128
export const SCOPE_RE = /^(global|coordinator|repo:[A-Za-z0-9_.-]+)$/
export const validScope = (v) => typeof v === 'string' && v.length <= SCOPE_MAX && SCOPE_RE.test(v)
// Tiers: how a session is given a memory. `always` memories are listed in
// full (name and description) in every session of their scope, as every
// memory was before tiers. `on_demand` memories are named only, grouped by
// `topic`; a session reads them with GET /memories/:name or finds them with
// POST /memories/recall when its work touches the topic. Every existing row
// is `always`, so adding the column changes nothing a session sees.
export const MEMORY_TIERS = ['always', 'on_demand']
export const DEFAULT_TIER = 'always'
export const TOPIC_MAX = 40
// The always tier is capped per scope, so the part of a memory set that is
// in every session's context cannot grow without anyone choosing what
// leaves it. Only a write that would ADD to a full set is affected: a
// create without a tier lands on_demand instead, and an explicit
// tier 'always' (or a scope change of an always memory) is refused with
// 'always_full'. Rows already over the cap stay as they are.
export const ALWAYS_MAX = { global: 25, coordinator: 30, repo: 15 }
export const alwaysMaxFor = (scope) => (scope.startsWith('repo:') ? ALWAYS_MAX.repo : (ALWAYS_MAX[scope] ?? ALWAYS_MAX.global))

// C0/C1 controls (covers \n, \r, \t) and the Unicode line/paragraph
// separators — the description is the one line the Coordinator sees at
// spawn, so it must stay a line. Same set the item-actions rule uses.
const LINE_BAD_CHARS = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/

export const newId = () => `me_${randomBytes(8).toString('hex')}`
export const validName = (v) => typeof v === 'string' && NAME_RE.test(v)

// {ok:false} on any bad field. body omitted → '' (a PUT is the whole memory).
// type, scope, tier and topic omitted → undefined: upsertMemory keeps the
// stored value on an update and applies the default on a create. topic ''
// or null clears it (stored as null).
export function validateMemoryFields(body) {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) return { ok: false }
  const { description, body: text, type, scope, tier } = body
  let topic = body.topic
  if (topic === null) topic = ''
  if (topic !== undefined) {
    if (typeof topic !== 'string') return { ok: false }
    topic = topic.trim()
    if (topic.length > TOPIC_MAX || LINE_BAD_CHARS.test(topic)) return { ok: false }
  }
  if (tier !== undefined && !MEMORY_TIERS.includes(tier)) return { ok: false }
  if (typeof description !== 'string') return { ok: false }
  const desc = description.trim()
  if (!desc || desc.length > DESCRIPTION_MAX || LINE_BAD_CHARS.test(desc)) return { ok: false }
  let value = ''
  if (text !== undefined) {
    if (typeof text !== 'string' || Buffer.byteLength(text, 'utf8') > BODY_MAX) return { ok: false }
    value = text
  }
  if (type !== undefined && !MEMORY_TYPES.includes(type)) return { ok: false }
  if (scope !== undefined && !validScope(scope)) return { ok: false }
  return { ok: true, value: { description: desc, body: value, type, scope, tier, topic } }
}

const rowToMemory = (r) => (r ? {
  id: r.id, user_id: r.user_id, name: r.name, type: r.type, scope: r.scope ?? DEFAULT_SCOPE, tier: r.tier ?? DEFAULT_TIER, topic: r.topic || null, description: r.description, body: r.body,
  origin_convo_id: r.origin_convo_id, origin_device_id: r.origin_device_id, origin_private: !!r.origin_private,
  created_by: r.created_by, updated_by: r.updated_by, created_at: r.created_at, updated_at: r.updated_at,
} : null)

// `key` is the id (me_…) or the name; both are unique per user.
export function getMemory(db, userId, key) {
  if (typeof key !== 'string' || !key) return null
  const col = key.startsWith('me_') ? 'id' : 'name'
  return rowToMemory(db.prepare(`SELECT * FROM memories WHERE user_id=? AND ${col}=?`).get(userId, key))
}

export function listMemories(db, userId, { excludePrivateOwned = false } = {}) {
  const sieve = excludePrivateOwned ? 'AND m.origin_private = 0' : ''
  return db.prepare(`SELECT * FROM memories m WHERE m.user_id=? ${sieve} ORDER BY m.name`).all(userId).map(rowToMemory)
}

// Saved from a private device → hidden from an ordinary agent (the
// privateOwnedConvo rule, applied to the memory's own origin device). Read
// from the snapshot taken at save time, never a live devices join: the
// device may be revoked (its row deleted, its id possibly reused) long
// after the memory was saved, and that must not change who may read it.
export const privateOrigin = (memory) => memory?.origin_private === true

// How many always-tier memories a scope holds, leaving out one row (the
// memory being written, whose own place in the set does not count).
const alwaysCount = (db, userId, scope, exceptId = null) => db.prepare(
  "SELECT COUNT(*) AS n FROM memories WHERE user_id=? AND scope=? AND tier='always' AND id IS NOT ?",
).get(userId, scope, exceptId).n

// The tier a write ends with (spec: the ALWAYS_MAX comment above). Throws
// Error('always_full') for a write that asked for the always tier by name,
// or that moves an always memory into a full scope, unless `softCap` (an
// approved proposal: the user's tap must not fail on a count) — then the
// memory lands on_demand like an unnamed create. → { tier, capped }.
function settleTier(db, userId, { existing, tier, scope, softCap }) {
  const wanted = tier ?? existing?.tier ?? DEFAULT_TIER
  if (wanted !== 'always') return { tier: wanted, capped: false }
  const adds = !existing || existing.tier !== 'always' || existing.scope !== scope
  if (!adds || alwaysCount(db, userId, scope, existing?.id ?? null) < alwaysMaxFor(scope)) return { tier: 'always', capped: false }
  if (tier === undefined && !existing) return { tier: 'on_demand', capped: true }
  if (softCap) return { tier: 'on_demand', capped: true }
  throw new Error('always_full')
}

// Create or overwrite by name in one transaction. Throws Error('too_many')
// when a CREATE would pass MEMORIES_MAX and Error('always_full') per
// settleTier; an update is otherwise never refused. `capped` says the
// memory landed on_demand because its scope's always tier was full.
export function upsertMemory(db, { userId, name, description, body, type, scope, tier, topic, softCap = false, originConvoId = null, originDeviceId = null, by, now = Date.now() }) {
  const originPrivate = originDeviceId != null && isPrivateDevice(db, originDeviceId) ? 1 : 0
  return db.transaction(() => {
    const existing = rowToMemory(db.prepare('SELECT * FROM memories WHERE user_id=? AND name=?').get(userId, name))
    const finalScope = scope ?? existing?.scope ?? DEFAULT_SCOPE
    const finalTopic = topic === undefined ? (existing?.topic ?? null) : (topic || null)
    if (existing) {
      const t = settleTier(db, userId, { existing, tier, scope: finalScope, softCap })
      db.prepare('UPDATE memories SET description=?, body=?, type=?, scope=?, tier=?, topic=?, updated_by=?, updated_at=? WHERE id=?')
        .run(description, body, type ?? existing.type, finalScope, t.tier, finalTopic, by, now, existing.id)
      return { memory: getMemory(db, userId, existing.id), created: false, capped: t.capped }
    }
    const n = db.prepare('SELECT COUNT(*) AS n FROM memories WHERE user_id=?').get(userId).n
    if (n >= MEMORIES_MAX) throw new Error('too_many')
    const t = settleTier(db, userId, { existing: null, tier, scope: finalScope, softCap })
    const id = newId()
    db.prepare(`INSERT INTO memories(id, user_id, name, type, scope, tier, topic, description, body, origin_convo_id, origin_device_id, origin_private, created_by, updated_by, created_at, updated_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(id, userId, name, type ?? DEFAULT_TYPE, finalScope, t.tier, finalTopic, description, body, originConvoId, originDeviceId, originPrivate, by, by, now, now)
    return { memory: getMemory(db, userId, id), created: true, capped: t.capped }
  })()
}

// The deleted row, or null when there was nothing to delete.
export function deleteMemory(db, userId, id) {
  return db.transaction(() => {
    const m = getMemory(db, userId, id)
    if (!m) return null
    db.prepare('DELETE FROM memories WHERE id=?').run(m.id)
    return m
  })()
}
