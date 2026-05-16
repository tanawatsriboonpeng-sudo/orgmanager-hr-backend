const express = require('express');
const router = express.Router();
const { authenticate, authorize, auditLog } = require('../middleware/auth');
const authCtrl = require('../controllers/authController');
const attendCtrl = require('../controllers/attendanceController');
const leaveCtrl = require('../controllers/leaveController');
const { query, pool } = require('../../config/database');

// ====== AUTH ======
router.post('/auth/login', authCtrl.login);
router.post('/auth/refresh', authCtrl.refreshToken);
router.post('/auth/logout', authenticate, authCtrl.logout);
router.post('/auth/change-password', authenticate, authCtrl.changePassword);
router.get('/auth/me', authenticate, authCtrl.getMe);

// ====== ATTENDANCE ======
// Owners do not check in. Block at the API layer so any client (web, mobile)
// gets the same answer — the frontend hides the UI separately.
const blockOwner = (req, res, next) => {
  if (req.user?.role === 'owner') {
    return res.status(403).json({ success: false, message: 'เจ้าของไม่ต้องลงทะเบียนเข้างาน' });
  }
  next();
};
router.post('/attendance/check-in', authenticate, blockOwner, attendCtrl.checkIn);
router.post('/attendance/check-out', authenticate, blockOwner, attendCtrl.checkOut);
router.get('/attendance/today', authenticate, attendCtrl.getToday);
router.get('/attendance/my-history', authenticate, attendCtrl.getMyHistory);
router.get('/attendance/daily-summary', authenticate, authorize('owner', 'hr'), attendCtrl.getDailySummary);

// ====== LEAVE ======
router.get('/leave/types', authenticate, leaveCtrl.getLeaveTypes);
router.get('/leave/my-quota', authenticate, leaveCtrl.getMyQuota);
router.get('/leave/my-history', authenticate, leaveCtrl.getMyHistory);
router.post('/leave/request', authenticate, leaveCtrl.createRequest);
router.post('/leave/:id/cancel', authenticate, leaveCtrl.cancelRequest);
router.get('/leave/pending', authenticate, authorize('hr', 'owner'), leaveCtrl.getPending);
// Owner included for the single-owner-no-HR case; if the company has HR
// staff they'll usually approve, but owner is the failsafe approver.
router.patch('/leave/:id/approve', authenticate, authorize('hr', 'owner'), auditLog('leave_approval', 'leave_requests'), leaveCtrl.approveRequest);

// ====== OT ======
router.get('/ot/pending', authenticate, authorize('hr', 'owner'), async (req, res) => {
  try {
    const result = await query(
      `SELECT o.*, e.first_name, e.last_name, e.nickname, e.avatar_url,
              e.employee_id as emp_code, d.name as department
       FROM ot_requests o
       JOIN employees e ON o.employee_id = e.id
       LEFT JOIN departments d ON e.department_id = d.id
       WHERE o.status IN ('pending','manager_approved')
       ORDER BY o.created_at ASC`
    );
    res.json({ success: true, data: result.rows });
  } catch (e) { res.status(500).json({ success: false, message: 'เกิดข้อผิดพลาด' }); }
});

router.post('/ot/request', authenticate, async (req, res) => {
  if (req.user.role === 'owner') {
    return res.status(403).json({ success: false, message: 'เจ้าของไม่ต้องขอ OT' });
  }
  try {
    const { date, startTime, endTime, reason } = req.body;
    const empResult = await query('SELECT id FROM employees WHERE user_id = $1', [req.user.id]);
    if (!empResult.rows[0]) return res.status(404).json({ success: false, message: 'ไม่พบพนักงาน' });
    const [sh, sm] = startTime.split(':').map(Number);
    const [eh, em] = endTime.split(':').map(Number);
    const hours = parseFloat(((eh * 60 + em - sh * 60 - sm) / 60).toFixed(2));
    if (hours <= 0) return res.status(400).json({ success: false, message: 'เวลาไม่ถูกต้อง' });
    const r = await query(
      'INSERT INTO ot_requests (employee_id, date, start_time, end_time, hours, reason) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *',
      [empResult.rows[0].id, date, startTime, endTime, hours, reason]
    );
    res.status(201).json({ success: true, message: 'ยื่นขอ OT แล้ว', data: r.rows[0] });
  } catch (e) { res.status(500).json({ success: false, message: 'เกิดข้อผิดพลาด' }); }
});

// Owner included as failsafe approver for companies without dedicated HR
// (mirrors the /leave approval setup).
router.patch('/ot/:id/approve', authenticate, authorize('hr', 'owner'), async (req, res) => {
  try {
    const { action, rejectedReason } = req.body;
    if (action !== 'approved' && action !== 'rejected') {
      return res.status(400).json({ success: false, message: 'action ไม่ถูกต้อง' });
    }
    const existing = await query('SELECT status FROM ot_requests WHERE id = $1', [req.params.id]);
    if (!existing.rows[0]) return res.status(404).json({ success: false, message: 'ไม่พบคำขอ' });
    if (existing.rows[0].status !== 'pending' && existing.rows[0].status !== 'manager_approved') {
      return res.status(400).json({ success: false, message: 'คำขอนี้ดำเนินการไปแล้ว' });
    }
    await query(
      `UPDATE ot_requests SET
         status = $1,
         hr_approved_by = $2,
         hr_approved_at = NOW(),
         rejected_reason = $3,
         updated_at = NOW()
       WHERE id = $4`,
      [
        action === 'approved' ? 'hr_approved' : 'rejected',
        req.user.id,
        action === 'rejected' ? (rejectedReason || null) : null,
        req.params.id,
      ]
    );
    res.json({ success: true, message: action === 'approved' ? 'อนุมัติ OT แล้ว' : 'ปฏิเสธ OT แล้ว' });
  } catch (e) {
    console.error('PATCH /ot/:id/approve error:', e.message);
    res.status(500).json({ success: false, message: 'เกิดข้อผิดพลาด' });
  }
});

// Employee's own OT history with approver name joined.
router.get('/ot/my-history', authenticate, async (req, res) => {
  try {
    const emp = await query('SELECT id FROM employees WHERE user_id = $1', [req.user.id]);
    if (!emp.rows[0]) return res.json({ success: true, data: [] });
    const r = await query(
      `SELECT o.*,
              approver_emp.first_name AS approver_first_name,
              approver_emp.last_name  AS approver_last_name,
              approver_emp.nickname   AS approver_nickname
       FROM ot_requests o
       LEFT JOIN users approver_u ON o.hr_approved_by = approver_u.id
       LEFT JOIN employees approver_emp ON approver_emp.user_id = approver_u.id
       WHERE o.employee_id = $1
       ORDER BY o.created_at DESC
       LIMIT 100`,
      [emp.rows[0].id]
    );
    res.json({ success: true, data: r.rows });
  } catch (e) {
    console.error('GET /ot/my-history error:', e.message);
    res.status(500).json({ success: false, message: 'เกิดข้อผิดพลาด' });
  }
});

// Employee self-cancel — only while still pending (not yet approved /
// rejected / cancelled).
router.post('/ot/:id/cancel', authenticate, async (req, res) => {
  try {
    const emp = await query('SELECT id FROM employees WHERE user_id = $1', [req.user.id]);
    if (!emp.rows[0]) return res.status(404).json({ success: false, message: 'ไม่พบพนักงาน' });
    const r = await query('SELECT employee_id, status FROM ot_requests WHERE id = $1', [req.params.id]);
    if (!r.rows[0]) return res.status(404).json({ success: false, message: 'ไม่พบคำขอ' });
    if (r.rows[0].employee_id !== emp.rows[0].id) {
      return res.status(403).json({ success: false, message: 'ยกเลิกได้เฉพาะคำขอของตัวเอง' });
    }
    if (r.rows[0].status !== 'pending') {
      return res.status(400).json({ success: false, message: 'ยกเลิกได้เฉพาะคำขอที่ยังรออนุมัติ' });
    }
    // ot_requests.status CHECK constraint allows ('pending','manager_approved','hr_approved','rejected')
    // — no 'cancelled' state yet, so we record cancellation as 'rejected'
    // with a sentinel reason. (If we relax the CHECK constraint later we
    // can switch to a true 'cancelled' value.)
    await query(
      `UPDATE ot_requests SET status = 'rejected', rejected_reason = $1, updated_at = NOW() WHERE id = $2`,
      ['ยกเลิกโดยพนักงาน', req.params.id]
    );
    res.json({ success: true, message: 'ยกเลิกคำขอ OT แล้ว' });
  } catch (e) {
    console.error('POST /ot/:id/cancel error:', e.message);
    res.status(500).json({ success: false, message: 'เกิดข้อผิดพลาด' });
  }
});

