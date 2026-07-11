import { snippetOf } from './journal.js'
import { clientDevicesForPush, pruneApnsToken, unreadBadge } from './db.js'

// Min gap between routine (priority-5) pushes to the same (device, convo).
const ROUTINE_COALESCE_MS = 10000

// Returns null for event types that must not push at all. Product call
// (dispatcher decision): convo_meta (a title rename) and session_status with
// state != 'done' (running/waiting flips) are journal-sync material — every
// connected device learns them from the journal frame, and nothing about
// them warrants buzzing a pocket. prompt/permission_request already cover
// "the session needs you", and the 'done' alert stays.
function classify(type, payload) {
  if (type === 'prompt' || type === 'permission_request') return { priority: 10, coalesce: false }
  if (type === 'session_status') {
    return payload && payload.state === 'done' ? { priority: 10, coalesce: false } : null
  }
  if (type === 'convo_meta') return null
  // Routine content: text/tool_output/diff/prompt_reply/file/image/etc. —
  // batched so a busy session is one updating notification, not hundreds.
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
  // send since no window is latched for it.
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
    // documented to never reject, but the .catch() (and the sync try/catch —
    // doSend is also called from timer callbacks, where an escaped throw
    // would crash the process) are backstops so a bug there can never leak
    // an unhandled rejection or exception out of the push pipeline.
    try {
      Promise.resolve(apnsClient.send({ deviceToken: device.apns_token, env: device.apns_env, ...opts }))
        .then((result) => handleResult(device, result))
        .catch((err) => {
          counters.failed += 1
          bumpReason('internal')
          console.error('apns: send threw unexpectedly', err)
        })
    } catch (err) {
      counters.failed += 1
      bumpReason('internal')
      console.error('apns: send threw synchronously', err)
    }
  }

  // Trailing-edge coalescing with a leading send when idle: the first
  // routine event for a (device, convo) pair sends immediately and latches
  // a window; further routine events within `coalesceMs` are held (latest
  // wins) and flushed once as a single trailing push when the window
  // elapses. Invariant: an entry exists in coalesceState iff its window
  // timer is armed — a timer that fires with nothing pending evicts the
  // entry, so the map never grows unboundedly across (device, convo) pairs.
  function scheduleRoutine(device, convoId, buildOpts) {
    const key = `${device.id}:${convoId}`
    const state = coalesceState.get(key)
    if (state) {
      state.pendingBuild = buildOpts // within the window: latest wins
      return
    }
    const fresh = { timer: null, pendingBuild: null }
    coalesceState.set(key, fresh)
    doSend(device, buildOpts()) // idle: leading send
    armWindow(key, fresh, device)
  }

  function armWindow(key, state, device) {
    state.timer = setTimeout(() => {
      const build = state.pendingBuild
      state.pendingBuild = null
      if (build) {
        doSend(device, build()) // trailing push, then a fresh window
        armWindow(key, state, device)
      } else {
        coalesceState.delete(key) // idle window: evict
      }
    }, coalesceMs)
    // Never keep the process alive for a pending trailing push; the state
    // is memory-only anyway (see comment above coalesceState).
    state.timer.unref()
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
    if (!cls) return // journal-sync-only type (convo_meta, non-done session_status)
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

  // _coalesceState is exposed for tests (eviction assertions) and as a
  // cheap gauge candidate for Task 5's /metrics; not part of the public API.
  return { onAppend, counters, close, _coalesceState: coalesceState }
}
