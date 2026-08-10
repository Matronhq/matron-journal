// One-time cleanup of bridge-baked title prefixes.
//
// Bridges used to prefix every journal conversation title with their
// SERVER_LABEL, in two shapes:
//   `DEV-:a3 Fix the thing`  — first-user-message fallback and Gemini title
//                              pass (2-char session-id fragment after the
//                              colon)
//   `DEV-: matron-apple`     — the workdir-basename seed
// The label is now data (conversations.agent_device_id, rendered as a chip
// by the apps) rather than text, and bridges no longer bake it in. This
// heals what is already stored.
//
// Deliberately conservative: the label is capped at 12 non-space chars, the
// fallback fragment must be exactly two alphanumerics, and the seed form
// only strips when what follows is a single space-free token. `Fix: parser
// bug` and `TODO: ship the thing` must survive — they are ordinary titles
// that merely contain a colon.
const FALLBACK = /^[^\s:]{1,12}:[0-9a-zA-Z]{2}\s+/
const SEED = /^[^\s:]{1,12}:\s+(\S+)$/

export function stripServerLabel(title) {
  if (typeof title !== 'string' || !title) return ''
  if (FALLBACK.test(title)) return title.replace(FALLBACK, '')
  const seed = title.match(SEED)
  if (seed) return seed[1]
  return title
}

// Runs once per database, gated on PRAGMA user_version (unused elsewhere in
// this repo, so version 1 is ours). An ungated re-run would eventually eat
// an organic title that happens to match, so the gate is the safety
// property, not an optimisation. `force` is for tests only.
//
// Every rewrite is logged: BYOS users run this unattended on their own
// server and deserve an audit trail of what their titles used to be.
export function healBakedTitles(db, { log = () => {}, force = false } = {}) {
  if (!force && db.pragma('user_version', { simple: true }) >= 1) return { scanned: 0, healed: 0 }
  const rows = db.prepare('SELECT id, title FROM conversations').all()
  const update = db.prepare('UPDATE conversations SET title=? WHERE id=?')
  let healed = 0
  const run = db.transaction(() => {
    for (const row of rows) {
      // `title` is NOT NULL in the schema, but a stray non-string would be
      // rewritten to '' by stripServerLabel's guard — a heal must never
      // erase a title it does not recognise.
      if (typeof row.title !== 'string') continue
      const next = stripServerLabel(row.title)
      if (next === row.title) continue
      update.run(next, row.id)
      healed++
      log(`heal-titles: ${row.id} ${JSON.stringify(row.title)} -> ${JSON.stringify(next)}`)
    }
    db.pragma('user_version = 1')
  })
  run()
  return { scanned: rows.length, healed }
}