// ====== EMPLOYEES ======
router.get('/employees', authenticate, authorize('hr', 'owner'), async (req, res) => {
  try {
    const result = await query(
      `SELECT e.*, u.email, u.role, u.is_active as account_active, u.last_login_at,
              d.name as department_name,
              m.first_name as manager_first_name, m.last_name as manager_last_name
       FROM employees e
       LEFT JOIN users u ON e.user_id = u.id
       LEFT JOIN departments d ON e.department_id = d.id
       LEFT JOIN employees m ON e.manager_id = m.id
       WHERE e.is_active = true
       ORDER BY e.first_name`
    );
    res.json({ success: true, data: result.rows });
  } catch (e) { res.status(500).json({ success: false, message: 'เกิดข้อผิดพลาด' }); }
});

router.get('/employees/me', authenticate, async (req, res) => {
  try {
    const result = await query(
      `SELECT e.*, u.email, d.name as department_name,
              m.first_name as manager_first_name, m.last_name as manager_last_name
       FROM employees e
       LEFT JOIN users u ON e.user_id = u.id
       LEFT JOIN departments d ON e.department_id = d.id
       LEFT JOIN employees m ON e.manager_id = m.id
       WHERE e.user_id = $1`,
      [req.user.id]
    );
    res.json({ success: true, data: result.rows[0] });
  } catch (e) { res.status(500).json({ success: false, message: 'เกิดข้อผิดพลาด' }); }
});

// Single employee by id. HR/owner can view anyone; employee can only
// view themselves.
router.get('/employees/:id', authenticate, async (req, res) => {
  try {
    const r = await query(
      `SELECT e.*, u.email, u.role, u.is_active as account_active, u.last_login_at,
              d.name as department_name,
              m.first_name as manager_first_name, m.last_name as manager_last_name
       FROM employees e
       LEFT JOIN users u ON e.user_id = u.id
       LEFT JOIN departments d ON e.department_id = d.id
       LEFT JOIN employees m ON e.manager_id = m.id
       WHERE e.id = $1`,
      [req.params.id]
    );
    const emp = r.rows[0];
    if (!emp) return res.status(404).json({ success: false, message: 'ไม่พบพนักงาน' });
    // Permission: HR/owner can see anyone; employee can only see own row
    if (req.user.role !== 'hr' && req.user.role !== 'owner') {
      const own = await query('SELECT id FROM employees WHERE user_id = $1', [req.user.id]);
      if (!own.rows[0] || own.rows[0].id !== emp.id) {
        return res.status(403).json({ success: false, message: 'ไม่มีสิทธิ์ดู' });
      }
    }
    res.json({ success: true, data: emp });
  } catch (e) {
    console.error('GET /employees/:id error:', e.message);
    res.status(500).json({ success: false, message: 'เกิดข้อผิดพลาด' });
  }
});

// Self-edit (employee can update own non-sensitive fields).
// Allowed: personal identity, contact info, address, ID/bank documents.
// NOT allowed: position, salary, role, department, employee_id, hire dates,
// employment_type — those need HR/owner approval.
router.patch('/employees/me', authenticate, async (req, res) => {
  const {
    nickname, phone, avatarUrl,
    // Personal
    title, firstNameEn, lastNameEn, nicknameEn,
    gender, nationality, maritalStatus, dateOfBirth, address,
    // IDs
    nationalId, passportNumber, socialSecurityNumber, taxId,
    // Bank
    bankAccount, bankName, bankBranchCode,
  } = req.body;
  // Avatar size guard
  if (avatarUrl && typeof avatarUrl === 'string' && avatarUrl.length > 700 * 1024) {
    return res.status(413).json({ success: false, message: 'รูปภาพใหญ่เกินไป (สูงสุด ~500KB)' });
  }
  try {
    await query(
      `UPDATE employees SET
         nickname = COALESCE($1, nickname),
         phone = COALESCE($2, phone),
         avatar_url = COALESCE($3, avatar_url),
         title = COALESCE($5, title),
         first_name_en = COALESCE($6, first_name_en),
         last_name_en = COALESCE($7, last_name_en),
         nickname_en = COALESCE($8, nickname_en),
         gender = COALESCE($9, gender),
         nationality = COALESCE($10, nationality),
         marital_status = COALESCE($11, marital_status),
         date_of_birth = COALESCE($12, date_of_birth),
         address = COALESCE($13, address),
         national_id = COALESCE($14, national_id),
         passport_number = COALESCE($15, passport_number),
         social_security_number = COALESCE($16, social_security_number),
         tax_id = COALESCE($17, tax_id),
         bank_account = COALESCE($18, bank_account),
         bank_name = COALESCE($19, bank_name),
         bank_branch_code = COALESCE($20, bank_branch_code),
         updated_at = NOW()
       WHERE user_id = $4`,
      [
        nickname ?? null, phone ?? null, avatarUrl ?? null, req.user.id,
        title ?? null, firstNameEn ?? null, lastNameEn ?? null, nicknameEn ?? null,
        gender ?? null, nationality ?? null, maritalStatus ?? null, dateOfBirth ?? null, address ?? null,
        nationalId ?? null, passportNumber ?? null, socialSecurityNumber ?? null, taxId ?? null,
        bankAccount ?? null, bankName ?? null, bankBranchCode ?? null,
      ]
    );
    res.json({ success: true, message: 'อัปเดตข้อมูลส่วนตัวแล้ว' });
  } catch (e) {
    console.error('PATCH /employees/me error:', e.message);
    res.status(500).json({ success: false, message: 'เกิดข้อผิดพลาด' });
  }
});

// ====== POSITIONS (โครงสร้างตำแหน่ง) ======
// Self-referential hierarchical structure of job titles.
router.get('/positions', authenticate, async (req, res) => {
  try {
    const r = await query(
      `SELECT id, code, name, description, parent_id, created_at
       FROM positions
       ORDER BY parent_id NULLS FIRST, code, name`
    );
    res.json({ success: true, data: r.rows });
  } catch (e) {
    console.error('GET /positions error:', e.message);
    res.status(500).json({ success: false, message: 'เกิดข้อผิดพลาด' });
  }
});

router.post('/positions', authenticate, authorize('hr', 'owner'), async (req, res) => {
  const { code, name, description, parentId } = req.body;
  if (!name || !name.trim()) {
    return res.status(400).json({ success: false, message: 'กรุณาระบุชื่อตำแหน่ง' });
  }
  // Auto-generate code if missing: POS001, POS002, ...
  let finalCode = code?.trim() || null;
  if (!finalCode) {
    try {
      const seq = await query(`SELECT COUNT(*)::int AS n FROM positions`);
      finalCode = `POS${String((seq.rows[0].n || 0) + 1).padStart(5, '0')}`;
    } catch { finalCode = null; }
  }
  try {
    const r = await query(
      `INSERT INTO positions (code, name, description, parent_id)
       VALUES ($1, $2, $3, $4) RETURNING *`,
      [finalCode, name.trim(), description || null, parentId || null]
    );
    res.status(201).json({ success: true, message: 'สร้างตำแหน่งแล้ว', data: r.rows[0] });
  } catch (err) {
    if (err.code === '23505') return res.status(400).json({ success: false, message: 'มีโค้ดตำแหน่งนี้อยู่แล้ว' });
    console.error('POST /positions error:', err.message);
    res.status(500).json({ success: false, message: 'เกิดข้อผิดพลาด' });
  }
});

router.patch('/positions/:id', authenticate, authorize('hr', 'owner'), async (req, res) => {
  const { code, name, description, parentId } = req.body;
  // Prevent assigning self as parent
  if (parentId === req.params.id) {
    return res.status(400).json({ success: false, message: 'ไม่สามารถตั้งตำแหน่งตัวเองเป็น parent ได้' });
  }
  try {
    await query(
      `UPDATE positions SET
         code = COALESCE($1, code),
         name = COALESCE($2, name),
         description = COALESCE($3, description),
         parent_id = $4,
         updated_at = NOW()
       WHERE id = $5`,
      [code, name, description, parentId === '' ? null : parentId, req.params.id]
    );
    res.json({ success: true, message: 'อัปเดตตำแหน่งแล้ว' });
  } catch (err) {
    if (err.code === '23505') return res.status(400).json({ success: false, message: 'มีโค้ดตำแหน่งนี้อยู่แล้ว' });
    console.error('PATCH /positions/:id error:', err.message);
    res.status(500).json({ success: false, message: 'เกิดข้อผิดพลาด' });
  }
});

