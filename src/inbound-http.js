// The doors an inbound source (src/inbound.js) comes through. Each takes
// the source's own key, `Authorization: Bearer <key>`. Posting ends in
// acceptReport either way, reading replies in readReplies.
//
//   POST /inbound/reports   {title?, body, links?}
//     201 {accepted:true} | 200 {accepted:false, duplicate:true}
//     400 bad_request | 413 too_large | 429 rate_limited (Retry-After)
//     403 account_locked
//
//   POST /inbound/replies   {}
//     200 {replies:[{at, text}], more} | 403 replies_off | account_locked
//     429 rate_limited (Retry-After)
//     Only for a source the user turned replies on for: what the user typed
//     in the source's conversation that its reports have not answered yet.
//
//   POST /inbound/mcp       a Model Context Protocol server (Streamable
//     HTTP, stateless, JSON replies) for assistants that connect to tools
//     by address. One tool, `post_report`, and with replies on a second,
//     `get_replies`. initialize, ping, tools/list and tools/call are
//     answered.
//
// Mounted in http.js AHEAD of the device Bearer auth, like the Alertmanager
// webhook, and with the same rule for wrong keys: each is charged to the
// caller address's unauthenticated budget (/login's), and once that is
// spent every request from the address is 429, a right key included. A
// journal with no source declines both paths, so they answer as any
// unknown path does.
import { json, readBody } from './http-body.js'
import { anySource, sourceForKey, acceptReport, readReplies, REPORT_BODY_MAX_BYTES, REPORT_TITLE_MAX, REPORT_LINKS_MAX, REPLIES_PER_READ_MAX } from './inbound.js'

export const INBOUND_REPORTS_PATH = '/inbound/reports'
export const INBOUND_MCP_PATH = '/inbound/mcp'
export const INBOUND_REPLIES_PATH = '/inbound/replies'
// Reads of replies, per source. A read hands over at most a page, so this
// bounds how fast a key can be used to watch the conversation.
export const REPLY_READS_HOURLY_MAX = 30
// The report's own cap plus room for the title, links and JSON escaping.
export const INBOUND_REQUEST_MAX = 3 * REPORT_BODY_MAX_BYTES
export const MCP_PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05']

const TOOL = {
  name: 'post_report',
  title: 'Post a report to Matron',
  description: 'Post one finished report to the user\'s Matron. It appears as a message in this source\'s own conversation. Text only: markdown and links. Post each report once.',
  inputSchema: {
    type: 'object',
    properties: {
      title: { type: 'string', maxLength: REPORT_TITLE_MAX, description: 'A one-line title.' },
      body: { type: 'string', description: `The report, in markdown. At most ${REPORT_BODY_MAX_BYTES} bytes.` },
      links: { type: 'array', maxItems: REPORT_LINKS_MAX, description: 'Sources, as web addresses.', items: { type: 'string' } },
    },
    required: ['body'],
    additionalProperties: false,
  },
}
const REPLIES_TOOL = {
  name: 'get_replies',
  title: 'Read the user\'s replies',
  description: `Read what the user typed in this source's Matron conversation that your reports have not answered yet, oldest first, at most ${REPLIES_PER_READ_MAX} at a time. Call it before you write a report, and answer the messages in that report. They stay listed until your next report is posted.`,
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
}
const INSTRUCTIONS = 'Use post_report to send a finished report to the user\'s Matron. This server takes reports only; it returns nothing about the user.'
const INSTRUCTIONS_REPLIES = 'Use get_replies before writing a report to read what the user typed in this conversation, and post_report to send the finished report. This server returns nothing else about the user.'

// What the caller is told. Never the text it sent.
function outcomeText(out) {
  if (out.status === 'accepted') return 'Posted.'
  if (out.status === 'duplicate') return 'Already posted: an identical report arrived within the last day. Nothing to do.'
  if (out.status === 'rate_limited') return `Not posted: this source is over its limit. Try again in ${out.retryAfter} seconds, and do not retry before then.`
  if (out.status === 'account_locked') return 'Not posted: the account is locked.'
  return `Not posted: ${out.detail || out.status}.`
}

function repliesText(out) {
  if (out.status === 'replies_off') return 'Replies are not turned on for this source.'
  if (out.status === 'account_locked') return 'Not read: the account is locked.'
  if (out.status === 'rate_limited') return `Not read: too many reads. Try again in ${out.retryAfter} seconds, and do not retry before then.`
  if (!out.replies.length) return 'No new messages from the user.'
  return [
    `${out.replies.length} message${out.replies.length === 1 ? '' : 's'} from the user, oldest first. Answer them in your next report; they stay listed until it is posted.${out.more ? ' There are more: they follow after that report.' : ''}`,
    ...out.replies.map((r) => `[${r.at}]\n${r.text}`),
  ].join('\n\n')
}

const rpcResult = (id, result) => ({ jsonrpc: '2.0', id, result })
const rpcError = (id, code, message) => ({ jsonrpc: '2.0', id: id ?? null, error: { code, message } })

