// GET /help — a self-describing summary of the HTTP API, aimed at agent
// callers (bridge sessions) that arrive with a token and no repo checkout.
// Deliberately a hand-maintained digest, not generated: /help answers "what
// can I call and how", docs/protocol.md remains the source of truth for
// semantics and edge cases. Keep the two in sync when endpoints change.
export const HELP_TEXT = `# Matron journal HTTP API

Every endpoint below requires \`Authorization: Bearer <token>\` (your device
token — for a bridge, the file named by \`JOURNAL_TOKEN_FILE\`). Conversation
reads answer 404 for "missing or not yours" — never 403. The full spec is
docs/protocol.md in the matron-journal repo ("Journal search" for the index).

## Finding things

- \`GET /search?q=<terms>&limit=<n>&convo_id=<id>\` — full-text search over
  every one of your user's conversations, across all their devices. Terms are
  ANDed literals (raw FTS5 syntax is neutralised); \`q\` max 256 chars;
  \`limit\` defaults 20, clamps at 50; \`convo_id\` narrows to one
  conversation. Hits: \`{convo_id, title, seq, ts, sender, snippet, live}\` —
  \`sender\` is \`user:<name>\` or \`agent:<device>\`, \`snippet\` wraps
  matches in \`**\`, \`live: true\` means that conversation's agent session is
  running now. Only prose is indexed (\`text\` and \`diff\` events); tool
  output never appears in results.
- \`GET /roster\` — \`{agents, conversations}\` metadata for the user's
  devices and conversations (agent callers get \`snippet\` omitted).

## Reading

- \`GET /convo/:id/messages?limit=&before_seq=\` — transcript pages, newest
  first; \`limit\` 1..200. Agent callers can only page conversations this
  device owns or has joined; others 404.
- \`GET /convo/:id/messages?around_seq=<seq>&limit=\` — a context window
  centred on a seq (pair it with a \`/search\` hit). Works on ANY of your
  user's conversations: a foreign read returns indexed prose only, clamps
  \`limit\` to 30, and is logged server-side.
- \`GET /snapshot\` — bootstrap state for this device.

## Media

- \`POST /media\` (raw body, Content-Type captured) →
  \`{media_id, size, content_type, sha256}\`; fetch with \`GET /media/:id\`.
`

/**
 * Serve HELP_TEXT as markdown. Kept beside the text so the route in http.js
 * stays one line.
 */
export function serveHelp(res) {
  res.writeHead(200, { 'Content-Type': 'text/markdown; charset=utf-8' })
  res.end(HELP_TEXT)
}
