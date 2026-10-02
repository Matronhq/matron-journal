// Fable-limit fallback, predicted (mission: spawns default to Opus on a box
// that is out of Fable). The target bridge decides at `start` time from its
// own /usage reading (matron-bridge lib/fable-fallback.js) and says so in
// its reply; the journal can only predict it, from the box's last
// box_status report, so the consent card and the Coordinator's
// consent_list can say "will run on Opus" before anyone approves.
// fableMaxed() mirrors the bridge's — keep the two in step.
import { getDeviceStatus } from './db.js'

export const FALLBACK_MODEL = 'opus'
export const FALLBACK_REASON_FABLE_LIMIT = 'fable_limit'
export const FABLE_MAXED_PERCENT = 99

function liveLine(line, nowMs) {
  if (!line || !Number.isFinite(line.percent)) return false
  if (typeof line.resets_at === 'string') {
    const at = Date.parse(line.resets_at)
    if (Number.isFinite(at) && at <= nowMs) return false
  }
  return true
}

const isFableWeek = (id) => typeof id === 'string' && (id === 'week_fable' || id.startsWith('week_fable_'))

// True when the Fable weekly meter is spent and a live all-models reading
// shows room (none, or one past its reset, is no evidence of room).
export function fableMaxed(lines, nowMs = Date.now()) {
  if (!Array.isArray(lines)) return false
  const fable = lines.find((l) => l && isFableWeek(l.id) && liveLine(l, nowMs))
  if (!fable || fable.percent < FABLE_MAXED_PERCENT) return false
  const all = lines.find((l) => l && l.id === 'week_all' && liveLine(l, nowMs))
  return !!all && all.percent < 100
}

// {fallback_model, fallback_reason} for an ask that named no model onto a
// box whose last report shows Fable spent, else {}. Spread straight into a
// card payload or a pending-ask row. Never throws: a prediction is a label,
// and the ask must not fail for want of one.
export function predictSpawnFallback(db, userId, targetDeviceId, { model = '', nowMs = Date.now() } = {}) {
  if (model) return {}
  try {
    const status = getDeviceStatus(db, userId, targetDeviceId)
    if (!fableMaxed(status?.limits?.lines, nowMs)) return {}
    return { fallback_model: FALLBACK_MODEL, fallback_reason: FALLBACK_REASON_FABLE_LIMIT }
  } catch (err) {
    console.error('predictSpawnFallback: status read failed', err)
    return {}
  }
}

// The target's `start` reply names the model it fell back to. Accepted only
// for a reason this build knows and a model that is a short plain token:
// it lands in a durable outcome and in agent-facing text.
export function startReplyFallback(result) {
  if (!result || result.model_reason !== FALLBACK_REASON_FABLE_LIMIT) return null
  const model = result.model
  if (typeof model !== 'string' || !/^[A-Za-z0-9._[\]-]{1,64}$/.test(model)) return null
  return { model, model_reason: FALLBACK_REASON_FABLE_LIMIT }
}
