// HTTP surface of contacts across journals (src/federation-contacts.js;
// docs/protocol.md "Contacts across journals"). Client devices only: an
// invite link is a capability, shown to the user's own device and never to
// an agent, and opening one is the user's own consent.
//
//   POST   /contacts/invites               mint an invite → {invite, link} (the link, once)
//   GET    /contacts/invites               my invites of the last 30 days
//   DELETE /contacts/invites/:id           withdraw an open invite
//   POST   /contacts/invites/open {link}   who the link is from (nothing is sent)
//   POST   /contacts/invites/accept {link} add them: queues the answer → 202 {contact}
import { json, readBody } from './http-body.js'
import { badRequest, notFound, conflict } from './http-who.js'
import { contactRow } from './contacts.js'

const CONFLICTS = new Set([
  'own_journal', 'journal_not_allowed', 'fingerprint_mismatch', 'journal_blocked',
  'already_contact', 'pending', 'blocked', 'too_many_invites', 'too_many_contacts', 'not_open',
])
// The other journal could not be asked: its well-known did not answer, or
// answered with something that is not a journal's identity.
const UPSTREAM = new Set(['unreachable', 'bad_journal'])

function refusal(res, err) {
  if (err.message === 'bad_link') return badRequest(res)
  if (err.message === 'unlisted') { json(res, 403, { error: 'forbidden' }); return true }
  if (CONFLICTS.has(err.message)) return conflict(res, { blocked_by: err.message })
  if (UPSTREAM.has(err.message)) { json(res, 502, { error: err.message }); return true }
  throw err
}

export async function handleInviteRoute({ federationContacts: fed = null }, req, res, url, who) {
  const path = url.pathname
  if (path !== '/contacts/invites' && !path.startsWith('/contacts/invites/')) return false
  if (who.kind !== 'client') { json(res, 403, { error: 'forbidden' }); return true }
  if (!fed) return conflict(res, { blocked_by: 'federation_off' })
  try {
    if (path === '/contacts/invites') {
      if (req.method === 'GET') { json(res, 200, { invites: fed.listInvites(who.userId) }); return true }
      if (req.method === 'POST') { json(res, 201, fed.createInvite(who.userId)); return true }
      return false
    }
    if (path === '/contacts/invites/open' || path === '/contacts/invites/accept') {
      if (req.method !== 'POST') return false
      const body = await readBody(req)
      if (typeof body.link !== 'string') return badRequest(res)
      if (path.endsWith('/open')) { json(res, 200, await fed.preview(who.userId, body.link)); return true }
      const row = await fed.accept(who.userId, body.link)
      json(res, 202, { contact: contactRow(row), pending: 'peer' })
      return true
    }
    const m = path.match(/^\/contacts\/invites\/([^/]+)$/)
    if (!m || req.method !== 'DELETE') return false
    let id
    try { id = decodeURIComponent(m[1]) } catch { return badRequest(res) }
    const invite = fed.revokeInvite(who.userId, id)
    if (!invite) return notFound(res)
    json(res, 200, { invite })
    return true
  } catch (err) {
    return refusal(res, err)
  }
}
