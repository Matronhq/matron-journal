# Matron-to-Matron sharing between people — design

**Date:** 2026-10-02 · **Requested by:** Dan (voice note, 2 Oct: he set
his friend Tim up with Matron, started a project on his own, and wants the
two Matrons to talk — to hand a project over or discuss an idea) ·
**Status:** design only, decisions taken with Dan one question at a time
on 2 Oct · **Repos touched (later):** matron-journal, matron-bridge,
matron-apple, matron-android, matron-web.

## Problem

Everything Matron does between agents stops at the user boundary.
`agent_invite`, `spawn_request` and the consent cards all require a target
device of the *same* user (`protocol.md` "agent_invite": another user's
device is `not_found`). The only cross-user path is read-only tracker
visibility derived from GitHub org membership (`src/visibility.js`), which
is implicit, all-or-nothing per repo, and cannot write.

So when Dan hands the Birthday Club / S&R work to Tim, the hand-over is
done by hand: SSH to Tim's box, a `~/CLAUDE.md` written into it, agents on
Dan's side talking among themselves. Tim's Matron never sees Dan's mission,
and neither agent can talk to the other.

Tim today is the user `tim` on Dan's journal (chat.yearbooks.be), with a VM
on shared-4. Other people will self-host. So there are two cases: two
users on one journal, and two users on different journals.

## Decisions (taken with Dan, 2 Oct)

1. **Both cases, same journal first.** Addresses are `user@journal` from
   day one; a same-journal share is the degenerate case where the remote
   journal is this one. Cross-journal is a later phase on the same model.
2. **All three kinds of sharing:** read-only share, hand-over, and a
   joint room / joint mission.
3. **Joint missions have one owner.** Others hold a grant at a level,
   `read` < `contribute` < `owner`. Contributors' writes go to the owning
   journal. A hand-over is moving `owner`. No per-side copies, no CRDT.
4. **Contacts by invite link or QR, no directory.** Same journal: pick
   from the user list, the other side gets an accept card. Cross-journal:
   an invite through the encrypted rendezvous on push.matron.chat. The
   push server stays identity-free.
5. **Cross-journal transport is direct.** Journal-to-journal HTTPS, every
   request signed with the sending journal's Ed25519 key, keys pinned when
   the contact is made. A sealed-box mailbox on the push server is a later
   fallback for unreachable journals, using the same envelope.
6. **Payload: the tracker record plus an agent-written brief, no
   transcripts.** Memories, secrets, transcripts, tool output, device and
   box names never cross.
7. **Agents talk freely, act only with their owner's OK.** In a room with
   another person's agent, anything that changes state or sends data out
   needs a consent card to the owner; the bridge enforces it.
8. **Same-journal users accept each other explicitly.** Being on the same
   journal does not make two people contacts; one accept card is needed,
   the same rule as across journals.
9. **After a hand-over the old owner keeps `read`** on the new copy, and
   the new owner can revoke it.

## Model

Three new concepts. Everything else (rooms, consent cards, consent items,
missions, items) is reused.

### Contacts

```
contacts(id, user_id, peer_user TEXT,        -- 'tim' or 'tim@tim.example'
         peer_journal TEXT NULL,             -- NULL = this journal
         peer_journal_key TEXT NULL,         -- pinned Ed25519 public key
         display_name, state,                -- pending_out|pending_in|active|blocked
         created_at, accepted_at, revoked_at)
```

A contact is mutual: a row on each side, both `active`. Nothing can be
shared, and no room invite addressed, except to an active contact. Either
side can block or remove at any time; removal revokes every grant between
the two (below).

- **Same journal:** "Add contact" lists the journal's users (names only);
  the other user gets a consent card and a `consent` question item, as
  agent-chat asks do today.
- **Cross-journal:** "Add contact" mints an invite. The app shows a QR /
  share link carrying a rendezvous id and a one-time key
  (`matron://contact?v=1&rid=…&k=…`, same construction as the 2026-07-18
  rendezvous offer encryption). The sealed offer holds the inviter's
  `user@journal`, journal base URL and journal public key. The invitee's
  journal opens it, posts its own sealed answer back to the rendezvous,
  and both journals then confirm directly over `/federation/contact`
  (signed). Each side pins the other's key; a key change later is a hard
  failure that needs a fresh invite.

