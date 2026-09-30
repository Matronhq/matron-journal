# Read state — the Coordinator knows what Dan hasn't seen

Date: 2026-09-30. Status: **design decided by Dan (all four questions answered, 30 Sep); build awaits his go-ahead.**
This is mission 5427 and spans matron-journal, matron-apple and matron-bridge.
matron-web and matron-android come later.

Dan asked for this on 30 Sep by voice: "Can we make it so that we track the
read status of messages, so that if someone has said something in a chat and
I haven't seen it, the Coordinator could tell me: by the way, you didn't see
this, it was an important thing that you should have seen."

Dan answered all four design questions in his tracker (§7). He chose the
recommended option each time, and added that agents may see which of their
own messages he hasn't seen (§5).

## 1. What exists today

- **The journal already has a coarse read cursor.** A client sends the
  `read_marker` op `{convo_id, up_to_seq}`. `markRead` (src/journal.js)
  appends a `read_marker` event and recomputes `conversations.unread_count`.
  The unread count drives the badge and the unread pill. It is one high-water
  mark per conversation, and it can only move forward.
- **"Opened" is not the same as "read".** Apple sends one `read_marker` when a
  chat opens, with `up_to_seq = store.maxSeq`. That covers everything, even
  twenty messages above the fold that were never scrolled to
  (`JournalTimelineService.markAsRead`). Messages that arrive while the chat is
  on screen are not marked. Web debounces the same op.
- **Bridges mark read too.** After mirroring the user's own message, a bridge
  sends `read_marker` with `up_to_seq: null` (meaning the head of the
  conversation) under an `agent:<box>` sender. The badge wants this, but it
  says nothing about what Dan saw.
- **Items and item comments have no read state at all**, only `awaiting`.
- **Text events carry no importance.** The payload is
  `{body, from, message_ref?}`. The existing `fallback_for: 'item'` flag is the
  precedent for adding a payload flag.
- **There is no periodic Coordinator sweep.** The consent nudge is the model
  for journal-driven nudges: one ephemeral frame, delivered as a turn to the
  Coordinator.

## 2. Design principle: seen is separate from unread

The badge keeps its current meaning, "there's something new here". **Seen** is
a new, finer-grained record of which messages were actually on Dan's screen.
It never changes `unread_count`, the badge, or push. This keeps the change
additive, with no risk to the badge that every app already relies on.

## 3. What counts as seen (Q1, decided: A)

**Decided:** a message counts as seen when it has been on screen for at
least 1 second in the foreground app. "On screen" means at least half the row
is visible, or the row fills at least half the viewport. On Mac the window
must also be key or at least visible. Clients report **seq ranges**, not a
single high-water mark, so a jump to the bottom does not count the unscrolled
middle as seen.

- The client batches ranges `[from_seq, to_seq]` of message events that were
  visible and flushes them about every 2 seconds, and on background or close.
- Ranges from all of Dan's client devices merge on the server. A range seen on
  the phone is seen everywhere.
- **Not seen:** a notification that was delivered but not tapped, a
  conversation-list snippet, a bridge's `read_marker`, or Dan replying from a
  notification.
- **Tapping a notification** counts the message it names as seen: the banner
  showed Dan the text.
- **Items:** opening an item's detail counts the item body and every comment
  rendered in the thread as seen. An inline item card in the timeline is
  covered by the card's own message seq.
- **Legacy clients** are Web and Android until they ship receipts, and Apple
  builds from before this change. They only send `read_marker`. For them the
  server treats a *client* `read_marker` as "seen up to that seq", but only if
  the device has never sent a seen range. That avoids a flood of false "you
  didn't see this" for things Dan read on the web. Once a device sends ranges,
  its coarse markers stop counting as seen.

## 4. Journal (matron-journal)

### Storage

Three new tables. No ALTER on existing tables, so there is no overlap with the
Projects migrations (§8).

```sql
-- Merged seen ranges per conversation, for the owning user. Adjacent and
-- overlapping ranges are coalesced on write, so a normally-read conversation
-- stays at one or a few rows.
CREATE TABLE IF NOT EXISTS seen_ranges(
  user_id   INTEGER NOT NULL,
  convo_id  TEXT NOT NULL,
  from_seq  INTEGER NOT NULL,
  to_seq    INTEGER NOT NULL,
  first_device_id INTEGER,          -- where it was first seen (audit only)
  seen_at   INTEGER NOT NULL,       -- earliest time any part was seen
  PRIMARY KEY(user_id, convo_id, from_seq)
);
-- Item threads: seen through which comment (or just the item itself).
CREATE TABLE IF NOT EXISTS item_seen(
  user_id  INTEGER NOT NULL,
  item_id  TEXT NOT NULL,
  seen_through_comment_at INTEGER,  -- created_at of the newest comment rendered
  seen_at  INTEGER NOT NULL,
  PRIMARY KEY(user_id, item_id)
);
-- What the Coordinator has already told Dan about (the no-repeat rule, §6).
CREATE TABLE IF NOT EXISTS unseen_flags(
  user_id   INTEGER NOT NULL,
  ref       TEXT NOT NULL,          -- 'msg:<convo_id>:<seq>' or 'item:<id>' or 'comment:<id>'
  flagged_at INTEGER NOT NULL,
  flagged_in_convo_id TEXT NOT NULL,
  PRIMARY KEY(user_id, ref)
);
```

