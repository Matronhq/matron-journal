#!/usr/bin/env node
// Auto-reply agent for the App Review demo account.
//
// Connects to the journal as an agent device and answers every user text
// message with one fixed reply. Also services the app's structured RPCs
// (`recent_folders`, `start`) so the new-session flow works during review.
//
// Stateless by design: every (re)connect replays from cursor 0 and re-offers
// a reply for every user message ever seen; the server's idempotency keys
// (`demo-reply:<seq of the user message>`) make all but the first a no-op.
// That only holds while the same agent device row exists — if you revoke and
// re-mint the agent, old messages get a second reply on the next replay.
//
// Config (env): MATRON_WS_URL (default ws://127.0.0.1:9810/ws),
// MATRON_DEMO_TOKEN_FILE (required, agent bearer token),
// MATRON_DEMO_REPLY (override the canned answer).
import WebSocket from 'ws'
import fs from 'node:fs'
import crypto from 'node:crypto'

const WS_URL = process.env.MATRON_WS_URL || 'ws://127.0.0.1:9810/ws'
const TOKEN_FILE = process.env.MATRON_DEMO_TOKEN_FILE
if (!TOKEN_FILE) { console.error('MATRON_DEMO_TOKEN_FILE is required'); process.exit(1) }
const token = fs.readFileSync(TOKEN_FILE, 'utf8').trim()

const REPLY = process.env.MATRON_DEMO_REPLY ||
  'Thanks for your message! I’m a demo responder for App Review, so I always reply with this same fixed answer. In normal use, Matron connects to a live Claude Code agent running on your own computer, and its replies stream here in real time.'
const INTRO =
  'This is a new demo conversation. Send a message and I’ll reply — though as a demo responder, I always send the same fixed answer.'
const REPLY_DELAY_MS = 1200

function connect() {
  const ws = new WebSocket(WS_URL)
  const send = (f) => { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(f)) }
  // Conversations this connection has already upserted. Publishing requires
  // ownership, and ownership is last-writer-wins, so one state-only upsert
  // per conversation per connection claims it without emitting convo_meta.
  const claimed = new Set()
  const claim = (convoId) => {
    if (claimed.has(convoId)) return
    claimed.add(convoId)
    send({ op: 'convo_upsert', convo_id: convoId })
  }

  ws.on('open', () => send({ op: 'hello', token, cursor: 0 }))
  ws.on('message', (data) => {
    let f
    try { f = JSON.parse(data.toString()) } catch { return }
    if (f.kind === 'control' && f.op === 'hello_ok') {
      console.log(`connected, head seq ${f.seq}`)
      return
    }
    if (f.kind === 'control' && f.op === 'error') {
      console.error(`server error: ${JSON.stringify(f)}`)
      return
    }
    if (f.kind === 'journal' && f.type === 'text' &&
        typeof f.sender === 'string' && f.sender.startsWith('user:')) {
      claim(f.convo_id)
      send({ op: 'activity', convo_id: f.convo_id, state: 'thinking' })
      setTimeout(() => {
        send({ op: 'publish', convo_id: f.convo_id, type: 'text', idem_key: `demo-reply:${f.seq}`, payload: { body: REPLY } })
        send({ op: 'activity', convo_id: f.convo_id, state: 'idle' })
        console.log(`replied to seq ${f.seq} in ${f.convo_id}`)
      }, REPLY_DELAY_MS)
      return
    }
    if (f.kind === 'rpc' && f.request) {
      const { request_id, from_device_id, method } = f.request
      if (method === 'recent_folders') {
        send({ op: 'agent_response', request_id, to_device_id: from_device_id, ok: true, result: { folders: [{ path: '/home/demo/projects/matron', last_used: Date.now() }] } })
      } else if (method === 'start') {
        const convo_id = crypto.randomUUID()
        claimed.add(convo_id)
        send({ op: 'convo_upsert', convo_id, title: 'Demo conversation' })
        send({ op: 'publish', convo_id, type: 'text', idem_key: `demo-intro:${convo_id}`, payload: { body: INTRO } })
        send({ op: 'agent_response', request_id, to_device_id: from_device_id, ok: true, result: { convo_id } })
        console.log(`started ${convo_id} for rpc ${request_id}`)
      } else {
        send({ op: 'agent_response', request_id, to_device_id: from_device_id, ok: false, error: { code: 'unknown_method' } })
      }
    }
  })
  ws.on('error', (e) => console.error(`ws error: ${e.message}`))
  ws.on('close', () => {
    console.log('disconnected, retrying in 5s')
    setTimeout(connect, 5000)
  })
}

connect()