### Grants

```
grants(id, owner_user_id, subject_kind,       -- 'mission' | 'project' | 'room'
       subject_id, contact_id, level,          -- read | contribute | owner
       state, created_at, revoked_at)
```

This is the `grants(convo_id, user_id, level)` table the 2026-07-10
protocol design sketched as future work, widened from conversations to
missions, projects and rooms.

- **read:** the grantee sees the mission (title, body, status, milestones
  as text, items and comments, attachments) in their tracker as "shared by
  dan". Live: new milestones and comments appear as they happen.
- **contribute:** read, plus post milestones, comment, create items,
  change item state, set mission status. Writes are attributed to the
  contributor (`by tim`) and land in the owner's journal, with the owner's
  numbering.
- **owner:** exactly one per subject. Transferring it is a hand-over.

`src/visibility.js` stays the single read rule: `canReadConvo`/`canRead*`
gain a "has an active grant via an active contact" clause alongside the
GitHub-org clause. Writes get a matching `canWrite*` that today only
admits the owner.

### Hand-over

A hand-over is a grant transfer plus a move:

1. The owner's agent drafts a **hand-over brief** (where things stand,
   repos, what's next, gotchas) and calls a new `mission_share` tool with
   `level: 'owner'`.
2. The owner gets a consent card previewing exactly what will cross:
   counts of milestones, items and comments, the attachment list with
   untick boxes, and the brief. Nothing leaves before approval.
3. The recipient gets a consent card: "dan wants to hand you mission
   *X*". On accept, the recipient's journal creates the mission in their
   own tracker with **their** numbering. The brief is the first comment;
   milestones arrive as text (their transcript jump links become plain
   text, since the transcripts don't cross).
4. The original is closed as "Handed to tim" with a link to the new one,
   and the former owner keeps a `read` grant on the new copy unless the
   recipient revokes it.

A same-journal hand-over could move rows in place. It copies anyway, so
both cases share one code path and the recipient's numbering is always
their own.

### Joint rooms

A room between two people's agents is an ordinary agent-chat room whose
`convo_agents` grant row names a device of a contact. The same-user check
in `agent_invite` becomes "same user, or a device of an active contact".
`agent_roster` gains the contact's *shareable* sessions (sessions the
contact has opted to expose by name, never the whole roster), and the
consent card names the person as well as the box.

- Both people's consent is needed: the inviter's agent asks its owner,
  then the invitee's owner gets the card. Neither Coordinator may answer a
  card that originates from another person (`coordinator_consent` does
  not apply across the user boundary).
- Both people can read the room. Each side's apps show it under the
  person's name.
- A room may be attached to a joint mission; then it is that mission's
  discussion and inherits its grants.

### What crosses, and what never does

