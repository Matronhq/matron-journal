# Protocol reference (v1)

The full design rationale lives in the
[protocol design spec](superpowers/specs/2026-07-10-matron-protocol-design.md);
this document is the operational reference for what the server implements
today. Golden wire-protocol fixtures under `test/fixtures/conformance/` are
the machine-checkable version of this page.

## HTTP endpoints

- `POST /login {username, password, device_name}` -> `{token, device_id, user_id}`.
  Brute-force protection: 5 attempts/min per IP (429 `rate_limited`), plus per-username
  lockout after 5 consecutive failures — 30s doubling per failure up to 1h, cleared by
  a successful login (429 `locked_out` with `retry_after` seconds + `Retry-After` header).
- `GET /snapshot` (Bearer) -> `{conversations, seq}`. Each conversation row
  carries `parent_convo_id` (`null` for a normal conversation; set for a
  subagent child — see "Child conversations").
- `GET /convo/:id/messages?before_seq&limit` (Bearer) -> `{events}`. `limit`
  is clamped to 1..200 (400 on non-integer/NaN/<1); `before_seq`, when given,
  must be an integer (400 otherwise). Owner-only; missing or not-owned are
  indistinguishable, both 404 `{error:'not_found'}` (never 403). For an
  **agent** token specifically, "owner" is narrower than plain user-scoped
  ownership: the same `authorizeAgentWrite` rule every other agent write
  path uses (the conversation's recorded owner device, a `joined`
  participant, or a legacy NULL-owner conversation) — a foreign convo of the
  same user's OTHER agent device is 404, same shape as a missing/not-owned
  one, never 403. This is the spec's "agents get roster metadata only, no
  cross-agent transcript reads in v1" rule enforced on the one HTTP read
  path that used to be only user-scoped; it's also exactly what a future
  `agent_chat_read` needs ("allowed for joined agents"). Client tokens are
  unaffected — still plain user-scoped ownership.
- `GET /convo/:id/messages?around_seq&limit` — a second paging mode on the
  same endpoint, mutually exclusive with `before_seq`: supplying both is
  400 `{error:'bad_request'}`. `around_seq` must be an integer when given
  (400 otherwise); `limit` uses the same 1..200 clamp as `before_seq`.
  Returns up to `limit` events centered on the anchor: `floor(limit/2)`
  strictly before `around_seq`, the remainder from `around_seq` up (so the
  anchor row itself is included when it exists) — either end of the
  conversation just yields a shorter window, never an error. This mode
  carries its own, separate agent-authorization story from the
  `before_seq`/default gate described above — see "Journal search" below
  for the full two-regime explanation.
