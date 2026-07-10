import { startServer } from '../src/server.js'

export async function startTestServer() {
  const s = await startServer({ dbPath: ':memory:', port: 0 })
  const base = `http://127.0.0.1:${s.port}`
  return {
    ...s,
    base,
    async http(path, { method = 'GET', token = null, body = null } = {}) {
      const r = await fetch(base + path, {
        method,
        headers: {
          ...(token ? { authorization: `Bearer ${token}` } : {}),
          ...(body ? { 'content-type': 'application/json' } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
      })
      let j = null
      try { j = await r.json() } catch { /* empty body */ }
      return { status: r.status, json: j }
    },
  }
}
