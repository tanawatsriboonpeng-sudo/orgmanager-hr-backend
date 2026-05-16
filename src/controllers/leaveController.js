const { query } = require('../../config/database');
const dayjs = require('dayjs');

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
    const result = await query(
      `SELECT lq.id, lq.employee_id, lq.leave_type_id, lq.year,
              lq.total_days, lq.used_days, lq.remaining_days,
              e.first_name, e.last_name, e.nickname, e.avatar_url,
              e.employee_id AS emp_code, e.position,
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

// POST /api/leave/request
const createRequest = async (req, res) => {
  // Mirrors the attendance/OT owner blocks — the owner has no quota and
  // no one to approve them, so they shouldn't be filing requests. Frontend
  // hides the form, but the API is the source of truth.
  if (req.user?.role === 'owner') {
    return res.status(403).json({ success: false, message: 'เจ้าของไม่ต้องยื่นลา' });
  }
  try {
    const { leaveTypeId, startDate, endDate, reason } = req.body;
    if (!leaveTypeId || !startDate || !endDate || !reason) {
      return res.status(400).json({ success: false, message: 'กรุณากรอกข้อมูลให้ครบ' });
    }

    const empResult = await query('SELECT id FROM employees WHERE user_id = $1', [req.user.id]);
    if (!empResult.rows[0]) return res.status(404).json({ success: false, message: 'ไม่พบข้อมูลพนักงาน' });
    const empId = empResult.rows[0].id;

    const start = dayjs(startDate);
    const end = dayjs(endDate);
    if (end.isBefore(start)) {
      return res.status(400).json({ success: false, message: 'วันสิ้นสุดต้องหลังวันเริ่มต้น' });
    }

    // นับวันทำงาน (ไม่นับเสาร์-อาทิตย์)
    let daysCount = 0;
    let current = start;
    while (!current.isAfter(end)) {
      if (current.day() !== 0 && current.day() !== 6) daysCount++;
      current = current.add(1, 'day');
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
      `INSERT INTO leave_requests (employee_id, leave_type_id, start_date, end_date, days_count, reason)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
      [empId, leaveTypeId, startDate, endDate, daysCount, reason]
    );

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
const getPending = async (req, res) => {
  try {
    const result = await query(
      `SELECT lr.*, lt.name as leave_type_name,
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

    await query(
      'UPDATE leave_requests SET status = $1, approved_by = $2, approved_at = NOW(), hr_notes = $3, updated_at = NOW() WHERE id = $4',
      [action, req.user.id, hrNotes, id]
    );

    // อัปเดต quota ถ้าอนุมัติ
    if (action === 'approved') {
      await query(
        `UPDATE leave_quotas SET used_days = used_days + $1
         WHERE employee_id = $2 AND leave_type_id = $3
         AND year = EXTRACT(YEAR FROM $4::date)`,
        [leave.days_count, leave.employee_id, leave.leave_type_id, leave.start_date]
      );

      // บันทึก attendance_logs เป็น leave
      let current = dayjs(leave.start_date);
      const end = dayjs(leave.end_date);
      while (!current.isAfter(end)) {
        if (current.day() !== 0 && current.day() !== 6) {
          await query(
            `INSERT INTO attendance_logs (employee_id, date, status, status_detail)
             VALUES ($1, $2, 'leave', 'ลาที่ได้รับอนุมัติ')
             ON CONFLICT (employee_id, date) DO UPDATE SET status = 'leave', status_detail = 'ลาที่ได้รับอนุมัติ'`,
            [leave.employee_id, current.format('YYYY-MM-DD')]
          );
        }
        current = current.add(1, 'day');
      }
    }

    res.json({
      success: true,
      message: action === 'approved' ? 'อนุมัติคำขอลาแล้ว' : 'ปฏิเสธคำขอลาแล้ว'
    });
  } catch (err) {
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
      `SELECT lr.*, lt.name as leave_type_name,
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

module.exports = { getLeaveTypes, getMyQuota, getAllQuotas, createRequest, getPending, approveRequest, getMyHistory, cancelRequest };
