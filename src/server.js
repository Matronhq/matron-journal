import http from 'node:http'
import { openDb } from './db.js'
import { makeRateLimiter } from './auth.js'
import { makeHttpHandler } from './http.js'

export function startServer({ dbPath, port = 0, bind = '127.0.0.1' } = {}) {
  const db = openDb(dbPath || process.env.MATRON_DB || './matron.db')
  const rateLimiter = makeRateLimiter()
  const server = http.createServer(makeHttpHandler({ db, rateLimiter }))
  return new Promise((resolve) => {
    server.listen(port, bind, () => {
      resolve({
        port: server.address().port,
        db,
        server,
        close: () => new Promise((r) => { server.close(() => { db.close(); r() }) }),
      })
    })
  })
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const port = Number(process.env.MATRON_PORT || 9810)
  const bind = process.env.MATRON_BIND || '127.0.0.1'
  startServer({ port, bind }).then((s) => console.log(`matron-journal listening on ${bind}:${s.port}`))
}