Crosses (only after the sender's consent card): mission title/body/status,
milestones as text, items with comment threads, selected attachments, the
project name for a project hand-over, the brief, room messages.

Never crosses: conversation transcripts and tool output, memories,
secrets and secure-viewer links, other missions, device and box names,
workdirs, reminders, the contact's roster beyond opted-in sessions.

Peer text is untrusted on arrival exactly as today (`peer-text.js`
flattening, quoted fields, never shown as the user's own words).

### Agents across the person boundary

The bridge marks a turn triggered by another person's message (room text
or a contributor's write) as **foreign**. A foreign turn runs with a
restricted tool set: tracker reads and writes on the shared mission, room
send, and nothing else — no Bash, Write/Edit, secrets, spawns, session
control or memories. The agent can discuss and answer from what is already
shared. To do more (run a command, push code, share a new file, grant
access, quote anything outside the shared mission) it files a consent card
to its own user, and only a tap lifts the restriction, for that one
action.

## Cross-journal transport

Each journal gets an Ed25519 keypair (`MATRON_FEDERATION_KEY`, generated on
first start, the public half served at `/.well-known/matron-journal`).

Every federated call is an HTTPS request to the peer's
`/federation/<op>` with a signed envelope:

```
{ v: 1, from: 'dan@chat.yearbooks.be', to: 'tim@tim.example',
  op, id, ts, body }   + Ed25519 signature over the canonical JSON
```

The receiver checks the signature against the pinned key for that contact,
rejects stale `ts` (±5 min) and replayed `id`s, then applies the op under
the same rules as a local call. Ops: `contact`, `grant`, `grant.revoke`,
`mission.snapshot`, `mission.event` (milestone, comment, status — pushed by
the owner to read/contribute grantees), `mission.write` (a contributor's
write, sent to the owner), `room.invite`, `room.message`, `media.fetch`
(attachments pulled on demand, authorised by grant).

The sender keeps a durable outbox and retries with backoff; the receiver is
idempotent on `id`. Messages are visible to both journals in plaintext.
That is intended: each journal is trusted by its own users and must read
the content for its agents. TLS covers the wire, and nothing else sits in
the middle.

**Later: mailbox fallback.** For a journal that cannot be reached directly,
the same signed envelope is sealed (X25519 + AES-256-GCM to the peer
journal's key) and dropped in a per-contact mailbox on push.matron.chat,
which sees only ciphertext and a mailbox id. Not built until someone
needs it.

## Audit and revocation

- Every contact, grant, hand-over, cross-person room and foreign-turn
  consent is an event in both users' logs, and a per-contact "Activity"
  list in the apps reads them back.
- Revoking a grant or removing a contact takes effect at once on the
  owner's journal and is sent to the peer, which hides the shared mission
  and leaves the room. What was already copied stays copied (a hand-over
  is a gift; a read share is not a vault).
- Blocking a contact also refuses future invites from that address.

## Alternatives considered

- **Searchable directory on the push server.** Easiest discovery, but it
  makes the relay hold personal data and become an identity provider with
  verification and abuse handling. Rejected for now; an opt-in directory
  can sit on top of contacts later.
- **End-to-end encryption between people's devices.** The journal and its
  agents could not read the content, which defeats the point. The only
  untrusted hop is the relay, and the mailbox fallback seals against that.
- **Per-side copies of a joint mission (CRDT-style).** Resilient and
  offline-friendly, but numbering, ordering and "who closes it" get hard,
  and the journal was designed as one user, one log. Rejected in favour
  of one owner plus grants.
- **Transcripts in the hand-over.** Most context, but full of paths,
  environment details and the occasional secret, and hard to scrub
  reliably. The agent-written brief replaces them.
- **Matrix-style federation.** Matron left Matrix; full room federation
  with state resolution is far more than two journals need.

## Build plan (each a follow-up mission for Dan to approve)

1. **Contacts and grants, same journal (journal + bridge).** `contacts`
   and `grants` tables, `visibility.js` clauses, read-only mission share,
   bridge `contact_*` and `mission_share` tools, "shared by" rendering.
   Covers sharing a mission with Tim now.
2. **Cross-person rooms and foreign turns (journal + bridge).** Relax the
   `agent_invite` same-user check to contacts, opted-in roster entries,
   both-sides consent, no Coordinator approval across people, the bridge's
   restricted foreign-turn tool set and consent-to-act cards.
3. **Contribute and hand-over (journal + bridge).** Contributor writes with
   attribution, the hand-over flow with preview, brief and copy-and-close.
4. **Apps.** Contacts screen, add-contact (user list on the same journal,
   QR/link for cross-journal), shared-mission and person badges, consent
   card variants, per-contact activity. Apple first, then Android and web.
5. **Federation (journal).** Journal keypair and well-known, contact invite
   through the relay rendezvous, signed `/federation/*` ops, outbox and
   retry, media fetch. Same-journal paths become the `peer_journal = NULL`
   case of the same code.
6. **Later, on demand:** sealed mailbox on push.matron.chat; opt-in
   directory.

Phases 1–3 need nothing from the push server and no new crypto.
