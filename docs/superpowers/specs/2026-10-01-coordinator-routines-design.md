# Coordinator routines — journal-owned schedules and a playbook loaded at spawn

**Status:** approved by Dan, 1 Oct 2026 (tracker item "Plan: journal-owned Coordinator routines + a playbook loaded at spawn", answered "build it"). Mission 5651.
**Repos:** matron-journal (routines table, routes, sweep, firing, seeding), matron-bridge (the `routine` session-control action, `routine_*` tools, the playbook), matron-apple (Settings ▸ Coordinator ▸ Routines — a separate mission).
**Related:** [memories](2026-09-27-memories-design.md), [read state](2026-09-30-read-state-design.md), matron-bridge `2026-09-29-coordinator-session-control-design.md` (session control, the Alertmanager relay).

## Why

The Coordinator's recurring work lives in fragile places: bridge reminders that belong to one conversation and have to re-arm themselves, memories that are rules but not procedures, and conversation context that compaction discards. Replacing the Coordinator conversation loses the schedule; a reminder that misses its re-arm drifts or stops.

Two things fix that. A **routine** is a schedule and a prompt the journal owns and fires into whichever conversation holds the Coordinator role, waking its box if needed — nothing in any conversation keeps it alive. A **playbook** is the written procedure for each routine and each standard task, loaded into the Coordinator's instructions at spawn, so a new Coordinator conversation behaves the same from its first turn. Dan's rules stay memories; the playbook names them.

## The routine

```sql
CREATE TABLE IF NOT EXISTS routines(
  id            TEXT PRIMARY KEY,            -- 'rt_' + 16 hex
  user_id       INTEGER NOT NULL REFERENCES users(id),
  name          TEXT NOT NULL,               -- slug, the handle agents and prompts use
  title         TEXT NOT NULL,
  schedule      TEXT NOT NULL,               -- 5-field cron, in `tz`
  tz            TEXT NOT NULL,               -- IANA zone, default Europe/London
  prompt        TEXT NOT NULL,               -- the turn text, ≤ 2000 chars
  enabled       INTEGER NOT NULL DEFAULT 1,
  origin        TEXT NOT NULL CHECK(origin IN ('seed','user','agent')),
  next_at       INTEGER,                     -- next fire (ms); NULL while paused
  retry_at      INTEGER,                     -- the one retry after a failed delivery
  last_fired_at INTEGER,
  last_outcome  TEXT,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL,
  UNIQUE(user_id, name)
);
CREATE INDEX IF NOT EXISTS idx_routines_due ON routines(enabled, next_at);
```

`user_settings` gains `routines_seeded_at INTEGER` (added with the same `PRAGMA table_info` guard as `coordinator_consent`), so the starter set is seeded once per user and never again after the user deletes it.

Limits: `name` matches `/^[a-z0-9][a-z0-9-]{0,63}$/`; `title` one line ≤ 200; `prompt` ≤ 2000 characters (the session-control message cap), control characters other than newlines stripped; `schedule` exactly five whitespace-separated fields that `croner` accepts, and whose consecutive fires are at least 15 minutes apart (checked over the next five fires from now — a routine is a check-in, not a poll); `tz` a zone `Intl.DateTimeFormat` accepts; at most 50 routines per user.

Cron is evaluated by **croner** (MIT, no dependencies, DST-correct in a named zone): the one new dependency. `next_at` is always `Cron(schedule, {timezone: tz}).nextRun(from)` for the `from` named below.

## Routes (Bearer, either device kind)

