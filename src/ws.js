import { WebSocketServer } from 'ws'
import { authToken } from './auth.js'
import { eventsAfter } from './journal.js'

const journalFrame = (e) => ({
  kind: 'journal', seq: e.seq, convo_id: e.convo_id, ts: e.ts,
  sender: e.sender, type: e.type, payload: e.payload,
})

export function attachWs({ server, db, hub, pingMs = 20000 }) {
  const wss = new WebSocketServer({ server, path: '/ws' })
  const interval = setInterval(() => {
    for (const ws of wss.clients) {
      if (ws._alive === false) { ws.terminate(); continue }
      ws._alive = false
      ws.ping()
    }
  }, pingMs)
  wss.on('close', () => clearInterval(interval))

  wss.on('connection', (ws) => {
    ws._alive = true
    ws.on('pong', () => { ws._alive = true })
    let conn = null

    ws.on('message', (data) => {
      let msg
      try { msg = JSON.parse(data) } catch { return }
      if (!conn) {
        if (msg.op !== 'hello') { ws.close(); return }
        const who = msg.token && authToken(db, msg.token)
        if (!who) {
          ws.send(JSON.stringify({ kind: 'control', op: 'error', code: 'auth' }))
          ws.close()
          return
        }
        conn = { ws, ...who, viewingConvoId: null }
        const head = db.prepare('SELECT seq FROM user_seq WHERE user_id=?').get(who.userId)
        ws.send(JSON.stringify({ kind: 'control', op: 'hello_ok', seq: head ? head.seq : 0 }))
        if (msg.cursor != null) {
          let cursor = msg.cursor
          for (;;) {
            const batch = eventsAfter(db, who.userId, cursor, 500)
            for (const e of batch) ws.send(JSON.stringify(journalFrame(e)))
            if (batch.length < 500) break
            cursor = batch[batch.length - 1].seq
          }
        }
        hub.register(conn)
        return
      }
      handleOp({ db, hub, conn, msg })
    })

    ws.on('close', () => { if (conn) hub.unregister(conn) })
  })
  return wss
}

// Extended by Tasks 7-8 with client and agent operations.
export function handleOp({ db, hub, conn, msg }) {
  if (msg.op === 'viewing') {
    conn.viewingConvoId = msg.convo_id ?? null
  }
}

export { journalFrame }