router.delete('/positions/:id', authenticate, authorize('hr', 'owner'), async (req, res) => {
  try {
    // Block delete if it has children
    const kids = await query('SELECT COUNT(*)::int as n FROM positions WHERE parent_id = $1', [req.params.id]);
    if (kids.rows[0].n > 0) {
      return res.status(400).json({
        success: false,
        message: `ลบไม่ได้ มีตำแหน่งย่อย ${kids.rows[0].n} ตำแหน่ง — กรุณาลบหรือย้ายออกก่อน`
      });
    }
    await query('DELETE FROM positions WHERE id = $1', [req.params.id]);
    res.json({ success: true, message: 'ลบตำแหน่งแล้ว' });
  } catch (e) {
    console.error('DELETE /positions/:id error:', e.message);
    res.status(500).json({ success: false, message: 'เกิดข้อผิดพลาด' });
  }
});

// ====== SHIFT CONFIGS (rules) ======
// Defines the rules for each shift type: work hours, late/absent
// thresholds, and (for flex shifts) the staggered tier table.
router.get('/shift-configs', authenticate, async (req, res) => {
  try {
    const r = await query(
      `SELECT id, name, code, shift_type, description, work_days,
              checkin_start, checkin_end, work_start, work_end,
              grace_minutes, late_warning_minutes, late_threshold_minutes, absent_threshold_minutes,
              flex_tiers, is_active
       FROM shift_configs
       ORDER BY shift_type, code, name`
    );
    res.json({ success: true, data: r.rows });
  } catch (e) {
    console.error('GET /shift-configs error:', e.message);
    res.status(500).json({ success: false, message: 'เกิดข้อผิดพลาด' });
  }
});

router.post('/shift-configs', authenticate, authorize('hr', 'owner'), async (req, res) => {
  const {
    name, code, shiftType, description, workDays,
    checkinStart, checkinEnd, workStart, workEnd,
    graceMinutes, lateWarningMinutes, lateThresholdMinutes, absentThresholdMinutes,
    flexTiers
  } = req.body;
  if (!name || !shiftType) {
    return res.status(400).json({ success: false, message: 'กรุณาระบุชื่อและประเภทกะ' });
  }
  // Auto-generate a code if not provided: WC + sequential number
  let finalCode = code?.trim() || null;
  if (!finalCode) {
    try {
      const seq = await query(`SELECT COUNT(*)::int AS n FROM shift_configs`);
      finalCode = `WC${String((seq.rows[0].n || 0) + 1).padStart(3, '0')}`;
    } catch { finalCode = null; }
  }
  try {
    const r = await query(
      `INSERT INTO shift_configs (
         name, code, shift_type, description, work_days,
         checkin_start, checkin_end, work_start, work_end,
         grace_minutes, late_warning_minutes, late_threshold_minutes, absent_threshold_minutes,
         flex_tiers
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
       RETURNING *`,
      [
        name, finalCode, shiftType, description || null,
        workDays || [1,2,3,4,5],
        checkinStart || '08:30',
        checkinEnd || '10:00',
        workStart || '09:00',
        workEnd || '17:00',
        graceMinutes ?? 0,
        lateWarningMinutes ?? 1,
        lateThresholdMinutes ?? 10,
        absentThresholdMinutes ?? 20,
        JSON.stringify(flexTiers || [])
      ]
    );
    res.status(201).json({ success: true, message: 'สร้างกะแล้ว', data: r.rows[0] });
  } catch (err) {
    if (err.code === '23505') return res.status(400).json({ success: false, message: 'มีโค้ดกะนี้อยู่แล้ว' });
    console.error('POST /shift-configs error:', err.message);
    res.status(500).json({ success: false, message: 'เกิดข้อผิดพลาด' });
  }
});

router.patch('/shift-configs/:id', authenticate, authorize('hr', 'owner'), async (req, res) => {
  const {
    name, code, shiftType, description, workDays,
    checkinStart, checkinEnd, workStart, workEnd,
    graceMinutes, lateWarningMinutes, lateThresholdMinutes, absentThresholdMinutes,
    flexTiers, isActive
  } = req.body;
  try {
    await query(
      `UPDATE shift_configs SET
         name = COALESCE($1, name),
         code = COALESCE($2, code),
         shift_type = COALESCE($3, shift_type),
         description = COALESCE($4, description),
         work_days = COALESCE($5, work_days),
         checkin_start = COALESCE($6, checkin_start),
         checkin_end = COALESCE($7, checkin_end),
         work_start = COALESCE($8, work_start),
         work_end = COALESCE($9, work_end),
         grace_minutes = COALESCE($10, grace_minutes),
         late_warning_minutes = COALESCE($11, late_warning_minutes),
         late_threshold_minutes = COALESCE($12, late_threshold_minutes),
         absent_threshold_minutes = COALESCE($13, absent_threshold_minutes),
         flex_tiers = COALESCE($14::jsonb, flex_tiers),
         is_active = COALESCE($15, is_active)
       WHERE id = $16`,
      [
        name, code, shiftType, description, workDays,
        checkinStart, checkinEnd, workStart, workEnd,
        graceMinutes, lateWarningMinutes, lateThresholdMinutes, absentThresholdMinutes,
        flexTiers !== undefined ? JSON.stringify(flexTiers) : null,
        isActive,
        req.params.id
      ]
    );
    res.json({ success: true, message: 'อัปเดตกะแล้ว' });
  } catch (e) {
    if (e.code === '23505') return res.status(400).json({ success: false, message: 'มีโค้ดกะนี้อยู่แล้ว' });
    console.error('PATCH /shift-configs/:id error:', e.message);
    res.status(500).json({ success: false, message: 'เกิดข้อผิดพลาด' });
  }
});

router.delete('/shift-configs/:id', authenticate, authorize('owner'), async (req, res) => {
  try {
    await query('DELETE FROM shift_configs WHERE id = $1', [req.params.id]);
    res.json({ success: true, message: 'ลบกะแล้ว' });
  } catch (e) {
    res.status(500).json({ success: false, message: 'เกิดข้อผิดพลาด' });
  }
});

// ====== SHIFT ASSIGNMENTS ======
// GET /api/shifts?startDate=YYYY-MM-DD&endDate=YYYY-MM-DD
// Returns one record per (employee, date) that has been explicitly assigned.
// Missing days fall back to employees.shift_type on the frontend.
router.get('/shifts', authenticate, authorize('hr', 'owner'), async (req, res) => {
  const { startDate, endDate } = req.query;
  if (!startDate || !endDate) {
    return res.status(400).json({ success: false, message: 'กรุณาระบุ startDate และ endDate' });
  }
  try {
    const r = await query(
      `SELECT id, employee_id, date::text as date, shift_type, notes
       FROM shift_assignments
       WHERE date BETWEEN $1 AND $2
       ORDER BY date, employee_id`,
      [startDate, endDate]
    );
    res.json({ success: true, data: r.rows });
  } catch (e) {
    console.error('GET /shifts error:', e.message);
    res.status(500).json({ success: false, message: 'เกิดข้อผิดพลาด' });
  }
});

// POST /api/shifts/bulk
// Body: { items: [{ employeeId, date, shiftType }, ...] }
// Upserts each item. shiftType 'default' deletes the override so the row
// falls back to employees.shift_type.
router.post('/shifts/bulk', authenticate, authorize('hr', 'owner'), async (req, res) => {
  const { items } = req.body;
  if (!Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ success: false, message: 'ไม่มีข้อมูล' });
  }
  try {
    let upserts = 0;
    let deletes = 0;
    for (const it of items) {
      if (!it.employeeId || !it.date) continue;
      // "default" / empty → remove override so the cell falls back to
      // employees.shift_type. Anything else is stored verbatim (it should
      // be a shift_configs.code on the grid but we don't enforce that
      // here so legacy values like "normal"/"flexible"/"dayoff" still
      // work).
      if (it.shiftType === 'default' || it.shiftType === '' || it.shiftType == null) {
        await query(
          'DELETE FROM shift_assignments WHERE employee_id = $1 AND date = $2',
          [it.employeeId, it.date]
        );
        deletes++;
        continue;
      }
      await query(
        `INSERT INTO shift_assignments (employee_id, date, shift_type, notes, created_by, updated_at)
         VALUES ($1, $2, $3, $4, $5, NOW())
         ON CONFLICT (employee_id, date)
         DO UPDATE SET shift_type = EXCLUDED.shift_type,
                       notes = EXCLUDED.notes,
                       updated_at = NOW()`,
        [it.employeeId, it.date, it.shiftType, it.notes || null, req.user.id]
      );
      upserts++;
    }
    res.json({ success: true, message: `บันทึก ${upserts} รายการ`, data: { upserts, deletes } });
  } catch (e) {
    console.error('POST /shifts/bulk error:', e.message);
    res.status(500).json({ success: false, message: 'เกิดข้อผิดพลาด' });
  }
});

