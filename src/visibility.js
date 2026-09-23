// The one cross-user read rule (spec 2026-09-23 tracker web/teams,
// "Visibility rule"): a viewer may read another user's conversation — and
// so the items, missions, milestones and prose excerpts hanging off it —
// when the conversation has a repo whose `host/org` scope both the viewer
// and the owner are verified members of (an `ok` GitHub link each), and
// the conversation is not owned by a private device. One SQL fragment, one
// function; every widened route uses these and nothing else, the way
// privacy.js is the only copy of the private-device sieve.
//
// The fragment binds the viewer as the NAMED parameter @viewer, so a caller
// can splice it into a larger statement without counting positional
// placeholders. It expresses the ORG rule only: callers that also want the
// owner to pass add `<alias>.owner_user_id = @viewer OR (...)`.
export const sharedConvoSql = (c) => `(
  ${c}.repo_scope IS NOT NULL
  AND ${c}.owner_user_id <> @viewer
  AND EXISTS (SELECT 1 FROM github_orgs gv
              JOIN github_accounts av ON av.user_id = gv.user_id AND av.state = 'ok'
              WHERE gv.user_id = @viewer AND gv.scope = ${c}.repo_scope)
  AND EXISTS (SELECT 1 FROM github_orgs go
              JOIN github_accounts ao ON ao.user_id = go.user_id AND ao.state = 'ok'
              WHERE go.user_id = ${c}.owner_user_id AND go.scope = ${c}.repo_scope)
  AND NOT EXISTS (SELECT 1 FROM devices d WHERE d.id = ${c}.agent_device_id AND d.private = 1)
)`

export function canReadConvo(db, viewerUserId, convoId) {
  const row = db.prepare(`SELECT c.owner_user_id = @viewer AS own, ${sharedConvoSql('c')} AS shared
    FROM conversations c WHERE c.id = @id`).get({ viewer: viewerUserId, id: convoId })
  return !!row && (!!row.own || !!row.shared)
}

export function sharedOrgScopes(db, viewerUserId) {
  return db.prepare(`SELECT g.scope FROM github_orgs g JOIN github_accounts a ON a.user_id = g.user_id AND a.state='ok'
    WHERE g.user_id = ? ORDER BY g.scope`).all(viewerUserId).map((r) => r.scope)
}