A device that has sent at least one range is marked with a `devices` bit held
in memory, rebuilt at start from `seen_ranges.first_device_id`. That drives the
legacy fallback without adding a column.

### Protocol

- **The new WebSocket op `seen`** is sent only by client connections:
  `{op:'seen', convo_id, ranges:[[from,to],...]}`. It is validated against
  the owner and capped at 64 ranges per op. It is not journaled as an event,
  because seen state is not conversation content and must not bump anything.
  The server fans out an ephemeral `seen` frame to the user's other client
  devices, so an unread-in-this-session highlight can clear everywhere.
- **The new WebSocket op `item_seen`** is `{item_id, through_comment_at}`, and
  follows the same rules.
- **`GET /unseen`** is Coordinator-only (§5). It returns unseen message events
  and items by the rules in §6.
- **`POST /unseen/flags`** is Coordinator-only and takes `{refs[], convo_id}`.
- **`GET /seen?convo_id=`** is for the user's own clients only, so an app can
  draw a "new since you last looked" divider from real seen state. This is
  optional and comes after v1.
- The **privacy gate** (§5) runs before anything else, as it does for
  `read_marker`.

### Retention

`seen_ranges` rows go when their conversation goes (retention.js already walks
conversations). `unseen_flags` rows are pruned after 30 days.

## 5. Privacy (Q3, decided)

Dan chose Coordinator-only visibility, then added that an agent should be able
to tell which of **its own** messages he hasn't seen. The use case is an agent
at the end of a long turn noticing that something it said early on was never
seen, and mentioning it again.

- **Writes.** Only Dan's client devices write read state.
- **The Coordinator** can query all of it (`unseen_list`, §6).
- **Any agent** can ask about its own messages in its own conversation, and in
  rooms it takes part in, with `unseen_mine()`. It sees nothing about other
  conversations and nothing about other senders' messages.
- **Nobody else sees it.** Other users, including team members on shared
  items, never do.
- **Private devices.** The Coordinator's `/unseen` excludes conversations owned
  by a private device, unless the Coordinator itself runs on that device. This
  is the same exclusion `coordinatorFor` already uses. `unseen_mine` is scoped
  to the caller's own rooms, so it needs no extra rule.
- **Nothing** about seen state goes into search, push payloads or the apps'
  roster.

### `unseen_mine` (every agent)

```
unseen_mine({ older_than?: '10m' })
→ [{ seq, ts, snippet, reasons[] }]   // the caller's own messages Dan hasn't seen
```

- This is backed by the journal route `GET /unseen?mine=1&convo_id=`, scoped
  to the caller's rooms.
- **Instructions in the bridge's base prompt.** Check it when finishing a long
  turn. If something that matters is unseen, restate it once, briefly, in the
  closing message ("Earlier I said X; you may have missed it"). Never repeat a
  restatement. Never tell Dan he hasn't read something.
- **Restating counts as raised.** The restatement is itself a new message. The
  agent calls `unseen_flag` on the original ref, but only for its own
  messages. The Coordinator's no-repeat rule then skips the original, and the
  Coordinator flags the restatement only if that also goes unseen.

## 6. Importance, the Coordinator tool, and the no-repeat rule (Q2, Q4)

### Importance (Q2, decided: A)

**Decided:** a journal-computed floor, plus the Coordinator's judgment. No
agent-side flag in v1. The journal tags each unseen thing with `reasons[]`:

| reason | rule |
| --- | --- |
| `awaiting_user` | an open item with `awaiting='user'` whose body or newest comment is unseen |
| `question` | an item of kind question created or commented on by an agent, unseen |
| `permission` / `prompt` | a `permission_request` or `prompt` event, unseen, still unanswered |
| `final` | the last agent message before a conversation went `done` or `waiting` |
| `failure` | `spawn_outcome` failure, session stalled, or a notice from the bridge's error paths |
| `mentions_dan` | in an agent-to-agent room, text that names Dan (in his own conversations every message is addressed to him, so this rule is for rooms only) |

Anything with at least one reason is `important`. The rest of the unseen
agent text is `other`. The Coordinator reads the snippets and decides whether
to raise them. It is already reading every session for status updates, so
this adds no new behaviour, just a better list.

