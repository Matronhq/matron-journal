// The conversation ↔ mission link table (spec 2026-09-30 projects & mission
// links §3): low-level SQL shared by missions.js (join/leave/reads),
// journal.js (inheritance) and db.js (the one-time backfill). Deliberately
// imports nothing from missions.js or db.js, so no import cycle can form.
// conversations.mission_id is the CURRENT pointer; this table is the truth
// for "which conversations belong to which mission". Invariant: a non-null
// pointer always has an active (ended_at IS NULL) link.
//
// LINK_HOWS mirrors the mission_conversations.how CHECK constraint in
// src/db.js's SCHEMA — kept module-private since nothing outside this file
// needs the vocabulary yet (D12: never export what no task uses).
const LINK_HOWS = ['origin', 'joined', 'spawned', 'inherited', 'backfill']

// One pass over what the journal already knows, run by openDb while the
// table is empty (the spec's guard). It is idempotent in practice: once any
// row exists (the first join after deploy writes one) it never runs again.
// On a brand-new database it is a no-op on empty tables. INSERT OR IGNORE
// throughout: a pair found twice keeps its first, stronger source — current
// pointers go first, so an active link is never downgraded to history.
export function backfillMissionLinks(db) {
  if (db.prepare('SELECT 1 FROM mission_conversations LIMIT 1').get()) return 0
  return db.transaction(() => {
    // 1. Every current pointer → an active link. how: origin when the
    //    mission was born here, inherited for a sub-chat, else joined.
    //    joined_at: the earliest created/joined marker this conversation
    //    holds for the mission; failing that, the later of the two rows'
    //    creation times (the link cannot predate either).
    const current = db.prepare(`
      INSERT OR IGNORE INTO mission_conversations(mission_id, convo_id, user_id, how, joined_at, ended_at)
      SELECT c.mission_id, c.id, c.owner_user_id,
        CASE WHEN m.origin_convo_id = c.id THEN 'origin'
             WHEN c.parent_convo_id IS NOT NULL THEN 'inherited'
             ELSE 'joined' END,
        COALESCE(
          (SELECT MIN(e.ts) FROM events e
            WHERE e.convo_id = c.id AND e.type = 'mission'
              AND json_valid(e.payload)
              AND json_extract(e.payload, '$.mission_id') = m.id
              AND json_extract(e.payload, '$.action') IN ('created', 'joined')),
          max(c.created_at, m.created_at)),
        NULL
      FROM conversations c JOIN missions m ON m.id = c.mission_id AND m.user_id = c.owner_user_id
      WHERE c.mission_id IS NOT NULL`).run().changes
    // 2. History: a conversation that posted a milestone or filed an item on
    //    a mission it no longer points at. Ended at its last such trace.
    //    Same-user only — a row whose conversation belongs to someone else is
    //    never a link.
    const history = db.prepare(`
      INSERT OR IGNORE INTO mission_conversations(mission_id, convo_id, user_id, how, joined_at, ended_at)
      SELECT t.mission_id, t.convo_id, c.owner_user_id, 'backfill', MIN(t.at), MAX(t.at)
      FROM (
        SELECT mission_id, convo_id, created_at AS at FROM milestones
        UNION ALL
        SELECT mission_id, origin_convo_id AS convo_id, created_at AS at FROM items WHERE mission_id IS NOT NULL
      ) t
      JOIN conversations c ON c.id = t.convo_id
      JOIN missions m ON m.id = t.mission_id AND m.user_id = c.owner_user_id
      GROUP BY t.mission_id, t.convo_id`).run().changes
    return current + history
  })()
}
