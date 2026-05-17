const { query, pool } = require('../../config/database');
const dayjs = require('dayjs');
const { notify, notifyManyByRole, userIdFromEmployee } = require('../middleware/notify');

// GET /api/leave/types
const getLeaveTypes = async (req, res) => {
  try {
    const result = await query('SELECT * FROM leave_types WHERE is_active = true ORDER BY name');
    res.json({ success: true, data: result.rows });
  } catch (err) {
    res.status(500).json({ success: false, message: 'เกิดข้อผิดพลาด' });
  }
};

// GET /api/leave/my-quota
const getMyQuota = async (req, res) => {
  try {
    const year = req.query.year || dayjs().year();
    const empResult = await query('SELECT id FROM employees WHERE user_id = $1', [req.user.id]);
    if (!empResult.rows[0]) return res.status(404).json({ success: false, message: 'ไม่พบข้อมูลพนักงาน' });

    const result = await query(
      `SELECT lq.*, lt.name as leave_type_name, lt.code
       FROM leave_quotas lq
       JOIN leave_types lt ON lq.leave_type_id = lt.id
       WHERE lq.employee_id = $1 AND lq.year = $2`,
      [empResult.rows[0].id, year]
    );

    // ถ้ายังไม่มี quota สร้างจาก leave_types default
    if (result.rows.length === 0) {
      const types = await query('SELECT * FROM leave_types WHERE is_active = true');
      const quotaRows = [];
      for (const lt of types.rows) {
        if (lt.days_per_year > 0) {
          const r = await query(
            'INSERT INTO leave_quotas (employee_id, leave_type_id, year, total_days) VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING RETURNING *',
            [empResult.rows[0].id, lt.id, year, lt.days_per_year]
          );
          if (r.rows[0]) quotaRows.push({ ...r.rows[0], leave_type_name: lt.name, code: lt.code });
        }
      }
      return res.json({ success: true, data: quotaRows });
    }

    res.json({ success: true, data: result.rows });
  } catch (err) {
    res.status(500).json({ success: false, message: 'เกิดข้อผิดพลาด' });
  }
};

// GET /api/leave/all-quotas?year=YYYY
// HR/owner overview: one row per (employee, leave_type) so the UI can
// group by employee and render a per-team usage table. Owners aren't
// counted — they have no quota row. Employees with no quota yet for the
// year simply don't appear; this stays consistent with the per-employee
// my-quota auto-seed behavior (we don't seed for everyone here).
const getAllQuotas = async (req, res) => {
  try {
    const year = parseInt(req.query.year, 10) || dayjs().year();
    // Compute remaining_days inline instead of relying on the GENERATED
    // STORED column — legacy prod DBs were seeded before that column
    // landed in migrate.js and would 500 here otherwise. The arithmetic
    // is trivial and keeps backwards-compat with both schemas.
    const result = await query(
      `SELECT lq.id, lq.employee_id, lq.leave_type_id, lq.year,
              lq.total_days, lq.used_days,
              (COALESCE(lq.total_days, 0) - COALESCE(lq.used_days, 0)) AS remaining_days,
              e.first_name, e.last_name, e.nickname, e.avatar_url,
              e.employee_id AS emp_code, e.position,
              e.start_date, e.hire_date, e.is_active AS emp_is_active,
              d.name AS department_name,
              lt.name AS leave_type_name, lt.code AS leave_type_code
         FROM leave_quotas lq
         JOIN employees e   ON lq.employee_id = e.id
         JOIN leave_types lt ON lq.leave_type_id = lt.id
         LEFT JOIN departments d ON e.department_id = d.id
         LEFT JOIN users u      ON e.user_id = u.id
        WHERE lq.year = $1
          AND e.is_active = true
          AND (u.role IS NULL OR u.role <> 'owner')
        ORDER BY e.first_name, e.last_name, lt.name`,
      [year]
    );
    res.json({ success: true, data: result.rows });
  } catch (err) {
    console.error('GET /leave/all-quotas error:', err.message);
    res.status(500).json({ success: false, message: 'เกิดข้อผิดพลาด' });
  }
};

// Cap the inline base64 size we accept for any leave document. ~500KB
// after base64 overhead matches the avatar/logo limit we use elsewhere
// and is plenty for a phone photo of a medical certificate.
const MAX_DOCUMENT_BYTES = 700 * 1024;