// DELETE /api/shifts/:id — remove a single assignment
router.delete('/shifts/:id', authenticate, authorize('hr', 'owner'), async (req, res) => {
  try {
    await query('DELETE FROM shift_assignments WHERE id = $1', [req.params.id]);
    res.json({ success: true, message: 'ลบรายการแล้ว' });
  } catch (e) {
    res.status(500).json({ success: false, message: 'เกิดข้อผิดพลาด' });
  }
});

// ====== DEPARTMENTS ======
router.get('/departments', authenticate, async (req, res) => {
  try {
    const r = await query(
      `SELECT d.id, d.name, d.description, d.manager_id,
              CONCAT(m.first_name, ' ', m.last_name) as manager_name,
              (SELECT COUNT(*) FROM employees e WHERE e.department_id = d.id AND e.is_active = true)::int as member_count
       FROM departments d
       LEFT JOIN employees m ON d.manager_id = m.id
       ORDER BY d.name`
    );
    res.json({ success: true, data: r.rows });
  } catch (e) {
    console.error('GET /departments error:', e.message, e.stack);
    res.status(500).json({ success: false, message: 'เกิดข้อผิดพลาด' });
  }
});

router.post('/departments', authenticate, authorize('hr', 'owner'), async (req, res) => {
  const { name, description, managerId } = req.body;
  if (!name || !name.trim()) {
    return res.status(400).json({ success: false, message: 'กรุณาระบุชื่อแผนก' });
  }
  try {
    const r = await query(
      'INSERT INTO departments (name, description, manager_id) VALUES ($1, $2, $3) RETURNING *',
      [name.trim(), description || null, managerId || null]
    );
    res.status(201).json({ success: true, message: 'สร้างแผนกแล้ว', data: r.rows[0] });
  } catch (err) {
    if (err.code === '23505') return res.status(400).json({ success: false, message: 'มีแผนกชื่อนี้อยู่แล้ว' });
    console.error('POST /departments error:', err.message, err.stack);
    res.status(500).json({ success: false, message: 'เกิดข้อผิดพลาด' });
  }
});

router.patch('/departments/:id', authenticate, authorize('hr', 'owner'), async (req, res) => {
  const { name, description, managerId } = req.body;
  try {
    await query(
      `UPDATE departments SET
         name = COALESCE($1, name),
         description = COALESCE($2, description),
         manager_id = $3
       WHERE id = $4`,
      [name, description, managerId || null, req.params.id]
    );
    res.json({ success: true, message: 'อัปเดตแผนกแล้ว' });
  } catch (e) {
    console.error('PATCH /departments/:id error:', e.message);
    res.status(500).json({ success: false, message: 'เกิดข้อผิดพลาด' });
  }
});

router.delete('/departments/:id', authenticate, authorize('owner'), async (req, res) => {
  try {
    const inUse = await query(
      'SELECT COUNT(*)::int as count FROM employees WHERE department_id = $1 AND is_active = true',
      [req.params.id]
    );
    if (inUse.rows[0].count > 0) {
      return res.status(400).json({
        success: false,
        message: `ลบไม่ได้ มีพนักงานในแผนกนี้อยู่ ${inUse.rows[0].count} คน — กรุณาย้ายออกก่อน`
      });
    }
    await query('DELETE FROM departments WHERE id = $1', [req.params.id]);
    res.json({ success: true, message: 'ลบแผนกแล้ว' });
  } catch (e) {
    console.error('DELETE /departments/:id error:', e.message);
    res.status(500).json({ success: false, message: 'เกิดข้อผิดพลาด' });
  }
});

// ====== HOLIDAYS ======
router.get('/holidays', authenticate, async (req, res) => {
  try {
    const year = req.query.year || new Date().getFullYear();
    const result = await query('SELECT * FROM holidays WHERE year = $1 ORDER BY date', [year]);
    res.json({ success: true, data: result.rows });
  } catch (e) { res.status(500).json({ success: false, message: 'เกิดข้อผิดพลาด' }); }
});

router.post('/holidays', authenticate, authorize('hr'), async (req, res) => {
  try {
    const { name, date, type } = req.body;
    const year = new Date(date).getFullYear();
    const r = await query(
      'INSERT INTO holidays (name, date, type, year, created_by) VALUES ($1,$2,$3,$4,$5) ON CONFLICT (date) DO NOTHING RETURNING *',
      [name, date, type || 'national', year, req.user.id]
    );
    res.status(201).json({ success: true, data: r.rows[0] });
  } catch (e) { res.status(500).json({ success: false, message: 'เกิดข้อผิดพลาด' }); }
});

router.delete('/holidays/:id', authenticate, authorize('hr'), async (req, res) => {
  try {
    await query('DELETE FROM holidays WHERE id = $1', [req.params.id]);
    res.json({ success: true, message: 'ลบวันหยุดแล้ว' });
  } catch (e) { res.status(500).json({ success: false, message: 'เกิดข้อผิดพลาด' }); }
});

// ====== ANNOUNCEMENTS ======
router.get('/announcements', authenticate, async (req, res) => {
  try {
    const result = await query(
      `SELECT a.*, u.id as created_by_id,
              CONCAT(e.first_name, ' ', e.last_name) as created_by_name,
              (SELECT COUNT(*) FROM announcement_reads ar WHERE ar.announcement_id = a.id) as read_count,
              EXISTS(SELECT 1 FROM announcement_reads ar WHERE ar.announcement_id = a.id AND ar.user_id = $1) as is_read
       FROM announcements a
       LEFT JOIN users u ON a.created_by = u.id
       LEFT JOIN employees e ON u.id = e.user_id
       WHERE a.is_active = true AND $2 = ANY(a.target_roles)
       ORDER BY a.created_at DESC LIMIT 20`,
      [req.user.id, req.user.role]
    );
    res.json({ success: true, data: result.rows });
  } catch (e) { res.status(500).json({ success: false, message: 'เกิดข้อผิดพลาด' }); }
});

router.post('/announcements', authenticate, authorize('hr', 'owner'), async (req, res) => {
  try {
    const { title, content, type, targetRoles } = req.body;
    const r = await query(
      'INSERT INTO announcements (title, content, type, target_roles, created_by) VALUES ($1,$2,$3,$4,$5) RETURNING *',
      [title, content, type || 'info', targetRoles || ['owner','hr','employee'], req.user.id]
    );
    res.status(201).json({ success: true, data: r.rows[0] });
  } catch (e) { res.status(500).json({ success: false, message: 'เกิดข้อผิดพลาด' }); }
});

router.post('/announcements/:id/read', authenticate, async (req, res) => {
  try {
    await query(
      'INSERT INTO announcement_reads (announcement_id, user_id) VALUES ($1,$2) ON CONFLICT DO NOTHING',
      [req.params.id, req.user.id]
    );
    res.json({ success: true });
  } catch (e) { res.status(500).json({ success: false, message: 'เกิดข้อผิดพลาด' }); }
});

// ====== PROJECTS & TASKS ======
router.get('/projects', authenticate, async (req, res) => {
  try {
    const result = await query(
      `SELECT p.*, CONCAT(e.first_name,' ',e.last_name) as owner_name,
              (SELECT COUNT(*) FROM tasks t WHERE t.project_id = p.id) as total_tasks,
              (SELECT COUNT(*) FROM tasks t WHERE t.project_id = p.id AND t.status = 'done') as done_tasks
       FROM projects p
       LEFT JOIN users u ON p.owner_id = u.id
       LEFT JOIN employees e ON u.id = e.user_id
       ORDER BY p.created_at DESC`
    );
    res.json({ success: true, data: result.rows });
  } catch (e) { res.status(500).json({ success: false, message: 'เกิดข้อผิดพลาด' }); }
});

router.post('/projects', authenticate, authorize('hr', 'owner'), async (req, res) => {
  try {
    const { name, description, priority, dueDate, space } = req.body;
    const r = await query(
      'INSERT INTO projects (name, description, priority, due_date, space, owner_id) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *',
      [name, description, priority || 'medium', dueDate, space, req.user.id]
    );
    res.status(201).json({ success: true, data: r.rows[0] });
  } catch (e) { res.status(500).json({ success: false, message: 'เกิดข้อผิดพลาด' }); }
});

router.get('/projects/:id/tasks', authenticate, async (req, res) => {
  try {
    const result = await query(
      `SELECT t.*, CONCAT(e.first_name,' ',e.last_name) as assignee_name, e.employee_id as assignee_code
       FROM tasks t
       LEFT JOIN employees e ON t.assignee_id = e.id
       WHERE t.project_id = $1
       ORDER BY t.created_at`,
      [req.params.id]
    );
    res.json({ success: true, data: result.rows });
  } catch (e) { res.status(500).json({ success: false, message: 'เกิดข้อผิดพลาด' }); }
});