| Route | Who | Body | Returns |
|---|---|---|---|
| `GET /routines` | any | | 200 `{routines:[…]}`, by `name` |
| `GET /routines/:key` | any | | 200 `{routine}`; `:key` is the id or the name |
| `POST /routines` | client, or the Coordinator | `{name, title, schedule, prompt, tz?, enabled?, convo_id?}` | 201 `{routine}`; **409** `conflict` when the name is taken; **409** `{error:'conflict', blocked_by:'cap'}` at 50 |
| `PATCH /routines/:key` | client, or the Coordinator | `{title?, schedule?, tz?, prompt?, enabled?, convo_id?}` — at least one | 200 `{routine}` |
| `DELETE /routines/:key` | client only (agent → **403**) | | 200 `{ok:true}` |
| `POST /routines/:key/run` | client, or the Coordinator | `{convo_id?}` | 202 `{accepted:true}` or `{delivered:false, reason:'no_coordinator'\|'busy'}` |

A routine row on the wire is every column except `retry_at`. **400** `bad_request` for any invalid field; **404** `not_found` for an unknown key or another user's routine.

**The Coordinator gate.** An agent writer must name its own conversation in `convo_id`, and it must be the user's Coordinator — the `closingConvo(…, {required: true})` rule missions and projects use: no `convo_id` or another conversation → **403** `{error:'forbidden', detail:'not_coordinator'}`; a conversation this device does not own → **404**. The journal is the gate, as for consent: an ordinary agent can read the list but never change it, and no agent can delete a routine (the user's list, the user's delete).

**`enabled`.** Pausing sets `next_at` and `retry_at` to NULL; resuming, or changing `schedule`/`tz`, recomputes `next_at` from now. Editing `title` or `prompt` leaves the schedule alone. The `run` route fires the routine now whatever `enabled` says and never touches `next_at`.

## Firing

A sweep (`src/routines-sweep.js`) runs once a minute, like the stall-wake sweep, and is stopped in `close()`. A routine is **due** when it is enabled and `next_at ≤ now`, or `retry_at ≤ now`.

For each due routine, in one transaction *before* anything is delivered: `last_fired_at = now`, `next_at = nextRun(now)`, `retry_at = NULL`. Advancing first means a crash, a slow wake or a journal restart mid-delivery can never fire the same occurrence twice.

- **Too late to be useful.** A `next_at` more than 6 hours in the past (the journal was down, or the clock jumped) is skipped with `last_outcome = 'missed'` and the row advances; a 07:05 sweep is not run at 15:00.
- **Delivery**, off the sweep's loop and bounded to 4 in flight per journal process (a fifth due routine waits for the next sweep without advancing): resolve the user's Coordinator and its box (`coordinatorDevice`); none → `last_outcome = 'no_coordinator'`. Otherwise `wakeIfOffline`, wait for the box to attach (`MATRON_SPAWN_WAKE_WAIT_MS`) when a wake was fired, then issue the journal-originated RPC, exactly as the Alertmanager relay does:

```json
{ "method": "session_control",
  "params": { "convo_id": "<the Coordinator conversation>", "action": "routine",
              "routine_id": "rt_…", "name": "daily-sweep", "title": "Daily sweep",
              "message": "<prompt>", "fired_at": "2026-10-02T06:05:00.000Z", "tz": "Europe/London",
              "from_name": "Routines" } }
```

- **Outcome.** The bridge answers `{ok:true, result:{applied:'now'|'deferred'}}` → `last_outcome = 'applied now'|'applied deferred'`. An error → `last_outcome = 'failed <code>'`. A delivery failure the next sweep might cure (`agent_unreachable`, `timeout`, `send_failed`, an internal error) sets `retry_at = now + 15 min` **once**: the retry's own failure leaves `retry_at` NULL, and the routine waits for its next scheduled time. A refusal from the bridge (`bad_request`, `not_coordinator`, `gone`) is not retried. A box the infra cannot wake costs one fire, never a storm (the wake gap itself is mission 5623).
- **Marker.** After the outcome is known, a `routine` event is appended into the Coordinator conversation: `{routine_id, name, action:'fired', outcome, next_at}`. Create, update and delete append `{routine_id, name, action:'saved'|'deleted', by:'user'|'agent'}` there too (nothing when no Coordinator is set). `routine` is not a `MESSAGE_TYPE` (no unread, no snippet), not an `AGENT_PUBLISH_TYPES` member, never pushes, never wakes; apps refetch `GET /routines` on it. One line is logged per fire: `routines: <name> for <user> -> Coordinator <convo> on device <id>: <outcome>`.

