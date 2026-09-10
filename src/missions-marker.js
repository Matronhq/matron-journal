// The 'mission' and 'milestone' marker events (spec: Marker events).
// Written only by src/missions-http.js; never publishable by an agent
// (not in AGENT_PUBLISH_TYPES). Not MESSAGE_TYPES: no unread/snippet
// column effect. push.js classify() returns null for both — they are
// navigation, not attention.
export const MISSION_EVENT_TYPE = 'mission'
export const MILESTONE_EVENT_TYPE = 'milestone'
export const MISSION_ACTIONS = ['created', 'joined', 'updated', 'closed']

// The milestone marker's own seq is the anchor the apps jump to; the
// payload carries enough to render the inline card without a fetch.
export function milestoneMarkerPayload({ milestone, mission, by }) {
  return {
    milestone_id: milestone.id, num: milestone.num, kind: milestone.kind,
    title: milestone.title, body: milestone.body ?? '',
    mission_id: mission.id, mission_num: mission.num, mission_title: mission.title,
    by,
  }
}

// Apps use this only as an invalidation signal plus a one-line notice.
// open_item_nums is present only on a user-forced close over open items.
export function missionMarkerPayload({ mission, action, by, openItemNums = null }) {
  if (!MISSION_ACTIONS.includes(action)) throw new Error(`unknown mission action: ${action}`)
  const out = { mission_id: mission.id, num: mission.num, title: mission.title, action, by }
  if (openItemNums && openItemNums.length) out.open_item_nums = openItemNums
  return out
}
