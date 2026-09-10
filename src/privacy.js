// Shared "ordinary agent" / "private-owned conversation" predicates used by
// every HTTP surface that filters a private device's data away from an
// agent that isn't itself private. Extracted from items-http.js when
// missions-http.js needed the exact same rule (Task 7 review, Critical 3):
// two hand-synced copies had already started drifting (missions-http.js's
// copy was missing from the sieve items-http.js applied), which is exactly
// the kind of hole this file exists to prevent. One copy, every caller.
import { isPrivateDevice } from './db.js'

// Ordinary-agent predicate shared with /roster, /search, /snapshot, /items*, /missions*.
export const filteredAgent = (db, who) => who.kind === 'agent' && !isPrivateDevice(db, who.deviceId)

export const privateOwnedConvo = (db, convoId) => {
  const owner = db.prepare('SELECT agent_device_id FROM conversations WHERE id=?').get(convoId)?.agent_device_id
  return owner != null && isPrivateDevice(db, owner)
}