router.post('/tasks', authenticate, async (req, res) => {
  try {
    const { projectId, title, description, assigneeId, priority, dueDate, estimatedHours } = req.body;
    const r = await query(
      'INSERT INTO tasks (project_id,title,description,assignee_id,priority,due_date,estimated_hours,created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *',
      [projectId, title, description, assigneeId, priority || 'medium', dueDate, estimatedHours, req.user.id]
    );
    res.status(201).json({ success: true, data: r.rows[0] });
  } catch (e) { res.status(500).json({ success: false, message: 'เกิดข้อผิดพลาด' }); }
});

router.patch('/tasks/:id', authenticate, async (req, res) => {
  try {
    const { status, progress, notes } = req.body;
    const r = await query(
      'UPDATE tasks SET status = COALESCE($1,status), progress = COALESCE($2,progress), updated_at = NOW() WHERE id = $3 RETURNING *',
      [status, progress, req.params.id]
    );
    res.json({ success: true, data: r.rows[0] });
  } catch (e) { res.status(500).json({ success: false, message: 'เกิดข้อผิดพลาด' }); }
});

// ====== AUDIT LOG ======
router.get('/audit-logs', authenticate, authorize('owner', 'hr'), async (req, res) => {
  try {
    const result = await query(
      `SELECT al.*, u.email, u.role, CONCAT(e.first_name,' ',e.last_name) as user_name
       FROM audit_logs al
       LEFT JOIN users u ON al.user_id = u.id
       LEFT JOIN employees e ON u.id = e.user_id
       ORDER BY al.created_at DESC LIMIT 100`
    );
    res.json({ success: true, data: result.rows });
  } catch (e) { res.status(500).json({ success: false, message: 'เกิดข้อผิดพลาด' }); }
});

// ====== HEALTH CHECK ======
router.get('/health', (req, res) => {
  res.json({ success: true, message: 'OrgManager HR API is running', version: '1.0.0', timestamp: new Date().toISOString() });
});
// ====== EMPLOYEE MANAGEMENT ======
router.post('/employees/create', authenticate, authorize('hr','owner'), async (req,res) => {
  const {firstName,lastName,email,employeeId,position,department,role,shiftType,baseSalary,password} = req.body
  if (!firstName||!lastName||!email||!employeeId||!password)
    return res.status(400).json({success:false,message:'กรุณากรอกข้อมูลให้ครบ'})
  try {
    const bcrypt = require('bcryptjs')
    const hash = await bcrypt.hash(password,12)
    const deptRes = await query('SELECT id FROM departments WHERE name=$1',[department])
    const deptId = deptRes.rows[0]?.id||null
    const uRes = await query('INSERT INTO users(employee_id,email,password_hash,role) VALUES($1,$2,$3,$4) RETURNING id',[employeeId,email.toLowerCase(),hash,role||'employee'])
    await query('INSERT INTO employees(user_id,employee_id,first_name,last_name,department_id,position,shift_type,base_salary,start_date) VALUES($1,$2,$3,$4,$5,$6,$7,$8,CURRENT_DATE)',[uRes.rows[0].id,employeeId,firstName,lastName,deptId,position,shiftType||'normal',baseSalary||0])
    res.status(201).json({success:true,message:`สร้างบัญชี ${firstName} ${lastName} สำเร็จ`})
  } catch(err) {
    if(err.code==='23505') return res.status(400).json({success:false,message:'อีเมลหรือรหัสพนักงานซ้ำในระบบ'})
    res.status(500).json({success:false,message:'เกิดข้อผิดพลาด'})
  }
})

router.patch('/employees/:id', authenticate, authorize('hr','owner'), async (req,res) => {
  const {
    firstName, lastName, nickname, phone,
    position, department, shiftType, baseSalary, role,
    managerId, avatarUrl,
    bankAccount, bankName, nationalId,
    workDays,
    employeeId,   // optional rename of the human-facing code (EMP-001 etc.)
    // Personal
    title, firstNameEn, lastNameEn, nicknameEn,
    gender, nationality, maritalStatus, dateOfBirth, address,
    // IDs
    passportNumber, socialSecurityNumber, taxId, fingerprintCode,
    // Employment
    hireDate, retirementYear, probationDays, probationEndDate,
    contractEndDate, employmentType, startDate,
    // Bank / payroll
    bankBranchCode, paymentMethod,
    // Free-form
    notes, hashtags,
  } = req.body
  // Avatar size guard
  if (avatarUrl && typeof avatarUrl === 'string' && avatarUrl.length > 700 * 1024) {
    return res.status(413).json({ success: false, message: 'รูปภาพใหญ่เกินไป (สูงสุด ~500KB)' });
  }
  // Employee-code rename validation (separate path because it touches two
  // tables and has its own uniqueness constraint).
  let renameTo = null
  if (employeeId !== undefined && employeeId !== null) {
    const trimmed = String(employeeId).trim()
    if (!trimmed) {
      return res.status(400).json({ success: false, message: 'รหัสพนักงานห้ามว่าง' })
    }
    if (trimmed.length > 20) {
      return res.status(400).json({ success: false, message: 'รหัสพนักงานยาวเกินไป (สูงสุด 20 ตัว)' })
    }
    renameTo = trimmed
  }
  try {
    // Resolve department by name → id (department arrives as name from UI)
    let deptId = null
    if (department !== undefined && department !== null) {
      const deptRes = await query('SELECT id FROM departments WHERE name=$1', [department])
      deptId = deptRes.rows[0]?.id || null
    }

    // Employee-code rename: needs to update both employees.employee_id and
    // users.employee_id (legacy duplicate column). Wrap in a transaction so
    // a unique-violation on either side rolls back cleanly.
    if (renameTo !== null) {
      const cur = await query('SELECT employee_id, user_id FROM employees WHERE id=$1', [req.params.id])
      const row = cur.rows[0]
      if (!row) return res.status(404).json({ success: false, message: 'ไม่พบพนักงาน' })
      if (row.employee_id !== renameTo) {
        const client = await pool.connect()
        try {
          await client.query('BEGIN')
          await client.query('UPDATE employees SET employee_id=$1, updated_at=NOW() WHERE id=$2', [renameTo, req.params.id])
          if (row.user_id) {
            await client.query('UPDATE users SET employee_id=$1 WHERE id=$2', [renameTo, row.user_id])
          }
          await client.query('COMMIT')
        } catch (e) {
          await client.query('ROLLBACK').catch(() => {})
          if (e.code === '23505') {
            return res.status(409).json({ success: false, message: 'รหัสพนักงานนี้มีคนอื่นใช้แล้ว' })
          }
          throw e
        } finally { client.release() }
      }
    }

    // Prevent setting manager_id to self (would create a self-loop)
    let resolvedManagerId = managerId
    if (resolvedManagerId === '' || resolvedManagerId === undefined) resolvedManagerId = null
    if (resolvedManagerId && resolvedManagerId === req.params.id) {
      return res.status(400).json({ success: false, message: 'ไม่สามารถตั้งตัวเองเป็นผู้บังคับบัญชาได้' })
    }

    await query(
      `UPDATE employees SET
         first_name = COALESCE($1, first_name),
         last_name  = COALESCE($2, last_name),
         nickname   = COALESCE($3, nickname),
         phone      = COALESCE($4, phone),
         position   = COALESCE($5, position),
         department_id = COALESCE($6, department_id),
         shift_type    = COALESCE($7, shift_type),
         base_salary   = COALESCE($8, base_salary),
         manager_id    = $9,
         avatar_url    = COALESCE($10, avatar_url),
         bank_account  = COALESCE($11, bank_account),
         bank_name     = COALESCE($12, bank_name),
         national_id   = COALESCE($13, national_id),
         work_days     = COALESCE($14, work_days),
         -- Personal
         title              = COALESCE($16, title),
         first_name_en      = COALESCE($17, first_name_en),
         last_name_en       = COALESCE($18, last_name_en),
         nickname_en        = COALESCE($19, nickname_en),
         gender             = COALESCE($20, gender),
         nationality        = COALESCE($21, nationality),
         marital_status     = COALESCE($22, marital_status),
         date_of_birth      = COALESCE($23, date_of_birth),
         address            = COALESCE($24, address),
         -- IDs
         passport_number    = COALESCE($25, passport_number),
         social_security_number = COALESCE($26, social_security_number),
         tax_id             = COALESCE($27, tax_id),
         fingerprint_code   = COALESCE($28, fingerprint_code),
         -- Employment
         hire_date          = COALESCE($29, hire_date),
         retirement_year    = COALESCE($30, retirement_year),
         probation_days     = COALESCE($31, probation_days),
         probation_end_date = COALESCE($32, probation_end_date),
         contract_end_date  = COALESCE($33, contract_end_date),
         employment_type    = COALESCE($34, employment_type),
         start_date         = COALESCE($35, start_date),
         -- Bank / payroll
         bank_branch_code   = COALESCE($36, bank_branch_code),
         payment_method     = COALESCE($37, payment_method),
         -- Free-form
         notes              = COALESCE($38, notes),
         hashtags           = COALESCE($39, hashtags),
         updated_at = NOW()
       WHERE id = $15`,
      [firstName, lastName, nickname, phone,
       position, deptId, shiftType, baseSalary,
       resolvedManagerId, avatarUrl,
       bankAccount, bankName, nationalId,
       Array.isArray(workDays) ? workDays : null,
       req.params.id,
       title, firstNameEn, lastNameEn, nicknameEn,
       gender, nationality, maritalStatus, dateOfBirth, address,
       passportNumber, socialSecurityNumber, taxId, fingerprintCode,
       hireDate, retirementYear, probationDays, probationEndDate,
       contractEndDate, employmentType, startDate,
       bankBranchCode, paymentMethod,
       notes, Array.isArray(hashtags) ? hashtags : null,
      ]
    )

    // Role change is owner-only
    if (role && req.user.role === 'owner') {
      const e = await query('SELECT user_id FROM employees WHERE id=$1', [req.params.id])
      if (e.rows[0]) await query('UPDATE users SET role=$1 WHERE id=$2', [role, e.rows[0].user_id])
    }
    res.json({success:true, message:'อัปเดตสำเร็จ'})
  } catch (err) {
    console.error('PATCH /employees/:id error:', err.message)
    res.status(500).json({success:false, message:'เกิดข้อผิดพลาด'})
  }
})

