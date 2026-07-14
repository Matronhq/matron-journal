# Tool-Output Purge After TTL — Design

**Decision (2026-07-14):** all tool output is purged from the journal after
`MATRON_TOOL_LOG_TTL_HOURS` (default 24) — not just the full-log blob, but the
snippet too. What survives forever is the command string, the exit code, and
the denied/truncated flags ("option A"): scrolling back you can always see
*what ran and whether it succeeded*, never *what it printed* once the TTL has
passed. This restores the ephemerality of the pre-journal viewer-link world
(links died at 24h and nothing was stored) while keeping the conversation
history navigable.

Motivation: tool output routinely contains sensitive material (`cat .env`,
build logs echoing tokens). The streaming pipeline persists output
automatically with no judgment in the loop, so durable storage must be
time-bounded by default. Commands with inline secrets are out of scope here —
that is the future `redact-event` tool's job, not a reason to nuke every
command string.

## Server changes (matron-journal)

### `runExpireLogs` (src/retention.js) rework

Today the sweep selects `type='tool_output' AND ts<cutoff AND blob_ref IS NOT
NULL`, deletes the blob, and rewrites the payload to
`{...payload, blob_ref: null, blob_expired: true}` — the snippet stays. New
behavior:

- **Selector:** all `type='tool_output'` rows older than the cutoff that are
  not yet tombstoned, regardless of `blob_ref` — a row whose blob already
  expired under the old code (payload has `blob_expired: true`, `blob_ref`
  NULL) must still get its snippet purged. Skip already-tombstoned rows
  cheaply in SQL (`json_extract(payload,'$.expired') IS NULL`), not by
  parsing every historical row's payload on every 6-hourly run.
- **Guard:** parse the payload; skip rows where `live_log !== true` (same
  guard as today — only bridge-uploaded live logs are governed by this TTL)
  and rows that fail to parse. Verified against the live DB (2026-07-14):
  every non-live_log tool_output row (6,406 of them) is a viewer-era pointer
  event shaped `{command, expires_at, tool_use_id, viewer_url}` — no output
  in the payload, only a long-expired signed link — so the guard excludes
  nothing that holds output. Those legacy rows are left untouched (their
  command strings are exactly what option A keeps anyway).
- **Tombstone shape:** rewrite the payload to
  `{message_ref, command, exit_code, denied, truncated, live_log: true,
  expired: true, blob_ref: null}` — the `snippet` key is **removed**, not
  nulled, and `expired: true` is the single flag clients key on
  (`blob_expired` is dropped from rewritten payloads; no shipped client reads
  it). `command`, `exit_code`, `denied`, `truncated`, `message_ref` are
  carried over verbatim from the old payload.
- **Blob deletion:** unchanged — delete the `blobs` row and disk file in the
  same transaction as the payload rewrite when a `blob_ref` is present.
- **Idempotent:** a tombstoned row is never reprocessed (excluded by the
  selector); re-running the sweep is always safe.
- Same knob and schedule as today: `MATRON_TOOL_LOG_TTL_HOURS` (default 24;
  0/invalid disables the sweep entirely), runs at boot then every 6h, manual
  `matron-admin expire-logs [--hours N]`.

### Conversation-list preview scrub

`publish` copies the first 120 chars of a tool_output snippet into
`conversations.snippet` (src/journal.js `snippetOf`). If a purged event is
still the conversation's latest (`conversations.last_seq == row.seq` for that
`convo_id`), the sweep must rewrite the preview too, or purged output
survives in the convo list indefinitely (archived convos never get a newer
message). Rule: recompute `conversations.snippet = snippetOf('tool_output',
tombstone)` for affected convos.

To make that preview useful, `snippetOf` gains one branch: for
`type='tool_output'` with no `snippet` but a `command`, return
`$ <command>` (120-char cap) instead of the generic `[tool_output]`
placeholder. This also improves previews for any future snippetless
tool_output.

### Interaction with the 30-day offload job

`runOffload` currently skips `blob_expired` payloads. Change the skip to
`expired` payloads. In practice every live-log tool_output row is a tiny
tombstone long before the 30-day offload horizon, so offload's tool_output
work becomes a no-op; the skip just keeps it from re-writing tombstones into
blob files.

## Protocol contract (docs/protocol.md)

Update the Retention section:

- Snippets are no longer kept forever: after the TTL the payload is the
  tombstone shape above. Document the exact shape and that `expired: true`
  is the client-facing flag.
- **Client rules** (binding on all future client implementations — none
  render tool_output today):
  1. Render `expired: true` as an "output expired" affordance (no fetch
     button, no snippet area) while still showing command + exit code.
  2. Any client-side persistence of tool_output payloads must enforce the
     same TTL locally: a device that cached a snippet at hour 2 drops it at
     hour 24 (event `ts` + TTL) without waiting for a server re-sync.
     Without this, the server purge is theater — the output would live on in
     every device cache. In-memory display of a currently-open conversation
     is exempt; the rule governs what is written to disk.
  3. The TTL is not currently communicated in-protocol; clients assume 24h.
     (If a deployment changes `MATRON_TOOL_LOG_TTL_HOURS`, client caches are
     conservatively wrong in one direction only if the server TTL is longer;
     acceptable — revisit only if a real deployment needs it.)

## Bridge (claude-matrix-bridge)

No changes. The bridge stores no tool output durably (Matrix receives only
`{tool_use_id, command}` in the custom live-output event; raw output goes
only to the journal). The `/tmp` matron-tee logs on the dev box are outside
this design (OS tmp lifecycle), as before.

## Tests

Extend `test/retention.test.js`:

1. Purge rewrites an old live-log row (with blob) to the exact tombstone
   shape — snippet key absent, `expired: true`, command/exit_code/flags
   carried over — and deletes blob row + file.
2. Purge tombstones a row already in the old `blob_expired` shape (blob_ref
   NULL) — snippet removed.
3. Rows younger than the cutoff, non-live_log rows, and already-tombstoned
   rows are untouched; sweep is idempotent (second run returns
   `{expired: 0}`).
4. Convo preview scrub: when the purged event is the convo's latest,
   `conversations.snippet` becomes `$ <command>`; when a newer event exists,
   the preview is untouched.
5. `snippetOf('tool_output', …)` command-branch unit cases (command present /
   absent / >120 chars).
6. Offload skips `expired` payloads.
7. TTL knob: 0/invalid disables (existing semantics preserved).

Conformance fixture `13_tool_stream.json` is unaffected (it exercises the
live path, not retention).

## Out of scope (recorded follow-ups)

- `matron-admin redact-event` — purge a specific event's payload/blob on
  demand (the answer to secrets in *command strings* or in output younger
  than the TTL).
- Bridge-side masking of high-confidence token shapes (same-byte-length
  replacement to preserve stream offsets).
- Client implementation itself — rules above bind it when it happens.