- `GET /search?q=&limit=&convo_id=` (Bearer, any authenticated device —
  client or agent) -> `{hits: [{convo_id, title, seq, ts, sender, snippet,
  live}]}`. Full-text search over the prose the journal has indexed (see
  "Journal search" below for what is indexed and why). `q` is required,
  must be non-empty after trimming, and is capped at 256 chars (400
  `{error:'bad_request'}` otherwise); every whitespace-separated term is
  double-quoted before it reaches FTS5's `MATCH` parser (embedded quotes
  escaped by doubling) and the terms are ANDed together — an implicit-AND
  query over literal terms, so raw FTS5 syntax a human might type (an
  unbalanced quote, a bare `*`, a stray `NEAR`) can never throw; a query
  with zero terms, or one that still fails to parse, is 400
  `{error:'bad_request'}`, never a 500 with SQLite internals in it. `limit`
  defaults to 20, clamped to 50 (400 on non-integer/NaN/<1, same convention
  as `/convo/:id/messages`). `convo_id`, when given, narrows to one
  conversation; an id belonging to another user (or a nonexistent one)
  yields the same empty result set the user-scoping already guarantees for
  a genuinely-unmatched query — there is no separate existence check, so
  this is not an oracle for "does this convo_id exist." Results are ranked
  by FTS5 `bm25()` (best match first), ties broken by `ts DESC`; `snippet`
  is the FTS5 `snippet()` excerpt with matched terms wrapped in `**`...`**`
  (markdown bold — agents and the apps both render markdown); `live` is
  `true` when the hit's conversation has `session_state = 'running'`, a
  hint to talk to the working agent (`GET /roster` / `agent_chat_start`)
  rather than only read its transcript. Scoped to the caller's own user
  (`search_messages.user_id`) regardless of device kind — open to both
  agents (the feature's primary audience) and clients; the agent-
  visibility/privacy plan layers additional agent-caller filtering on top
  later.
- `POST /media` (Bearer, client or agent) -> raw request body streamed to disk;
  `{media_id, size, content_type, sha256}`. Content-Type header captured
  (default `application/octet-stream`). 400 `{error:'empty'}` on a zero-byte
  body; 413 `{error:'too_large'}` over `MATRON_MEDIA_MAX_BYTES` (default 50 MB);
  413 `{error:'quota_exceeded'}` when the user's total blob bytes would exceed
  `MATRON_MEDIA_USER_QUOTA_BYTES` (default 2 GiB) — checked up front (rejected
  before the body streams) when already at the ceiling, and precisely after the
  size is known otherwise (the just-written file is deleted on rejection).
  Storage root: `MATRON_MEDIA_DIR` env or `<dirname of the db file>/media`,
  sharded `<root>/<id[0:2]>/<id>`.
- `GET /media/:id` (Bearer) -> streams the blob with its Content-Type,
  Content-Length and a long-lived `Cache-Control` (ids are immutable random
  handles), plus `X-Content-Type-Options: nosniff` and
  `Content-Disposition: attachment` so an uploader-chosen content-type can never
  render as active content on the API origin. Owner-only; missing or not-owned
  are indistinguishable, both 404 `{error:'not_found'}`.
- `POST /push/register` (Bearer, client devices only — agents get 403
  `{error:'forbidden'}`): `{apns_token, environment}` with `environment` in
  `{'sandbox','prod'}` registers a device for push; `{apns_token: null}`
  unregisters. 400 `{error:'bad_request'}` on a bad `environment` or a
  missing/non-string `apns_token` (unless it's `null`). Response echoes the
  device's current `push_prefs` (see `PUT /push/prefs` below); `GET
  /devices` echoes the same per-device `push_prefs` in its roster.
- `PUT /push/prefs` (Bearer, client devices only — agents get 403
  `{error:'forbidden'}`): body is any subset of `{attention, done, activity}`
  booleans — a partial merge, not a replace: only the given keys change, the
  rest keep their stored value. 400 `{error:'bad_request'}` on an unknown
  field or a non-boolean value for a known field. Response `{ok:true,
  push_prefs}` echoes the full merged three-key shape. Defaults (NULL /
  never set) are `{attention: true, done: true, activity: false}` — "buzz me
  when the agent needs me or finishes; routine activity is opt-in."
- `POST /password` (Bearer, client devices only — agents get 403
  `{error:'forbidden'}`): `{old_password, new_password}`. `old_password` is
  always verified against the real argon2 hash (no shortcuts); a wrong one
  is 401 `{error:'bad_password'}`. `new_password` must be a string of at
  least 8 characters, otherwise 400 `{error:'weak_password'}`; a
  missing/non-string `old_password` is 400 `{error:'bad_request'}`. On
  success the user's hash is rotated to a fresh argon2id hash; **existing
  device tokens (including the one used to make this request) stay valid**
  — a password change does not revoke sessions, only the credential used to
  mint new ones via `/login`.
- `GET /metrics` (Bearer, any valid device — client or agent, no admin
  concept in v1) -> JSON: `{user: {head_seq, devices: [{device_id, kind,
  cursor, lag, last_seen_at}]}, sockets_connected, journal_row_count,
  db_file_size_bytes, push: {sent, failed, pruned, by_reason}}`. The `user`
  section is scoped to the caller's own user only — never another user's
  devices or username; the rest are global aggregates (bare numbers/
  counters, safe for any authenticated caller). `push` mirrors the push
  pipeline's in-memory counters (all zero when push is disabled).
  `matron-admin status` prints the DB-derived subset of the same numbers
  (per-user head seq, per-device kind/cursor/lag/last_seen_at, total events,
  DB file size) directly from the SQLite file — connected-socket count and
  APNs counters only exist in a running server's memory, so those are
  `/metrics`-only.
- `GET /devices` (Bearer, client devices only — agents get 403
  `{error:'forbidden'}`) -> `{devices: [{device_id, kind, name, created_at,
  cursor, lag, last_seen_at, is_self, connected, push_prefs}]}`. The
  caller's own user's devices only; `is_self` marks the requesting device.
  `push_prefs` is the per-device notification prefs (see `PUT /push/prefs`
  above), always the full three-key shape (defaults filled in). Overlaps `/metrics`'
  `user.devices` deliberately — metrics is observability (agents may read
  it, no `name`), this is the management roster. `connected` is whether the
  device has a live WebSocket right now — the "can I start a session on
  this agent" signal; `last_seen_at` stays the offline story.
- `GET /roster` (Bearer, any authenticated device — client or agent) ->
  `{agents, conversations}`. Targeting surface for agent chat rooms (spec:
  2026-08-06 agent-to-agent chat design, Phase 2) — unlike `GET /devices`
  (management, client devices only) this is deliberately open to agent
  tokens too, and deliberately narrower. `agents`:
  `[{device_id, name, created_at, last_seen_at, connected}]` — this user's
  `kind='agent'` devices only (never client devices; no `cursor`/`lag`/
  `push_prefs`); `connected` is the same live-WebSocket check `/devices`
  uses. `conversations`:
  `[{id, title, session_state, last_seq, summary, agent_device_id,
  created_at, last_ts}]` — top-level conversations only
  (`parent_convo_id IS NULL`; children are silenced sub-chats, never invite/
  chat targets), ordered by `last_seq DESC`; `last_ts` is the newest
  event's timestamp (`null` for an event-less conversation), same
  derivation as `/snapshot`. Scoped to the caller's own user like every
  other read. See "Agent chat rooms" below for what a room and `summary`
  are.
- `POST /pair/start` (unauthenticated; shares /login's per-IP rate limit) ->
  `{pair_code, poll_token, expires_in}`. Pending pairs are in-memory only
  (10-minute TTL, 64 outstanding max — 429 `rate_limited` beyond either);
  a restart forgets them.
- `POST /pair/approve {pair_code, agent_name}` (Bearer, client devices
  only) -> `{status:'approved'}`. Binds the pair to the approving caller's
  user. Exactly once per pair: already-approved is 409 `{error:'conflict'}`;
  unknown and expired are indistinguishable 404s. Codes are normalized
  (case/hyphens/spaces) before lookup.
- `POST /pair/preview {pair_code}` (Bearer, client devices only) ->
  `{requester_ip, expires_in}` for a pending pair — the approval screen shows
  who is asking before the user approves. `requester_ip` is the IP that
  called `pair/start`; `expires_in` is the pair's remaining TTL in seconds.
  Read-only. Unknown, expired, and already-approved codes are
  indistinguishable 404s; codes are normalized as in approve.
- `POST /pair/claim {poll_token}` (unauthenticated) -> `{status:'pending'}`
  until approval, then exactly once `{status:'approved', token, device_id}`
  — the agent device row is minted at claim, not approve, so an unclaimed
  pair leaves no DB residue. Second claim / unknown / expired: 404.
- `POST /link/start` (Bearer, client devices only) -> `{link_code, expires_in}`.
  Starts a device-link session for QR sign-in (TTL 120s). One active session
  per starter device: a new start replaces the previous one. Store cap 64
  pending -> 429 `{error:'rate_limited'}`.
- `POST /link/claim {link_code, device_name}` (unauthenticated; shares
  /login's per-IP rate limit) -> `{status:'claimed', claim_token, expires_in}`.
  First claim wins: already-claimed is 409 `{error:'conflict'}`; unknown and
  expired merge into 404. `device_name` is trimmed, non-empty, max 64 chars.
  A successful claim extends the session TTL to at least 60s remaining.
- `POST /link/poll {claim_token}` (unauthenticated, not rate-limited) ->
  `{status:'pending'}` until the starter acts, then exactly once
  `{status:'approved', token, device_id, user_id, username}` (the `client`
  device is minted at this poll; the session is deleted first) or
  `{status:'denied'}` (observed once, then the session is deleted). Unknown /
  expired / already-observed: 404. `username` is included because link
  claimants never type one.
- `POST /link/status` (Bearer, client devices only; starter device only) ->
  `{status:'waiting', expires_in}` or
  `{status:'claimed', device_name, requester_ip, expires_in}`. 404 when the
  device has no active session (none started, expired, or already resolved).
- `POST /link/approve {link_code}` (Bearer, client devices only; starter
  device only, and the code must match its active session) ->
  `{status:'approved'}`. 409 `{error:'conflict'}` when the session is not in
  the `claimed` state (nothing to approve yet, or already resolved); 404 for
  unknown/expired/other-device.
- `POST /link/deny {link_code}` (Bearer, same binding as approve) ->
  `{status:'denied'}`. 404 for unknown/expired/other-device/already-resolved.

## Journal search

(spec: `docs/superpowers/specs/2026-08-07-agent-journal-search-design.md`.)
A prose-only full-text index over the journal, serving `GET /search` and
the `around_seq` context mode on `GET /convo/:id/messages` (both above) —
the feature that lets an agent look up "what happened with X" across a
user's whole history instead of only the roster metadata a foreign
conversation otherwise exposes.

### What is indexed

Two event types: `text` (`payload.body`) and `diff` (`payload.diff`,
falling back to `payload.snippet` when `diff` is empty/absent). Everything
else — `tool_output`, `prompt`, `file`, `image`, `permission_request`,
`session_status`, and any future type — is never indexed. Diffs were kept
in deliberately: "what did we change to fix X" is a real question, and
dropping them later is a one-line change if it turns out to leak too much
(a committed `.env` diff would land in the index verbatim).

One function, `indexableBody(type, payload)` (`src/search.js`), is the
single source of truth for this rule. It is called from three places: the
live append path (inside `append()`'s own transaction in `src/journal.js`,
so an event and its index row commit or roll back together), the startup
backfill, and the `around_seq` foreign-agent context filter (see below) —
one predicate, three consumers, zero drift between them.

`tool_output` is excluded on purpose and is the load-bearing case: command
output is retrieval noise for "why did we do this" questions, and it is
where credentials land. Because `indexableBody` is the exact predicate the
`around_seq` foreign-agent filter also uses, this is simultaneously the
guarantee that an agent reading context around a search hit in a
conversation it doesn't manage can never have a `tool_output` payload (or
the client-only `permission_request` consent card, or anything else
outside the prose set) placed in front of it — that guarantee rests on one
shared function, not on two filters kept in sync by hand.

### Index invariants

- **Append-only, insert-trigger-only.** `search_messages` has an `AFTER
  INSERT` trigger populating `search_fts` and nothing else — no update or
  delete trigger exists. This mirrors `events` itself: rows are written
  with a plain `INSERT`, never `INSERT OR REPLACE` (`REPLACE` silently
  skipping a delete trigger is the exact corruption that hit the app-side
  FTS index — matron-apple #106), and no `DELETE FROM events` exists
  anywhere in the server. A prose-only index of an append-only table needs
  an insert path and nothing else; if a delete path is ever added to
  `events`, this schema needs revisiting.
- **Retention never touches indexed rows.** The two retention passes under
  "Retention (payload offload)" below only ever rewrite `tool_output`
  payloads — purging live-streamed output after
  `MATRON_TOOL_LOG_TTL_HOURS` and offloading older output to a blob after
  `MATRON_RETENTION_DAYS` — and `tool_output` is never indexed. Neither
  pass can therefore invalidate a `search_messages`/`search_fts` row; the
  index has no reconciliation path with retention because it needs none.
- **Backfill is resumable and self-healing.** A startup walk over `events`
  by `rowid`, batched, indexing every row `indexableBody` accepts via
  `INSERT OR IGNORE` (never `OR REPLACE`) against `search_messages`'
  `UNIQUE(user_id, seq)` — so a re-run, or overlap with the live append
  path, is a no-op rather than a duplicate or a corruption. Progress lives
  in one row, `search_backfill_state(id=1, last_events_rowid)`, written
  after each committed batch: an interrupted run resumes from there on the
  next boot, and a completed run costs a single row read. `/search`
  returns partial results until the walk finishes — acceptable, because any
  event appended after the schema exists is indexed by the live path, so
  the backfill cursor can never miss a row on the way to catching up.

### Agent context access: two regimes

`GET /convo/:id/messages` now has two distinct authorization stories for
an agent token, selected by which query parameter is present:

- **`before_seq` (or neither param)** keeps the Phase-2 gate described
  above unchanged: an agent reads a conversation's full transcript (every
  event type, unfiltered) only for one it manages or has `joined`
  (`authorizeAgentWrite`) — a conversation outside that set stays 404,
  exactly as before this feature existed.
- **`around_seq`** is the search-context surface, and deliberately looser:
  an agent MAY read a conversation outside that set — that is the point,
  since a `/search` hit can be anywhere in the user's history — but the
  response is limited to the set the index can see (`text` + `diff`
  prose). `tool_output` and every other type, including the client-only
  agent-chat consent card, never reach an agent through this path. An
  agent's `around_seq` read of a conversation it DOES manage or has
  joined is unfiltered, same as `before_seq`; a client's read is
  identical either way — this narrowing applies to agent callers only.

  For a foreign read specifically, the seq window itself is computed FROM
  `search_messages` — the indexed prose set, not `events` — rather than
  windowed over every event and filtered afterward. In a `tool_output`-heavy
  conversation (the common case: an agent's own tool calls dwarf its prose),
  windowing over everything first and filtering after can starve a small
  `limit` down to a couple of visible rows even though plenty of prose
  exists further out; picking the window from the already-indexed set means
  a requested window is a full window of visible events whenever that much
  prose exists. `indexableBody` is still applied to the result as
  belt-and-braces against drift between the index and the rule, so it stays
  the single predicate all three consumers (live append, backfill, this
  filter) ultimately answer to — it should just never have anything left to
  filter in practice now.

  Two more restrictions apply only to this foreign-read path: `limit` is
  clamped to 30 regardless of what the caller requests (a context read is
  meant to orient around one search hit, not extract a conversation
  wholesale — the client and managing-agent paths keep the normal 1..200
  clamp), and every foreign context read is logged server-side
  (`journal: foreign-agent context read convo=… device=… anchor=…`) so the
  exposure this feature grants is observable, not silent.

  This resolves what would otherwise be a contradiction with the design
  spec's original wording, "reuses the endpoint's existing authorisation
  unchanged": that holds for a client, but for an agent it means the
  Phase-2 gate is specifically bypassed in `around_seq` mode, with the
  indexed-window-plus-`indexableBody` filter substituted in as the narrower
  replacement. Both modes still collapse "not found" and "not yours" into
  the same 404 `{error:'not_found'}` — never 403 — so a caller can't use
  either path to probe which conversations exist.

## WebSocket

- `WS /ws`: first frame `{op:'hello', token, cursor}` (cursor null = live-only).
  Server: `hello_ok {seq, device_id, name}`, then journal frames `> cursor`,
  then live. `device_id`/`name` are the authenticated device's own identity —
  bridges use them for agent-chat rooms (own-echo guard, roster
  self-exclusion, room titles).
  If the replay gap (`head_seq - cursor`) exceeds `MATRON_MAX_REPLAY`
  (default 50000), the server sends `{kind:'control', op:'snapshot_required'}`
  instead of replaying and closes the socket with code `4009` — the client
  wipes its local store, calls `GET /snapshot`, and reconnects with the
  fresh cursor (spec §6). Journal rows are never deleted, so this is an
  efficiency valve, not a data-loss boundary.
  Client ops: send (type text, or file/image with a top-level blob_ref from a
  prior POST /media — payload mirrors the agent-publish media shape),
  prompt_reply, read_marker, ack, viewing.
  Agent ops: convo_upsert, publish, stream (ephemeral), stream_append,
  finalize, activity (ephemeral), status (ephemeral, cached). `read_marker`
  is available to both kinds:
  an agent (bridge) connection may advance its user's read marker too —
  e.g. after mirroring the user's own message into the journal, so that
  mirrored round-trip doesn't inflate the unread badge.
  `up_to_seq: null` resolves server-side to the conversation's current
  `last_seq` at processing time, so a fire-and-forget publisher never needs
  to learn the seq it was assigned; explicit integers keep working as before.
- Live journal frames (fan-out at append time) carry `sender_device_id` —
  the numeric device id of the connection that produced the event. Device
  names have no unique constraint, so this is the only exact own-echo test
  a bridge has in a shared room. Deliberately live-only: absent from hello
  replay frames and never stored in the event row, so consumers must fall
  back to sender-name matching for replayed history.
- Publishes and sends are at-least-once: a caller that doesn't get a
  confirmation should retry with the same `idem_key`/`local_id`. A deduped
  retry gets NO dedicated confirmation frame — convergence is observed via
  the journal frame carrying the event, which carries the same `seq` on
  every delivery (original or retried).
- Conversation ids are a global primary key across all users, not scoped to a
  user or device. Bridges MUST mint globally unique ids — Claude session
  UUIDs are the convention.
- `convo_upsert` appends a `convo_meta` journal event
  (`payload:{title, parent_convo_id}`, sender = the agent device, e.g.
  `agent:dev-2`) whenever it changes an existing conversation's title, sets
  a non-empty title at creation, or creates a child (`parent_convo_id` set,
  even titleless — the linkage must ride the journal, or a live client would
  list the child as a normal conversation until its next `/snapshot`) — so
  other devices learn renames and child linkage live instead of only via
  `/snapshot`. No event otherwise (unchanged/omitted title, state-only
  upserts on existing conversations).
- `convo_upsert` accepts an optional `parent_convo_id` linking a durable child
  conversation to its parent (subagent sub-chats). It is a non-empty string
  (id length cap 128; malformed → `bad_request`), **set once at creation and
  immutable afterwards**: a later upsert that omits it does not clear it, and
  one carrying a different value does not change it. The referenced parent need
  not exist yet — ordering between a child's upsert and its parent's is not
  guaranteed, so the reference is stored as-is. `parent_convo_id` is exposed
  wherever conversation metadata already flows: the `convo_meta` payload above
  (so it rides hello replay) and each `/snapshot` conversation row (`null` for
  normal conversations). See "Child conversations" below.
- `convo_upsert` accepts an optional `summary` (string, ≤1000 chars —
  `bad_request` over the cap): a rolling 2-3 sentence conversation summary
  the owning bridge maintains as a targeting aid for `GET /roster` (see
  "Agent chat rooms" below). Same don't-clobber discipline as `title`/
  `parent_convo_id`: only an upsert that carries a non-null `summary`
  changes the stored value; omitting it leaves the existing summary
  untouched. Unlike a title change, a summary change never appends a
  `convo_meta` event — it's roster-read material, not something a live
  client needs to learn mid-conversation.
- Agent delivery scoping: `convo_upsert` records the upserting agent device
  as the conversation's owner (`agent_device_id`). Ownership is
  last-writer-wins **except** for a guest: a device that has ever appeared
  in `convo_agents` for this conversation (`invited`, `joined`, `refused`,
  `left`, or `expired` — any state at all) never becomes the recorded owner
  on upsert, so a room participant's own housekeeping upserts can't steal
  delivery ownership from the room's real owner (spec: agent chat phase 2,
  the "ownership no-steal" fix). A device with no participant row keeps the
  old takeover behavior — a re-paired bridge gets a new device id and must
  still be able to reclaim its own sessions. Journal frames for an owned
  conversation are delivered to that owner device **and** every currently-
  `joined` participant (see "Agent chat rooms" below); client devices always
  receive every frame. A conversation with no recorded owner (rows
  predating the column, or a bridge that hasn't re-upserted yet) keeps
  legacy broadcast-to-all-agents delivery, so multi-bridge fleets migrate
  without a flag day. Hello replay (the `cursor`-driven catch-up above)
  applies the identical owner-or-joined-participant predicate per
  conversation for an agent connection, so a joined participant catching up
  after a disconnect sees the room's backlog too, not just live traffic
  from the moment it joined.
- **Room-upsert ownership gate.** Before `convo_upsert` reaches the
  ownership no-steal logic above, the server checks: if the conversation
  already exists **under the caller's own user**, has at least one
  `convo_agents` row (any state — the conversation is a "room"), and its
  recorded owner (`agent_device_id`) is non-NULL and different from the
  upserting device, the WHOLE upsert is rejected with `{code:'forbidden',
  detail:'only the room owner may upsert a room'}` — no title/state/summary
  change is applied, not even a non-ownership-changing one. The gate's
  lookup is deliberately scoped to the caller's user id: an upsert naming
  another user's conversation falls through to the generic cross-user
  rejection (`{code:'forbidden'}` with no detail), so the room-specific
  detail never confirms to a foreign agent that a given convo id exists
  and is a populated room. This is stricter than the no-steal rule
  above: a guest used to be allowed to upsert a room's title/session_state
  (just never reassign its ownership); now, once a room has ANY
  participant history, only its recorded owner may upsert it at all —
  joined guests and uninvited strangers alike, since either one's own
  housekeeping upsert would otherwise flap title/session_state/summary
  that the room's creator owns. A participant-less conversation (no
  `convo_agents` rows at all) keeps the old last-writer-wins takeover
  behavior — a re-paired bridge with a new device id can still reclaim its
  own sessions — and a conversation with no recorded owner (legacy NULL)
  stays writable by anyone. Accepted trade-off for v1: a re-paired owner
  (new device id after a bridge restart pairs fresh) can no longer reclaim
  a room it created once that room has participant history, because the
  gate sees a mismatched non-NULL owner and a populated `convo_agents`
  table — same "needs a fresh invite" story as any other stranger. The
  ownership no-steal predicate in `upsertConversation` itself still runs
  underneath as belt-and-braces for any caller that reaches it directly
  (e.g. a test harness bypassing the WS layer), but on ordinary WS traffic
  this gate rejects a disqualified upsert before that code ever runs.
- Agent write authorization: `publish`, `finalize`, `stream`,
  `stream_append`, `activity`, and `status` all gate on the same rule
  (`authorizeAgentWrite`) — the agent device must be the conversation's
  recorded owner (`agent_device_id`), a `joined` participant (`convo_agents`
  state=`'joined'`), or the conversation must have no recorded owner at all
  (legacy NULL, broadcast-era rows — any of the user's agent devices may
  write there). Anything else — a different agent device's conversation the
  caller was never invited into, or one it was invited into but hasn't
  accepted / has since left / has expired — fails closed as
  `{kind:'control', op:'error', code:'forbidden', ref:<op>}` (`publish`/
  `finalize` add `detail:'not a participant of this conversation'`).
  `convo_upsert` and `read_marker` are deliberately NOT gated by this rule:
  `convo_upsert` is how a device becomes an owner or a guest in the first
  place, and `read_marker` stays scoped to the conversation's owning user
  only — a bridge may mark its user's own messages read regardless of room
  membership (see the `read_marker` note above). This is safe precisely
  because `read_marker` only ever advances the CALLER'S OWN user's read
  state (never another user's — `markRead` is scoped by `who.userId` like
  every other op) and writes no message content of any kind: there is no
  content to steal or forge, and no way to use it to gain or fake
  participation in a room, so no participant/ownership check is needed on
  top of the existing user scoping.
- Unread semantics: a user's own `send` never increments `unread_count` (it's
  their own message); agent-published/finalized events do. `read_marker`
  recomputes `unread_count` from events after `up_to_seq`, so
  `up_to_seq >= last_seq` always resets it to 0.
- Agent `publish` rejects any `idem_key` starting with `fin:` (reserved for
  `finalize`'s internally composed `fin:<ref>` keys) with
  `{op:'error', code:'bad_request', detail:'idem_key prefix fin: is
  reserved'}`; nothing is appended.
- Agent `stream {convo_id, message_ref, text?, replace_text?}` broadcasts a
  live message overlay (never journaled). Same ownership rule as every other
  agent write (missing/not-owned convo → `forbidden`); `text`/`replace_text`
  must be strings when present (else `bad_request`). No separate byte cap — the
  1 MiB WS frame limit bounds it and nothing is retained (transient,
  latest-wins in the hub coalescer). Delivered as `{kind:'ephemeral', convo_id,
  message_ref, text, replace_text}` to viewing clients.
- Agent `activity {convo_id, state, detail?}` broadcasts a typing/tool-use
  indicator: `state` must be one of `thinking`/`tool`/`idle` (else
  `bad_request`); `detail` is an optional string, truncated (not rejected) at
  200 chars. Same ownership rule as every other agent write (missing/not-owned
  convo → `forbidden`). Delivered as `{kind:'ephemeral', convo_id,
  activity:{state, detail}}` only to the owning user's client connections
  currently `viewing` that conversation, via the same hub fan-out `stream`
  uses — never written to the journal (no seq, no unread/push effects).
- Agent `status {convo_id, status}` publishes the session's header data
  (model, context-window gauge, rate limits — the shape is owned by the
  bridge and passed through opaquely). Validated only as a non-null object
  whose JSON encoding is ≤ 4096 bytes (else `bad_request`); ownership as
  `activity` (`forbidden`); agent connections only. Delivered as
  `{kind:'ephemeral', convo_id, status:{...}}` to viewing clients, same as
  `activity` — never journaled. Unlike `activity`, the server caches the
  last status per conversation (in-memory, bounded) and replays it to a
  client immediately after it sends `viewing`, so headers populate on open
  instead of waiting for the next turn end.
- Agent `stream_append {convo_id, message_ref, offset, chunk, meta?}` streams
  live tool output (never journaled). `message_ref` is the tool_use_id;
  `offset` is the UTF-8 byte position of `chunk` in the command's output.
  The server holds a capped in-memory buffer per stream (1 MiB /
  `MATRON_TOOL_STREAM_MAX_BYTES`; 64 buffers /
  `MATRON_TOOL_STREAM_MAX_BUFFERS`; 30 min idle /
  `MATRON_TOOL_STREAM_IDLE_MS`). `meta {tool, command}` is required on the
  buffer-creating (offset-0) frame. Offset rules: `== end` appends, `< end`
  trims the overlap (idempotent retries), `> end` (or unknown buffer at
  offset > 0) draws `{kind:'control', op:'stream_resync', convo_id,
  message_ref, have}` — resend from byte `have`. Ownership as `activity`
  (`forbidden`); agent connections only.
- Viewing clients receive tool-stream ephemerals distinguished by the
  `tool_stream` key: `{event:'append', offset, chunk}` live (consecutive
  appends coalesce by concatenation, not latest-wins); on starting to view,
  one `{event:'sync', meta, offset, content, head_truncated}` per active
  stream (full scrollback so far — clients trim any append whose offset
  precedes their accumulated end); `{event:'end', reason:'stale'}` when the
  idle sweep frees a buffer whose bridge died. Normal completion sends no
  ephemeral: the durable `tool_output` event arrives with the same
  `message_ref` in its payload and retires the live view. Because journal
  frames bypass the hub's coalescing but ephemerals don't, a pending
  `tool_stream` append can flush up to 200 ms after that completion frame —
  clients must ignore `tool_stream` ephemerals for a `message_ref` already
  retired by a durable event rather than re-opening a retired overlay.
- `finalize` accepts an optional top-level `blob_ref` (same passthrough as
  `publish`) and frees the matching live-stream buffer.

## Child conversations

A bridge may link a durable **child conversation** to a parent by sending
`parent_convo_id` on the child's `convo_upsert` (subagent sub-chats — a
subagent's turns land in their own conversation instead of interleaving into
the parent's transcript). The linkage is a fixed structural fact:

- **Immutable.** `parent_convo_id` is set once, at the child's creation. Later
  upserts can never clear it (omitting the field) or repoint it (a different
  value); both are ignored. A conversation created without a parent likewise
  cannot gain one later.
- **Silent, server-side.** A conversation with `parent_convo_id IS NOT NULL` is
  exempt from both unread counting and APNs: an agent event in a child never
  increments the owner's `unread_count` and never pushes a notification (of any
  kind — alert, coalesced routine, or the read_marker background wake). The
  short-circuit is enforced by the server, not the client, so stale app
  versions stay silent for children too. The child's `last_seq`/`snippet` still
  advance normally; only the unread and push side effects are suppressed.
- **Delivery is unchanged.** Journal delivery is user-wide and every event is
  tagged with its `convo_id`, so a child's events ride the same journal as any
  other conversation's — no separate subscription. Clients discover the
  parent/child relationship from `parent_convo_id` on the `/snapshot`
  conversation row and the `convo_meta` payload.

## Agent chat rooms

A **room** is not a new entity — it's an ordinary top-level conversation
(never a child; see "Child conversations" above) whose owner
(`agent_device_id`) has drawn other agent devices of the same user into its
lifecycle via the `convo_agents` table (spec: 2026-08-06 agent-to-agent chat
design, Phase 2; consent gating: 2026-08-07 agent chat consent design). A
`convo_agents` row is a **grant**, one per `(convo_id, agent_device_id)`,
that moves through a small state machine:

    awaiting_user -> invited -> joined
         │              │      └─refuse──> refused
         │              └─ttl──────────> expired
         ├─deny────> denied
         └─ttl─────> expired
    joined  -> left

`awaiting_user` and `invited` are the two pending states.
`awaiting_user` means the request is parked awaiting the **user's**
decision (see "Consent gating" below) — it is where every `agent_invite`/
`agent_join` lands by default. `invited` means the user has decided (or the
directed pair was already always-allowed, skipping the park step
entirely) and the target agent has yet to answer. `joined` is the only
state that confers delivery and write rights (see "Agent write
authorization" and "Agent delivery scoping" above). A row left in
`refused`, `denied`, `left`, or `expired` is **renewable** — a fresh
`agent_invite`/`agent_join` may reuse the same `(convo_id, agent_device_id)`
pair and resets it to `awaiting_user` (or `invited`, on the allowance-
bypass path); a row already `awaiting_user`, `invited`, or `joined` is not
— inviting/joining over one of those returns `{code:'conflict',
detail:'already <state>'}` instead of silently resetting it (a
double-invite is a caller bug worth surfacing, not a no-op; the same
non-renewability keeps a still-pending `awaiting_user` ask from becoming a
re-request loop against the user's attention — see the per-requester cap
below).

Every row also records `initiator_device_id` — whichever side asked (the
room owner sending an invite, or the would-be participant sending a join
request) — because the **other** side is the one entitled to answer: the
initiator can never ack or answer its own invite
(`{code:'forbidden', detail:'the initiator cannot answer its own invite'}`).

### The five room ops

All five are agent-connection-only (`{code:'forbidden'}` for a client
connection) and all five require the connection to be past its own hello
replay (`conn.registered`; `{code:'not_ready'}` otherwise — same stance as
`agent_request`: a reply might need to reach this very socket, and
mid-replay it's invisible to the hub's delivery scan). Every op resolves
`room_id` the same way: `bad_request` for a missing/non-string/oversized
(>128 char) id, `not_found` for an unknown id or one owned by another user,
`bad_request` for a child conversation (`parent_convo_id` set — children
can never be rooms). Error frames for these five ops also carry
`room_id` — a bridge can have several rooms' ops in flight at once, and
`ref` alone can't say which room an error is about — but only when the
inbound `room_id` was a well-formed id (non-empty string, ≤128 chars); a
malformed id is never echoed back. Other ops' error frames are unchanged.

- **`agent_invite {room_id, target_device_id, topic?, justification}`** —
  only the room's own owner (`agent_device_id === conn.deviceId`) may send
  it (`forbidden` — "only the room owner may invite" — otherwise);
  `target_device_id` must be a different agent device of the same user
  (`not_found` for an unknown id, another user's device, or a client-kind
  device — anti-enumeration, same stance as `agent_request`; `bad_request`
  for inviting self). `topic` is optional (≤200 chars,
  `INVITE_TOPIC_MAX_CHARS`), `justification` is required (1-1000 chars,
  `INVITE_TEXT_MAX_CHARS`). What happens next depends on whether the user
  has already always-allowed this directed pair, `initiator_device_id ->
  target_device_id` (see "Consent gating" below):
  - **Allowance bypass** — creates/renews an `invited` row and attempts
    delivery immediately. Delivery is single-socket (`hub.sendRpcRequest`,
    same rule as Agent RPC — the most recently registered live connection
    of the target device, so a mid-reconnect bridge can't double-receive):
    no live registered connection on the target means `{code:'offline'}`,
    and the just-created row is deleted (`removeParticipant`) so no
    pending invite is left that nobody was told about. On success the
    caller gets `{kind:'invite', event:'delivered', room_id,
    target_device_id}` and the target gets `{kind:'invite',
    event:'request', room_id, from_device_id, from_name, topic,
    justification}`.
  - **No standing allowance (the default)** — creates/renews an
    `awaiting_user` row instead. The target agent is sent **nothing**; the
    justification never leaves the journal until the user approves it. The
    caller still gets `{kind:'invite', event:'delivered', room_id,
    target_device_id}` — see "Consent gating" below for what `delivered`
    means in this case.
- **`agent_join {room_id, justification}`** — the reverse direction: an
  agent asks to join a room it doesn't own. The room must have a recorded
  owner (`{code:'conflict', detail:'room has no recorded owner to ask'}`
  otherwise) and the caller can't be that owner
  (`{code:'bad_request', detail:'cannot join own room'}`). Same
  allowance-bypass-vs-park branch as `agent_invite`, with the caller as
  both the participant and the initiator and the room's owner device as
  the target: on the bypass path it creates/renews an `invited` row with
  the same single-socket delivery and `offline` handling, and on success
  the caller gets `{kind:'invite', event:'delivered', room_id,
  target_device_id:<owner>}` and the owner gets `{kind:'invite',
  event:'join_request', room_id, from_device_id, from_name,
  justification}`; with no standing allowance it parks an `awaiting_user`
  row instead, same as `agent_invite`.
- **`agent_invite_ack {room_id, peer_device_id?, session_state}`** — a
  non-committal status ping while an invite/join is still pending
  (`invited`), sent by whichever side did NOT initiate. `session_state` must
  be `'idle'` or `'busy'` (`bad_request` otherwise). `peer_device_id`
  selects direction: present means the room owner is acking a join request
  (naming the requesting participant device — only the owner may supply it,
  `forbidden` otherwise); absent means a participant is acking an invite
  addressed to itself. No pending `invited` row for the resolved device
  (`{code:'conflict', detail:'no pending invite'}`) or the caller IS that
  row's initiator (`forbidden`, see above) both fail closed. Delivered to
  the initiator as
  `{kind:'invite', event:'ack', room_id, from_device_id, session_state}` —
  no journal entry, no state change.
- **`agent_invite_answer {room_id, peer_device_id?, accept, reason?}`** —
  resolves a pending `invited` row to `joined` (`accept:true`) or `refused`
  (`accept:false`); same direction rule, pending-row check, and
  initiator-can't-answer-itself check as `agent_invite_ack` above (a row
  that stopped being `invited` between the check and the update — e.g. a
  race with the expiry sweep — also surfaces as `{code:'conflict',
  detail:'no pending invite'}`). `reason` is optional (≤1000 chars,
  `INVITE_TEXT_MAX_CHARS` — a refusal justification, typically). Delivered
  to the initiator as
  `{kind:'invite', event:'answer', room_id, peer_device_id, accept,
  from_device_id, reason?}` (`reason` omitted from the frame when
  absent/empty). `from_device_id` is the device that actually sent this
  `agent_invite_answer` — the room owner when answering a join request
  (`peer_device_id` present, naming the joiner instead), or the invited
  participant itself otherwise — so the initiator always learns who
  answered, not just which row changed. Contrast with the expiry sweep's
  synthetic `answer` frame below, which has no answering connection behind
  it and so carries no `from_device_id`.
- **`agent_leave {room_id}`** — a joined participant leaves (`joined` ->
  `left`; `{code:'conflict', detail:'not a joined participant'}` if the
  caller isn't currently joined). If the room has a recorded owner other
  than the caller, that owner is told:
  `{kind:'invite', event:'left', room_id, from_device_id}`. When the
  caller IS the room's recorded owner (who has no `convo_agents` row of
  its own) **and the conversation is actually a room** — it has at least
  one `convo_agents` row, in any state — the room dissolves instead:
  - Every *live* row (`joined`, still-pending `invited`, or parked
    `awaiting_user`) flips to `left`. Terminal outcomes (`refused`,
    `denied`, `expired`) are left alone: they are history, not membership.
  - Each previously-**joined** participant is sent the same
    `{kind:'invite', event:'left', room_id, from_device_id}` frame.
  - Each pending `invited`/`awaiting_user` row that the *other* side
    initiated — i.e. a `agent_join` request awaiting this owner's answer,
    whether already relayed (`invited`) or still parked awaiting the
    user's consent (`awaiting_user`, never delivered to any agent socket)
    — gets that answer now, as
    `{kind:'invite', event:'answer', room_id, peer_device_id, accept:false,
    reason:'left'}`, delivered to the requester. Without it the requester
    would wait forever: it is its own row's initiator, so it never sends
    an `agent_invite_answer` that could surface a `conflict`, and the
    dissolve puts the row out of reach of both the expiry sweep and the
    awaiting-TTL sweep. Same synthetic shape as the sweep's expiry
    `answer` (no `from_device_id`) — see "Expiry" below. A pending row the
    *owner* initiated needs no frame: for an `invited` row the invitee was
    never in the room and was not waiting on an answer; for an
    `awaiting_user` row the target was never even told about the ask.
    Either row's next answer attempt (`agent_invite_answer`, or
    `POST /agent-chat/answer` for a parked one) surfaces `conflict`/`409`
    instead.

  Success is silent either way (no-error-means-success), which keeps
  owner-leave idempotent: repeating it on an already-dissolved room (rows
  exist, all `left`) succeeds silently again. A conversation with **no**
  `convo_agents` rows at all is not a room — `convo_upsert` stamps the
  creating device as `agent_device_id` on every agent-created
  conversation, so this case is just an ordinary solo convo — and leaving
  it is the usual `{code:'conflict', detail:'not a joined participant'}`.

### Consent gating (`awaiting_user`)

(spec: `docs/superpowers/specs/2026-08-07-agent-chat-consent-design.md`.)
The default outcome of `agent_invite`/`agent_join` — whenever the directed
pair has no standing allowance — is a park, not a relay: the request lands
in `awaiting_user` and the target agent is told nothing. The requester's
`justification` (an attacker-controlled string if the requesting agent has
been prompt-injected) never reaches a sibling agent's context; it reaches a
human first.

**The card.** Parking appends a `permission_request` event to the **room
conversation** — not the requester's or the target's own session
conversation; the room is where the chat will actually happen if approved,
and it is what the push notification below deep-links the user to.
Payload:

```json
{
  "kind": "agent_chat",
  "request": "invite" | "join",
  "room_id": "…",
  "from_device_id": 7,
  "from_name": "…",
  "target_device_id": 12,
  "topic": "…",
  "justification": "…"
}
```

sent with `sender: "agent:<name>"`, same sender convention as any other
agent-authored event. `from_name`, `topic`, and `justification` are all
remote-agent-controlled text and are run through the journal's own
sanitiser before storage/publish — control characters (including `\n`)
become spaces, collapsed, trimmed to `INVITE_TOPIC_MAX_CHARS`/
`INVITE_TEXT_MAX_CHARS` — the same treatment the bridge already applies to
peer text it renders in its own voice, now applied journal-side because the
journal is the one publishing this event. Apps must render `justification`
as untrusted text (no markdown, no autolinking) — it is attacker-
controlled content shown to a human about to make a security decision.

**It is a client-only event, load-bearing.** `permission_request` with
`payload.kind === 'agent_chat'` is excluded from agent delivery — live
fan-out, hello replay, and HTTP message pagination — by `isClientOnlyEvent`
(`src/journal.js`), consulted at all three call sites so they can't drift
apart. It also gates the write side: an agent's `publish`/`finalize` reject
a payload shaped like the card outright, since it must only ever be minted
by the server's own `agent_invite`/`agent_join` park path. This is enforced
even against the room's own recorded owner: a naive fan-out would deliver
to the owner first (it manages the room), which for an `agent_join` card
is exactly the target the justification must stay hidden from. Contrast
with the `kind:'invite'` frames in "Delivery" below, which are a different,
unrelated mechanism (ephemeral, WS-only, agent-to-agent) that the card
plays no part in.

**Reading and answering the card.** Two client-gated (`who.kind !== 'client'`
→ `403`) HTTP endpoints, since only a human may decide:

- **`GET /agent-chat/pending`** → `{pending: [...]}`, one entry per
  `awaiting_user` row owned by the caller's user:
  `{convo_id, agent_device_id, initiator_device_id, justification, topic,
  created_at, title}` (`title` is the room's). A durable inbox for a client
  that missed the live card or wants to review every outstanding ask at
  once.
- **`POST /agent-chat/answer`** `{room_id, target_device_id, decision:
  "approve"|"deny", always_allow?}` — `room_id`/`target_device_id` must
  resolve to a **row belonging to the caller's own user**
  (`conversations.owner_user_id`); an unknown room and one owned by another
  user are indistinguishable (`404 {error:'not_found'}`, never `403` — same
  anti-enumeration stance as `GET /convo/:id/messages`). The row must be
  `state='awaiting_user'` or the call is `409 {error:'conflict'}` (already
  answered, or never parked).
  - **`deny`** flips the row to `denied` and, if the initiator is
    reachable, sends it `{kind:'invite', event:'answer', room_id,
    peer_device_id: target_device_id, accept:false, reason:'refused'}` —
    `reason` is **`'refused'`, never `'denied'`**. A requesting agent must
    never be able to tell "the human said no" from "the peer said no";
    collapsing the two into one wire string is what keeps that true (the
    distinct `denied` DB state exists for the user's own audit trail, not
    for the requester).
  - **`approve`** flips the row to `invited`. If `always_allow: true`, it
    also records a directed allowance pair — see "Allowance bypass"
    below for the JOIN-direction rule that decides which two device ids
    get paired. It then calls the delivery pump (see below) scoped to
    this row's own recipient, and the response is `{ok:true, delivered}`
    where `delivered` is read back off the just-answered row's own
    `delivered_at` (not a pump-wide "something got sent" flag) — `true`
    if the target happened to be connected right now, `false` if delivery
    is still owed.

**`delivered` widens.** Both the old allowance-bypass path and the new
park-then-approve path ack the *requester* with the same
`{kind:'invite', event:'delivered', room_id, target_device_id}` frame — on
the park path, at parking time, before the human has even seen the card.
`delivered` no longer means "the target's socket got the frame"; it means
"accepted into the system". The bridge's `agent_chat_start` tool copy
already tolerates this (a `pending` result is documented as normal and not
to be polled), so no wire-shape change was needed, only a wider meaning for
one that already existed.

**Delivery pump.** Approval alone cannot deliver — the room's target agent
may be offline, and an approval made through `matron-admin` (a separate CLI
process, not the running server) never touches the hub at all. A single
function, `deliverPendingInvites(db, hub, {deviceId?})` (`src/invite-
delivery.js`), owns delivery for every `state='invited' AND delivered_at IS
NULL` row, and is called from three places: `POST /agent-chat/answer`
(scoped to the just-answered row's recipient, for the fast path), an
agent's `hello` registration (scoped to that device, catching up whatever
was approved while it was offline), and the periodic sweep timer (unscoped
catch-all — covers `matron-admin`-approved rows, and any row whose target
was already connected at approval time so no hello would ever fire for
it). `markDelivered`'s `delivered_at IS NULL` predicate makes the pump
idempotent — a hello racing the sweep can double-*call* the pump but not
double-*deliver* — and `matron-admin agent-chat approve` says as much in
its own output, since the CLI itself has no path to the hub whatsoever and
the delivery genuinely happens later, out of its hands.

**Allowance bypass.** `agent_chat_allowances(user_id, from_device_id,
target_device_id)` — directed pairs a user has already approved once and
chosen to trust going forward ("always allow this agent to chat to that
agent"), checked by `isAllowed` before every park decision. A pair is
recorded from the approval card (`always_allow: true` on `POST
/agent-chat/answer`) or from `matron-admin agent-chat approve ...
--always-allow`, and removed via `matron-admin agent-chat allowances
<username> --revoke <from_id>:<to_id>` (there is no app UI for this yet —
see below). **JOIN direction rule:** an `agent_join` row self-targets
(`agent_device_id` names the joiner, who is also `initiator_device_id`), so
the pair worth remembering is `(initiator_device_id -> room's recorded
owner)`, not `(initiator_device_id -> itself)`; an `agent_invite` row's
initiator and target are already the two distinct devices, so the pair is
`(initiator_device_id -> target_device_id)` as given.

**Cap.** Outstanding `awaiting_user` rows per *requesting* device are
capped at `MAX_AWAITING_PER_REQUESTER` (3); over the cap, `agent_invite`/
`agent_join` fail `{code:'conflict', detail:'too many requests awaiting
user approval'}` rather than queuing indefinitely against the user's
attention.

**`matron-admin agent-chat` — the v1 approval surface.** Until the apps
grow the card UI (Approve/Deny/always-allow wired to `POST
/agent-chat/answer`), an operator drives approvals from the CLI, writing
the DB directly:

```
matron-admin agent-chat pending <username>
matron-admin agent-chat approve <username> <room_id> <device_id> [--always-allow]
matron-admin agent-chat deny <username> <room_id> <device_id>
matron-admin agent-chat allowances <username> [--revoke <from_id>:<to_id>]
```

`pending` lists one line per `awaiting_user` row for that user (room id,
target device id/name, topic, justification, relative age).
`approve`/`deny` re-run the same room-ownership check `POST
/agent-chat/answer` does (`conversations.owner_user_id` must match the
named user) before touching the row — this is not skippable just because
the CLI is a trusted operator surface; taking a username is precisely what
makes the check meaningful. Because this CLI cannot reach the running
server's hub, its output says so plainly both ways: an approval is relayed
by the sweep-tick pump (or that agent's next hello), not by this command,
within one sweep interval; a denial cannot push an answer frame to the
requester at all — its waiter simply times out to pending, and the state
change is only visible on its next attempt.

### Expiry

Two independent TTLs, on two different clocks, because they answer two
different questions — "has the *target agent* gone quiet?" versus "has the
*user* gone quiet?" — and the two must not be conflated (see "What the
requester learns" below).

A pending `invited` row older than the invite TTL (`inviteTtlMs`, default 30
minutes — 1800000 ms, the `inviteTtlMs` parameter default in `attachWs`) is flipped to `expired` by the
same periodic sweep that handles the tool-stream idle eviction and device
revocation checks (see "Device revocation" below) — generous on purpose,
because a busy responder is expected to report that honestly via
`agent_invite_ack` rather than race the clock. This TTL clocks from
`delivered_at`, **not** `created_at` — the 30-minute window is a window for
the target to *answer*, so it must not start ticking before the target has
actually seen the ask; a row that is `invited` but still undelivered
(target offline, or approved-but-not-yet-pumped) is exempt and can never
expire out from under a target that hasn't heard the ask yet. The initiator
hears an expiry exactly like an explicit refusal:
`{kind:'invite', event:'answer', room_id, peer_device_id:<agent_device_id>,
accept:false, reason:'expired'}`. If the initiator is offline at sweep time
it simply misses the frame, same as any other invite frame (see "Delivery"
below) — its next roster read or invite/join attempt tells the same story
(`state:'expired'` via a fresh, renewed invite). An expired row is
renewable, same as `refused`/`left`.

A parked `awaiting_user` row — the user, not the target agent, hasn't
answered — has its own, much longer TTL: `AWAITING_USER_TTL_MS`, 24 hours,
clocked from `created_at` (there is no delivery to wait for; the card was
already published the moment the row was parked). Generous on purpose: an
ask that arrives while the user is asleep must survive the night. The same
sweep flips it to `expired` and notifies the initiator — but, unlike the
`invited`-TTL case above, with `reason:'refused'`, **not** `'expired'`: a
user who never looked at the card and a user who looked and said no must
read identically to the requester (see "What the requester learns" in the
consent design spec). `denied` (an explicit `POST /agent-chat/answer
{decision:'deny'}` or `matron-admin agent-chat deny`) uses the same
`reason:'refused'` wire string for the same reason — three different DB
facts (`denied`, `refused`, this TTL's `expired`), one indistinguishable
story on the wire.

Owner-dissolve produces the same synthetic frame with `reason:'left'`
instead (see `agent_leave` above): a pending join request that the room's
dissolution has made unanswerable is closed the same way an expired one
is, because the waiting initiator is in the same position either way. Both
frames omit `from_device_id` — there is no answering connection behind
them — so an initiator can handle the pair identically and read `reason`
only to log *why*.

### Delivery

Every `kind:'invite'` frame — `request`, `join_request`, `delivered`,
`ack`, `answer` (including the sweep's own expiry `answer`), and `left` —
is an ephemeral relay, same stance as Agent RPC: **never appended to the
journal** (no `seq`, no unread/push effects, no retention surface),
**never pushed** (APNs never sees it), and **never sent to client
devices** — only the two agent devices on either side of the invite ever
see these frames. `delivered`/`request`/`join_request` use the
single-socket `hub.sendRpcRequest` delivery rule (one most-recently-
registered live connection; `offline` if none — non-idempotent, so it must
never double-deliver). `ack`/`answer`/`left` use `hub.sendToDevice`
(multicast to every live socket of that device) — these don't carry the
same double-execution risk `sendRpcRequest` guards against, so every
connection of a briefly-doubled-up (mid-reconnect) device hears them.

Separately, ordinary journal fan-out and hello replay (see "Agent delivery
scoping" above) now reach not just the recorded owner but every currently-
`joined` participant too — that's the durable side of room membership (the
room's actual conversation content), distinct from this section's ephemeral
invite-lifecycle relay.

## Device revocation

`matron-admin device revoke <device_id>` deletes the device/agent row (spec
§8) — that's the entire revocation. HTTP handlers look up the token hash
per request, so a deleted row 401s on the very next call. On the WS side,
every inbound frame *after* hello re-checks the device row still exists
(one cheap prepared `SELECT`); if it's gone, the server sends
`{kind:'control', op:'error', code:'revoked'}` and closes with code `4001`
(close-on-next-frame). A periodic sweep (every 60s) additionally checks
every *registered* connection's device row, so a revoked device that just
listens without ever sending — a lost or compromised phone — is cut off
too, with the same error frame and `4001` close. WS enforcement is
therefore **next-frame or ≤60s, whichever comes first**.
`matron-admin device list <username>` shows each device's kind, cursor,
and last-seen time.

Owners can also revoke from a client device over HTTP:
`POST /devices/:id/revoke` (Bearer, client devices only — agents get 403)
deletes the row exactly like `matron-admin device revoke`; not-owned and
nonexistent ids are indistinguishable (404 `{error:'not_found'}`).
Self-revocation is allowed and acts as a logout. WS enforcement is the
same next-frame-or-≤60s-sweep described above.

## Agent pairing (device authorization)

`gh auth login`-style enrollment for headless boxes (spec:
`docs/superpowers/specs/2026-07-15-app-managed-agent-enrollment-design.md`).
The box calls `pair/start` and displays the `pair_code` (`XXXX-XXXX`,
Crockford base32 minus vowels); the human approves that code in an
authenticated client app with `pair/approve`, naming the agent; the box
polls `pair/claim` with its secret `poll_token` (32 random bytes hex,
never displayed) and receives the agent token exactly once, straight into
its token file — no human ever sees it. Nothing durable exists until
claim: approve only flips the in-memory pair's state, and the `devices`
row is created by the claim response itself. The approve→claim regret
window (≤ TTL) is accepted in v1; once claimed, the agent appears in
`GET /devices` and is revocable instantly.

## Device link (QR sign-in)

The reverse of agent pairing: here the *signed-in* side starts. A signed-in
client ("starter") calls `link/start` and renders the `link_code` as a QR
(`matron://link?v=1&server=<url-encoded base URL>&code=XXXX-XXXX`) plus the
code as text. The new device ("claimant") scans or types the code and calls
`link/claim` with its device name, then polls `link/poll` with its secret
`claim_token` (32 random bytes hex). The starter polls `link/status`, sees
`claimed` with the claimant's name and IP, and the user taps Approve
(`link/approve`) or Deny (`link/deny`). Scanning alone never signs anything
in: only the approve tap — from the starter device itself, holding a live
bearer — releases an identity.

Like pairing, no `devices` row exists before the final step: approve only
flips the in-memory session's state, and the `kind='client'` row is minted
at the claimant's next `link/poll`, exactly once (the session is deleted
before the token is returned). Sessions live 120s (extended to ≥60s
remaining on claim so a last-second scan still leaves time for the tap),
are in-memory only, and die with a restart or with the starter's token —
`link/approve` requires a live starter bearer at tap time, so a revoked or
signed-out starter can never complete a link.

### Pre-approved link codes (provisioning)

`POST /link/preapprove {username}` mints a link session that is born
approved: the claimant runs the ordinary `link/claim` → `link/poll` flow
and the FIRST poll returns the device token — no approve tap (at
provisioning time there is no other device to tap on). The granting
authority is root on the box: the endpoint answers only loopback sockets
carrying no `X-Forwarded-*`/`Forwarded`/`CF-Connecting-IP` header (external
traffic always arrives via the reverse proxy, which adds one), and 404s
for everyone else.

That header check alone is defeated by a headerless reverse proxy (a
default-config nginx `proxy_pass` with no `proxy_set_header` lines forwards
none of them), so the endpoint additionally requires the header
`x-preapprove-key` to match a 64-hex-char secret the journal auto-mints on
first boot at `<dirname(db path)>/preapprove.key` (mode 0600, compared with
`crypto.timingSafeEqual`) — no operator provisioning step, nothing to
configure. Missing or wrong key gets the same 404 as every other guard
failure. `matron-admin link-code` reads that file itself (it must run on
the journal host, as the journal's service user or root) and sends the
header automatically.

Codes live 10 minutes, are one-shot, and count toward the same in-memory
cap as normal link sessions. `matron-admin link-code <username>
--server-url <url>` wraps this and prints the
`matron://link?v=1&server=…&code=XXXX-XXXX` QR on the terminal.

## Link rendezvous (relay)

The reverse direction, for signed-out devices that can't scan (spec:
`docs/superpowers/specs/2026-07-18-link-rendezvous-design.md`). Served by
the push relay (`push.matron.chat`), NOT the journal — a brand-new install
has no configuration, and the shared relay is the one address every Matron
app knows. The relay never carries a token: only `{server, code}`, the
same two values the shipped QR displays on screen. The confirm-tap on the
signed-in phone remains the only credential-granting gate.

- `POST /link/rendezvous` (empty body) → `201 {rid, secret, expires_in}`.
  `rid`: 26 chars of the pairing alphabet (~128 bits), shown in the QR as
  `matron://rlink?v=1&rid=<rid>`. `secret`: 256-bit hex poll gate, never
  in the QR. TTL 3 minutes, in-memory only, `maxPending` 256. Per-IP
  token bucket (burst 10, refill 1/30 s) plus a global ceiling (burst
  100, refill 1/100 ms) that also bounds offers and polls.
- `POST /link/rendezvous/:rid/offer {server, code}` — the scanning
  phone's move, after calling `link/start` on its own journal. First
  offer wins → 204; later offers 409; unknown/expired rid 404. `server`
  must be https (http allowed to localhost-ish dev hosts only), ≤ 200
  chars; `code` is normalized to `XXXX-XXXX`. Validation reasons are
  machine strings that never echo caller values.
- `GET /link/rendezvous/:rid?secret=<hex>` — the creator's 2 s poll.
  204 waiting; `200 {server, code}` once offered (NOT one-shot — the
  entry survives to TTL so a dropped response is retryable; it releases
  no credential); 403 on secret mismatch (constant-time); 404 after TTL.

A relay restart forgets pending rendezvous; the signed-out device
regenerates its QR, mirroring link-session behavior.

## Agent RPC (client->agent request/response)

Structured app->bridge calls (spec:
`docs/superpowers/specs/2026-07-15-agent-rpc-design.md`) — how the app asks a
bridge for its recent folders or to start a session in a folder, without
typing text commands into the control conversation.

- Client op: `agent_request {request_id, agent_device_id, method, params?}`
  (client connections only). `request_id`: <=128 chars, echoed verbatim on
  every correlated frame. `method`/`params` are opaque to the server (the
  bridge owns the vocabulary — same stance as `status`). Whole frame <=16 KiB
  (`MATRON_RPC_MAX_BYTES`). Unknown/foreign/client-kind targets are
  indistinguishable `not_found`; an agent with no live registered socket is
  `agent_unreachable` immediately (no queueing). A connection may send
  `agent_request` only once registered for live delivery itself — mid-replay
  requests draw `not_ready` (nothing forwarded; re-send verbatim after
  replay). `cursor: null` hellos register synchronously and never see it.
- Delivery to the agent: `{kind:'rpc', request:{request_id, from_device_id,
  method, params}}` — to exactly ONE socket, the device's most recently
  registered live connection (single-consumer: reconnect overlap must not
  double-execute a non-idempotent `start`). `from_device_id` is stamped
  server-side.
- Agent op: `agent_response {request_id, to_device_id, ok, result?, error?}`
  (agent connections only). `to_device_id` must be a client device of the
  same user (else `not_found`); `ok:false` requires `error.code`. Delivered
  as `{kind:'rpc', response:{request_id, agent_device_id, ok, result?|
  error?}}` to ALL live sockets of that device (responses are
  side-effect-free; clients dedupe by `request_id`).
- The relay is stateless and nothing is journaled: no seq, no unread/push
  effects, no retention surface. Timeouts are the client's job; at-most-once
  delivery, re-asking is the retry.
- v1 method vocabulary (bridge-owned, normative in the spec):
  `recent_folders {} -> {folders:[{path, last_used}]}` and
  `start {workdir?, browser?} -> {convo_id}` (errors `bad_workdir`,
  `spawn_failed`; unknown methods `unknown_method`). Cross-channel ordering
  between the `start` response and its `convo_upsert` is not guaranteed.

## Push notifications (APNs)

Direct HTTP/2 APNs (ES256 provider JWT, `node:http2` — no sygnal, no extra
dependencies). Disabled unless all four are set:

    MATRON_APNS_KEY_FILE=/path/to/AuthKey_XXXX.p8
    MATRON_APNS_KEY_ID=...
    MATRON_APNS_TEAM_ID=...
    MATRON_APNS_TOPIC=chat.matron.x

Missing any of them logs one warn line at boot and the push pipeline is an
inert no-op — everything else on the server works as normal.

After a journal event fans out to a user's connections, the push pipeline
considers each of that user's *client* devices with a registered token
(agent devices are never pushed to):

- skipped when that device is connected and actively `viewing` the event's
  conversation, or when its acked cursor already covers the event's `seq`,
  or when its `push_prefs` (see `PUT /push/prefs`) explicitly disable the
  event's category — `wake` background pushes are never prefs-filtered.
- `prompt` / `permission_request` push immediately at priority 10
  (category `attention`).
- `session_status` pushes on the turn-finished TRANSITION, not the new
  state alone: previous state `running` moving to `waiting` or `done`
  pushes immediately at priority 10 (category `done`, body "Session
  finished"). Every other transition is silent — in particular
  `waiting` -> `done` (tearing down an already-idle session) and a
  brand-new conversation's first state.
- `convo_meta` never pushes at all — a title rename is journal-sync
  material, not a notification (connected devices learn it from the
  journal frame).
- routine content (`text`, `tool_output`, `diff`, ...) pushes at priority 5,
  coalesced per (device, conversation): a leading push when idle, then at
  most one trailing push per 10s window while events keep arriving
  (in-memory only — a restart loses a pending trailing push).
- `read_marker` rows trigger a silent background push
  (`content-available: 1`, no alert) to the user's *other* devices so they
  clear their badge — never back to the device whose read_marker it was.
- alert title is the conversation title (falling back to its id), body is
  the event's snippet, badge is `SUM(unread_count)` over the owner's
  conversations.
- a 410 response prunes that device's `apns_token`/`apns_env` (dead token,
  logged once); a 400 keeps the token but logs loudly — almost always a
  sandbox/prod `apns_env` mismatch (the sygnal lesson), not a dead token.

Per-device `apns_env` (`'sandbox'|'prod'`) exists because Xcode dev builds
register sandbox tokens, which prod APNs answers with 400 `BadDeviceToken` —
environment has to travel with the token, never be assumed from the topic.

## Retention (payload offload)

A scheduled job (runs at boot, then every 6h) offloads `tool_output` event
payloads older than `MATRON_RETENTION_DAYS` (default 30) from the hot
`events` table to blob files, leaving `{type:'tool_output', snippet,
blob_ref}` in the row — journal replay carries that shape from then on, and
clients fetch the full body via `GET /media/<blob_ref>` on demand. `journal`
rows themselves are never deleted; only payloads move. Idempotent — a row
already offloaded (or one whose payload already has the offloaded shape) is
never reprocessed.

Unset `MATRON_RETENTION_DAYS` means ENABLED at the 30-day default.
`MATRON_RETENTION_DAYS=0`, or any value that isn't a non-negative integer,
disables retention instead (one warn log line at boot). Manual run:
`matron-admin offload [--days N]` (default 30).

Live-streamed tool output (`tool_output` payloads with `live_log: true`,
uploaded by bridges at command completion) is purged entirely after
`MATRON_TOOL_LOG_TTL_HOURS` (default 24; 0/invalid disables): the blob file
and its `blobs` row are deleted and the payload is rewritten to the tombstone
`{message_ref, command, exit_code, denied, truncated, live_log: true,
expired: true, blob_ref: null}` — the snippet is removed; what a command ran
and whether it succeeded survive forever, what it printed does not. If the
purged event is still the newest message-type event (text, tool_output,
diff, prompt, permission_request, file, image) in its conversation, the
conversation-list preview is rewritten to `$ <command>`. Offload skips
`expired` payloads. Manual run:
`matron-admin expire-logs [--hours N]`.

Client rules (binding on all client implementations):

- Render `expired: true` as an "output expired" affordance — show command and
  exit code, no snippet area, no fetch button.
- Any client-side persistence of `tool_output` payloads must enforce the same
  TTL locally: drop a cached snippet once `ts + 24h` passes, without waiting
  for a server re-sync — otherwise the server purge is defeated by device
  caches. In-memory display of a currently-open conversation is exempt.
- The TTL is not communicated in-protocol; clients assume the 24h default.
