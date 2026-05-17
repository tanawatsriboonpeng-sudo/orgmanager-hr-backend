const { query } = require('../../config/database');
const { pushTextTo } = require('./linePush');

// Fire-and-forget delivery of a single notification to one user.
// Mirrors the auditLog pattern: failures are logged to stderr (so they
// show up in Render logs) but never break the request that triggered
// the notification.
//
// Two channels in parallel:
//   1. In-app: INSERT into notifications (bell icon, /notifications page)
//   2. LINE OA: pushTextTo() if the user has line_user_id linked
//
// Both run; one failing doesn't block the other. The LINE push is gated
// on LINE_OA_CHANNEL_TOKEN being set (otherwise pushTextTo no-ops),
// so this is safe to enable before the OA channel is actually wired.
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

  // LINE push, best-effort. Look up line_user_id lazily — most users
  // won't have it set yet, and we don't want to add a JOIN to every
  // notify() call site. Single cheap SELECT here is fine.
  try {
    const r = await query('SELECT line_user_id FROM users WHERE id = $1', [userId]);
    const lineUserId = r.rows[0]?.line_user_id;
    if (!lineUserId) return;
    const text = body ? `${title}\n${body}` : title;
    // Fire and forget — don't await so the originating request returns
    // even if LINE is slow. The console.error inside pushTextTo handles
    // diagnostics.
    pushTextTo(lineUserId, text, { link }).catch(() => {});
  } catch (err) {
    console.error(`[notify] LINE lookup failed for user ${userId}:`, err.message);
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
