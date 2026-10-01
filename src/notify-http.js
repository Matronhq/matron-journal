// HTTP surface of the notification settings (spec 2026-10-01 notification
// settings). GET /notify is the settings screen's whole view; PUT /notify
// changes any part of it. Client tokens only — agents never see or choose
// what buzzes the user's pocket. Every change is sent live to the user's
// open apps ({kind:'notify'}), so the iPhone and the Mac stay in step.
import { json, readBody } from './http-body.js'
import { badRequest, notFound } from './http-who.js'
import { CONVO_ID_MAX_CHARS } from './journal.js'
import {
  NOTIFY_MODES, NOTIFY_EVENTS, CONVO_LEVELS, DEVICE_LEVELS,
  notifyView, setNotifyPrefs, setConvoNotify, setDeviceLevel,
} from './notify.js'

// A mute is "for 1 h / 8 h / until tomorrow 08:00" — a week is plenty.
const MUTE_MAX_MS = 7 * 24 * 60 * 60 * 1000

function validate(body, now) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return false
  const keys = Object.keys(body)
  if (!keys.length || keys.some((k) => !['mode', 'events', 'device_level', 'convo'].includes(k))) return false
  if ('mode' in body && !NOTIFY_MODES.includes(body.mode)) return false
  if ('events' in body) {
    const e = body.events
    if (!e || typeof e !== 'object' || Array.isArray(e)) return false
    if (Object.entries(e).some(([k, v]) => !NOTIFY_EVENTS.includes(k) || typeof v !== 'boolean')) return false
  }
  if ('device_level' in body && !DEVICE_LEVELS.includes(body.device_level)) return false
  if ('convo' in body) {
    const c = body.convo
    if (!c || typeof c !== 'object' || Array.isArray(c)) return false
    if (typeof c.convo_id !== 'string' || !c.convo_id || c.convo_id.length > CONVO_ID_MAX_CHARS) return false
    if (!('level' in c) && !('mute_until' in c)) return false
    if ('level' in c && c.level !== null && !CONVO_LEVELS.includes(c.level)) return false
    if ('mute_until' in c && c.mute_until !== null
      && (!Number.isInteger(c.mute_until) || c.mute_until > now + MUTE_MAX_MS)) return false
  }
  return true
}

export async function handleNotifyRoute(ctx, req, res, url, who) {
  if (url.pathname !== '/notify') return false
  const { db, hub } = ctx
  if (who.kind !== 'client') { json(res, 403, { error: 'forbidden' }); return true }
  if (req.method === 'GET') {
    json(res, 200, notifyView(db, who.userId, who.deviceId))
    return true
  }
  if (req.method !== 'PUT') return false
  const body = await readBody(req)
  const now = Date.now()
  if (!validate(body, now)) return badRequest(res)
  if (body.convo) {
    const owned = db.prepare('SELECT 1 FROM conversations WHERE id=? AND owner_user_id=?').get(body.convo.convo_id, who.userId)
    if (!owned) return notFound(res)
  }
  db.transaction(() => {
    if ('mode' in body || 'events' in body) setNotifyPrefs(db, who.userId, { mode: body.mode, events: body.events }, now)
    if ('device_level' in body) setDeviceLevel(db, who.deviceId, body.device_level)
    if (body.convo) {
      const { convo_id: convoId, ...rest } = body.convo
      setConvoNotify(db, who.userId, convoId, rest, now)
    }
  })()
  const view = notifyView(db, who.userId, who.deviceId, now)
  // device_level is per device: the live frame carries only the synced part,
  // and each app keeps its own level from its own GET/PUT.
  const { device_level: _ownLevel, ...synced } = view
  try { hub.sendToClients(who.userId, { kind: 'notify', settings: synced }) } catch (err) { console.error('notify: live frame failed (saved)', err) }
  json(res, 200, view)
  return true
}
