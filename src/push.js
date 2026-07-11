import { snippetOf } from './journal.js'
import { clientDevicesForPush, pruneApnsToken, unreadBadge } from './db.js'

// Min gap between routine (priority-5) pushes to the same (device, convo).
const ROUTINE_COALESCE_MS = 10000

function classify(type, payload) {
  if (type === 'prompt' || type === 'permission_request') return { priority: 10, coalesce: false }
  if (type === 'session_status' && payload && payload.state === 'done') return { priority: 10, coalesce: false }
  // Everything else routine: text/tool_output/diff/convo_meta/prompt_reply/
  // non-done session_status/etc. — batched so a busy session is one updating
  // notification, not hundreds.
  return { priority: 5, coalesce: true }
}

// Wired in server.js after a successful journal append fans out (see the
// `fanOut` choke point in ws.js). `apnsClient` is the makeApnsClient()
// instance, or undefined when push is disabled (all onAppend calls become a
// cheap no-op).
export function makePushPipeline({ db, hub, apnsClient, coalesceMs = ROUTINE_COALESCE_MS } = {}) {
  const counters = { sent: 0, failed: 0, pruned: 0, byReason: {} }

  // Coalescing state lives in memory only, keyed by `${deviceId}:${convoId}`.
  // A process restart loses any pending trailing push — acceptable for v1;
  // the next routine event after restart just does a fresh leading-edge
  // send since there's no recorded lastSentAt for it.
  const coalesceState = new Map()

  const bumpReason = (key) => { counters.byReason[key] = (counters.byReason[key] || 0) + 1 }

  function handleResult(device, result) {
    if (result.status >= 200 && result.status < 300) {
      counters.sent += 1
      return
    }
    counters.failed += 1
    bumpReason(result.reason || (result.status === 0 ? 'transport' : String(result.status)))
    if (result.status === 410) {
      // Dead token: prune instead of retrying it forever.
      pruneApnsToken(db, device.id)
      counters.pruned += 1
      console.error(`apns: device ${device.id} unregistered (410${result.reason ? ' ' + result.reason : ''}) — token pruned`)
    } else if (result.status === 400) {
      // Sygnal lesson: this is almost always a sandbox/prod environment
      // mismatch, not a dead token — keep it, but log loudly so it gets fixed.
      console.error(`apns: device ${device.id} got 400${result.reason ? ' ' + result.reason : ''} — keeping token, check apns_env (env=${device.apns_env})`)
    } else {
      console.error(`apns: device ${device.id} push failed: status=${result.status}${result.reason ? ' reason=' + result.reason : ''}`)
    }
  }

  function doSend(device, opts) {
    // Fire and forget from the caller's perspective: apnsClient.send() is
    // documented to never reject, but the .catch() is a backstop so a bug
    // there can never leak an unhandled rejection out of the push pipeline.
    Promise.resolve(apnsClient.send({ deviceToken: device.apns_token, env: device.apns_env, ...opts }))
      .then((result) => handleResult(device, result))
      .catch((err) => {
        counters.failed += 1
        bumpReason('internal')
        console.error('apns: send threw unexpectedly', err)
      })
  }

  // Trailing-edge coalescing with a leading send when idle: the first
  // routine event for a (device, convo) pair sends immediately; further
  // routine events within `coalesceMs` are held (latest wins) and flushed
  // once as a single trailing push when the window elapses.
  function scheduleRoutine(device, convoId, buildOpts) {
    const key = `${device.id}:${convoId}`
    const now = Date.now()
    let state = coalesceState.get(key)
    if (!state) { state = { lastSentAt: 0, timer: null, pendingBuild: null }; coalesceState.set(key, state) }

    if (!state.timer && now - state.lastSentAt >= coalesceMs) {
      state.lastSentAt = now
      doSend(device, buildOpts())
      return
    }
    state.pendingBuild = buildOpts // latest wins
    if (!state.timer) {
      const delay = Math.max(coalesceMs - (now - state.lastSentAt), 0)
      state.timer = setTimeout(() => {
        state.timer = null
        state.lastSentAt = Date.now()
        const build = state.pendingBuild
        state.pendingBuild = null
        if (build) doSend(device, build())
      }, delay)
      // Never keep the process alive for a pending trailing push; the state
      // is memory-only anyway (see comment above coalesceState).
      state.timer.unref()
    }
  }

  function onAppend(userId, event, originDeviceId) {
    if (!apnsClient) return
    const convo = db.prepare('SELECT id, title FROM conversations WHERE id=? AND owner_user_id=?').get(event.convo_id, userId)
    if (!convo) return
    // kind='client' only — agent devices are never pushed to.
    const devices = clientDevicesForPush(db, userId)
    if (devices.length === 0) return
    const badge = unreadBadge(db, userId)

    if (event.type === 'read_marker') {
      for (const device of devices) {
        if (device.id === originDeviceId) continue // never push a device its own read_marker
        if (!device.apns_env) continue
        doSend(device, {
          payload: { aps: { 'content-available': 1, badge } },
          priority: 5,
          pushType: 'background',
        })
      }
      return
    }

    const cls = classify(event.type, event.payload)
    const title = convo.title || convo.id
    const body = snippetOf(event.type, event.payload)
    for (const device of devices) {
      if (!device.apns_env) continue
      if (hub.isViewing(userId, device.id, event.convo_id)) continue
      if (device.cursor >= event.seq) continue
      const buildOpts = () => ({
        payload: { aps: { alert: { title, body }, badge, 'thread-id': event.convo_id } },
        priority: cls.priority,
        pushType: 'alert',
        collapseId: event.convo_id,
      })
      if (cls.coalesce) {
        scheduleRoutine(device, event.convo_id, buildOpts)
      } else {
        doSend(device, buildOpts())
      }
    }
  }

  function close() {
    for (const state of coalesceState.values()) {
      if (state.timer) clearTimeout(state.timer)
    }
    coalesceState.clear()
  }

  return { onAppend, counters, close }
}