// Bulk update weekly_shifts — used by the recurring "ตารางรายสัปดาห์"
// grid. Each item: { employeeId, weeklyShifts: { "0": "WC001"|"dayoff", ... } }
router.post('/employees/weekly-shifts/bulk', authenticate, authorize('hr','owner'), async (req, res) => {
  const { items } = req.body
  if (!Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ success: false, message: 'ไม่มีข้อมูล' })
  }
  try {
    let updated = 0
    for (const it of items) {
      if (!it.employeeId || typeof it.weeklyShifts !== 'object' || it.weeklyShifts === null) continue
      await query(
        'UPDATE employees SET weekly_shifts = $1::jsonb, updated_at = NOW() WHERE id = $2',
        [JSON.stringify(it.weeklyShifts), it.employeeId]
      )
      updated++
    }
    res.json({ success: true, message: `บันทึก ${updated} คน`, data: { updated } })
  } catch (e) {
    console.error('POST /employees/weekly-shifts/bulk error:', e.message)
    res.status(500).json({ success: false, message: 'เกิดข้อผิดพลาด' })
  }
})

// Bulk update work_days for many employees at once — used by the
// "วันทำงาน/วันหยุด" grid which lets HR change several rows then save once.
router.post('/employees/work-days/bulk', authenticate, authorize('hr','owner'), async (req, res) => {
  const { items } = req.body
  if (!Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ success: false, message: 'ไม่มีข้อมูล' })
  }
  try {
    let updated = 0
    for (const it of items) {
      if (!it.employeeId || !Array.isArray(it.workDays)) continue
      await query(
        'UPDATE employees SET work_days = $1, updated_at = NOW() WHERE id = $2',
        [it.workDays, it.employeeId]
      )
      updated++
    }
    res.json({ success: true, message: `บันทึก ${updated} รายการ`, data: { updated } })
  } catch (e) {
    console.error('POST /employees/work-days/bulk error:', e.message)
    res.status(500).json({ success: false, message: 'เกิดข้อผิดพลาด' })
  }
})

router.patch('/employees/:id/toggle-active', authenticate, authorize('owner'), async (req,res) => {
  try {
    const e = await query('SELECT user_id,is_active FROM employees WHERE id=$1',[req.params.id])
    if(!e.rows[0]) return res.status(404).json({success:false,message:'ไม่พบพนักงาน'})
    const active = !e.rows[0].is_active
    await query('UPDATE employees SET is_active=$1 WHERE id=$2',[active,req.params.id])
    await query('UPDATE users SET is_active=$1 WHERE id=$2',[active,e.rows[0].user_id])
    res.json({success:true,message:active?'เปิดใช้งานแล้ว':'ระงับบัญชีแล้ว'})
  } catch(err){res.status(500).json({success:false,message:'เกิดข้อผิดพลาด'})}
})

router.patch('/employees/:id/reset-password', authenticate, authorize('hr','owner'), async (req,res) => {
  const {newPassword} = req.body
  if(!newPassword||newPassword.length<6)
    return res.status(400).json({success:false,message:'รหัสผ่านต้องมีอย่างน้อย 6 ตัว'})
  try {
    const bcrypt = require('bcryptjs')
    const e = await query('SELECT user_id FROM employees WHERE id=$1',[req.params.id])
    if(!e.rows[0]) return res.status(404).json({success:false,message:'ไม่พบพนักงาน'})
    const hash = await bcrypt.hash(newPassword,12)
    await query('UPDATE users SET password_hash=$1,failed_login_count=0,locked_until=NULL WHERE id=$2',[hash,e.rows[0].user_id])
    res.json({success:true,message:'รีเซ็ตรหัสผ่านสำเร็จ'})
  } catch(err){res.status(500).json({success:false,message:'เกิดข้อผิดพลาด'})}
})
// ====== ORG SETTINGS ======
// Singleton row at id=1. Read by anyone authenticated; write by owner only.
router.get('/org-settings', authenticate, async (req, res) => {
  try {
    const r = await query('SELECT * FROM org_settings WHERE id = 1');
    res.json({ success: true, data: r.rows[0] || null });
  } catch (e) {
    console.error('GET /org-settings error:', e.message);
    res.status(500).json({ success: false, message: 'เกิดข้อผิดพลาด' });
  }
});

router.patch('/org-settings', authenticate, authorize('owner'), async (req, res) => {
  const {
    companyName, companyNameEn, companyAddress,
    companyPhone, companyEmail, companyTaxId, companyLogo,
  } = req.body;
  // Logo size guard — base64 dataURL with same ~500KB cap as avatars.
  if (companyLogo && typeof companyLogo === 'string' && companyLogo.length > 700 * 1024) {
    return res.status(413).json({ success: false, message: 'โลโก้ใหญ่เกินไป (สูงสุด ~500KB)' });
  }
  try {
    await query(
      `UPDATE org_settings SET
         company_name     = COALESCE($1, company_name),
         company_name_en  = COALESCE($2, company_name_en),
         company_address  = COALESCE($3, company_address),
         company_phone    = COALESCE($4, company_phone),
         company_email    = COALESCE($5, company_email),
         company_tax_id   = COALESCE($6, company_tax_id),
         company_logo     = COALESCE($7, company_logo),
         updated_at = NOW()
       WHERE id = 1`,
      [companyName ?? null, companyNameEn ?? null, companyAddress ?? null,
       companyPhone ?? null, companyEmail ?? null, companyTaxId ?? null, companyLogo ?? null]
    );
    res.json({ success: true, message: 'บันทึกข้อมูลบริษัทแล้ว' });
  } catch (e) {
    console.error('PATCH /org-settings error:', e.message);
    res.status(500).json({ success: false, message: 'เกิดข้อผิดพลาด' });
  }
});

// ====== PAYROLL ======
// payroll_records is the master table of monthly slips. One row per
// (employee, month, year). net_salary is a GENERATED column computed by
// Postgres from base_salary + ot_amount + bonus + allowances minus
// social_security + income_tax + other_deductions, so the UI never has to
// keep it in sync — just update inputs and re-read.
//
// Status flow: draft → approved → paid. HR creates as draft, then approves
// (signals "amounts locked in"), then marks-paid (signals "money sent" and
// stamps paid_at). Going backwards is allowed via PATCH.

// Helper: HR/owner can act on any record; employee can only read their own.
async function resolveOwnEmployeeId(userId) {
  const r = await query('SELECT id FROM employees WHERE user_id = $1', [userId]);
  return r.rows[0]?.id || null;
}

