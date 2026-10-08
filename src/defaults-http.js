// HTTP surface of the user's default model and effort for new chats
// (src/defaults.js). Either device kind may read and write: the apps' Settings
// set it, and a bridge writes it when the user taps "Yes" to "Use this for
// new chats too?". A change goes live to every socket of the user, apps and
// bridges alike ({kind:'defaults'}); nothing is journaled — a bridge re-reads
// GET /defaults on every hello_ok, so there is nothing to replay.
import { json, readBody } from './http-body.js'
import { badRequest } from './http-who.js'
import { getDefaults, setDefaults, normaliseModel, normaliseEffort } from './defaults.js'

const KEYS = ['default_model', 'default_effort']

export async function handleDefaultsRoute(ctx, req, res, url, who) {
  if (url.pathname !== '/defaults') return false
  const { db, hub } = ctx
  if (req.method === 'GET') {
    json(res, 200, getDefaults(db, who.userId))
    return true
  }
  if (req.method !== 'PUT') return false
  const body = await readBody(req)
  if (Object.keys(body).some((k) => !KEYS.includes(k))) return badRequest(res)
  const patch = {}
  if ('default_model' in body) {
    patch.default_model = normaliseModel(body.default_model)
    if (patch.default_model === undefined) { json(res, 400, { error: 'bad_model' }); return true }
  }
  if ('default_effort' in body) {
    patch.default_effort = normaliseEffort(body.default_effort)
    if (patch.default_effort === undefined) { json(res, 400, { error: 'bad_effort' }); return true }
  }
  const { defaults, changed } = setDefaults(db, who.userId, patch, Date.now())
  if (changed) {
    try { hub.sendToUser(who.userId, { kind: 'defaults', ...defaults }) } catch (err) { console.error('defaults: live frame failed (saved)', err) }
  }
  json(res, 200, defaults)
  return true
}