Rejected for v1: an agent-marked `important: true` flag. Agent text is plain
assistant output with no tool call, so marking it would need a new tool or a
magic prefix. The tracker is already the "this needs Dan" channel. If the
floor proves too coarse, add it in v2 as a payload flag alongside
`fallback_for`.

### The tool (Q4)

In the bridge, `unseen_list` is available to the Coordinator only:

```
unseen_list({
  older_than?: '30m',          // don't flag what Dan is probably about to read
  since?: '3d',                // don't dredge up last month
  importance?: 'important' | 'all',   // default 'important'
  convo_id?, mission?,         // narrow
  include_flagged?: false,     // default: hide what was already raised
  limit?: 50,
})
→ grouped by conversation: title, mission #, state; per entry:
  ref, kind (message|item|comment), seq/num, ts, sender, snippet,
  reasons[], item link, age
```

`unseen_flag({refs, note?})` records that the Coordinator has told Dan about
these entries.

Default exclusions:
- Dan's own messages.
- tool_output, diff and summary events.
- Agent-to-agent rooms, which are shown with `importance:'all'` only.
- Conversations Dan has archived.
- Anything superseded: an item since closed, or a prompt since answered.

### No-repeat rule

- A ref that has been flagged is never returned again by default
  (`include_flagged:false`), even if Dan still hasn't opened it.
- If Dan sees the Coordinator's message containing the flag, the ref stays
  flagged and done.
- If he *also* doesn't see that message, the Coordinator's own conversation
  shows up as unseen. That is one message to catch up on, not N repeated
  flags.

### When the Coordinator uses it (Q4, decided: A)

**Decided:**
1. Every status update gets a short "You haven't seen" section with at most 5
   entries, each giving the conversation link, one line, and why it matters.
2. **An event-driven nudge.** The journal sends the Coordinator one ephemeral
   `unseen` frame, the same mechanism as the consent nudge, when an
   `important` entry has been unseen for 2 hours. Frames are batched, at most
   one per hour, and only 07:00–22:00 UK time. The Coordinator then decides
   whether to message Dan and calls `unseen_flag`.

`BRIDGE_COORDINATOR.md` gets a short section on this, with the no-repeat rule
and "one line each, lead with why it matters".

## 7. Dan's decisions (30 Sep)

1. Seen: on screen for 1 s, reported as seq ranges. Tapping a notification
   counts that one message.
2. Important: journal reasons plus the Coordinator's judgement. No agent flag
   in v1.
3. Privacy: the Coordinator sees all. Each agent sees only its own unseen
   messages (`unseen_mine`). Nobody else sees any of it.
4. Triggers: a "You haven't seen" section in status updates, plus a 2 h
   nudge (at most hourly, 07:00–22:00 UK). The no-repeat rule applies.

## 8. Order of work, and the Projects work (mission 5181)

- Projects' journal PR (#101) has already merged. Its bridge PR (#332) and its
  apple plan (#276) are open.
- Read-state adds new tables, ops, routes and a new bridge tool. It does not
  alter `events`, `conversations`, `items` or `missions`. In Apple it touches
  the chat timeline and item detail, not the mission and project views.
- **Agreed with the Projects session (dan-mac, 30 Sep): Projects first,
  read-state rebases after.**
- **Journal:** Projects PR 101 is merged and live, and there is no further
  Projects schema work, so the three new tables collide with nothing.
- **Bridge:** Projects PR 332 is merged and deployed. A small follow-up is
  coming: `reminder_create` gets `repeat: "daily"`, and a check-in paragraph
  goes into BRIDGE_COORDINATOR.md. Our `unseen` section in that file will
  need a trivial text rebase.
- **Apple:** Projects is 4 stacked PRs (`feat/projects-data` first). None of
  them touch ChatTimelineController or ItemDetailView. They do touch the
  headers and toolbars in ChatView.swift and MacChatView.swift, but not the
  timeline rows, so our tracker should only need a small rebase.
- **Mac timeline:** apple #264 moves the Mac chat timeline to a virtualised
  AppKit view behind `chat.timeline.appkit`. The Mac visibility tracker is
  built on the AppKit timeline's visible rows. It covers the SwiftUI
  `MacChatView` only while that is still the default.

Build order once approved:
1. **journal:** tables, the `seen` and `item_seen` ops, the legacy fallback,
   `/unseen` and flags, and the nudge frame. Tests with real merged ranges.
2. **bridge:** `unseen_list` / `unseen_flag` / `unseen_mine`, the nudge turn, and the
   Coordinator brief.
3. **apple:** visibility tracker (iOS `ChatTimelineController` visible index
   paths; Mac `LazyVStack` row geometry), flush on scene phase, item detail
   receipts, and notification-tap receipt.
4. **later:** web and android receipts. Until then, the legacy fallback keeps
   them from causing false alarms.
