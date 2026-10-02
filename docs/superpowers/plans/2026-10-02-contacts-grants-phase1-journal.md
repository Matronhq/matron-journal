# Contacts and read-only mission share, same journal — journal plan (phase 1)

**Date:** 2026-10-02 · **Spec:** `docs/superpowers/specs/2026-10-02-matron-to-matron-sharing-design.md`
(build plan step 1) · **Companion:** matron-bridge
`docs/superpowers/plans/2026-10-02-contacts-mission-share-bridge.md`

## Goal

Dan can add Tim as a contact, Tim accepts once, Dan shares a mission with
Tim read-only, Tim sees it live, and either side can revoke. Both users are
on this journal (`peer_journal IS NULL`); the schema already carries
`user@journal` addresses so phase 5 (federation) adds rows, not columns.

## Decisions this plan takes (beyond the spec's nine)

1. **A read grant does not open transcripts.** The spec says `canReadConvo`
   gains the grant clause, and also (decision 6) that transcripts never
   cross. The second wins: the grant clause is a *mission* rule
   (`grantedMissionSql`, `canReadMission`) plus a blob clause in
   `canReadBlob`. `canReadConvo` is unchanged, so `/convo/:id/messages` and
   `/milestones?convo=` stay closed to a grantee.
2. **A grantee sees the mission as an ordinary agent of the owner would,
   minus ids.** Milestones and items from private-device conversations stay
   hidden, consent mirrors stay hidden, a privately written status stays
   hidden, and a private-origin mission cannot be shared at all
   (`409 private_mission`). Conversation ids, device ids, box names, seqs
   and the project are stripped: the conversation list is always empty.
3. **A read share needs the grantee's accept too.** One card each side:
   the owner approves what leaves (when an agent asked), the grantee accepts
   what arrives. Same shape as the hand-over flow in the spec, so phase 3
   reuses it.
