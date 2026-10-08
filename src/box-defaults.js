// Per-box defaults for new sessions (matron-bridge docs/specs/box-defaults.md):
// the agent (claude | codex), model and effort a session started on one
// agent device gets when nobody names them. Three nullable columns on
// devices; NULL = the bridge's own fallback (MATRON_DEFAULT_*). Pure reads,
// writes and validation; src/box-defaults-http.js is the surface.
// The model and effort belong to the box's default agent — a Claude alias
// on a Claude box, a Codex model id on a Codex box — so the model is
// checked for shape only, by the user's /defaults rules (normaliseModel and
// normaliseModel in src/defaults.js); normaliseAgent and normaliseBoxEffort
// below do the other two.

import { DEFAULT_EFFORTS } from './defaults.js'

export const AGENTS = ['claude', 'codex']
// The user's five levels plus Codex's `minimal`; a bridge ignores a level
// its box's agent can't run (Claude has no `minimal`, Codex no `max`).
export const BOX_EFFORTS = ['minimal', ...DEFAULT_EFFORTS]

export function normaliseBoxEffort(v) {
  if (v === null) return null
  if (typeof v !== 'string') return undefined
  const s = v.trim().toLowerCase()
  if (s === '' || s === 'default') return null
  return BOX_EFFORTS.includes(s) ? s : undefined
}

// One body value → its stored form: undefined = not a valid value. null, ""
// and "default" clear (back to the bridge's fallback); anything else is
// trimmed and lowercased before it is checked.
export function normaliseAgent(v) {
  if (v === null) return null
  if (typeof v !== 'string') return undefined
  const s = v.trim().toLowerCase()
  if (s === '' || s === 'default') return null
  return AGENTS.includes(s) ? s : undefined
}

// {default_agent, default_model, default_effort} for one of the user's
// agent devices, else null (unknown, another user's, or a client device —
// the route tells those apart itself).
export function getBoxDefaults(db, userId, deviceId) {
  const row = db.prepare(
    "SELECT default_agent, default_model, default_effort FROM devices WHERE id=? AND user_id=? AND kind='agent'"
  ).get(deviceId, userId)
  if (!row) return null
  return { default_agent: row.default_agent ?? null, default_model: row.default_model ?? null, default_effort: row.default_effort ?? null }
}

// `patch` holds already-normalised values; an absent key keeps its value.
// A new default_agent without a default_model in the same patch clears the
// model: `opus` means nothing on a Codex box. Effort is kept (the five
// levels mean the same to both agents). Returns {defaults, changed}, or
// null when the device is not one of the user's agents — an unchanged
// value writes nothing, so the caller sends no live frame for it.
export function setBoxDefaults(db, userId, deviceId, patch) {
  return db.transaction(() => {
    const cur = getBoxDefaults(db, userId, deviceId)
    if (!cur) return null
    const next = { ...cur }
    for (const k of ['default_agent', 'default_model', 'default_effort']) if (k in patch) next[k] = patch[k]
    if (next.default_agent !== cur.default_agent && !('default_model' in patch)) next.default_model = null
    if (next.default_agent === cur.default_agent && next.default_model === cur.default_model && next.default_effort === cur.default_effort) {
      return { defaults: cur, changed: false }
    }
    db.prepare('UPDATE devices SET default_agent=?, default_model=?, default_effort=? WHERE id=?')
      .run(next.default_agent, next.default_model, next.default_effort, deviceId)
    // The box's last reported effective block predates this change and
    // would outrank it (effectiveBoxDefaults) — for as long as an asleep
    // box can't report again. Drop it; a live bridge re-reports at once.
    db.prepare("UPDATE device_status SET status=json_remove(status, '$.defaults') WHERE device_id=? AND user_id=? AND json_valid(status)")
      .run(deviceId, userId)
    return { defaults: next, changed: true }
  })()
}

// deviceId -> {agent, model, effort} for every agent device of one user:
// the short shape GET /devices, GET /roster and spawn_targets carry.
export function boxDefaultsByDevice(db, userId) {
  const out = new Map()
  for (const r of db.prepare("SELECT id, default_agent, default_model, default_effort FROM devices WHERE user_id=? AND kind='agent'").all(userId)) {
    out.set(r.id, { agent: r.default_agent ?? null, model: r.default_model ?? null, effort: r.default_effort ?? null })
  }
  return out
}

// What a new session on the box will start with, as best the journal
// knows: the bridge's own effective block from its last box_status
// (`reported`, already sanitised — it folds in the bridge's env fallback),
// else the stored journal values. null when neither says anything.
export function effectiveBoxDefaults(reported, stored) {
  if (reported && (reported.agent || reported.model || reported.effort)) {
    return { agent: reported.agent ?? null, model: reported.model ?? null, effort: reported.effort ?? null }
  }
  if (stored && (stored.agent || stored.model || stored.effort)) return { agent: stored.agent, model: stored.model, effort: stored.effort }
  return null
}
