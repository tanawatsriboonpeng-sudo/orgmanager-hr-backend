// Data retention / purge.
//
// Strategy: keep the metadata rows (we need them for KPI, payroll audit,
// labor-law compliance) and null out the heavy binary blobs once they're
// past the configured age. Notification + audit log ROWS themselves are
// the value, so those get DELETEd.
//
// All retention windows live on org_settings (singleton row id=1) so the
// owner can tune them from /settings without a redeploy.
const { query } = require('../../config/database');
const dayjs = require('dayjs');
const utc = require('dayjs/plugin/utc');
const timezone = require('dayjs/plugin/timezone');
dayjs.extend(utc);
dayjs.extend(timezone);
const TZ = process.env.APP_TIMEZONE || 'Asia/Bangkok';
// Bangkok-anchored YYYY-MM-DD. Used to gate runPurgeIfDue so the daily
// window flips at local midnight (00:00 BKK), not UTC midnight — which
// would otherwise mean the purge could run twice in the 17:00–07:00
// UTC window (once before, once after UTC day rollover, both still
// being the same Bangkok day).
const bkkDay = (d = new Date()) => dayjs(d).tz(TZ).format('YYYY-MM-DD');

// Cheap shared cache so /me-style endpoints can poll runPurgeIfDue()
// without each one running the full purge in parallel. The actual write
// is gated by a `last_purge_at < today` check too — this just stops the
// thundering-herd between calls in the same second.
let inFlight = null;

async function readPolicy() {
  const r = await query(
    `SELECT retention_selfie_days, retention_attachment_days,
            retention_notification_days, retention_audit_days,
            retention_auto_purge, last_purge_at
       FROM org_settings WHERE id = 1`
  );
  // Defensive defaults if the row hasn't been seeded yet (shouldn't
  // happen since ensureSchema seeds it, but keeps purge crash-safe).
  return r.rows[0] || {
    retention_selfie_days: 180,
    retention_attachment_days: 365,
    retention_notification_days: 90,
    retention_audit_days: 730,
    retention_auto_purge: true,
    last_purge_at: null,
  };
}

// The real workhorse. Returns a summary suitable for both the API
// response and storing on org_settings.last_purge_summary.
async function purgeOnce() {
  const policy = await readPolicy();
  const summary = {
    started_at: new Date().toISOString(),
    selfies_cleared: 0,
    offsite_selfies_cleared: 0,
    backdate_attachments_cleared: 0,
    leave_documents_cleared: 0,
    notifications_deleted: 0,
    audit_logs_deleted: 0,
    expired_refresh_tokens_deleted: 0,
    password_reset_tokens_deleted: 0,
    policy_used: {
      selfie_days: policy.retention_selfie_days,
      attachment_days: policy.retention_attachment_days,
      notification_days: policy.retention_notification_days,
      audit_days: policy.retention_audit_days,
    },
  };

  // 1) Null-out attendance check-in selfies past the window.
  //    We only touch rows that still HAVE a selfie (NOT NULL) — keeps the
  //    UPDATE count meaningful and avoids gratuitous row rewrites.
  {
    const r = await query(
      `UPDATE attendance_logs
          SET check_in_selfie = NULL
        WHERE check_in_selfie IS NOT NULL
          AND date < CURRENT_DATE - ($1::int || ' days')::interval`,
      [policy.retention_selfie_days]
    );
    summary.selfies_cleared = r.rowCount || 0;
  }

  // 2) Off-site selfies live on the same row — purge those too on the
  //    same window. The is_offsite/offsite_status metadata stays so HR
  //    can still see "X had an off-site check-in on this date".
  //    The schema stores off-site selfies in check_in_selfie, but some
  //    deployments split them — guard with column existence at query
  //    time using a dynamic check to stay schema-tolerant.
  {
    // Use information_schema so missing-column doesn't blow up purge.
    const colCheck = await query(
      `SELECT 1 FROM information_schema.columns
        WHERE table_name = 'attendance_logs'
          AND column_name = 'offsite_selfie'`
    );
    if (colCheck.rows[0]) {
      const r = await query(
        `UPDATE attendance_logs
            SET offsite_selfie = NULL
          WHERE offsite_selfie IS NOT NULL
            AND date < CURRENT_DATE - ($1::int || ' days')::interval`,
        [policy.retention_selfie_days]
      );
      summary.offsite_selfies_cleared = r.rowCount || 0;
    }
  }

  // 3) Backdate request attachments — kept longer (default 1y) because
  //    they're the user's own evidence and may be re-reviewed.
  {
    const r = await query(
      `UPDATE attendance_backdate_requests
          SET attachment = NULL
        WHERE attachment IS NOT NULL
          AND created_at < NOW() - ($1::int || ' days')::interval`,
      [policy.retention_attachment_days]
    );
    summary.backdate_attachments_cleared = r.rowCount || 0;
  }

  // 3b) Leave request documents (medical certificates etc.) — same
  //     window as backdate attachments since they're functionally the
  //     same kind of evidence. The leave row + decision metadata stays.
  {
    const colCheck = await query(
      `SELECT 1 FROM information_schema.columns
        WHERE table_name = 'leave_requests' AND column_name = 'document'`
    );
    if (colCheck.rows[0]) {
      const r = await query(
        `UPDATE leave_requests
            SET document = NULL
          WHERE document IS NOT NULL
            AND created_at < NOW() - ($1::int || ' days')::interval`,
        [policy.retention_attachment_days]
      );
      summary.leave_documents_cleared = r.rowCount || 0;
    }
  }

  // 4) Notifications — delete fully. Old "you have a leave request"
  //    pings have zero value after 90 days.
  {
    const r = await query(
      `DELETE FROM notifications
        WHERE created_at < NOW() - ($1::int || ' days')::interval`,
      [policy.retention_notification_days]
    );
    summary.notifications_deleted = r.rowCount || 0;
  }

  // 5) Audit logs — delete fully, but on a much longer 2-year default.
  {
    const r = await query(
      `DELETE FROM audit_logs
        WHERE created_at < NOW() - ($1::int || ' days')::interval`,
      [policy.retention_audit_days]
    );
    summary.audit_logs_deleted = r.rowCount || 0;
  }

  // 6) Refresh tokens past expires_at — these accumulate silently if
  //    users never explicitly log out. Cheap row delete.
  {
    const r = await query(
      `DELETE FROM refresh_tokens WHERE expires_at < NOW()`
    );
    summary.expired_refresh_tokens_deleted = r.rowCount || 0;
  }

  // 7) Password reset tokens — keep 7 days (long enough to debug a
  //    failed reset, short enough to keep the table tiny). Used/expired
  //    rows are eligible. Wrapped in catch since the table may not yet
  //    exist on a partially-migrated DB.
  try {
    const r = await query(
      `DELETE FROM password_reset_tokens WHERE created_at < NOW() - INTERVAL '7 days'`
    );
    summary.password_reset_tokens_deleted = r.rowCount || 0;
  } catch (e) {
    // Table missing on legacy DB — ensureSchema will create it next boot.
    summary.password_reset_tokens_deleted = 0;
  }

  summary.finished_at = new Date().toISOString();

  await query(
    `UPDATE org_settings
        SET last_purge_at = NOW(),
            last_purge_summary = $1
      WHERE id = 1`,
    [summary]
  );

  return summary;
}

