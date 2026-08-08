export function isAllowed(db, userId, fromDeviceId, targetDeviceId) {
  const row = db.prepare(
    'SELECT 1 FROM agent_chat_allowances WHERE user_id = ? AND from_device_id = ? AND target_device_id = ?'
  ).get(userId, fromDeviceId, targetDeviceId)
  return row !== undefined
}

export function addAllowance(db, { userId, fromDeviceId, targetDeviceId }) {
  db.prepare(
    'INSERT OR IGNORE INTO agent_chat_allowances(user_id, from_device_id, target_device_id, created_at) VALUES(?, ?, ?, ?)'
  ).run(userId, fromDeviceId, targetDeviceId, Date.now())
}

export function removeAllowance(db, { userId, fromDeviceId, targetDeviceId }) {
  const result = db.prepare(
    'DELETE FROM agent_chat_allowances WHERE user_id = ? AND from_device_id = ? AND target_device_id = ?'
  ).run(userId, fromDeviceId, targetDeviceId)
  return result.changes > 0
}

export function listAllowances(db, userId) {
  return db.prepare(
    'SELECT * FROM agent_chat_allowances WHERE user_id = ? ORDER BY created_at'
  ).all(userId)
}