`routine` is **not** a `session_control` op action: only the sweep and the `run` route build it, so no agent can forge one through its own op (the bridge refuses a `routine` whose `from_device_id` is not the journal's 0, and one aimed anywhere but the Coordinator).

## The bridge

- `lib/session-control.js` gains action `routine` (journal-only, Coordinator-only, like `alert`). The turn is framed on the bridge: `[routine daily-sweep, fired by the journal at 07:05 Europe/London] <prompt>`. Parked while the Coordinator is mid-turn, in its own slot kind: a newer fire of the **same** routine replaces an unapplied one (a 2-hourly check never piles up); fires of different routines are appended, oldest first, under the alert cap. Notice line: `🔔 Routine daily-sweep: Daily sweep` (`… once this turn finishes` when parked).
- `lib/routines-client.js` + `lib/routines-tools.js`: `routine_list`, `routine_update(name, {title?, schedule?, tz?, prompt?, enabled?})`, `routine_run(name)`, mounted in `ask-user.js` like the consent tools and refused locally for a session that is not the Coordinator. No create or delete tool: the apps own those.
- **Playbook.** `BRIDGE_COORDINATOR.md` stays the preamble (role, never do the work, memories, tracker, links, consent, session control). A `coordinator/` directory holds `procedures/*.md` (sweep, triage a consent request, unstick a session, close missions, file projects, hand to the merge train or deploy-1, infrastructure alert) and `routines/*.md` (one per starter routine, each a section headed by the routine's name). `loadCoordinatorBlock` concatenates the preamble, then every file in each directory in name order, into the one block appended to the Coordinator's system prompt. The `Check-ins` section (bridge reminders) is replaced by a `Routines` section.

## Seeding

`seedRoutines(db, userId, now)` inserts the starter set with `origin='seed'` when `user_settings.routines_seeded_at` is NULL and the user has no routines, then stamps `routines_seeded_at`. It runs when the user's Coordinator is first assigned (`PUT /coordinator`, after the role transaction commits) and once at boot for every user who already has a Coordinator — the one-off for Dan. Prompts are one line each and point at the playbook section, so editing a procedure never means editing the journal.

| name | schedule (Europe/London) | prompt |
|---|---|---|
| `daily-sweep` | `5 7 * * *` | Routine daily-sweep: follow the Daily sweep section of your playbook. |
| `session-health` | `0 */2 * * *` | Routine session-health: follow the Session health section of your playbook. |
| `project-status` | `0 8,17 * * *` | Routine project-status: follow the Project status refresh section of your playbook. |
| `unseen-digest` | `0 12,18 * * *` | Routine unseen-digest: follow the Unseen digest section of your playbook. |
| `deploy-window` | `30 18 * * 1-5` | Routine deploy-window: follow the Evening deploy window section of your playbook. |

## Migration

Once the routines are firing, the Coordinator cancels its own reminders (the daily sweep, the 2-hourly health check, the 08:00/17:00 project check-ins) with `reminder_cancel` and the standing rule about the check-in cadence is retired; the playbook's Routines section tells it to. Nothing re-arms itself any more.

## Testing

Journal: unit tests for validation and `nextRun` (including a DST crossing and the 15-minute spacing rule), the sweep (due, missed, advance-before-deliver, in-flight bound, retry once), delivery through a fake bridge socket (the `alerts-http` test fleet), the routes (gate, caps, conflict, marker), seeding (once per user, at assignment and at boot). Bridge: the `routine` action (authorisation, framing, parked merge), the tools, `loadCoordinatorBlock` concatenation. Tests run serially (`--test-concurrency=1`); the DB is backed up before the services-1 deploy.