export function makeInboundHandler({ db, hub = null, pushPipeline = null, rateLimiter = null, log = console.log }) {
  const ctx = { db, hub, pushPipeline }
  const post = (source, input) => {
    const out = acceptReport(ctx, source, input)
    // One line, no content: which source, the outcome, the size.
    log(`inbound: ${source.id} ${out.status}${out.bytes != null ? ` bytes=${out.bytes}` : ''}`)
    return out
  }
  // In memory: a restart forgives, which costs one more hour's worth.
  const reads = new Map()
  const replies = (source, now = Date.now()) => {
    const recent = (reads.get(source.id) || []).filter((ts) => ts > now - 60 * 60 * 1000)
    let out
    if (recent.length >= REPLY_READS_HOURLY_MAX) out = { status: 'rate_limited', retryAfter: Math.max(1, Math.ceil((recent[0] + 60 * 60 * 1000 - now) / 1000)) }
    else { recent.push(now); out = readReplies(db, source, { hub }) }
    reads.set(source.id, recent)
    // No content here either: how many, never what.
    log(`inbound: ${source.id} replies ${out.status}${out.replies ? ` n=${out.replies.length}` : ''}`)
    return out
  }
  return async (req, res, url, { rejectEarly }) => {
    const mcp = url.pathname === INBOUND_MCP_PATH
    const reading = url.pathname === INBOUND_REPLIES_PATH
    if (!mcp && !reading && url.pathname !== INBOUND_REPORTS_PATH) return false
    if (!anySource(db)) return false
    if (req.method !== 'POST') {
      // An MCP client may try GET for a stream this server does not offer.
      res.setHeader('allow', 'POST')
      rejectEarly(req, res, 405, { error: 'method_not_allowed' })
      return true
    }
    const ip = req.headers['cf-connecting-ip'] || req.socket.remoteAddress || 'unknown'
    if (rateLimiter?.blocked?.(ip)) { rejectEarly(req, res, 429, { error: 'rate_limited' }); return true }
    const given = /^Bearer (.+)$/.exec(req.headers.authorization || '')?.[1]
    const source = given ? sourceForKey(db, given.trim()) : null
    if (!source) {
      rateLimiter?.allow(ip)
      res.setHeader('www-authenticate', 'Bearer')
      rejectEarly(req, res, 401, { error: 'unauthenticated' })
      return true
    }
    // readBody's 400 (not JSON / not an object) and 413 (over the cap)
    // propagate to http.js's outer catch like every other route's.
    const body = await readBody(req, { maxBytes: INBOUND_REQUEST_MAX })
    if (reading) {
      const out = replies(source)
      if (out.status === 'ok') json(res, 200, { replies: out.replies, more: out.more })
      else if (out.status === 'rate_limited') { res.setHeader('retry-after', String(out.retryAfter)); json(res, 429, { error: 'rate_limited', retry_after: out.retryAfter }) }
      else json(res, 403, { error: out.status })
      return true
    }
    if (!mcp) {
      const out = post(source, body)
      if (out.status === 'accepted') json(res, 201, { accepted: true })
      else if (out.status === 'duplicate') json(res, 200, { accepted: false, duplicate: true })
      else if (out.status === 'rate_limited') { res.setHeader('retry-after', String(out.retryAfter)); json(res, 429, { error: 'rate_limited', retry_after: out.retryAfter }) }
      else if (out.status === 'too_large') json(res, 413, { error: 'too_large', detail: out.detail })
      else if (out.status === 'account_locked') json(res, 403, { error: 'account_locked' })
      else json(res, 400, { error: 'bad_request', detail: out.detail })
      return true
    }
    // --- MCP: one JSON-RPC message per POST ---
    const { id, method, params } = body
    if (body.jsonrpc !== '2.0' || typeof method !== 'string') {
      // A response or anything else a client sends that needs no answer.
      if (body.jsonrpc === '2.0' && method === undefined) { res.writeHead(202); res.end(); return true }
      json(res, 400, rpcError(id, -32600, 'Invalid Request'))
      return true
    }
    if (id === undefined) { res.writeHead(202); res.end(); return true } // a notification
    if (method === 'initialize') {
      const asked = params?.protocolVersion
      json(res, 200, rpcResult(id, {
        protocolVersion: MCP_PROTOCOL_VERSIONS.includes(asked) ? asked : MCP_PROTOCOL_VERSIONS[0],
        capabilities: { tools: {} },
        serverInfo: { name: 'matron-inbound', title: 'Matron', version: '1' },
        instructions: source.replies ? INSTRUCTIONS_REPLIES : INSTRUCTIONS,
      }))
    } else if (method === 'ping') {
      json(res, 200, rpcResult(id, {}))
    } else if (method === 'tools/list') {
      json(res, 200, rpcResult(id, { tools: source.replies ? [TOOL, REPLIES_TOOL] : [TOOL] }))
    } else if (method === 'tools/call') {
      // A source without replies is told the tool does not exist.
      if (params?.name === REPLIES_TOOL.name && source.replies) {
        const out = replies(source)
        json(res, 200, rpcResult(id, { content: [{ type: 'text', text: repliesText(out) }], isError: out.status !== 'ok' }))
        return true
      }
      if (params?.name !== TOOL.name) { json(res, 200, rpcError(id, -32602, `Unknown tool: ${String(params?.name).slice(0, 80)}`)); return true }
      const out = post(source, params.arguments)
      json(res, 200, rpcResult(id, { content: [{ type: 'text', text: outcomeText(out) }], isError: out.status !== 'accepted' && out.status !== 'duplicate' }))
    } else {
      json(res, 200, rpcError(id, -32601, 'Method not found'))
    }
    return true
  }
}
