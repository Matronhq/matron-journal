// The persisted subset of a bridge's `status` op (spec 2026-09-29
// coordinator session control §1, in matron-bridge
// docs/superpowers/specs/2026-09-29-coordinator-session-control-design.md).
// The op itself stays opaque and in-memory for header replay (ws.js
// statusCache); this module keeps only what the roster and mission views
// need — model, context gauge, usage-limit stall, account meters —
// validated block by block so one malformed block never costs the others,
// and unknown keys (effort, workdir, email, vitals, model_options…) are
// never written.
import { sanitizeSpawnLimits } from './spawns.js'

const MODEL_CAP = 64
const STALL_KINDS = new Set(['usage_limit'])
const ISO_CAP = 40
const MS_MAX = 4102444800000 // 2100-01-01

const nonNegInt = (n) => Number.isInteger(n) && n >= 0
const shortStr = (s, cap) => typeof s === 'string' && s.length > 0 && s.length <= cap

function sanitizeContext(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const { tokens, window, pct } = raw
  if (!nonNegInt(tokens) || !Number.isInteger(window) || window <= 0) return null
  if (!Number.isInteger(pct) || pct < 0 || pct > 100) return null
  return { tokens, window, pct }
}

function sanitizeStall(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  if (!STALL_KINDS.has(raw.kind)) return null
  const out = { kind: raw.kind }
  if (raw.model !== undefined) { if (!shortStr(raw.model, MODEL_CAP)) return null; out.model = raw.model }
  if (raw.resets_at !== undefined) { if (!shortStr(raw.resets_at, ISO_CAP)) return null; out.resets_at = raw.resets_at }
  if (raw.since !== undefined) { if (!nonNegInt(raw.since) || raw.since > MS_MAX) return null; out.since = raw.since }
  return out
}

// A bridge frame's `limits` is the bare lines array (buildSessionStatus);
// sanitizeSpawnLimits speaks the {as_of, lines} block spawn_targets uses,
// so wrap it with the report time. `reportedAt` is the caller's clock.
export function sanitizeConvoStatus(raw, reportedAt = Date.now()) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const out = {}
  if (shortStr(raw.model, MODEL_CAP)) out.model = raw.model
  const context = sanitizeContext(raw.context)
  if (context) out.context = context
  const stall = sanitizeStall(raw.stall)
  if (stall) out.stall = stall
  const limits = Array.isArray(raw.limits) ? sanitizeSpawnLimits({ as_of: reportedAt, lines: raw.limits }) : null
  if (limits) out.limits = limits
  return Object.keys(out).length ? out : null
}

export function upsertConvoStatus(db, { userId, convoId, status, reportedAt = Date.now() }) {
  db.prepare(
    `INSERT INTO conversation_status(convo_id, user_id, reported_at, status) VALUES (?,?,?,?)
     ON CONFLICT(convo_id) DO UPDATE SET user_id=excluded.user_id, reported_at=excluded.reported_at, status=excluded.status`
  ).run(convoId, userId, reportedAt, JSON.stringify(status))
}

function parseRow(r) {
  try { return { reported_at: r.reported_at, ...JSON.parse(r.status) } } catch { return null }
}

export function convoStatuses(db, userId) {
  const out = new Map()
  for (const r of db.prepare('SELECT convo_id, reported_at, status FROM conversation_status WHERE user_id=?').all(userId)) {
    const parsed = parseRow(r)
    if (parsed) out.set(r.convo_id, parsed)
  }
  return out
}

export function convoStatus(db, convoId) {
  const r = db.prepare('SELECT reported_at, status FROM conversation_status WHERE convo_id=?').get(convoId)
  return r ? parseRow(r) : null
}
