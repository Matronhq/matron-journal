// Conversations named after their current mission.
//
// A bridge publishes a generated title, `{marker }[xx] {topic}`. The journal
// keeps that as `auto_title` (with the parsed `session_short` and
// `title_marker` beside it) and composes the DISPLAY title in
// `conversations.title`: while the conversation is on a mission and has a
// short, `{marker }[xx] {mission label}`; otherwise exactly what the bridge
// sent. Every reader of `title` (snapshot, roster, search, push alerts,
// spawn-room tags) therefore gets the mission name with no change of its
// own, and the `[xx]` shape every short parser expects is kept.
//
// Never mission-named (title stays auto_title): system conversations,
// sub-chats (parent_convo_id), rooms of every kind (agent-chat, spawn and
// person rooms, or any title carrying a room marker) and titles with no
// short. A mission born in a private device's conversation never names a
// conversation that is not itself private-owned — the markerTitleAllowed
// rule mission markers already follow.
import { titlePrefix } from './room-title.js'
import { markerTitleAllowed } from './privacy.js'

// missions.name: an optional short name, trimmed, at most this many UTF-16
// code units (JS .length, like the mission TITLE_MAX).
export const MISSION_NAME_MAX = 40
// A mission label cut from the title is at most this long, "…" included.
export const MISSION_LABEL_MAX = 40
const ELLIPSIS = '…'
// The room markers (src/room-title.js TITLE_MARKERS, ↔️ and legacy 🔗): a
// title carrying one is a room's, never a session's.
const ROOM_MARKERS = ['↔️', '🔗']

// The label a mission lends its conversations: its name when set, else its
// title cut at a word boundary to MISSION_LABEL_MAX with "…" when cut. A
// single word longer than the cap is cut mid-word. Iterated by code point
// so an astral character is never split.
export function missionLabel(mission) {
  const name = typeof mission?.name === 'string' ? mission.name.trim() : ''
  if (name) return name
  const title = typeof mission?.title === 'string' ? mission.title.trim().replace(/\s+/g, ' ') : ''
  const chars = [...title]
  if (chars.length <= MISSION_LABEL_MAX) return title
  const room = MISSION_LABEL_MAX - ELLIPSIS.length
  let cut = chars.slice(0, room).join('')
  if (chars[room] !== ' ') {
    const space = cut.lastIndexOf(' ')
    if (space > 0) cut = cut.slice(0, space)
  }
  return `${cut.replace(/[\s,.;:!?–—-]+$/u, '')}${ELLIPSIS}`
}

// Pure: the display title. `mission` is { name, title } or null; `excluded`
// is the caller's verdict on the row (system, sub-chat, room, private
// mission) — see recomputeConvoTitle.
export function composeTitle({ autoTitle, marker = '', short = '', mission = null, excluded = false }) {
  const base = typeof autoTitle === 'string' ? autoTitle : ''
  if (excluded || !mission || !short) return base
  if (base.includes(' ↔️ ') || ROOM_MARKERS.some((m) => (marker || '').includes(m))) return base
  const label = missionLabel(mission)
  if (!label) return base
  return `${marker ? `${marker} ` : ''}[${short}] ${label}`
}

// The three columns a published title writes. Stored as NULL, not '', when
// the title carries no short / no marker.
export function autoTitleColumns(title) {
  const { marker, short } = titlePrefix(title)
  return { auto_title: title, session_short: short || null, title_marker: marker || null }
}

// The convo_meta payload for a conversation row — the shape convo_upsert has
// always fanned, plus auto_title (the bridge's own title, for a second line).
export const convoMetaPayload = (c) => ({
  title: c.title,
  auto_title: c.auto_title ?? null,
  parent_convo_id: c.parent_convo_id ?? null,
  agent_device_id: c.agent_device_id ?? null,
  repo: c.repo ?? null,
})

// Recompose one conversation's title from its stored columns and write it
// when it changed. Returns the updated row, or null when nothing changed.
// A row with no auto_title (written by something other than
// upsertConversation — person rooms, the People conversation) is never
// touched: its title is the only copy there is.
export function recomputeConvoTitle(db, convoId) {
  const row = db.prepare(`
    SELECT c.id, c.title, c.auto_title, c.session_short, c.title_marker, c.mission_id, c.parent_convo_id, c.system,
      m.name AS mission_name, m.title AS mission_title, m.origin_convo_id AS mission_origin,
      (EXISTS (SELECT 1 FROM convo_agents ca WHERE ca.convo_id = c.id)
        OR EXISTS (SELECT 1 FROM agent_spawn_requests s WHERE s.room_id = c.id)
        OR EXISTS (SELECT 1 FROM person_rooms pr WHERE pr.owner_room_id = c.id OR pr.guest_room_id = c.id)) AS is_room
    FROM conversations c LEFT JOIN missions m ON m.id = c.mission_id AND m.user_id = c.owner_user_id
    WHERE c.id = ?`).get(convoId)
  if (!row || row.auto_title == null) return null
  const excluded = row.system != null || row.parent_convo_id != null || !!row.is_room
  const mission = row.mission_title != null && !excluded && markerTitleAllowed(db, row.mission_origin, row.id)
    ? { name: row.mission_name, title: row.mission_title }
    : null
  const next = composeTitle({ autoTitle: row.auto_title, marker: row.title_marker || '', short: row.session_short || '', mission, excluded })
  if (next === row.title) return null
  db.prepare('UPDATE conversations SET title=? WHERE id=?').run(next, convoId)
  return db.prepare('SELECT * FROM conversations WHERE id=?').get(convoId)
}

// Every conversation whose CURRENT mission this is — after the mission's
// title or name changed. Returns the rows that changed.
export function recomputeMissionTitles(db, missionId) {
  const ids = db.prepare('SELECT id FROM conversations WHERE mission_id=?').all(missionId).map((r) => r.id)
  return ids.map((id) => recomputeConvoTitle(db, id)).filter(Boolean)
}
