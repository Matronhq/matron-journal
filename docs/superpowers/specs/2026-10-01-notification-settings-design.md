# Notification settings: Coordinator mode, per-conversation levels, sync

Mission: "Matron notifications: let Dan choose what pushes". Dan approved the
whole plan on 1 Oct 2026. He works through the Coordinator, and the
turn-finished push from every session became noise.

## Today (before this change)

`src/push.js` is the only place a push is decided. `classify()` sorts an event
into `attention` (prompts, permission requests, agent-filed items awaiting the
user), `done` (a top-level session leaving `running`), or `activity` (batched
routine content, off by default). Per-device `push_prefs` can switch each kind
off, but no client ever had a UI for it.

## Model

All synced settings live in the journal, per user. A client reads them with
`GET /notify` and changes them with `PUT /notify`, and each change is sent live
to the user's client sockets (`{kind:'notify', settings}`), so the iPhone and
the Mac stay in step.

### Mode and events (per user, `user_settings.notify_prefs`)

`mode` is one of `coordinator` (the default), `all` or `custom`. The two
presets fix the event switches:

| event | meaning | coordinator | all |
|---|---|---|---|
| `prompts` | prompts, permission requests, spawn/chat consent cards | on (always) | on (always) |
| `questions` | an agent-filed item or comment left awaiting the user | on | on |
| `coordinator_done` | the Coordinator's session leaves `running` | on | on |
| `other_done` | any other session finishes its turn (running → waiting) | off | on |
| `stopped` | any other session stops mid-turn (running → done) | off | on |
| `rooms` | agent-room messages (batched) | off | off |
| `activity` | routine content in ordinary conversations (batched) | off | off |

`custom` uses the stored `events` object. `prompts` cannot be switched off: an
unanswered prompt blocks an agent.

Coordinator mode with no Coordinator set behaves as `all`, because there is no
Coordinator to watch the other sessions.

### Per conversation (`convo_notify`)

`level` is `all`, `needs_me` or `none`, or no row for "follow the mode".
`mute_until` (ms) acts as `none` until then.

- `none`, or a mute that is still running: nothing pushes.
- `needs_me`: only `prompts` and `questions`.
- `all`: `prompts`, `questions`, every finished or stopped turn, and `rooms`
  and `activity` if those switches are on.

### Per device (`devices.push_level`)

`all` (the default), `needs_me` or `off`. This applies on top of everything
above. The legacy per-device `push_prefs` booleans stay as a further filter.
Since no client ever set them, they are all at their defaults.

### Consent cards: a 30 s hold in Coordinator mode

When the effective mode is `coordinator`, a Coordinator is set, its consent
switch is on, and the ask did not come from the Coordinator itself, the push
for a spawn or chat consent card is held for 30 s. When the hold ends, the
push is sent only if the ask is still `awaiting_user`. A Coordinator that
decides in time therefore never buzzes the phone.

A held push is lost if the journal restarts. `resumeHeldConsent()` runs at
startup and re-arms any card that was still mid-hold when the journal went
down: one younger than the hold plus 60 s of slack, still pending, and held
under the current settings. Older cards, and cards that pushed at once, got
their push before the restart. The read uses a partial index on
`permission_request` events. Questions and items are never held (Dan's call).

### Badge

In Coordinator mode, the badge is the Coordinator's unread count plus the
number of open items awaiting the user. In `all` or `custom` mode it stays the
total unread count.

## Not built

Quiet hours. Dan's call: Focus on iOS and macOS already silences Matron on a
schedule.