// GET /payroll — list. HR/owner see everyone; employee sees self only.
// Optional filters: month, year, status, employeeId.
router.get('/payroll', authenticate, async (req, res) => {
  const { month, year, status, employeeId } = req.query;
  try {
    const where = [];
    const params = [];
    const push = (clause, value) => { params.push(value); where.push(clause.replace('$$', `$${params.length}`)); };

    if (req.user.role !== 'hr' && req.user.role !== 'owner') {
      const ownId = await resolveOwnEmployeeId(req.user.id);
      if (!ownId) return res.json({ success: true, data: [] });
      push('p.employee_id = $$', ownId);
    } else if (employeeId) {
      push('p.employee_id = $$', employeeId);
    }
    if (month) push('p.month = $$', parseInt(month, 10));
    if (year)  push('p.year = $$',  parseInt(year, 10));
    if (status) push('p.status = $$', status);

    const sql = `
      SELECT p.*,
             e.first_name, e.last_name, e.nickname, e.avatar_url,
             e.employee_id AS emp_code, e.position,
             d.name AS department_name
      FROM payroll_records p
      JOIN employees e ON p.employee_id = e.id
      LEFT JOIN departments d ON e.department_id = d.id
      ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
      ORDER BY p.year DESC, p.month DESC, e.first_name`;
    const r = await query(sql, params);
    res.json({ success: true, data: r.rows });
  } catch (e) {
    console.error('GET /payroll error:', e.message);
    res.status(500).json({ success: false, message: 'เกิดข้อผิดพลาด' });
  }
});

// GET /payroll/:id — single slip. Employees can only read their own.
router.get('/payroll/:id', authenticate, async (req, res) => {
  try {
    const r = await query(
      `SELECT p.*,
              e.first_name, e.last_name, e.nickname, e.avatar_url,
              e.employee_id AS emp_code, e.position,
              e.bank_account, e.bank_name, e.bank_branch_code,
              d.name AS department_name
       FROM payroll_records p
       JOIN employees e ON p.employee_id = e.id
       LEFT JOIN departments d ON e.department_id = d.id
       WHERE p.id = $1`,
      [req.params.id]
    );
    const slip = r.rows[0];
    if (!slip) return res.status(404).json({ success: false, message: 'ไม่พบสลิป' });
    if (req.user.role !== 'hr' && req.user.role !== 'owner') {
      const ownId = await resolveOwnEmployeeId(req.user.id);
      if (slip.employee_id !== ownId) {
        return res.status(403).json({ success: false, message: 'ไม่มีสิทธิ์ดู' });
      }
    }
    res.json({ success: true, data: slip });
  } catch (e) {
    console.error('GET /payroll/:id error:', e.message);
    res.status(500).json({ success: false, message: 'เกิดข้อผิดพลาด' });
  }
});

// POST /payroll — HR/owner creates one slip manually.
router.post('/payroll', authenticate, authorize('hr', 'owner'), async (req, res) => {
  const {
    employeeId, month, year,
    baseSalary, otAmount, bonus, allowances,
    socialSecurity, incomeTax, otherDeductions,
    workDays, absentDays, lateCount, otHours,
    notes,
  } = req.body;
  if (!employeeId || !month || !year || baseSalary === undefined || baseSalary === null) {
    return res.status(400).json({ success: false, message: 'ข้อมูลไม่ครบ (employeeId, month, year, baseSalary จำเป็น)' });
  }
  try {
    const r = await query(
      `INSERT INTO payroll_records (
         employee_id, month, year,
         base_salary, ot_amount, bonus, allowances,
         social_security, income_tax, other_deductions,
         work_days, absent_days, late_count, ot_hours,
         notes, created_by
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
       RETURNING *`,
      [employeeId, month, year,
       baseSalary, otAmount || 0, bonus || 0, allowances || 0,
       socialSecurity || 0, incomeTax || 0, otherDeductions || 0,
       workDays ?? null, absentDays || 0, lateCount || 0, otHours || 0,
       notes || null, req.user.id]
    );
    res.status(201).json({ success: true, message: 'สร้างสลิปแล้ว', data: r.rows[0] });
  } catch (err) {
    if (err.code === '23505') {
      return res.status(409).json({ success: false, message: 'มีสลิปของพนักงานคนนี้สำหรับเดือน/ปีนี้แล้ว' });
    }
    console.error('POST /payroll error:', err.message);
    res.status(500).json({ success: false, message: 'เกิดข้อผิดพลาด' });
  }
});

// PATCH /payroll/:id — HR/owner edits. Disallow edits when status='paid'.
router.patch('/payroll/:id', authenticate, authorize('hr', 'owner'), async (req, res) => {
  const {
    baseSalary, otAmount, bonus, allowances,
    socialSecurity, incomeTax, otherDeductions,
    workDays, absentDays, lateCount, otHours,
    notes, status,
  } = req.body;
  try {
    const existing = await query('SELECT status FROM payroll_records WHERE id = $1', [req.params.id]);
    if (!existing.rows[0]) return res.status(404).json({ success: false, message: 'ไม่พบสลิป' });
    if (existing.rows[0].status === 'paid' && status !== 'draft' && status !== 'approved') {
      return res.status(400).json({ success: false, message: 'สลิปที่จ่ายแล้วไม่สามารถแก้ไขได้ (เปลี่ยนสถานะกลับก่อน)' });
    }
    if (status && !['draft','approved','paid'].includes(status)) {
      return res.status(400).json({ success: false, message: 'สถานะไม่ถูกต้อง' });
    }
    await query(
      `UPDATE payroll_records SET
         base_salary       = COALESCE($1,  base_salary),
         ot_amount         = COALESCE($2,  ot_amount),
         bonus             = COALESCE($3,  bonus),
         allowances        = COALESCE($4,  allowances),
         social_security   = COALESCE($5,  social_security),
         income_tax        = COALESCE($6,  income_tax),
         other_deductions  = COALESCE($7,  other_deductions),
         work_days         = COALESCE($8,  work_days),
         absent_days       = COALESCE($9,  absent_days),
         late_count        = COALESCE($10, late_count),
         ot_hours          = COALESCE($11, ot_hours),
         notes             = COALESCE($12, notes),
         status            = COALESCE($13, status),
         paid_at           = CASE WHEN $13 = 'paid' THEN COALESCE(paid_at, NOW())
                                  WHEN $13 IS NOT NULL AND $13 <> 'paid' THEN NULL
                                  ELSE paid_at END,
         updated_at        = NOW()
       WHERE id = $14`,
      [baseSalary ?? null, otAmount ?? null, bonus ?? null, allowances ?? null,
       socialSecurity ?? null, incomeTax ?? null, otherDeductions ?? null,
       workDays ?? null, absentDays ?? null, lateCount ?? null, otHours ?? null,
       notes ?? null, status ?? null, req.params.id]
    );
    res.json({ success: true, message: 'อัปเดตสลิปแล้ว' });
  } catch (err) {
    console.error('PATCH /payroll/:id error:', err.message);
    res.status(500).json({ success: false, message: 'เกิดข้อผิดพลาด' });
  }
});

// DELETE /payroll/:id — HR/owner deletes. Only allowed when status='draft'.
router.delete('/payroll/:id', authenticate, authorize('hr', 'owner'), async (req, res) => {
  try {
    const existing = await query('SELECT status FROM payroll_records WHERE id = $1', [req.params.id]);
    if (!existing.rows[0]) return res.status(404).json({ success: false, message: 'ไม่พบสลิป' });
    if (existing.rows[0].status !== 'draft') {
      return res.status(400).json({ success: false, message: 'ลบได้เฉพาะสลิปสถานะ "ร่าง" เท่านั้น' });
    }
    await query('DELETE FROM payroll_records WHERE id = $1', [req.params.id]);
    res.json({ success: true, message: 'ลบสลิปแล้ว' });
  } catch (err) {
    console.error('DELETE /payroll/:id error:', err.message);
    res.status(500).json({ success: false, message: 'เกิดข้อผิดพลาด' });
  }
});

// POST /payroll/:id/approve — flip status from draft → approved.
router.post('/payroll/:id/approve', authenticate, authorize('hr', 'owner'),
  auditLog('payroll_approve', 'payroll_records'),
  async (req, res) => {
  try {
    const r = await query(
      `UPDATE payroll_records SET status = 'approved', updated_at = NOW()
       WHERE id = $1 AND status = 'draft' RETURNING id`,
      [req.params.id]
    );
    if (!r.rows[0]) return res.status(400).json({ success: false, message: 'อนุมัติได้เฉพาะสลิปร่าง' });
    res.json({ success: true, message: 'อนุมัติสลิปแล้ว', data: { id: r.rows[0].id } });
  } catch (err) {
    console.error('POST /payroll/:id/approve error:', err.message);
    res.status(500).json({ success: false, message: 'เกิดข้อผิดพลาด' });
  }
});

