// The user's default model and effort for NEW chats (2026-10-05 contract
// shared with matron-bridge and matron-web). Two nullable columns
// on user_settings; NULL = "use the box default" (the bridge's own env).
// Pure reads, writes and validation; src/defaults-http.js is the surface.
// The journal does not know any box's model list: it checks the shape of a
// model name, and a bridge ignores a value it cannot use.

export const DEFAULT_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max']
export const DEFAULT_MODEL_MAX = 64
// Aliases (`opus`, `opus[1m]`, `sonnet`, `opusplan`, `fable`) and full names
// (`claude-opus-5-5`), lowercased; `[1m]` is the 1M-context suffix.
const MODEL_RE = /^[a-z0-9][a-z0-9.-]*(\[1m\])?$/

export function getDefaults(db, userId) {
  const row = db.prepare('SELECT default_model, default_effort FROM user_settings WHERE user_id=?').get(userId)
  return { default_model: row?.default_model ?? null, default_effort: row?.default_effort ?? null }
}

// One body value → its stored form: undefined = not a valid value. null,
// "" and (model only) "default" clear; anything else is trimmed and
// lowercased before it is checked, and stored that way.
export function normaliseModel(v) {
  if (v === null) return null
  if (typeof v !== 'string') return undefined
  const s = v.trim().toLowerCase()
  if (s === '' || s === 'default') return null
  return s.length <= DEFAULT_MODEL_MAX && MODEL_RE.test(s) ? s : undefined
}

export function normaliseEffort(v) {
  if (v === null) return null
  if (typeof v !== 'string') return undefined
  const s = v.trim().toLowerCase()
  if (s === '') return null
  return DEFAULT_EFFORTS.includes(s) ? s : undefined
}

// `patch` holds already-normalised values; an absent key keeps its value.
// Returns {defaults, changed} — an unchanged value writes nothing, so the
// caller sends no live frame for it.
export function setDefaults(db, userId, patch, now = Date.now()) {
  return db.transaction(() => {
    const cur = getDefaults(db, userId)
    const next = { ...cur }
    if ('default_model' in patch) next.default_model = patch.default_model
    if ('default_effort' in patch) next.default_effort = patch.default_effort
    if (next.default_model === cur.default_model && next.default_effort === cur.default_effort) {
      return { defaults: cur, changed: false }
    }
    db.prepare(`INSERT INTO user_settings(user_id, default_model, default_effort, updated_at) VALUES(?,?,?,?)
      ON CONFLICT(user_id) DO UPDATE SET default_model=excluded.default_model, default_effort=excluded.default_effort, updated_at=excluded.updated_at`)
      .run(userId, next.default_model, next.default_effort, now)
    return { defaults: next, changed: true }
  })()
}
