// Fable-limit fallback, predicted (mission: spawns default to Opus on a box
// that is out of Fable). The target bridge decides at `start` time from its
// own /usage reading (matron-bridge lib/fable-fallback.js) and says so in
// its reply; the journal can only predict it, from the box's last
// box_status report, so the consent card and the Coordinator's
// consent_list can say "will run on Opus" before anyone approves.
// fableMaxed() mirrors the bridge's — keep the two in step.
import { getDeviceStatus } from './db.js'
import { getBoxDefaults, effectiveBoxDefaults } from './box-defaults.js'

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

// A Claude model name as the bridge recognises one: an alias (with or
// without the 1M suffix), "default", or a full claude-* id. Mirrors
// matron-bridge's check — keep the two in step.
const CLAUDE_ALIASES = ['opus', 'sonnet', 'haiku', 'opusplan', 'fable', 'default']
const CLAUDE_ONLY_EFFORTS = ['max']
export function isClaudeModel(name) {
  const m = String(name).trim().toLowerCase()
  return m.startsWith('claude-') || CLAUDE_ALIASES.includes(m.replace(/\[1m\]$/, ''))
}

// What the spawned session will actually run (matron-bridge
// docs/specs/box-defaults.md), for the consent card, its tracker item and
// consent_list: each of agent, model and effort as the ask named it
// (`*_source: 'explicit'`), else the target box's default
// (`'box_default'`) — the bridge's last reported effective block, else the
// journal's stored values — else omitted, as cards always were. The box's
// model and effort belong to its default agent, so an ask naming another
// agent gets neither. A Claude model (or the Claude-only effort `max`)
// named for a Codex box with no agent named is reported as
// dropped_model / dropped_effort, and the box's own values in its place.
// Plus the Fable fallback above, for a session that is
// not Codex and has no model of its own other than a Fable one. Never
// throws, like predictSpawnFallback.
export function predictSpawnRun(db, userId, targetDeviceId, { agent = '', model = '', effort = '', nowMs = Date.now() } = {}) {
  let box = null
  try {
    const stored = getBoxDefaults(db, userId, targetDeviceId)
    box = effectiveBoxDefaults(getDeviceStatus(db, userId, targetDeviceId)?.defaults,
      stored && { agent: stored.default_agent, model: stored.default_model, effort: stored.default_effort })
  } catch (err) {
    console.error('predictSpawnRun: box defaults read failed', err)
  }
  // A Codex box asked for a Claude model with no agent named: the target
  // bridge drops that model (and a Claude-only effort) and runs Codex on
  // the box defaults (matron-bridge PR 383), so the card says so.
  const dropped = {}
  if (!agent && box?.agent === 'codex') {
    if (model && isClaudeModel(model)) { dropped.dropped_model = model; model = '' }
    if (effort && CLAUDE_ONLY_EFFORTS.includes(effort.toLowerCase())) { dropped.dropped_effort = effort; effort = '' }
  }
  const boxApplies = !!box && (!agent || agent === box.agent)
  const out = { ...dropped }
  const pick = (key, named, fromBox) => {
    if (named) Object.assign(out, { [key]: named, [`${key}_source`]: 'explicit' })
    else if (fromBox) Object.assign(out, { [key]: fromBox, [`${key}_source`]: 'box_default' })
  }
  pick('agent', agent, box?.agent)
  pick('model', model, boxApplies ? box.model : null)
  pick('effort', effort, boxApplies ? box.effort : null)
  if (out.agent === 'codex') return out
  const boxModel = out.model_source === 'box_default' ? out.model : ''
  return { ...out, ...predictSpawnFallback(db, userId, targetDeviceId, { model: model || (boxModel.startsWith('fable') ? '' : boxModel), nowMs }) }
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
