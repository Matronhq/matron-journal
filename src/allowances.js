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

// Joined to the devices each row names, because everything that lists
// allowances (the apps' consent screen, matron-admin) shows them to the
// human who granted them, and a bare device id is not a who. LEFT JOIN, not
// JOIN: a row whose device has since gone leaves a null name rather than
// vanishing from the very list the user would revoke it from.
export function listAllowances(db, userId) {
  return db.prepare(`
    SELECT a.from_device_id, a.target_device_id, a.created_at,
           f.name AS from_name, t.name AS target_name
    FROM agent_chat_allowances a
    LEFT JOIN devices f ON f.id = a.from_device_id AND f.user_id = a.user_id
    LEFT JOIN devices t ON t.id = a.target_device_id AND t.user_id = a.user_id
    WHERE a.user_id = ? ORDER BY a.created_at
  `).all(userId)
}

// Every allowance naming this device, either end. Called when a device is
// revoked: `devices.id` is a plain INTEGER PRIMARY KEY, so SQLite reuses the
// rowid of the highest-numbered deleted device, and the next agent created
// would otherwise inherit a standing consent the user granted to a different
// agent entirely. A revoked device's allowances are dead weight regardless.
export function forgetDeviceAllowances(db, userId, deviceId) {
  return db.prepare(
    'DELETE FROM agent_chat_allowances WHERE user_id = ? AND (from_device_id = ? OR target_device_id = ?)'
  ).run(userId, deviceId, deviceId).changes
}
