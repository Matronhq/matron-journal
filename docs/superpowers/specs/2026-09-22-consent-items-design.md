# Consent asks in the Decisions list — design

**Date:** 2026-09-22 · **Requested by:** Dan (2026-09-22, from the bev
session: "I can never find the approval cards"; option A chosen on item
#135 on 2026-09-10, detailed in item #162) · **Repos touched:**
matron-journal (this spec). Apps embed the card in item detail as a
follow-up (item #162, per platform).

## Problem

A consent ask — an agent wanting to spawn a session on another box, an
agent wanting to chat with another session — is published as a
`permission_request` card into one conversation's timeline. The user has
many conversations and reads the tracker's Decisions list for things that
need an answer, so a card in a timeline they are not looking at goes
unseen until it expires (24 h). Spawn asks have no list at all; chat asks
have `GET /agent-chat/pending`, which no client surfaces prominently.

The bridge already solves this for one ask: `request_secret` files a
`question` item with the secure link in its body and closes it on submit.
That is bridge-side and reaches a box only through a fleet rollout. Spawn
consent is brokered by the journal for every box, so mirroring it there
covers the fleet in one deploy.

## Design (spawn consent, this pass)

**File.** When `spawn_request` has journaled the card (the commit point
that decides row-vs-discard), `fileSpawnConsentItem` creates a `question`
item on the parent conversation: awaiting the user, created by the agent,
origin = the parent conversation and device, top of the open list, label
`consent`, one link `matron://consent/spawn/<request_id>`. Title
`Approve spawn on <box> — <topic or task head>`. Body: who asks, box,
workdir, model and room flag when present, the task verbatim, how to
answer, the 24 h expiry. The row remembers the item
(`agent_spawn_requests.item_id`, new nullable column).

**Close.** `emitSpawnOutcome` is the one funnel every terminal transition
passes through (answer route, orchestration, both sweeps), so it closes
the item: `started`/`declined` → `decided` (the user's call, attributed to
the answering client device), `expired`/`failed` → `cancelled` (the ask
lapsed, attributed to the asking agent's device), each with a one-line
closing note. Item #162's resolution mapping, kept verbatim.

**Markdown-safe.** The body is the first place another agent's words meet
a markdown renderer: the task sits in a fence longer than its longest
backtick run (so it stays verbatim), names have markup stripped, a
backtick in a workdir is dropped from its code span.

**Quiet.** The item's markers are written under the asking agent's device
(the card's sender): no bridge turns them into a session turn (bridges
route only `user:*` markers), no push (the card already pushed), no wake,
and no old-client fallback text — a fallback `text` is a message and would
overwrite the card's snippet and double the unread. `emitMarker` gains a
`fallback` flag for this.

**Journal-owned while pending.** Any agent mutation of the item through
the item routes is `403` until the ask resolves (the asking agent, if
prompt-injected, must not rewrite what the user reads or close the item
out of sight); reads and the user's own hand-close are unaffected.

**Best-effort.** A tracker failure is logged and never costs the ask, the
card, or the outcome frame. An item the user closed by hand stays as they
left it. Rows with no `item_id` resolve without one.

**Links.** `validateItemFields` accepts `matron://` alongside `http(s)://`
so a client that patches an item's links can round-trip a consent link.

## What the user gets

On every client, today: the ask appears in the Decisions list, numbered,
with everything the card says and the way back to it (origin chip); it
closes itself with the outcome. When an app learns to render the card
inside item detail (link scheme `matron://consent/spawn/<id>`, buttons on
the existing answer API), the answer happens from the item too.

## Trade recorded on purpose

Items are user-wide. The task text is therefore readable via `GET /items`
by every non-private agent of the user while the ask is open — the text
the card itself withholds from agents. Dan asked for the task in the item
body; the alternative (a consent-label sieve on agent reads) is a
follow-up if wanted.

## Out of scope (recommendation filed separately)

Agent-chat asks (`agent_invite`/`agent_join`) use the same mechanism and
are the obvious next pass. Tool-permission prompts are bridge-local,
short-lived and answered in seconds; a per-prompt item would flood the
tracker — see the recommendation item for the option of filing one only
once a prompt has waited past a threshold.