// Walk the date range and count working days (Mon–Fri). Pulled out of
// createRequest so adminCreateLeave can reuse it without duplicating the
// loop.
function countWorkingDays(start, end) {
  let n = 0;
  let cur = dayjs(start);
  const last = dayjs(end);
  while (!cur.isAfter(last)) {
    if (cur.day() !== 0 && cur.day() !== 6) n++;
    cur = cur.add(1, 'day');
  }
  return n;
}

// POST /api/leave/request
const createRequest = async (req, res) => {
  // Mirrors the attendance/OT owner blocks — the owner has no quota and
  // no one to approve them, so they shouldn't be filing requests. Frontend
  // hides the form, but the API is the source of truth.
  if (req.user?.role === 'owner') {
    return res.status(403).json({ success: false, message: 'เจ้าของไม่ต้องยื่นลา' });
  }
  try {
    const { leaveTypeId, startDate, endDate, reason, document } = req.body;
    if (!leaveTypeId || !startDate || !endDate || !reason) {
      return res.status(400).json({ success: false, message: 'กรุณากรอกข้อมูลให้ครบ' });
    }
    if (document && typeof document === 'string' && document.length > MAX_DOCUMENT_BYTES) {
      return res.status(413).json({ success: false, message: 'ไฟล์แนบใหญ่เกินไป (สูงสุด ~500KB)' });
    }

    const empResult = await query('SELECT id FROM employees WHERE user_id = $1', [req.user.id]);
    if (!empResult.rows[0]) return res.status(404).json({ success: false, message: 'ไม่พบข้อมูลพนักงาน' });
    const empId = empResult.rows[0].id;

    // Pull the type config so we can enforce advance_notice_days and the
    // requires_document flag in one place. Bail if the type was disabled
    // since the frontend dropdown last refreshed.
    const typeRow = await query(
      'SELECT id, name, advance_notice_days, requires_document, is_active FROM leave_types WHERE id = $1',
      [leaveTypeId]
    );
    const type = typeRow.rows[0];
    if (!type) return res.status(400).json({ success: false, message: 'ไม่พบประเภทการลา' });
    if (!type.is_active) {
      return res.status(400).json({ success: false, message: 'ประเภทการลานี้ถูกปิดใช้งานแล้ว' });
    }
    if (type.requires_document && !document) {
      return res.status(400).json({
        success: false,
        message: `ลา"${type.name}" ต้องแนบหลักฐาน (เช่น ใบรับรองแพทย์)`,
      });
    }

    const start = dayjs(startDate);
    const end = dayjs(endDate);
    if (end.isBefore(start)) {
      return res.status(400).json({ success: false, message: 'วันสิ้นสุดต้องหลังวันเริ่มต้น' });
    }

    // Advance-notice enforcement. advance_notice_days = 0 means
    // "same-day allowed" (e.g. sick leave); positive N means today
    // must be ≥ N days before the start date.
    const required = type.advance_notice_days ?? 1;
    if (required > 0) {
      const today = dayjs().startOf('day');
      const lead = start.startOf('day').diff(today, 'day');
      if (lead < required) {
        return res.status(400).json({
          success: false,
          message: `ลา "${type.name}" ต้องยื่นล่วงหน้าอย่างน้อย ${required} วัน (เลือกวันที่ห่างจากวันนี้ได้แค่ ${lead} วัน)`,
        });
      }
    }

    const daysCount = countWorkingDays(start, end);
    if (daysCount === 0) {
      return res.status(400).json({ success: false, message: 'ช่วงที่เลือกไม่มีวันทำงาน' });
    }

    // ตรวจสอบ quota
    const quota = await query(
      'SELECT * FROM leave_quotas WHERE employee_id = $1 AND leave_type_id = $2 AND year = $3',
      [empId, leaveTypeId, start.year()]
    );

    if (quota.rows[0] && quota.rows[0].remaining_days < daysCount) {
      return res.status(400).json({
        success: false,
        message: `วันลาไม่พอ (คงเหลือ ${quota.rows[0].remaining_days} วัน แต่ขอ ${daysCount} วัน)`
      });
    }

    const result = await query(
      `INSERT INTO leave_requests (employee_id, leave_type_id, start_date, end_date, days_count, reason, document)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
      [empId, leaveTypeId, startDate, endDate, daysCount, reason, document || null]
    );

    // Notify everyone who can approve. Lookup the leave_type name + the
    // applicant's display name so the bell entry reads naturally.
    const meta = await query(
      `SELECT lt.name AS type_name,
              CONCAT(e.first_name, ' ', e.last_name) AS emp_name
         FROM leave_types lt, employees e
        WHERE lt.id = $1 AND e.id = $2`,
      [leaveTypeId, empId]
    );
    const typeName = meta.rows[0]?.type_name || 'การลา';
    const empName  = meta.rows[0]?.emp_name  || 'พนักงาน';
    notifyManyByRole(['hr', 'owner'], {
      type: 'leave_request_pending',
      title: `คำขอลาใหม่จาก ${empName}`,
      body: `${typeName} ${dayjs(startDate).format('D MMM')}–${dayjs(endDate).format('D MMM')} (${daysCount} วัน)`,
      link: '/leave',
      relatedId: result.rows[0].id,
    });

    res.status(201).json({
      success: true,
      message: 'ยื่นคำขอลาแล้ว รอ HR อนุมัติ',
      data: { ...result.rows[0], daysCount }
    });
  } catch (err) {
    res.status(500).json({ success: false, message: 'เกิดข้อผิดพลาด' });
  }
};

// GET /api/leave/pending (HR)
// lr.* already pulls `document` (the new TEXT col); we don't strip it
// because the approval queue thumbnail is the whole point of pulling
// pending rows.
const getPending = async (req, res) => {
  try {
    const result = await query(
      `SELECT lr.*, lt.name as leave_type_name, lt.requires_document,
              e.first_name, e.last_name, e.nickname, e.avatar_url,
              e.employee_id as emp_code,
              d.name as department
       FROM leave_requests lr
       JOIN employees e ON lr.employee_id = e.id
       JOIN leave_types lt ON lr.leave_type_id = lt.id
       LEFT JOIN departments d ON e.department_id = d.id
       WHERE lr.status = 'pending'
       ORDER BY lr.created_at ASC`
    );
    res.json({ success: true, data: result.rows });
  } catch (err) {
    res.status(500).json({ success: false, message: 'เกิดข้อผิดพลาด' });
  }
};

// GET /api/leave/all-requests
// HR/owner organization-wide view. Supports filters so the UI can pivot
// without re-fetching everything. All filters are optional.
//   ?status=pending|approved|rejected|cancelled
//   ?year=YYYY (anchored on start_date)
//   ?departmentId=<uuid>
//   ?employeeId=<uuid>
//   ?limit=N (default 200; capped at 1000 to keep one accidental owner
//             click from dragging the whole table down the wire)
const getAllRequests = async (req, res) => {
  try {
    const { status, year, departmentId, employeeId } = req.query;
    const limit = Math.min(parseInt(req.query.limit, 10) || 200, 1000);
    const conds = [];
    const params = [];
    if (status) { params.push(status); conds.push(`lr.status = $${params.length}`); }
    if (year)   { params.push(parseInt(year, 10)); conds.push(`EXTRACT(YEAR FROM lr.start_date) = $${params.length}`); }
    if (departmentId) { params.push(departmentId); conds.push(`e.department_id = $${params.length}`); }
    if (employeeId)   { params.push(employeeId);   conds.push(`e.id = $${params.length}`); }
    const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';
    params.push(limit);
    const result = await query(
      `SELECT lr.*, lt.name as leave_type_name, lt.code as leave_type_code,
              e.first_name, e.last_name, e.nickname, e.avatar_url,
              e.employee_id as emp_code,
              d.name as department, d.id as department_id,
              approver_emp.first_name AS approver_first_name,
              approver_emp.last_name  AS approver_last_name
         FROM leave_requests lr
         JOIN employees e   ON lr.employee_id = e.id
         JOIN leave_types lt ON lr.leave_type_id = lt.id
         LEFT JOIN departments d ON e.department_id = d.id
         LEFT JOIN users approver_u   ON lr.approved_by = approver_u.id
         LEFT JOIN employees approver_emp ON approver_emp.user_id = approver_u.id
         ${where}
        ORDER BY lr.start_date DESC, lr.created_at DESC
        LIMIT $${params.length}`,
      params
    );
    res.json({ success: true, data: result.rows });
  } catch (err) {
    console.error('GET /leave/all-requests error:', err.message);
    res.status(500).json({ success: false, message: 'เกิดข้อผิดพลาด' });
  }
};

// PATCH /api/leave/:id/approve
const approveRequest = async (req, res) => {
  try {
    const { id } = req.params;
    const { action, hrNotes } = req.body; // action: 'approved' | 'rejected'

    const leaveResult = await query('SELECT * FROM leave_requests WHERE id = $1', [id]);
    if (!leaveResult.rows[0]) return res.status(404).json({ success: false, message: 'ไม่พบคำขอ' });
    const leave = leaveResult.rows[0];

    if (leave.status !== 'pending') {
      return res.status(400).json({ success: false, message: 'คำขอนี้ดำเนินการไปแล้ว' });
    }

    // All three writes (status update, quota deduction, attendance backfill)
    // must succeed together. Previously each ran on its own connection, so
    // a quota or attendance failure left the request marked approved with
    // no quota deducted — silently inconsistent.
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        'UPDATE leave_requests SET status = $1, approved_by = $2, approved_at = NOW(), hr_notes = $3, updated_at = NOW() WHERE id = $4',
        [action, req.user.id, hrNotes, id]
      );

      if (action === 'approved') {
        await client.query(
          `UPDATE leave_quotas SET used_days = used_days + $1
           WHERE employee_id = $2 AND leave_type_id = $3
           AND year = EXTRACT(YEAR FROM $4::date)`,
          [leave.days_count, leave.employee_id, leave.leave_type_id, leave.start_date]
        );

        let current = dayjs(leave.start_date);
        const end = dayjs(leave.end_date);
        while (!current.isAfter(end)) {
          if (current.day() !== 0 && current.day() !== 6) {
            await client.query(
              `INSERT INTO attendance_logs (employee_id, date, status, status_detail)
               VALUES ($1, $2, 'leave', 'ลาที่ได้รับอนุมัติ')
               ON CONFLICT (employee_id, date) DO UPDATE SET status = 'leave', status_detail = 'ลาที่ได้รับอนุมัติ'`,
              [leave.employee_id, current.format('YYYY-MM-DD')]
            );
          }
          current = current.add(1, 'day');
        }
      }
      await client.query('COMMIT');
    } catch (txErr) {
      await client.query('ROLLBACK').catch(() => {});
      throw txErr;
    } finally {
      client.release();
    }

    // Notify the employee whose request was just decided.
    const empUserId = await userIdFromEmployee(leave.employee_id);
    const typeRow = await query('SELECT name FROM leave_types WHERE id = $1', [leave.leave_type_id]);
    const typeName = typeRow.rows[0]?.name || 'การลา';
    const rangeText = `${typeName} ${dayjs(leave.start_date).format('D MMM')}–${dayjs(leave.end_date).format('D MMM')} (${leave.days_count} วัน)`;
    notify(empUserId, {
      type: action === 'approved' ? 'leave_approved' : 'leave_rejected',
      title: action === 'approved' ? 'คำขอลาของคุณได้รับการอนุมัติ' : 'คำขอลาของคุณถูกปฏิเสธ',
      body: hrNotes ? `${rangeText} · "${hrNotes}"` : rangeText,
      link: '/leave',
      relatedId: id,
    });

    res.json({
      success: true,
      message: action === 'approved' ? 'อนุมัติคำขอลาแล้ว' : 'ปฏิเสธคำขอลาแล้ว'
    });
  } catch (err) {
    console.error('PATCH /leave/:id/approve error:', err.message);
    res.status(500).json({ success: false, message: 'เกิดข้อผิดพลาด' });
  }
};

// GET /api/leave/my-history
const getMyHistory = async (req, res) => {
  try {
    const empResult = await query('SELECT id FROM employees WHERE user_id = $1', [req.user.id]);
    if (!empResult.rows[0]) return res.status(404).json({ success: false, message: 'ไม่พบข้อมูลพนักงาน' });

    // Join approver via users → employees so the UI can show "อนุมัติโดย X"
    // and surface any rejection note the HR/owner left.
    const result = await query(
      `SELECT lr.*, lt.name as leave_type_name, lt.requires_document,
              approver_emp.first_name AS approver_first_name,
              approver_emp.last_name  AS approver_last_name,
              approver_emp.nickname   AS approver_nickname
       FROM leave_requests lr
       JOIN leave_types lt ON lr.leave_type_id = lt.id
       LEFT JOIN users approver_u ON lr.approved_by = approver_u.id
       LEFT JOIN employees approver_emp ON approver_emp.user_id = approver_u.id
       WHERE lr.employee_id = $1
       ORDER BY lr.created_at DESC LIMIT 50`,
      [empResult.rows[0].id]
    );
    res.json({ success: true, data: result.rows });
  } catch (err) {
    res.status(500).json({ success: false, message: 'เกิดข้อผิดพลาด' });
  }
};

// POST /api/leave/:id/cancel
// Employee can cancel their own request — but only while still pending.
// Once approved, the quota has been deducted and attendance_logs marked,
// so we don't allow self-cancel (HR has to handle that case manually).
const cancelRequest = async (req, res) => {
  try {
    const { id } = req.params;
    const empResult = await query('SELECT id FROM employees WHERE user_id = $1', [req.user.id]);
    if (!empResult.rows[0]) return res.status(404).json({ success: false, message: 'ไม่พบข้อมูลพนักงาน' });

    const leaveResult = await query('SELECT * FROM leave_requests WHERE id = $1', [id]);
    if (!leaveResult.rows[0]) return res.status(404).json({ success: false, message: 'ไม่พบคำขอ' });
    const leave = leaveResult.rows[0];

    if (leave.employee_id !== empResult.rows[0].id) {
      return res.status(403).json({ success: false, message: 'ยกเลิกได้เฉพาะคำขอของตัวเอง' });
    }
    if (leave.status !== 'pending') {
      return res.status(400).json({ success: false, message: 'ยกเลิกได้เฉพาะคำขอที่ยังรออนุมัติ' });
    }

    await query(
      `UPDATE leave_requests SET status = 'cancelled', updated_at = NOW() WHERE id = $1`,
      [id]
    );
    res.json({ success: true, message: 'ยกเลิกคำขอลาแล้ว' });
  } catch (err) {
    res.status(500).json({ success: false, message: 'เกิดข้อผิดพลาด' });
  }
};

/* ===== LEAVE TYPE CRUD (HR/owner) ===== */

// GET /api/leave/types-all
// Default getLeaveTypes hides is_active=false; HR/owner managing types
// needs to see disabled rows too so they can re-enable.
const getAllLeaveTypes = async (req, res) => {
  try {
    const r = await query('SELECT * FROM leave_types ORDER BY is_active DESC, name');
    res.json({ success: true, data: r.rows });
  } catch (e) {
    res.status(500).json({ success: false, message: 'เกิดข้อผิดพลาด' });
  }
};

// POST /api/leave/types
const createLeaveType = async (req, res) => {
  const { name, code, daysPerYear, carryOverDays, advanceNoticeDays, requiresDocument } = req.body;
  if (!name || !code) {
    return res.status(400).json({ success: false, message: 'กรุณาระบุชื่อและรหัสประเภท' });
  }
  // Normalize code so the unique constraint isn't tripped by casing.
  const normCode = String(code).trim().toUpperCase();
  try {
    const r = await query(
      `INSERT INTO leave_types
         (name, code, days_per_year, carry_over_days, advance_notice_days, requires_document, is_active)
       VALUES ($1, $2, $3, $4, $5, $6, true)
       RETURNING *`,
      [
        String(name).trim(),
        normCode,
        Number.isFinite(+daysPerYear) ? +daysPerYear : 0,
        Number.isFinite(+carryOverDays) ? +carryOverDays : 0,
        Number.isFinite(+advanceNoticeDays) ? +advanceNoticeDays : 1,
        !!requiresDocument,
      ]
    );
    res.status(201).json({ success: true, data: r.rows[0] });
  } catch (err) {
    if (err.code === '23505') {
      return res.status(409).json({ success: false, message: `รหัส "${normCode}" ถูกใช้แล้ว` });
    }
    console.error('POST /leave/types error:', err.message);
    res.status(500).json({ success: false, message: 'เกิดข้อผิดพลาด' });
  }
};

// PATCH /api/leave/types/:id
const updateLeaveType = async (req, res) => {
  const { id } = req.params;
  const { name, code, daysPerYear, carryOverDays, advanceNoticeDays, requiresDocument, isActive } = req.body;
  try {
    const r = await query(
      `UPDATE leave_types SET
         name = COALESCE($1, name),
         code = COALESCE($2, code),
         days_per_year = COALESCE($3, days_per_year),
         carry_over_days = COALESCE($4, carry_over_days),
         advance_notice_days = COALESCE($5, advance_notice_days),
         requires_document = COALESCE($6, requires_document),
         is_active = COALESCE($7, is_active)
       WHERE id = $8 RETURNING *`,
      [
        name != null ? String(name).trim() : null,
        code != null ? String(code).trim().toUpperCase() : null,
        daysPerYear != null && Number.isFinite(+daysPerYear) ? +daysPerYear : null,
        carryOverDays != null && Number.isFinite(+carryOverDays) ? +carryOverDays : null,
        advanceNoticeDays != null && Number.isFinite(+advanceNoticeDays) ? +advanceNoticeDays : null,
        requiresDocument != null ? !!requiresDocument : null,
        isActive != null ? !!isActive : null,
        id,
      ]
    );
    if (!r.rows[0]) return res.status(404).json({ success: false, message: 'ไม่พบประเภทการลา' });
    res.json({ success: true, data: r.rows[0] });
  } catch (err) {
    if (err.code === '23505') {
      return res.status(409).json({ success: false, message: 'รหัสนี้ถูกใช้แล้ว' });
    }
    console.error('PATCH /leave/types/:id error:', err.message);
    res.status(500).json({ success: false, message: 'เกิดข้อผิดพลาด' });
  }
};

// DELETE /api/leave/types/:id
// Per the design discussion: soft-delete (is_active=false) when there
// are existing requests of this type so history stays intact; hard
// delete only when the type was never used. Cascade FK on leave_quotas
// would also strand quota rows so we only allow hard delete in the
// clean case.
const deleteLeaveType = async (req, res) => {
  const { id } = req.params;
  try {
    const usage = await query(
      `SELECT
         (SELECT COUNT(*) FROM leave_requests WHERE leave_type_id = $1) AS reqs,
         (SELECT COUNT(*) FROM leave_quotas   WHERE leave_type_id = $1) AS quotas`,
      [id]
    );
    const reqs = parseInt(usage.rows[0].reqs, 10);
    const quotas = parseInt(usage.rows[0].quotas, 10);
    if (reqs > 0 || quotas > 0) {
      await query('UPDATE leave_types SET is_active = false WHERE id = $1', [id]);
      return res.json({
        success: true,
        soft: true,
        message: `มี ${reqs} คำขอเดิม + ${quotas} โควตา — ปิดใช้งานแทน (ข้อมูลเดิมยังอยู่)`,
      });
    }
    const r = await query('DELETE FROM leave_types WHERE id = $1', [id]);
    if (r.rowCount === 0) return res.status(404).json({ success: false, message: 'ไม่พบประเภทการลา' });
    res.json({ success: true, soft: false, message: 'ลบประเภทการลาแล้ว' });
  } catch (err) {
    console.error('DELETE /leave/types/:id error:', err.message);
    res.status(500).json({ success: false, message: 'เกิดข้อผิดพลาด' });
  }
};

/* ===== QUOTA EDITING (HR/owner) ===== */

// PUT /api/leave/quotas
// Upsert pattern — pass (employeeId, leaveTypeId, year, totalDays) and
// we'll INSERT or UPDATE accordingly. Useful for both "create quota
// from scratch" and "raise/lower the cap" in one endpoint.
//
// Guard: totalDays must be >= used_days. Otherwise remaining_days (a
// GENERATED column) would go negative and the UI would show garbage.
const setQuota = async (req, res) => {
  const { employeeId, leaveTypeId, year, totalDays } = req.body;
  if (!employeeId || !leaveTypeId || !year || totalDays == null) {
    return res.status(400).json({ success: false, message: 'กรุณาระบุข้อมูลให้ครบ' });
  }
  const total = parseInt(totalDays, 10);
  if (!Number.isFinite(total) || total < 0 || total > 365) {
    return res.status(400).json({ success: false, message: 'จำนวนวันต้องอยู่ระหว่าง 0–365' });
  }
  try {
    const existing = await query(
      'SELECT id, used_days FROM leave_quotas WHERE employee_id = $1 AND leave_type_id = $2 AND year = $3',
      [employeeId, leaveTypeId, year]
    );
    if (existing.rows[0]) {
      if (total < existing.rows[0].used_days) {
        return res.status(400).json({
          success: false,
          message: `ตั้งได้ขั้นต่ำ ${existing.rows[0].used_days} วัน (ใช้ไปแล้ว)`,
        });
      }
      await query(
        'UPDATE leave_quotas SET total_days = $1 WHERE id = $2',
        [total, existing.rows[0].id]
      );
      return res.json({ success: true, message: 'อัปเดตโควตาแล้ว' });
    }
    await query(
      `INSERT INTO leave_quotas (employee_id, leave_type_id, year, total_days, used_days)
       VALUES ($1, $2, $3, $4, 0)`,
      [employeeId, leaveTypeId, year, total]
    );
    res.status(201).json({ success: true, message: 'สร้างโควตาแล้ว' });
  } catch (err) {
    console.error('PUT /leave/quotas error:', err.message);
    res.status(500).json({ success: false, message: 'เกิดข้อผิดพลาด' });
  }
};

/* ===== BULK SEED (HR/owner one-click "give everyone their defaults") ===== */

// POST /api/leave/quotas/seed-defaults
// Body: { year? }   (defaults to current year)
// For every active employee × active leave_type with days_per_year > 0,
// INSERT a quota row using the type's default. Skips rows that already
// exist (ON CONFLICT DO NOTHING) so calling this repeatedly is safe —
// it only fills gaps. Returns the count we created.
const seedDefaultQuotas = async (req, res) => {
  const year = parseInt(req.body?.year, 10) || dayjs().year();
  try {
    const r = await query(
      `INSERT INTO leave_quotas (employee_id, leave_type_id, year, total_days, used_days)
       SELECT e.id, lt.id, $1, lt.days_per_year, 0
         FROM employees e
         JOIN users u ON e.user_id = u.id
        CROSS JOIN leave_types lt
        WHERE e.is_active = true
          AND u.role <> 'owner'
          AND lt.is_active = true
          AND lt.days_per_year > 0
       ON CONFLICT (employee_id, leave_type_id, year) DO NOTHING
       RETURNING id`,
      [year]
    );
    res.json({
      success: true,
      data: { year, created: r.rowCount || 0 },
      message: r.rowCount
        ? `สร้างโควตาเริ่มต้น ${r.rowCount} แถวสำหรับปี ${year + 543}`
        : `ทุกคนมีโควตาครบแล้วสำหรับปี ${year + 543}`,
    });
  } catch (err) {
    console.error('POST /leave/quotas/seed-defaults error:', err.message);
    res.status(500).json({ success: false, message: 'เกิดข้อผิดพลาด' });
  }
};

/* ===== ADMIN-RECORD (HR/owner backdate leave for employee) ===== */

// POST /api/leave/admin-record
// HR/owner records a leave on someone's behalf — typically a backdate
// for a leave the employee already took. Auto-approved, optional quota
// deduction (default ON), optional document. Bypasses advance-notice
// since HR is reconciling historical reality, not planning ahead.
const adminCreateLeave = async (req, res) => {
  const {
    employeeId, leaveTypeId, startDate, endDate, reason, document,
    deductQuota = true, hrNotes,
  } = req.body;
  if (!employeeId || !leaveTypeId || !startDate || !endDate || !reason) {
    return res.status(400).json({ success: false, message: 'กรุณากรอกข้อมูลให้ครบ' });
  }
  if (document && typeof document === 'string' && document.length > MAX_DOCUMENT_BYTES) {
    return res.status(413).json({ success: false, message: 'ไฟล์แนบใหญ่เกินไป (สูงสุด ~500KB)' });
  }
  const start = dayjs(startDate);
  const end = dayjs(endDate);
  if (end.isBefore(start)) {
    return res.status(400).json({ success: false, message: 'วันสิ้นสุดต้องหลังวันเริ่มต้น' });
  }
  const daysCount = countWorkingDays(start, end);
  if (daysCount === 0) {
    return res.status(400).json({ success: false, message: 'ช่วงที่เลือกไม่มีวันทำงาน' });
  }

  // Confirm employee + type exist before we open the transaction.
  const empCheck = await query('SELECT id FROM employees WHERE id = $1 AND is_active = true', [employeeId]);
  if (!empCheck.rows[0]) return res.status(404).json({ success: false, message: 'ไม่พบพนักงาน' });
  const typeCheck = await query('SELECT id, name FROM leave_types WHERE id = $1', [leaveTypeId]);
  if (!typeCheck.rows[0]) return res.status(400).json({ success: false, message: 'ไม่พบประเภทการลา' });

  // If deducting, validate quota has room — same guard as createRequest
  // so backdates can't push remaining_days below zero either.
  if (deductQuota) {
    const q = await query(
      'SELECT remaining_days FROM leave_quotas WHERE employee_id = $1 AND leave_type_id = $2 AND year = $3',
      [employeeId, leaveTypeId, start.year()]
    );
    if (q.rows[0] && q.rows[0].remaining_days < daysCount) {
      return res.status(400).json({
        success: false,
        message: `โควตาไม่พอ (คงเหลือ ${q.rows[0].remaining_days} วัน แต่บันทึก ${daysCount} วัน)`,
      });
    }
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const ins = await client.query(
      `INSERT INTO leave_requests
         (employee_id, leave_type_id, start_date, end_date, days_count, reason, document,
          status, approved_by, approved_at, hr_notes)
       VALUES ($1, $2, $3, $4, $5, $6, $7,
               'approved', $8, NOW(), $9)
       RETURNING id`,
      [employeeId, leaveTypeId, startDate, endDate, daysCount, reason,
       document || null, req.user.id, hrNotes || `บันทึกย้อนหลังโดย ${req.user.role}`]
    );
    if (deductQuota) {
      // Upsert-then-deduct: if the employee has no quota row for this
      // type/year yet, seed it with the type's default so the deduction
      // has somewhere to land. Without this, an "unused" quota stays
      // invisible and the deduction silently no-ops.
      await client.query(
        `INSERT INTO leave_quotas (employee_id, leave_type_id, year, total_days, used_days)
         SELECT $1, $2, EXTRACT(YEAR FROM $3::date), lt.days_per_year, 0
           FROM leave_types lt
          WHERE lt.id = $2
         ON CONFLICT (employee_id, leave_type_id, year) DO NOTHING`,
        [employeeId, leaveTypeId, startDate]
      );
      await client.query(
        `UPDATE leave_quotas SET used_days = used_days + $1
          WHERE employee_id = $2 AND leave_type_id = $3
            AND year = EXTRACT(YEAR FROM $4::date)`,
        [daysCount, employeeId, leaveTypeId, startDate]
      );
    }
    // Mark the affected weekdays as 'leave' in attendance_logs — same
    // pattern as approveRequest, keeps daily stats consistent.
    let current = dayjs(startDate);
    const endD = dayjs(endDate);
    while (!current.isAfter(endD)) {
      if (current.day() !== 0 && current.day() !== 6) {
        await client.query(
          `INSERT INTO attendance_logs (employee_id, date, status, status_detail)
             VALUES ($1, $2, 'leave', 'ลาที่บันทึกย้อนหลัง')
           ON CONFLICT (employee_id, date) DO UPDATE
             SET status = 'leave', status_detail = 'ลาที่บันทึกย้อนหลัง'`,
          [employeeId, current.format('YYYY-MM-DD')]
        );
      }
      current = current.add(1, 'day');
    }
    await client.query('COMMIT');

    // Notify the employee. Owner-recorded vs HR-recorded reads the same
    // to the recipient — the audit log keeps the "who" detail.
    const empUserId = await userIdFromEmployee(employeeId);
    notify(empUserId, {
      type: 'leave_admin_recorded',
      title: 'HR/เจ้าของบันทึกการลาให้คุณ',
      body: `${typeCheck.rows[0].name} ${dayjs(startDate).format('D MMM')}–${dayjs(endDate).format('D MMM')} (${daysCount} วัน)${deductQuota ? '' : ' · ไม่หักโควตา'}`,
      link: '/leave',
      relatedId: ins.rows[0].id,
    });

    res.status(201).json({
      success: true,
      message: 'บันทึกการลาย้อนหลังแล้ว',
      data: { id: ins.rows[0].id, daysCount, deductQuota: !!deductQuota },
    });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('POST /leave/admin-record error:', err.message);
    res.status(500).json({ success: false, message: 'เกิดข้อผิดพลาด' });
  } finally {
    client.release();
  }
};

module.exports = {
  getLeaveTypes, getAllLeaveTypes,
  createLeaveType, updateLeaveType, deleteLeaveType,
  getMyQuota, getAllQuotas, setQuota, seedDefaultQuotas,
  createRequest, getPending, approveRequest, getMyHistory, cancelRequest,
  getAllRequests, adminCreateLeave,
};
