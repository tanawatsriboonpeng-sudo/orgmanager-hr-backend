const { query } = require('../../config/database');

// Fire-and-forget delivery of a single notification to one user.
// Mirrors the auditLog pattern: failures are logged to stderr (so they
// show up in Render logs) but never break the request that triggered
// the notification.
async function notify(userId, { type, title, body, link, relatedId } = {}) {
  if (!userId || !type || !title) return;
  try {
    await query(
      `INSERT INTO notifications (user_id, type, title, body, link, related_id)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [userId, type, title, body || null, link || null, relatedId || null]
    );
  } catch (err) {
    console.error(`[notify] failed: ${type} → user ${userId}:`, err.message);
  }
}

// Fan-out: notify every active user whose role is in `roles`.
// Used for "broadcast to all HR + owner" kind of events (e.g. an
// employee just filed a leave request — everyone who can approve it
// should see it in their bell).
async function notifyManyByRole(roles, payload) {
  if (!Array.isArray(roles) || roles.length === 0) return;
  try {
    const r = await query(
      `SELECT id FROM users WHERE role = ANY($1::varchar[]) AND is_active = true`,
      [roles]
    );
    await Promise.all(r.rows.map(u => notify(u.id, payload)));
  } catch (err) {
    console.error(`[notify] role broadcast failed (${roles.join(',')}):`, err.message);
  }
}

// Convenience: given an employees.id, look up their users.id (so callers
// that only have the employee FK don't have to do the join themselves).
async function userIdFromEmployee(employeeId) {
  if (!employeeId) return null;
  try {
    const r = await query('SELECT user_id FROM employees WHERE id = $1', [employeeId]);
    return r.rows[0]?.user_id || null;
  } catch (err) {
    console.error(`[notify] userIdFromEmployee failed for ${employeeId}:`, err.message);
    return null;
  }
}

module.exports = { notify, notifyManyByRole, userIdFromEmployee };