4. **Cards from or to another person are answered by a client device
   only.** Every answer route refuses agents with 403, the asks never
   appear in `/consent/pending`, and `/consent/answer` keeps its two kinds.
   That covers the Coordinator by construction, in both directions (its
   own user's outgoing asks included: they send data to another person).
5. **A per-user system conversation, "People", is the home of the
   recipient-side cards, their consent items and the audit events.** The
   log is per user and every event needs a conversation; the recipient of
   a contact request has none in common with the sender. It is created on
   first use, has no agent, and no agent can read, write or adopt it.
6. **Consent items carry `Accept`/`Decline` (or `Approve`/`Decline`)
   action buttons**, and a tap on one applies the decision. Today's apps
   render item actions, so phase 1 is usable before the phase 4 app work.
7. **Asks an agent parks for its own user expire after 24 h** like spawn
   and chat asks. Asks waiting on the other person do not expire; the
   requester can withdraw them (remove the contact, revoke the grant).
8. **Agents may remove, block and revoke** (they reduce access). They may
   not unblock, accept or approve.

## Schema (`src/db.js`)

```sql
contacts(id TEXT PK, user_id, peer_user TEXT, peer_journal TEXT NULL,
         peer_journal_key TEXT NULL, peer_user_id INTEGER NULL,   -- local row of a same-journal peer
         display_name TEXT, state,     -- awaiting_user|pending_out|pending_in|active|blocked|declined|removed|expired
         requested_by, origin_convo_id, origin_device_id, item_id,
         created_at, updated_at, accepted_at, revoked_at)
  UNIQUE(user_id, peer_user, COALESCE(peer_journal, ''))

grants(id TEXT PK, owner_user_id, subject_kind,  -- mission|project|room
       subject_id, contact_id, level,             -- read|contribute|owner
       state,                                     -- awaiting_owner|pending|active|declined|revoked|expired
       requested_by, origin_convo_id, origin_device_id,
       owner_item_id, grantee_item_id, revoked_by,
       created_at, updated_at, answered_at, revoked_at)
  UNIQUE(subject_kind, subject_id, contact_id)

conversations.system TEXT NULL      -- 'people' on the system conversation
```

`awaiting_user` / `awaiting_owner` are the spec's states plus "my own agent
asked and I have not said yes yet". A row is reused when a request is made
again after a decline, removal or expiry (same stance as `convo_agents`).
`items.consent` gains the values `'contact'` and `'share'`.

## Modules

| File | What |
|---|---|
| `src/people-convo.js` | `ensurePeopleConvo`, `isSystemConvo`; the guards in `journal.js` (`upsertConversation` refuses, `agentTargetsFor` → empty set), `auth.js` (`authorizeAgentWrite` false), `/snapshot` and `/roster` (agents never list it) |
| `src/contacts.js` | Pure DB: request, send, answer, remove, block, unblock, list, user directory, expiry |
| `src/grants.js` | Pure DB: share, answer, revoke, list, expiry, `revokeGrantsBetween`, the grantee's read view (`listGrantedMissions`, `getGrantedMission`, `grantedMissionDetail`, `getGrantedItem`, `grantedComments`) |
| `src/visibility.js` | `grantedMissionSql`, `canReadMission`, `canWriteMission` (owner only today), grant clause in `canReadBlob` |
| `src/sharing-events.js` | Side effects: cards, consent items and their closing, `people` audit events, live frames, push |
| `src/sharing-http.js` | Routes below |

## Routes

```
GET    /contacts/users                 names of this journal's other users
GET    /contacts                       my contacts, every state
POST   /contacts {user, convo_id?}     request (agent: parks for my approval; client: sends)
POST   /contacts/:id/answer {decision} client only: approve|decline
POST   /contacts/:id/block             DELETE /contacts/:id (remove)
POST   /contacts/:id/unblock           client only
GET    /contacts/:id/activity          the audit events for one contact
POST   /missions/:id/shares {contact, level, convo_id?}
GET    /missions/:id/shares            owner: grants on this mission
GET    /grants?direction=in|out        POST /grants/:id/answer {decision}   DELETE /grants/:id
GET    /missions?scope=shared          + missions granted to me (shared_via: 'grant')
GET    /missions/:id                   + granted detail          GET /items/:id  + granted item
GET    /media/:id                      + attachments on a granted mission's items
```

A tap on a consent item's action button (`POST /items/:id/comments
{action}`) on a `contact`/`share` mirror applies the same decision.

## Events

- `permission_request` cards, `kind: 'contact_request' | 'mission_share'`,
  `direction: 'out' | 'in'`. Client-only (`isClientOnlyEvent`), so no agent
  ever replays one and no agent can forge one.
- `people` audit events (`contact.requested|accepted|declined|removed|
  blocked|expired`, `grant.requested|shared|accepted|declined|revoked|
  expired`), one in each user's People conversation. Client-only, never a
  push.
- Live: `{kind:'shared', event:'mission_changed', mission_id, owner, what}`
  to the grantee's client sockets on every milestone, mission update/close
  and item write on a granted mission; `{kind:'people', event:'changed'}`
  to both users' clients on any contact or grant transition.

## Tasks

1. Schema, `people-convo.js` and its guards. Tests: an agent cannot upsert,
   publish into, list or replay the People conversation.
2. `contacts.js` + tests: request/accept/decline, crossed requests, block
   refuses future requests silently, remove, re-request, expiry.
3. `grants.js` + `visibility.js` + tests: the clause needs an active grant
   and both contact rows active; private sieve; revocation; contact
   removal revokes grants in both directions; blob clause.
4. `sharing-events.js` + `sharing-http.js` + wiring in `http.js`,
   `items-http.js` (action tap, live frame), `missions-http.js` (shared
   reads, live frame), sweep in `ws.js`.
5. HTTP/WS tests: full flow Dan→Tim with real sockets, live frames, cards
   on both sides, Coordinator cannot list or answer, agents cannot answer,
   revocation hides the mission at once, audit trail on both sides.
6. `docs/protocol.md` section "Contacts and grants".

## Not in this phase

Contribute and owner levels (accepted by the schema, refused by the
route), hand-over, cross-person rooms and foreign turns, federation, app
screens, project and room grants.