// Lazy daily auto-run. Called from hot paths (dashboard, /auth/me) so we
// don't need a separate cron worker; the cost is one cheap SELECT on
// org_settings unless we're actually due. Safe to call concurrently —
// the inFlight promise dedupes parallel callers in the same process.
async function runPurgeIfDue() {
  if (inFlight) return inFlight;
  inFlight = (async () => {
    try {
      const policy = await readPolicy();
      if (!policy.retention_auto_purge) return null;
      // "Due" = never purged OR last purge was on an earlier Bangkok
      // calendar day. Comparing YYYY-MM-DD strings is robust against
      // DST (n/a in Thailand but defensive) and against UTC day
      // boundaries falling mid-Bangkok-day.
      if (policy.last_purge_at && bkkDay(policy.last_purge_at) === bkkDay()) {
        return null;
      }
      return await purgeOnce();
    } catch (e) {
      console.warn('[retention] auto-purge failed (non-fatal):', e.message);
      return null;
    } finally {
      // Release the dedupe slot 30s later so a same-process burst keeps
      // dedup'd but the next legitimate "next day" run isn't blocked.
      setTimeout(() => { inFlight = null; }, 30_000);
    }
  })();
  return inFlight;
}

// GET /api/admin/retention — read policy + last summary
const getRetention = async (req, res) => {
  try {
    const policy = await readPolicy();
    res.json({ success: true, data: policy });
  } catch (e) {
    console.error('GET /admin/retention error:', e.message);
    res.status(500).json({ success: false, message: 'เกิดข้อผิดพลาด' });
  }
};

// PATCH /api/admin/retention — owner edits the days/auto toggle
const updateRetention = async (req, res) => {
  const {
    selfieDays, attachmentDays, notificationDays, auditDays, autoPurge,
  } = req.body;
  // Sanity bounds so a slip-of-the-keyboard doesn't wipe everything to 0.
  const bounded = (v, min, max) =>
    v === undefined || v === null ? null
      : Number.isFinite(+v) && +v >= min && +v <= max ? +v
      : 'invalid';
  const vals = {
    selfie: bounded(selfieDays, 7, 3650),
    attachment: bounded(attachmentDays, 7, 3650),
    notification: bounded(notificationDays, 1, 3650),
    audit: bounded(auditDays, 30, 3650),
  };
  for (const [k, v] of Object.entries(vals)) {
    if (v === 'invalid') {
      return res.status(400).json({
        success: false,
        message: `ค่า ${k}Days อยู่นอกช่วงที่ยอมรับได้`,
      });
    }
  }
  try {
    await query(
      `UPDATE org_settings SET
         retention_selfie_days       = COALESCE($1, retention_selfie_days),
         retention_attachment_days   = COALESCE($2, retention_attachment_days),
         retention_notification_days = COALESCE($3, retention_notification_days),
         retention_audit_days        = COALESCE($4, retention_audit_days),
         retention_auto_purge        = COALESCE($5, retention_auto_purge),
         updated_at = NOW()
       WHERE id = 1`,
      [vals.selfie, vals.attachment, vals.notification, vals.audit,
       autoPurge === undefined ? null : !!autoPurge]
    );
    res.json({ success: true, message: 'บันทึกนโยบายแล้ว' });
  } catch (e) {
    console.error('PATCH /admin/retention error:', e.message);
    res.status(500).json({ success: false, message: 'เกิดข้อผิดพลาด' });
  }
};

// POST /api/admin/purge-old-data — owner-triggered manual run
const purgeNow = async (req, res) => {
  try {
    const summary = await purgeOnce();
    res.json({ success: true, data: summary });
  } catch (e) {
    console.error('POST /admin/purge-old-data error:', e.message);
    res.status(500).json({ success: false, message: 'เกิดข้อผิดพลาด' });
  }
};

module.exports = {
  getRetention,
  updateRetention,
  purgeNow,
  runPurgeIfDue,
};