// POST /payroll/:id/mark-paid — flip status from approved → paid + stamp paid_at.
router.post('/payroll/:id/mark-paid', authenticate, authorize('hr', 'owner'),
  auditLog('payroll_mark_paid', 'payroll_records'),
  async (req, res) => {
  try {
    const r = await query(
      `UPDATE payroll_records SET status = 'paid', paid_at = NOW(), updated_at = NOW()
       WHERE id = $1 AND status = 'approved' RETURNING id`,
      [req.params.id]
    );
    if (!r.rows[0]) return res.status(400).json({ success: false, message: 'จ่ายได้เฉพาะสลิปที่อนุมัติแล้ว' });
    res.json({ success: true, message: 'ทำเครื่องหมายจ่ายแล้ว', data: { id: r.rows[0].id } });
  } catch (err) {
    console.error('POST /payroll/:id/mark-paid error:', err.message);
    res.status(500).json({ success: false, message: 'เกิดข้อผิดพลาด' });
  }
});

// POST /payroll/bulk-generate — generate draft slips for every active
// non-owner employee for a given month/year. Seeds work_days / absent_days
// / late_count from attendance_logs and ot_hours/ot_amount from approved
// ot_requests. Idempotent: skips employees who already have a slip for
// that period (so HR can re-run safely if new employees were added).
//
// Formulas (Thai labor standard, HR can override per-slip after):
//   ot_amount       = round(ot_hours × base_salary / 240 × 1.5, 2)
//   social_security = min(base_salary × 0.05, 750)
// bonus/allowances/income_tax/other_deductions all default to 0.
router.post('/payroll/bulk-generate', authenticate, authorize('hr', 'owner'),
  auditLog('payroll_bulk_generate', 'payroll_records'),
  async (req, res) => {
  const { month, year } = req.body;
  if (!month || !year) {
    return res.status(400).json({ success: false, message: 'กรุณาระบุเดือนและปี' });
  }
  const m = parseInt(month, 10);
  const y = parseInt(year, 10);
  if (m < 1 || m > 12 || y < 2000 || y > 2200) {
    return res.status(400).json({ success: false, message: 'เดือนหรือปีไม่ถูกต้อง' });
  }
  // Period bounds (inclusive). Use first/last day of the month.
  const startDate = `${y}-${String(m).padStart(2, '0')}-01`;
  const endDate = new Date(y, m, 0); // last day of month m
  const endDateStr = `${y}-${String(m).padStart(2, '0')}-${String(endDate.getDate()).padStart(2, '0')}`;

  try {
    // Pull every active non-owner employee with a base_salary.
    const empRows = await query(
      `SELECT e.id, e.base_salary
       FROM employees e
       LEFT JOIN users u ON e.user_id = u.id
       WHERE e.is_active = true
         AND (u.role IS NULL OR u.role <> 'owner')
         AND e.base_salary IS NOT NULL`
    );

    let created = 0, skipped = 0;
    for (const emp of empRows.rows) {
      // Skip if slip already exists for this period.
      const dup = await query(
        'SELECT 1 FROM payroll_records WHERE employee_id=$1 AND month=$2 AND year=$3',
        [emp.id, m, y]
      );
      if (dup.rows[0]) { skipped++; continue; }

      // Attendance buckets for the period.
      const attRows = await query(
        `SELECT
           COUNT(*) FILTER (WHERE status IN ('present','late','very_late'))::int AS work_days,
           COUNT(*) FILTER (WHERE status = 'absent')::int                       AS absent_days,
           COUNT(*) FILTER (WHERE status IN ('late','very_late'))::int          AS late_count
         FROM attendance_logs
         WHERE employee_id = $1 AND date BETWEEN $2 AND $3`,
        [emp.id, startDate, endDateStr]
      );
      const att = attRows.rows[0] || { work_days: 0, absent_days: 0, late_count: 0 };

      // Approved OT hours for the period (status='hr_approved').
      const otRows = await query(
        `SELECT COALESCE(SUM(hours),0)::numeric AS ot_hours
         FROM ot_requests
         WHERE employee_id = $1
           AND date BETWEEN $2 AND $3
           AND status = 'hr_approved'`,
        [emp.id, startDate, endDateStr]
      );
      const otHours = Number(otRows.rows[0]?.ot_hours || 0);

      const base = Number(emp.base_salary);
      const otAmount = +(otHours * (base / 240) * 1.5).toFixed(2);
      const ss = +Math.min(base * 0.05, 750).toFixed(2);

      await query(
        `INSERT INTO payroll_records (
           employee_id, month, year,
           base_salary, ot_amount, social_security,
           work_days, absent_days, late_count, ot_hours,
           created_by
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
        [emp.id, m, y,
         base, otAmount, ss,
         att.work_days, att.absent_days, att.late_count, otHours,
         req.user.id]
      );
      created++;
    }
    res.status(201).json({
      success: true,
      message: `สร้างสลิปแล้ว ${created} รายการ (ข้าม ${skipped} ที่มีอยู่แล้ว)`,
      data: { created, skipped, month: m, year: y }
    });
  } catch (err) {
    console.error('POST /payroll/bulk-generate error:', err.message);
    res.status(500).json({ success: false, message: 'เกิดข้อผิดพลาด' });
  }
});

// ====== FORGOT PASSWORD / OTP ======
const { sendOTPEmail } = require('../services/emailService')
const crypto = require('crypto')
const otpStore = new Map()

router.post('/auth/forgot-password', async (req, res) => {
  const { email } = req.body
  if (!email) return res.status(400).json({ success: false, message: 'กรุณาระบุอีเมล' })
  try {
    const result = await query(
      `SELECT u.id, u.email, u.is_active, CONCAT(e.first_name,' ',e.last_name) as full_name
       FROM users u LEFT JOIN employees e ON u.id = e.user_id WHERE u.email = $1`,
      [email.toLowerCase()])
    if (!result.rows[0] || !result.rows[0].is_active)
      return res.json({ success: true, message: 'ถ้าอีเมลนี้มีในระบบ จะได้รับ OTP ทางอีเมล' })
    const otp = Math.floor(100000 + Math.random() * 900000).toString()
    const expiresAt = Date.now() + 10 * 60 * 1000
    otpStore.set(email.toLowerCase(), { otp, userId: result.rows[0].id, expiresAt, attempts: 0 })
    await sendOTPEmail(result.rows[0].email, result.rows[0].full_name || 'ผู้ใช้งาน', otp)
    res.json({ success: true, message: 'ส่ง OTP ไปที่อีเมลแล้ว' })
  } catch (err) {
    console.error('OTP error:', err)
    res.status(500).json({ success: false, message: 'เกิดข้อผิดพลาด กรุณาลองใหม่' })
  }
})

router.post('/auth/verify-otp', async (req, res) => {
  const { email, otp } = req.body
  const stored = otpStore.get(email?.toLowerCase())
  if (!stored) return res.status(400).json({ success: false, message: 'ไม่พบคำขอ OTP กรุณาขอใหม่' })
  if (Date.now() > stored.expiresAt) { otpStore.delete(email.toLowerCase()); return res.status(400).json({ success: false, message: 'OTP หมดอายุ กรุณาขอใหม่' }) }
  stored.attempts++
  if (stored.attempts > 5) { otpStore.delete(email.toLowerCase()); return res.status(400).json({ success: false, message: 'ลองผิดหลายครั้ง กรุณาขอ OTP ใหม่' }) }
  if (stored.otp !== otp) return res.status(400).json({ success: false, message: `OTP ไม่ถูกต้อง (เหลือ ${5 - stored.attempts} ครั้ง)` })
  const resetToken = crypto.randomBytes(32).toString('hex')
  stored.resetToken = resetToken
  stored.verified = true
  res.json({ success: true, message: 'OTP ถูกต้อง', data: { resetToken } })
})

router.post('/auth/reset-password', async (req, res) => {
  const { email, resetToken, newPassword } = req.body
  if (!email || !resetToken || !newPassword) return res.status(400).json({ success: false, message: 'ข้อมูลไม่ครบ' })
  if (newPassword.length < 6) return res.status(400).json({ success: false, message: 'รหัสผ่านต้องมีอย่างน้อย 6 ตัว' })
  const stored = otpStore.get(email.toLowerCase())
  if (!stored || !stored.verified || stored.resetToken !== resetToken)
    return res.status(400).json({ success: false, message: 'Token ไม่ถูกต้อง กรุณาขอ OTP ใหม่' })
  try {
    const bcrypt = require('bcryptjs')
    const hash = await bcrypt.hash(newPassword, 12)
    await query('UPDATE users SET password_hash=$1,failed_login_count=0,locked_until=NULL WHERE id=$2', [hash, stored.userId])
    otpStore.delete(email.toLowerCase())
    res.json({ success: true, message: 'เปลี่ยนรหัสผ่านสำเร็จ' })
  } catch (err) { res.status(500).json({ success: false, message: 'เกิดข้อผิดพลาด' }) }
})
module.exports = router;
