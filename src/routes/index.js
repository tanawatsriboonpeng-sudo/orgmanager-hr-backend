const express = require('express');
const router = express.Router();
const { authenticate, authorize, auditLog } = require('../middleware/auth');
const authCtrl = require('../controllers/authController');
const attendCtrl = require('../controllers/attendanceController');
const leaveCtrl = require('../controllers/leaveController');
const retentionCtrl = require('../controllers/retentionController');
const { query, pool } = require('../../config/database');
const { notify, notifyManyByRole, userIdFromEmployee } = require('../middleware/notify');
const dayjsForNotif = require('dayjs');

// ====== AUTH ======
router.post('/auth/login', authCtrl.login);
router.post('/auth/refresh', authCtrl.refreshToken);
router.post('/auth/logout', authenticate, authCtrl.logout);
router.post('/auth/change-password', authenticate, authCtrl.changePassword);
router.get('/auth/me', authenticate, authCtrl.getMe);
// LINE Login (LIFF integration). line-login is the entry point — verifies
// the LINE access token against our channel and either issues JWTs (when
// the LINE userId is already linked) or returns a 404+code so the
// frontend can prompt for email+password to link. line-link is the
// "already logged in, want to attach LINE" path; line-unlink is the
// reverse.
router.post('/auth/line-login',  authCtrl.lineLogin);
router.post('/auth/line-link',   authenticate, authCtrl.lineLink);
router.post('/auth/line-unlink', authenticate, authCtrl.lineUnlink);

// ====== ATTENDANCE ======
// Owners do not check in. Block at the API layer so any client (web, mobile)
// gets the same answer — the frontend hides the UI separately.
const blockOwner = (req, res, next) => {
  if (req.user?.role === 'owner') {
    return res.status(403).json({ success: false, message: 'เจ้าของไม่ต้องลงทะเบียนเข้างาน' });
  }
  next();
};
// Audit-log every check-in/out so the IP/UA + timestamp are preserved
// alongside the attendance_logs row. attendance_logs is the data
// record; audit_logs answers "from where + via what device". Volume is
// manageable — ~2 rows/employee/day, retention prunes after 730 days.
router.post('/attendance/check-in',
  authenticate, blockOwner,
  auditLog('attendance_check_in', 'attendance_logs'),
  attendCtrl.checkIn);
router.post('/attendance/check-out',
  authenticate, blockOwner,
  auditLog('attendance_check_out', 'attendance_logs'),
  attendCtrl.checkOut);
router.get('/attendance/today', authenticate, attendCtrl.getToday);
router.get('/attendance/my-history', authenticate, attendCtrl.getMyHistory);
router.get('/attendance/daily-summary', authenticate, authorize('owner', 'hr'), attendCtrl.getDailySummary);
router.get('/attendance/recent-summary', authenticate, authorize('owner', 'hr'), attendCtrl.getRecentSummary);
router.get('/attendance/offsite-pending',     authenticate, authorize('owner', 'hr'), attendCtrl.getOffsitePending);
router.post('/attendance/offsite/:id/approve', authenticate, authorize('owner', 'hr'), auditLog('offsite_approve', 'attendance_logs'), attendCtrl.approveOffsite);
router.post('/attendance/offsite/:id/reject',  authenticate, authorize('owner', 'hr'), auditLog('offsite_reject',  'attendance_logs'), attendCtrl.rejectOffsite);
// Backdated check-in/check-out requests
router.post('/attendance/backdate-request',     authenticate,                            attendCtrl.createBackdateRequest);
router.get('/attendance/backdate-mine',         authenticate,                            attendCtrl.getMyBackdateRequests);
router.get('/attendance/backdate-pending',      authenticate, authorize('owner', 'hr'), attendCtrl.getBackdatePending);
router.post('/attendance/backdate/:id/approve', authenticate, authorize('owner', 'hr'), auditLog('backdate_approve', 'attendance_backdate_requests'), attendCtrl.approveBackdate);
router.post('/attendance/backdate/:id/reject',  authenticate, authorize('owner', 'hr'), auditLog('backdate_reject',  'attendance_backdate_requests'), attendCtrl.rejectBackdate);
// Manual trigger for the missing-checkout sweep. Daily-summary also
// invokes it lazily, so HR usually doesn't need to call this directly.
router.post('/attendance/sweep-missing-checkouts', authenticate, authorize('owner', 'hr'), attendCtrl.runMissingCheckoutSweep);
// HR / owner manually records check-in/check-out on someone's behalf.
// Audit-logged so we can see who fabricated which row.
router.post('/attendance/admin-record', authenticate, authorize('owner', 'hr'), auditLog('attendance_admin_record', 'attendance_logs'), attendCtrl.adminRecord);

// ====== LEAVE ======
router.get('/leave/types', authenticate, leaveCtrl.getLeaveTypes);
router.get('/leave/types-all', authenticate, authorize('hr', 'owner'), leaveCtrl.getAllLeaveTypes);
router.post('/leave/types',
  authenticate, authorize('hr', 'owner'),
  auditLog('leave_type_create', 'leave_types'),
  leaveCtrl.createLeaveType);
router.patch('/leave/types/:id',
  authenticate, authorize('hr', 'owner'),
  auditLog('leave_type_update', 'leave_types'),
  leaveCtrl.updateLeaveType);
router.delete('/leave/types/:id',
  authenticate, authorize('hr', 'owner'),
  auditLog('leave_type_delete', 'leave_types'),
  leaveCtrl.deleteLeaveType);
router.get('/leave/my-quota', authenticate, leaveCtrl.getMyQuota);
router.get('/leave/all-quotas', authenticate, authorize('hr', 'owner'), leaveCtrl.getAllQuotas);
router.put('/leave/quotas',
  authenticate, authorize('hr', 'owner'),
  auditLog('leave_quota_set', 'leave_quotas'),
  leaveCtrl.setQuota);
router.post('/leave/quotas/seed-defaults',
  authenticate, authorize('hr', 'owner'),
  auditLog('leave_quota_seed_defaults', 'leave_quotas'),
  leaveCtrl.seedDefaultQuotas);
router.get('/leave/my-history', authenticate, leaveCtrl.getMyHistory);
router.get('/leave/all-requests', authenticate, authorize('hr', 'owner'), leaveCtrl.getAllRequests);
router.post('/leave/request', authenticate, leaveCtrl.createRequest);
router.post('/leave/admin-record',
  authenticate, authorize('hr', 'owner'),
  auditLog('leave_admin_record', 'leave_requests'),
  leaveCtrl.adminCreateLeave);
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

    // Tell every approver about the new pending OT.
    const nameRow = await query(
      `SELECT CONCAT(first_name, ' ', last_name) AS n FROM employees WHERE id = $1`,
      [empResult.rows[0].id]
    );
    notifyManyByRole(['hr', 'owner'], {
      type: 'ot_request_pending',
      title: `คำขอ OT ใหม่จาก ${nameRow.rows[0]?.n || 'พนักงาน'}`,
      body: `${dayjsForNotif(date).format('D MMM')} · ${startTime}–${endTime} (${hours} ชม.)`,
      link: '/ot',
      relatedId: r.rows[0].id,
    });

    res.status(201).json({ success: true, message: 'ยื่นขอ OT แล้ว', data: r.rows[0] });
  } catch (e) { res.status(500).json({ success: false, message: 'เกิดข้อผิดพลาด' }); }
});

// Owner included as failsafe approver for companies without dedicated HR
// (mirrors the /leave approval setup).
router.patch('/ot/:id/approve', authenticate, authorize('hr', 'owner'),
  auditLog('ot_approval', 'ot_requests'),
  async (req, res) => {
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

    // Notify the employee whose request just got decided. Need to look
    // up the request meta because the SELECT above only fetched status.
    const ot = await query(
      `SELECT o.employee_id, o.date, o.start_time, o.end_time, o.hours
         FROM ot_requests o WHERE o.id = $1`,
      [req.params.id]
    );
    if (ot.rows[0]) {
      const empUserId = await userIdFromEmployee(ot.rows[0].employee_id);
      const bodyText = `${dayjsForNotif(ot.rows[0].date).format('D MMM')} · ${String(ot.rows[0].start_time).slice(0,5)}–${String(ot.rows[0].end_time).slice(0,5)} (${ot.rows[0].hours} ชม.)`;
      notify(empUserId, {
        type: action === 'approved' ? 'ot_approved' : 'ot_rejected',
        title: action === 'approved' ? 'OT ของคุณได้รับการอนุมัติ' : 'OT ของคุณถูกปฏิเสธ',
        body: rejectedReason ? `${bodyText} · "${rejectedReason}"` : bodyText,
        link: '/ot',
        relatedId: req.params.id,
      });
    }

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

// Direct reports of the calling user. Any authenticated user can hit this
// (managers in this system are just employees with subordinates pointing
// at them via employees.manager_id) — the rows are filtered server-side
// to the caller's reports, so plain employees with no subordinates get
// an empty array rather than a 403.
// Used by the /kpi page so managers (role=employee) can pick someone
// to review without needing to list the whole company.
router.get('/employees/my-subordinates', authenticate, async (req, res) => {
  try {
    // Whitelist columns — managers don't need (and shouldn't see) salary,
    // bank account, national ID, DOB, address, etc. Only fields the /kpi
    // picker actually renders are returned.
    const result = await query(
      `SELECT e.id, e.first_name, e.last_name, e.nickname, e.avatar_url,
              e.employee_id, e.position, e.position_id,
              u.email, u.role, d.name as department_name
         FROM employees e
         LEFT JOIN users u ON e.user_id = u.id
         LEFT JOIN departments d ON e.department_id = d.id
        WHERE e.is_active = true
          AND e.manager_id = (SELECT id FROM employees WHERE user_id = $1)
        ORDER BY e.first_name`,
      [req.user.id]
    );
    res.json({ success: true, data: result.rows });
  } catch (e) {
    console.error('GET /employees/my-subordinates error:', e.message);
    res.status(500).json({ success: false, message: 'เกิดข้อผิดพลาด' });
  }
});

router.get('/employees/me', authenticate, async (req, res) => {
  try {
    const result = await query(
      `SELECT e.*, u.email, u.line_user_id, d.name as department_name,
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

router.post('/positions', authenticate, authorize('hr', 'owner'),
  auditLog('position_create', 'positions'),
  async (req, res) => {
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

router.patch('/positions/:id', authenticate, authorize('hr', 'owner'),
  auditLog('position_update', 'positions'),
  async (req, res) => {
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

router.delete('/positions/:id', authenticate, authorize('hr', 'owner'),
  auditLog('position_delete', 'positions'),
  async (req, res) => {
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

router.post('/departments', authenticate, authorize('hr', 'owner'),
  auditLog('department_create', 'departments'),
  async (req, res) => {
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

router.patch('/departments/:id', authenticate, authorize('hr', 'owner'),
  auditLog('department_update', 'departments'),
  async (req, res) => {
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

router.delete('/departments/:id', authenticate, authorize('owner'),
  auditLog('department_delete', 'departments'),
  async (req, res) => {
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

router.post('/holidays', authenticate, authorize('hr', 'owner'), async (req, res) => {
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

router.delete('/holidays/:id', authenticate, authorize('hr', 'owner'), async (req, res) => {
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
    const finalTargets = targetRoles && targetRoles.length > 0
      ? targetRoles
      : ['owner','hr','employee'];
    const r = await query(
      'INSERT INTO announcements (title, content, type, target_roles, created_by) VALUES ($1,$2,$3,$4,$5) RETURNING *',
      [title, content, type || 'info', finalTargets, req.user.id]
    );

    // Fan-out a bell notification to every active user in the target
    // roles. The existing announcement_reads table tracks the "seen the
    // full text" state — this notification is the prompt that takes
    // them there.
    notifyManyByRole(finalTargets, {
      type: 'announcement',
      title: `ประกาศใหม่: ${title}`,
      body: content?.length > 80 ? content.slice(0, 80) + '…' : (content || null),
      link: '/announcements',
      relatedId: r.rows[0].id,
    });

    res.status(201).json({ success: true, data: r.rows[0] });
  } catch (e) { res.status(500).json({ success: false, message: 'เกิดข้อผิดพลาด' }); }
});

router.post('/announcements/:id/read', authenticate, async (req, res) => {
  try {
    await query(
      'INSERT INTO announcement_reads (announcement_id, user_id) VALUES ($1,$2) ON CONFLICT DO NOTHING',
      [req.params.id, req.user.id]
    );
    // Also clear the corresponding bell notification(s). When an
    // announcement is posted we fan out a notification per target user
    // with related_id = announcement.id — without this update the bell
    // badge stayed unread forever because announcement_reads and
    // notifications were tracked independently.
    await query(
      `UPDATE notifications SET read_at = NOW()
         WHERE user_id = $1 AND type = 'announcement'
           AND related_id = $2 AND read_at IS NULL`,
      [req.user.id, req.params.id]
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

router.post('/tasks', authenticate, authorize('hr', 'owner'), async (req, res) => {
  try {
    const { projectId, title, description, assigneeId, priority, dueDate, estimatedHours } = req.body;
    const r = await query(
      'INSERT INTO tasks (project_id,title,description,assignee_id,priority,due_date,estimated_hours,created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *',
      [projectId, title, description, assigneeId, priority || 'medium', dueDate, estimatedHours, req.user.id]
    );
    res.status(201).json({ success: true, data: r.rows[0] });
  } catch (e) { res.status(500).json({ success: false, message: 'เกิดข้อผิดพลาด' }); }
});

// PATCH ownership check: allow HR/owner, the task's creator, or the
// assignee (matched via employees.user_id → employees.id). Anyone else
// gets 403 — previously any authenticated user could mutate any task.
router.patch('/tasks/:id', authenticate, async (req, res) => {
  try {
    const cur = await query('SELECT assignee_id, created_by FROM tasks WHERE id = $1', [req.params.id]);
    if (!cur.rows[0]) return res.status(404).json({ success: false, message: 'ไม่พบงาน' });
    const task = cur.rows[0];

    let allowed = req.user.role === 'hr' || req.user.role === 'owner' || task.created_by === req.user.id;
    if (!allowed && task.assignee_id) {
      const me = await query('SELECT id FROM employees WHERE user_id = $1', [req.user.id]);
      if (me.rows[0] && me.rows[0].id === task.assignee_id) allowed = true;
    }
    if (!allowed) return res.status(403).json({ success: false, message: 'ไม่มีสิทธิ์แก้ไขงานนี้' });

    const { status, progress, notes } = req.body;
    const r = await query(
      'UPDATE tasks SET status = COALESCE($1,status), progress = COALESCE($2,progress), updated_at = NOW() WHERE id = $3 RETURNING *',
      [status, progress, req.params.id]
    );
    res.json({ success: true, data: r.rows[0] });
  } catch (e) { res.status(500).json({ success: false, message: 'เกิดข้อผิดพลาด' }); }
});

// ====== NOTIFICATIONS ======
// Every user gets their own personal bell. All endpoints are scoped to
// req.user.id server-side — no way to read someone else's notifications.
router.get('/notifications', authenticate, async (req, res) => {
  const limit  = Math.min(parseInt(req.query.limit,  10) || 50, 200);
  const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);
  const unread = req.query.unread === 'true';
  try {
    const where = ['user_id = $1'];
    const params = [req.user.id];
    if (unread) where.push('read_at IS NULL');
    params.push(limit); params.push(offset);
    const r = await query(
      `SELECT id, type, title, body, link, related_id, read_at, created_at
         FROM notifications
        WHERE ${where.join(' AND ')}
        ORDER BY created_at DESC
        LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params
    );
    const total = await query(
      `SELECT COUNT(*)::int AS n FROM notifications WHERE ${where.join(' AND ')}`,
      params.slice(0, params.length - 2)
    );
    res.json({ success: true, data: r.rows, meta: { total: total.rows[0]?.n || 0, limit, offset } });
  } catch (e) {
    console.error('GET /notifications error:', e.message);
    res.status(500).json({ success: false, message: 'เกิดข้อผิดพลาด' });
  }
});

// Lightweight badge endpoint — hit by the sidebar bell every ~30s, so
// it must stay cheap. The partial index on (user_id) WHERE read_at IS
// NULL keeps this O(rows-of-unread) regardless of total table size.
router.get('/notifications/unread-count', authenticate, async (req, res) => {
  try {
    const r = await query(
      `SELECT COUNT(*)::int AS n FROM notifications WHERE user_id = $1 AND read_at IS NULL`,
      [req.user.id]
    );
    res.json({ success: true, data: { count: r.rows[0]?.n || 0 } });
  } catch (e) {
    res.status(500).json({ success: false, message: 'เกิดข้อผิดพลาด' });
  }
});

router.post('/notifications/:id/read', authenticate, async (req, res) => {
  try {
    await query(
      `UPDATE notifications SET read_at = NOW()
        WHERE id = $1 AND user_id = $2 AND read_at IS NULL`,
      [req.params.id, req.user.id]
    );
    res.json({ success: true, message: 'อ่านแล้ว' });
  } catch (e) {
    res.status(500).json({ success: false, message: 'เกิดข้อผิดพลาด' });
  }
});

router.post('/notifications/mark-all-read', authenticate, async (req, res) => {
  try {
    const r = await query(
      `UPDATE notifications SET read_at = NOW()
        WHERE user_id = $1 AND read_at IS NULL`,
      [req.user.id]
    );
    res.json({ success: true, message: 'อ่านทั้งหมดแล้ว', data: { updated: r.rowCount } });
  } catch (e) {
    res.status(500).json({ success: false, message: 'เกิดข้อผิดพลาด' });
  }
});

router.delete('/notifications/:id', authenticate, async (req, res) => {
  try {
    await query(
      `DELETE FROM notifications WHERE id = $1 AND user_id = $2`,
      [req.params.id, req.user.id]
    );
    res.json({ success: true, message: 'ลบแล้ว' });
  } catch (e) {
    res.status(500).json({ success: false, message: 'เกิดข้อผิดพลาด' });
  }
});

// Cleanup helper: drop everything the user has already read. Useful for
// the "เคลียร์ที่อ่านแล้ว" button on /notifications. Doesn't touch
// unread rows so HR can't accidentally lose pending tasks.
router.post('/notifications/clear-read', authenticate, async (req, res) => {
  try {
    const r = await query(
      `DELETE FROM notifications WHERE user_id = $1 AND read_at IS NOT NULL`,
      [req.user.id]
    );
    res.json({ success: true, message: 'ลบรายการที่อ่านแล้ว', data: { deleted: r.rowCount } });
  } catch (e) {
    res.status(500).json({ success: false, message: 'เกิดข้อผิดพลาด' });
  }
});

// ====== AUDIT LOG ======
// Owner-only viewer. HR can read but typically owner cares most.
// Filters: action, resource, userId, from, to (ISO date), limit, offset.
router.get('/audit-logs', authenticate, authorize('owner', 'hr'), async (req, res) => {
  try {
    const { action, resource, userId, from, to } = req.query;
    const limit = Math.min(parseInt(req.query.limit, 10) || 100, 500);
    const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);

    const where = [];
    const params = [];
    const push = (clause, value) => { params.push(value); where.push(clause.replace('$$', `$${params.length}`)); };

    if (action)   push('al.action = $$', action);
    if (resource) push('al.resource = $$', resource);
    if (userId)   push('al.user_id = $$', userId);
    if (from)     push('al.created_at >= $$', from);
    if (to)       push('al.created_at <= $$', to);

    const whereSql = where.length ? 'WHERE ' + where.join(' AND ') : '';
    params.push(limit); const limitIdx = params.length;
    params.push(offset); const offsetIdx = params.length;

    const [rows, countRes, actionsRes] = await Promise.all([
      query(
        `SELECT al.*, u.email, u.role,
                CONCAT(e.first_name, ' ', e.last_name) AS user_name,
                e.nickname AS user_nickname, e.avatar_url AS user_avatar
         FROM audit_logs al
         LEFT JOIN users u ON al.user_id = u.id
         LEFT JOIN employees e ON u.id = e.user_id
         ${whereSql}
         ORDER BY al.created_at DESC
         LIMIT $${limitIdx} OFFSET $${offsetIdx}`,
        params
      ),
      query(`SELECT COUNT(*)::int AS n FROM audit_logs al ${whereSql}`, params.slice(0, params.length - 2)),
      // Distinct action list (small table by definition) so the UI can
      // populate the action filter dropdown without a separate endpoint.
      query(`SELECT DISTINCT action FROM audit_logs ORDER BY action`),
    ]);

    res.json({
      success: true,
      data: rows.rows,
      meta: {
        total: countRes.rows[0]?.n || 0,
        limit, offset,
        knownActions: actionsRes.rows.map(r => r.action),
      },
    });
  } catch (e) {
    console.error('GET /audit-logs error:', e.message);
    res.status(500).json({ success: false, message: 'เกิดข้อผิดพลาด' });
  }
});

// ====== HEALTH CHECK ======
router.get('/health', (req, res) => {
  res.json({ success: true, message: 'OrgManager HR API is running', version: '1.0.0', timestamp: new Date().toISOString() });
});
// ====== EMPLOYEE MANAGEMENT ======
router.post('/employees/create', authenticate, authorize('hr','owner'),
  auditLog('employee_create', 'employees'),
  async (req,res) => {
  const {firstName,lastName,email,employeeId,position,positionId,department,role,shiftType,baseSalary,password} = req.body
  if (!firstName||!lastName||!email||!employeeId||!password)
    return res.status(400).json({success:false,message:'กรุณากรอกข้อมูลให้ครบ'})
  try {
    const bcrypt = require('bcryptjs')
    const hash = await bcrypt.hash(password,12)
    const deptRes = await query('SELECT id FROM departments WHERE name=$1',[department])
    const deptId = deptRes.rows[0]?.id||null
    // positionId wins over the freeform position string — when given, we
    // overwrite the text with the canonical position name so the two
    // columns stay in sync. position-string-only path (no positionId) is
    // still supported for legacy callers.
    let finalPositionId = null
    let finalPosition = position || null
    if (positionId) {
      const pRes = await query('SELECT name FROM positions WHERE id=$1', [positionId])
      if (!pRes.rows[0]) return res.status(400).json({success:false, message:'ตำแหน่งที่เลือกไม่พบ'})
      finalPositionId = positionId
      finalPosition = pRes.rows[0].name
    }
    const uRes = await query('INSERT INTO users(employee_id,email,password_hash,role) VALUES($1,$2,$3,$4) RETURNING id',[employeeId,email.toLowerCase(),hash,role||'employee'])
    const empRes = await query('INSERT INTO employees(user_id,employee_id,first_name,last_name,department_id,position,position_id,shift_type,base_salary,start_date) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,CURRENT_DATE) RETURNING id',[uRes.rows[0].id,employeeId,firstName,lastName,deptId,finalPosition,finalPositionId,shiftType||'normal',baseSalary||0])
    // Auto-seed leave quotas for the new hire's current calendar year so
    // they show up on /leave's team-quota table immediately — without
    // this HR has to remember to seed manually every time. Skip the
    // owner role (owner has no quota row anywhere else in the system).
    if ((role || 'employee') !== 'owner') {
      await query(
        `INSERT INTO leave_quotas (employee_id, leave_type_id, year, total_days, used_days)
         SELECT $1, lt.id, EXTRACT(YEAR FROM CURRENT_DATE)::int, lt.days_per_year, 0
           FROM leave_types lt
          WHERE lt.is_active = true
         ON CONFLICT (employee_id, leave_type_id, year) DO NOTHING`,
        [empRes.rows[0].id]
      ).catch(err => console.error('[leave] auto-seed quotas for new employee failed:', err.message))
    }
    res.status(201).json({success:true,message:`สร้างบัญชี ${firstName} ${lastName} สำเร็จ`})
  } catch(err) {
    if(err.code==='23505') return res.status(400).json({success:false,message:'อีเมลหรือรหัสพนักงานซ้ำในระบบ'})
    res.status(500).json({success:false,message:'เกิดข้อผิดพลาด'})
  }
})

router.patch('/employees/:id', authenticate, authorize('hr','owner'),
  auditLog('employee_update', 'employees'),
  async (req,res) => {
  const {
    firstName, lastName, nickname, phone,
    position, positionId, department, shiftType, baseSalary, role,
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

    // positionId update runs as a separate statement because the legacy
    // PATCH uses COALESCE for every field (so null = "leave alone"), but
    // we need positionId to be settable to null when the user clears
    // their position. Whenever positionId is explicitly present in the
    // body we re-write both position_id and the legacy position text so
    // they stay in sync.
    if (positionId !== undefined) {
      if (positionId === null || positionId === '') {
        await query(
          'UPDATE employees SET position_id = NULL, position = NULL, updated_at = NOW() WHERE id = $1',
          [req.params.id]
        )
      } else {
        const pRes = await query('SELECT name FROM positions WHERE id = $1', [positionId])
        if (!pRes.rows[0]) {
          return res.status(400).json({ success: false, message: 'ตำแหน่งที่เลือกไม่พบ' })
        }
        await query(
          'UPDATE employees SET position_id = $1, position = $2, updated_at = NOW() WHERE id = $3',
          [positionId, pRes.rows[0].name, req.params.id]
        )
      }
    }

    // Role change is owner-only. Guard against (a) the calling owner
    // demoting themselves and (b) demoting the last active owner — either
    // would leave the system in an unrecoverable state.
    if (role && req.user.role === 'owner') {
      const e = await query(
        'SELECT e.user_id, u.role AS current_role FROM employees e LEFT JOIN users u ON e.user_id = u.id WHERE e.id=$1',
        [req.params.id]
      )
      const row = e.rows[0]
      if (row && row.current_role !== role) {
        if (row.user_id === req.user.id) {
          return res.status(400).json({ success: false, message: 'เปลี่ยน role ของตัวเองไม่ได้' })
        }
        if (row.current_role === 'owner' && role !== 'owner') {
          const c = await query("SELECT COUNT(*)::int AS n FROM users WHERE role='owner' AND is_active=true")
          if ((c.rows[0]?.n || 0) <= 1) {
            return res.status(400).json({ success: false, message: 'ระบบต้องมี owner อย่างน้อย 1 คน' })
          }
        }
        await query('UPDATE users SET role=$1 WHERE id=$2', [role, row.user_id])
      }
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

router.patch('/employees/:id/toggle-active', authenticate, authorize('owner'),
  auditLog('employee_toggle_active', 'employees'),
  async (req,res) => {
  try {
    const e = await query('SELECT e.user_id, e.is_active, u.role AS target_role FROM employees e LEFT JOIN users u ON e.user_id = u.id WHERE e.id=$1',[req.params.id])
    if(!e.rows[0]) return res.status(404).json({success:false,message:'ไม่พบพนักงาน'})
    const target = e.rows[0]
    const active = !target.is_active

    // Guard 1: owner cannot suspend their own account (would lock self out)
    if (target.user_id === req.user.id) {
      return res.status(400).json({ success: false, message: 'ระงับบัญชีตัวเองไม่ได้' })
    }
    // Guard 2: never leave the system without an active owner
    if (!active && target.target_role === 'owner') {
      const c = await query("SELECT COUNT(*)::int AS n FROM users WHERE role='owner' AND is_active=true")
      if ((c.rows[0]?.n || 0) <= 1) {
        return res.status(400).json({ success: false, message: 'ระบบต้องมี owner อย่างน้อย 1 คน' })
      }
    }

    await query('UPDATE employees SET is_active=$1 WHERE id=$2',[active,req.params.id])
    await query('UPDATE users SET is_active=$1 WHERE id=$2',[active,target.user_id])

    // Tell the affected user. When disabling they'll get this in the
    // bell on their next login attempt (assuming they ever come back);
    // when re-enabling it's reassuring confirmation.
    notify(target.user_id, {
      type: active ? 'account_enabled' : 'account_disabled',
      title: active ? 'บัญชีของคุณถูกเปิดใช้งานอีกครั้ง' : 'บัญชีของคุณถูกระงับ',
      body: active ? null : 'หากต้องการสอบถาม กรุณาติดต่อ HR หรือเจ้าของบริษัท',
      link: active ? '/dashboard' : null,
    });

    res.json({success:true,message:active?'เปิดใช้งานแล้ว':'ระงับบัญชีแล้ว'})
  } catch(err){res.status(500).json({success:false,message:'เกิดข้อผิดพลาด'})}
})

router.patch('/employees/:id/reset-password', authenticate, authorize('hr','owner'),
  auditLog('employee_password_reset', 'users'),
  async (req,res) => {
  const {newPassword} = req.body
  if(!newPassword||newPassword.length<6)
    return res.status(400).json({success:false,message:'รหัสผ่านต้องมีอย่างน้อย 6 ตัว'})
  try {
    const bcrypt = require('bcryptjs')
    const e = await query('SELECT user_id FROM employees WHERE id=$1',[req.params.id])
    if(!e.rows[0]) return res.status(404).json({success:false,message:'ไม่พบพนักงาน'})
    const hash = await bcrypt.hash(newPassword,12)
    await query('UPDATE users SET password_hash=$1,failed_login_count=0,locked_until=NULL WHERE id=$2',[hash,e.rows[0].user_id])

    // Security-sensitive event — the employee should always know their
    // password was changed externally so they can spot misuse.
    notify(e.rows[0].user_id, {
      type: 'password_reset',
      title: 'รหัสผ่านของคุณถูกรีเซ็ต',
      body: 'รหัสผ่านใหม่ถูกตั้งโดยผู้ดูแลระบบ หากไม่ใช่คุณกรุณาติดต่อ HR ทันที',
      link: '/settings/change-password',
    });

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

router.patch('/org-settings', authenticate, authorize('owner'),
  auditLog('org_settings_update', 'org_settings'),
  async (req, res) => {
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

// ====== DATA RETENTION ======
// Read by HR/owner (HR can see policy too so they know what to expect);
// only owner can mutate. Manual purge is owner-only — it's a destructive
// op (binary blobs gone for good) so we keep the trigger surface tight.
router.get('/admin/retention',
  authenticate, authorize('hr', 'owner'),
  retentionCtrl.getRetention);
router.patch('/admin/retention',
  authenticate, authorize('owner'),
  auditLog('retention_policy_update', 'org_settings'),
  retentionCtrl.updateRetention);
router.post('/admin/purge-old-data',
  authenticate, authorize('owner'),
  auditLog('manual_purge', 'org_settings'),
  retentionCtrl.purgeNow);

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
// Numeric validation for payroll inputs. Each rule says "if the field is
// present it must be a finite number, ≥0, and ≤ max". Numeric typos like
// 100000000000 baht or accidental negative deductions used to flow
// straight into the DB and produce garbage net_salary (a Postgres
// GENERATED column) with no way for HR to notice until a slip went out.
const PAYROLL_NUMERIC_RULES = {
  baseSalary:       { max: 100_000_000, label: 'เงินเดือนพื้นฐาน' },
  otAmount:         { max:  10_000_000, label: 'ค่า OT' },
  bonus:            { max:  50_000_000, label: 'โบนัส' },
  allowances:       { max:  10_000_000, label: 'ค่าตอบแทนอื่น' },
  socialSecurity:   { max:     750,     label: 'ประกันสังคม' },
  incomeTax:        { max:  50_000_000, label: 'ภาษีหัก ณ ที่จ่าย' },
  otherDeductions:  { max:  10_000_000, label: 'รายการหักอื่น' },
  workDays:         { max:      31,     label: 'วันทำงาน' },
  absentDays:       { max:      31,     label: 'วันขาด' },
  lateCount:        { max:     200,     label: 'จำนวนสาย' },
  otHours:          { max:     500,     label: 'ชั่วโมง OT' },
};
function validatePayrollNumbers(body) {
  for (const [field, rule] of Object.entries(PAYROLL_NUMERIC_RULES)) {
    const v = body[field];
    if (v === undefined || v === null || v === '') continue;
    const n = Number(v);
    if (!Number.isFinite(n)) return `${rule.label} ต้องเป็นตัวเลข`;
    if (n < 0)               return `${rule.label} ต้องไม่ติดลบ`;
    if (n > rule.max)        return `${rule.label} เกินค่าที่อนุญาต (สูงสุด ${rule.max.toLocaleString()})`;
  }
  return null;
}

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
  const numErr = validatePayrollNumbers(req.body);
  if (numErr) return res.status(400).json({ success: false, message: numErr });
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
  const numErr = validatePayrollNumbers(req.body);
  if (numErr) return res.status(400).json({ success: false, message: numErr });
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

// Tiny helper to look up payslip metadata once and notify the employee
// — used by both approve and mark-paid which differ only in the title.
async function notifyPayrollChange(payrollId, type, title) {
  try {
    const r = await query(
      `SELECT employee_id, month, year, net_salary FROM payroll_records WHERE id = $1`,
      [payrollId]
    );
    const row = r.rows[0];
    if (!row) return;
    const empUserId = await userIdFromEmployee(row.employee_id);
    const monthName = ['', 'ม.ค.','ก.พ.','มี.ค.','เม.ย.','พ.ค.','มิ.ย.','ก.ค.','ส.ค.','ก.ย.','ต.ค.','พ.ย.','ธ.ค.'][row.month] || '';
    const net = Number(row.net_salary || 0).toLocaleString('th-TH', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    notify(empUserId, {
      type,
      title,
      body: `เดือน ${monthName} ${row.year + 543} · สุทธิ ฿${net}`,
      link: '/payroll',
      relatedId: payrollId,
    });
  } catch (err) {
    console.error(`[notify] payroll ${type} lookup failed:`, err.message);
  }
}

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
    notifyPayrollChange(r.rows[0].id, 'payroll_approved', 'สลิปเงินเดือนของคุณได้รับการอนุมัติ');
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
    notifyPayrollChange(r.rows[0].id, 'payroll_paid', 'เงินเดือนของคุณจ่ายแล้ว');
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
    // Previously this did 4 queries per employee (eligibility, dup-check,
    // attendance, OT, then INSERT) — 4N round trips for N people. On
    // Render free tier with N=30+ this routinely cost 3-5 seconds. Now
    // the whole thing is one INSERT … SELECT with CTEs: eligible roster,
    // attendance buckets per employee, approved OT sum per employee, and
    // a final aggregation that computes ot_amount and social_security in
    // SQL. ON CONFLICT DO NOTHING on the (employee_id, month, year)
    // unique handles the dup case in one shot — we count "skipped" as
    // eligible-minus-inserted.
    const totalRes = await query(
      `SELECT COUNT(*)::int AS n
         FROM employees e
         LEFT JOIN users u ON e.user_id = u.id
        WHERE e.is_active = true
          AND (u.role IS NULL OR u.role <> 'owner')
          AND e.base_salary IS NOT NULL`
    );
    const eligible = totalRes.rows[0]?.n || 0;

    const ins = await query(
      `WITH eligible AS (
         SELECT e.id AS employee_id, e.base_salary
           FROM employees e
           LEFT JOIN users u ON e.user_id = u.id
          WHERE e.is_active = true
            AND (u.role IS NULL OR u.role <> 'owner')
            AND e.base_salary IS NOT NULL
       ),
       att AS (
         SELECT employee_id,
                COUNT(*) FILTER (WHERE status IN ('present','late','very_late'))::int AS work_days,
                COUNT(*) FILTER (WHERE status = 'absent')::int                       AS absent_days,
                COUNT(*) FILTER (WHERE status IN ('late','very_late'))::int          AS late_count
           FROM attendance_logs
          WHERE date BETWEEN $1 AND $2
          GROUP BY employee_id
       ),
       ot AS (
         SELECT employee_id, COALESCE(SUM(hours),0)::numeric AS ot_hours
           FROM ot_requests
          WHERE date BETWEEN $1 AND $2
            AND status = 'hr_approved'
          GROUP BY employee_id
       )
       INSERT INTO payroll_records (
         employee_id, month, year,
         base_salary, ot_amount, social_security,
         work_days, absent_days, late_count, ot_hours,
         created_by
       )
       SELECT
         e.employee_id, $3::int, $4::int,
         e.base_salary,
         ROUND(COALESCE(ot.ot_hours,0) * (e.base_salary / 240.0) * 1.5, 2)  AS ot_amount,
         LEAST(ROUND(e.base_salary * 0.05, 2), 750.00)                       AS social_security,
         COALESCE(att.work_days,   0),
         COALESCE(att.absent_days, 0),
         COALESCE(att.late_count,  0),
         COALESCE(ot.ot_hours,     0),
         $5
         FROM eligible e
         LEFT JOIN att ON att.employee_id = e.employee_id
         LEFT JOIN ot  ON ot.employee_id  = e.employee_id
       ON CONFLICT (employee_id, month, year) DO NOTHING
       RETURNING id`,
      [startDate, endDateStr, m, y, req.user.id]
    );
    const created = ins.rowCount;
    const skipped = Math.max(0, eligible - created);

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

// ====== KPI ======
// Two tables back this:
//   kpi_criteria — rubric items (name, weight, optional department scope).
//                  Weight is relative; computeOverall() divides by the sum
//                  of weights actually used so absolute scale doesn't matter.
//   kpi_reviews  — one row per (employee, quarter, year). scores is JSONB:
//                  [ { criterionId, score:1-5, note? } ]. overall_score is
//                  0-100, computed server-side as weighted_avg(score) × 20.
// Status flow: draft (reviewer drafting) → submitted (locked, visible to
// subject) → approved (HR endorsed). Employees only see submitted/approved
// reviews of themselves — drafts stay private to the reviewer.

// "Am I this employee's manager?" Map req.user.id (users.id) → employees.id
// then check that against target.manager_id.
async function isManagerOf(reqUserId, targetEmployeeId) {
  const r = await query(
    `SELECT 1 FROM employees target
       JOIN employees mgr ON target.manager_id = mgr.id
       WHERE target.id = $1 AND mgr.user_id = $2`,
    [targetEmployeeId, reqUserId]
  );
  return r.rowCount > 0;
}

function computeOverall(scores, weightById) {
  let weightedSum = 0;
  let weightTotal = 0;
  for (const s of scores) {
    const w = Number(weightById[s.criterionId] ?? 0);
    if (!w) continue;
    weightedSum += w * Number(s.score);
    weightTotal += w;
  }
  if (!weightTotal) return 0;
  // 1-5 weighted average × 20 → 0-100, rounded to 2dp.
  return Math.round((weightedSum / weightTotal) * 20 * 100) / 100;
}

// ----- Criteria -----

// GET /kpi/criteria — list. Anyone authenticated. By default only active
// criteria are returned (used by the review editor); HR/owner can pass
// ?includeInactive=1 to also see soft-deleted rows for management.
router.get('/kpi/criteria', authenticate, async (req, res) => {
  try {
    const includeInactive = req.query.includeInactive === '1'
      && (req.user.role === 'hr' || req.user.role === 'owner');
    const r = await query(
      `SELECT c.id, c.name, c.description, c.weight, c.department_id,
              c.is_active, c.created_at, d.name AS department_name
         FROM kpi_criteria c
         LEFT JOIN departments d ON c.department_id = d.id
         ${includeInactive ? '' : 'WHERE c.is_active = true'}
         ORDER BY c.is_active DESC, c.created_at ASC`
    );
    res.json({ success: true, data: r.rows });
  } catch (e) {
    console.error('GET /kpi/criteria error:', e.message);
    res.status(500).json({ success: false, message: 'เกิดข้อผิดพลาด' });
  }
});

router.post('/kpi/criteria', authenticate, authorize('hr', 'owner'), async (req, res) => {
  const { name, description, weight, departmentId } = req.body;
  if (!name || !name.trim()) {
    return res.status(400).json({ success: false, message: 'กรุณาระบุชื่อเกณฑ์' });
  }
  const w = weight === undefined || weight === null || weight === '' ? 100 : Number(weight);
  if (!Number.isFinite(w) || w <= 0) {
    return res.status(400).json({ success: false, message: 'น้ำหนักต้องเป็นตัวเลขมากกว่า 0' });
  }
  try {
    const r = await query(
      `INSERT INTO kpi_criteria (name, description, weight, department_id)
         VALUES ($1, $2, $3, $4) RETURNING *`,
      [name.trim(), description || null, w, departmentId || null]
    );
    res.status(201).json({ success: true, message: 'เพิ่มเกณฑ์แล้ว', data: r.rows[0] });
  } catch (err) {
    console.error('POST /kpi/criteria error:', err.message);
    res.status(500).json({ success: false, message: 'เกิดข้อผิดพลาด' });
  }
});

router.patch('/kpi/criteria/:id', authenticate, authorize('hr', 'owner'), async (req, res) => {
  const { name, description, weight, departmentId, isActive } = req.body;
  if (weight !== undefined && weight !== null) {
    const w = Number(weight);
    if (!Number.isFinite(w) || w <= 0) {
      return res.status(400).json({ success: false, message: 'น้ำหนักต้องเป็นตัวเลขมากกว่า 0' });
    }
  }
  try {
    const r = await query(
      `UPDATE kpi_criteria SET
         name          = COALESCE($1, name),
         description   = COALESCE($2, description),
         weight        = COALESCE($3, weight),
         department_id = CASE WHEN $4::text = '__clear__' THEN NULL
                              WHEN $4 IS NULL THEN department_id
                              ELSE $4::uuid END,
         is_active     = COALESCE($5, is_active)
       WHERE id = $6 RETURNING *`,
      [
        name?.trim() || null,
        description ?? null,
        weight ?? null,
        departmentId === null ? '__clear__' : (departmentId ?? null),
        isActive ?? null,
        req.params.id,
      ]
    );
    if (!r.rows[0]) return res.status(404).json({ success: false, message: 'ไม่พบเกณฑ์' });
    res.json({ success: true, message: 'อัปเดตเกณฑ์แล้ว', data: r.rows[0] });
  } catch (err) {
    console.error('PATCH /kpi/criteria/:id error:', err.message);
    res.status(500).json({ success: false, message: 'เกิดข้อผิดพลาด' });
  }
});

// DELETE /kpi/criteria/:id — hard delete only if no review references it;
// otherwise soft-delete (is_active=false) so historical reviews still
// show the criterion name. Soft-deleted criteria are hidden from the
// review editor but visible to HR via ?includeInactive=1.
router.delete('/kpi/criteria/:id', authenticate, authorize('hr', 'owner'), async (req, res) => {
  try {
    const usage = await query(
      `SELECT 1 FROM kpi_reviews
        WHERE scores @> $1::jsonb LIMIT 1`,
      [JSON.stringify([{ criterionId: req.params.id }])]
    );
    if (usage.rowCount > 0) {
      await query(`UPDATE kpi_criteria SET is_active = false WHERE id = $1`, [req.params.id]);
      return res.json({ success: true, message: 'ปิดใช้งานเกณฑ์แล้ว (มีการประเมินอ้างอิงอยู่)' });
    }
    const r = await query(`DELETE FROM kpi_criteria WHERE id = $1 RETURNING id`, [req.params.id]);
    if (!r.rows[0]) return res.status(404).json({ success: false, message: 'ไม่พบเกณฑ์' });
    res.json({ success: true, message: 'ลบเกณฑ์แล้ว' });
  } catch (err) {
    console.error('DELETE /kpi/criteria/:id error:', err.message);
    res.status(500).json({ success: false, message: 'เกิดข้อผิดพลาด' });
  }
});

// ----- Reviews -----

// GET /kpi/reviews — visibility:
//   hr/owner: every row
//   employee with subordinates: rows where they are the reviewer OR the
//                               subject's manager — plus their own
//                               submitted/approved reviews
//   plain employee: own submitted/approved only (drafts stay private to
//                   the reviewer until submit).
// Filters: employeeId, quarter, year, status.
router.get('/kpi/reviews', authenticate, async (req, res) => {
  const { employeeId, quarter, year, status } = req.query;
  try {
    const where = [];
    const params = [];
    const push = (clause, value) => { params.push(value); where.push(clause.replace('$$', `$${params.length}`)); };

    const isHR = req.user.role === 'hr' || req.user.role === 'owner';
    if (!isHR) {
      const r = await query('SELECT id FROM employees WHERE user_id = $1', [req.user.id]);
      const selfEmpId = r.rows[0]?.id || null;
      if (!selfEmpId) return res.json({ success: true, data: [] });
      // Self sees: their own submitted/approved + anything where they're
      // the reviewer + subordinates' reviews (any status).
      params.push(selfEmpId, req.user.id, selfEmpId);
      const a = params.length - 2, b = params.length - 1, c = params.length;
      where.push(
        `((r.employee_id = $${a} AND r.status IN ('submitted','approved'))
           OR r.reviewer_id = $${b}
           OR e.manager_id = $${c})`
      );
    }
    if (employeeId) push('r.employee_id = $$', employeeId);
    if (quarter)    push('r.quarter = $$',     parseInt(quarter, 10));
    if (year)       push('r.year = $$',        parseInt(year, 10));
    if (status)     push('r.status = $$',      status);

    const sql = `
      SELECT r.*,
             e.first_name, e.last_name, e.nickname, e.avatar_url,
             e.employee_id AS emp_code, e.position,
             d.name AS department_name,
             ru.email AS reviewer_email,
             re.first_name AS reviewer_first_name,
             re.last_name  AS reviewer_last_name,
             re.nickname   AS reviewer_nickname,
             re.avatar_url AS reviewer_avatar_url
        FROM kpi_reviews r
        JOIN employees e ON r.employee_id = e.id
        LEFT JOIN departments d ON e.department_id = d.id
        LEFT JOIN users ru     ON r.reviewer_id = ru.id
        LEFT JOIN employees re ON re.user_id   = ru.id
        ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
       ORDER BY r.year DESC, r.quarter DESC, r.created_at DESC`;
    const r = await query(sql, params);
    res.json({ success: true, data: r.rows });
  } catch (e) {
    console.error('GET /kpi/reviews error:', e.message);
    res.status(500).json({ success: false, message: 'เกิดข้อผิดพลาด' });
  }
});

// GET /kpi/reviews/:id — same visibility rules as list. Joins criteria
// names onto each score entry so the UI can render without a second fetch
// (works for soft-deleted criteria too — they stay readable in history).
router.get('/kpi/reviews/:id', authenticate, async (req, res) => {
  try {
    const r = await query(
      `SELECT r.*,
              e.first_name, e.last_name, e.nickname, e.avatar_url,
              e.employee_id AS emp_code, e.position, e.manager_id,
              d.name AS department_name,
              ru.email AS reviewer_email,
              re.first_name AS reviewer_first_name,
              re.last_name  AS reviewer_last_name,
              re.nickname   AS reviewer_nickname,
              re.avatar_url AS reviewer_avatar_url
         FROM kpi_reviews r
         JOIN employees e ON r.employee_id = e.id
         LEFT JOIN departments d ON e.department_id = d.id
         LEFT JOIN users ru     ON r.reviewer_id = ru.id
         LEFT JOIN employees re ON re.user_id   = ru.id
        WHERE r.id = $1`,
      [req.params.id]
    );
    const row = r.rows[0];
    if (!row) return res.status(404).json({ success: false, message: 'ไม่พบการประเมิน' });

    const isHR = req.user.role === 'hr' || req.user.role === 'owner';
    if (!isHR) {
      const selfEmp = await query('SELECT id FROM employees WHERE user_id = $1', [req.user.id]);
      const selfEmpId = selfEmp.rows[0]?.id || null;
      const isReviewer = row.reviewer_id === req.user.id;
      const isSubject = row.employee_id === selfEmpId;
      const isMgr = row.manager_id === selfEmpId;
      if (!isReviewer && !isMgr && !(isSubject && (row.status === 'submitted' || row.status === 'approved'))) {
        return res.status(403).json({ success: false, message: 'ไม่มีสิทธิ์ดูการประเมินนี้' });
      }
    }

    // Enrich score entries with criterion name/weight for display.
    const ids = (row.scores || []).map(s => s.criterionId).filter(Boolean);
    if (ids.length) {
      const cr = await query(
        `SELECT id, name, weight, is_active FROM kpi_criteria WHERE id = ANY($1::uuid[])`,
        [ids]
      );
      const byId = Object.fromEntries(cr.rows.map(c => [c.id, c]));
      row.scores = row.scores.map(s => ({
        ...s,
        criterion_name: byId[s.criterionId]?.name || '(เกณฑ์ถูกลบ)',
        criterion_weight: byId[s.criterionId]?.weight ?? null,
        criterion_active: byId[s.criterionId]?.is_active ?? false,
      }));
    }
    res.json({ success: true, data: row });
  } catch (e) {
    console.error('GET /kpi/reviews/:id error:', e.message);
    res.status(500).json({ success: false, message: 'เกิดข้อผิดพลาด' });
  }
});

// POST /kpi/reviews — reviewer must be the subject's manager (or HR/owner
// override). Body: { employeeId, quarter, year, scores:[{criterionId,score,note?}], comments? }
router.post('/kpi/reviews', authenticate, async (req, res) => {
  const { employeeId, quarter, year, scores, comments } = req.body;
  if (!employeeId || !quarter || !year) {
    return res.status(400).json({ success: false, message: 'ข้อมูลไม่ครบ (employeeId, quarter, year จำเป็น)' });
  }
  const q = parseInt(quarter, 10), y = parseInt(year, 10);
  if (![1, 2, 3, 4].includes(q)) return res.status(400).json({ success: false, message: 'quarter ต้องเป็น 1-4' });
  if (!Number.isFinite(y) || y < 2000 || y > 2100) return res.status(400).json({ success: false, message: 'year ไม่ถูกต้อง' });

  const isHR = req.user.role === 'hr' || req.user.role === 'owner';
  if (!isHR && !(await isManagerOf(req.user.id, employeeId))) {
    return res.status(403).json({ success: false, message: 'เฉพาะหัวหน้าของพนักงานคนนี้เท่านั้นที่ประเมินได้' });
  }

  const cleanScores = Array.isArray(scores) ? scores : [];
  for (const s of cleanScores) {
    const sc = Number(s?.score);
    if (!s?.criterionId || !Number.isFinite(sc) || sc < 1 || sc > 5) {
      return res.status(400).json({ success: false, message: 'คะแนนต้องเป็น 1-5 และต้องระบุเกณฑ์' });
    }
  }
  try {
    let overall = 0;
    if (cleanScores.length) {
      const cr = await query(
        `SELECT id, weight FROM kpi_criteria WHERE id = ANY($1::uuid[])`,
        [cleanScores.map(s => s.criterionId)]
      );
      const weightById = Object.fromEntries(cr.rows.map(r => [r.id, r.weight]));
      overall = computeOverall(cleanScores, weightById);
    }
    const r = await query(
      `INSERT INTO kpi_reviews (employee_id, reviewer_id, quarter, year, scores, overall_score, comments)
         VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7) RETURNING *`,
      [employeeId, req.user.id, q, y, JSON.stringify(cleanScores), overall, comments || null]
    );
    res.status(201).json({ success: true, message: 'สร้างการประเมินแล้ว', data: r.rows[0] });
  } catch (err) {
    if (err.code === '23505') {
      return res.status(409).json({ success: false, message: 'มีการประเมินของพนักงานคนนี้สำหรับไตรมาส/ปีนี้แล้ว' });
    }
    console.error('POST /kpi/reviews error:', err.message);
    res.status(500).json({ success: false, message: 'เกิดข้อผิดพลาด' });
  }
});

// PATCH /kpi/reviews/:id — reviewer (while draft) or hr/owner (any time
// before paid-equivalent — here we just allow hr/owner to edit any status).
// Body: { scores?, comments?, status? } — status updates beyond draft go
// through the dedicated /submit and /approve endpoints to keep the flow
// explicit, but we accept "draft" here to reopen a submitted review.
router.patch('/kpi/reviews/:id', authenticate, async (req, res) => {
  const { scores, comments, status } = req.body;
  try {
    const existing = await query(
      `SELECT id, employee_id, reviewer_id, status FROM kpi_reviews WHERE id = $1`,
      [req.params.id]
    );
    const row = existing.rows[0];
    if (!row) return res.status(404).json({ success: false, message: 'ไม่พบการประเมิน' });

    const isHR = req.user.role === 'hr' || req.user.role === 'owner';
    const isReviewer = row.reviewer_id === req.user.id;
    if (!isHR && !isReviewer) {
      return res.status(403).json({ success: false, message: 'ไม่มีสิทธิ์แก้ไข' });
    }
    if (!isHR && row.status !== 'draft') {
      return res.status(400).json({ success: false, message: 'แก้ไขได้เฉพาะการประเมินที่เป็น "ร่าง"' });
    }
    if (status && !['draft','submitted','approved'].includes(status)) {
      return res.status(400).json({ success: false, message: 'สถานะไม่ถูกต้อง' });
    }
    // Only hr/owner can move to/from submitted/approved via this endpoint —
    // reviewers should use /submit instead. Allow reviewer to keep status as draft.
    if (status && status !== 'draft' && !isHR) {
      return res.status(403).json({ success: false, message: 'ใช้ปุ่ม "ส่งการประเมิน" หรือ "อนุมัติ" แทน' });
    }

    let cleanScores = null;
    let overall = null;
    if (Array.isArray(scores)) {
      for (const s of scores) {
        const sc = Number(s?.score);
        if (!s?.criterionId || !Number.isFinite(sc) || sc < 1 || sc > 5) {
          return res.status(400).json({ success: false, message: 'คะแนนต้องเป็น 1-5 และต้องระบุเกณฑ์' });
        }
      }
      cleanScores = scores;
      const cr = await query(
        `SELECT id, weight FROM kpi_criteria WHERE id = ANY($1::uuid[])`,
        [cleanScores.map(s => s.criterionId)]
      );
      const weightById = Object.fromEntries(cr.rows.map(r => [r.id, r.weight]));
      overall = computeOverall(cleanScores, weightById);
    }

    await query(
      `UPDATE kpi_reviews SET
         scores        = COALESCE($1::jsonb, scores),
         overall_score = COALESCE($2, overall_score),
         comments      = COALESCE($3, comments),
         status        = COALESCE($4, status),
         updated_at    = NOW()
       WHERE id = $5`,
      [
        cleanScores ? JSON.stringify(cleanScores) : null,
        overall,
        comments ?? null,
        status ?? null,
        req.params.id,
      ]
    );
    res.json({ success: true, message: 'อัปเดตการประเมินแล้ว' });
  } catch (err) {
    console.error('PATCH /kpi/reviews/:id error:', err.message);
    res.status(500).json({ success: false, message: 'เกิดข้อผิดพลาด' });
  }
});

// POST /kpi/reviews/:id/submit — reviewer locks in their draft. From here
// the subject can see it.
router.post('/kpi/reviews/:id/submit', authenticate, async (req, res) => {
  try {
    const existing = await query(
      `SELECT reviewer_id, status FROM kpi_reviews WHERE id = $1`,
      [req.params.id]
    );
    const row = existing.rows[0];
    if (!row) return res.status(404).json({ success: false, message: 'ไม่พบการประเมิน' });
    const isHR = req.user.role === 'hr' || req.user.role === 'owner';
    if (!isHR && row.reviewer_id !== req.user.id) {
      return res.status(403).json({ success: false, message: 'เฉพาะผู้ประเมินเท่านั้นที่ส่งการประเมินได้' });
    }
    if (row.status !== 'draft') {
      return res.status(400).json({ success: false, message: 'ส่งได้เฉพาะการประเมินที่เป็น "ร่าง"' });
    }
    await query(`UPDATE kpi_reviews SET status='submitted', updated_at=NOW() WHERE id=$1`, [req.params.id]);
    res.json({ success: true, message: 'ส่งการประเมินแล้ว' });
  } catch (err) {
    console.error('POST /kpi/reviews/:id/submit error:', err.message);
    res.status(500).json({ success: false, message: 'เกิดข้อผิดพลาด' });
  }
});

router.post('/kpi/reviews/:id/approve', authenticate, authorize('hr', 'owner'),
  auditLog('kpi_approve', 'kpi_reviews'),
  async (req, res) => {
  try {
    const r = await query(
      `UPDATE kpi_reviews SET status='approved', updated_at=NOW()
         WHERE id=$1 AND status='submitted' RETURNING id`,
      [req.params.id]
    );
    if (!r.rows[0]) return res.status(400).json({ success: false, message: 'อนุมัติได้เฉพาะการประเมินที่ส่งแล้ว' });
    res.json({ success: true, message: 'อนุมัติการประเมินแล้ว' });
  } catch (err) {
    console.error('POST /kpi/reviews/:id/approve error:', err.message);
    res.status(500).json({ success: false, message: 'เกิดข้อผิดพลาด' });
  }
});

router.delete('/kpi/reviews/:id', authenticate, authorize('hr', 'owner'), async (req, res) => {
  try {
    const existing = await query(`SELECT status FROM kpi_reviews WHERE id = $1`, [req.params.id]);
    if (!existing.rows[0]) return res.status(404).json({ success: false, message: 'ไม่พบการประเมิน' });
    if (existing.rows[0].status !== 'draft') {
      return res.status(400).json({ success: false, message: 'ลบได้เฉพาะการประเมินที่เป็น "ร่าง"' });
    }
    await query(`DELETE FROM kpi_reviews WHERE id = $1`, [req.params.id]);
    res.json({ success: true, message: 'ลบการประเมินแล้ว' });
  } catch (err) {
    console.error('DELETE /kpi/reviews/:id error:', err.message);
    res.status(500).json({ success: false, message: 'เกิดข้อผิดพลาด' });
  }
});

// ====== FORGOT PASSWORD / OTP ======
//
// DB-backed (was in-memory Map) for three reasons:
//   1. Map is lost on every Render redeploy / cold-boot
//   2. multi-instance deployments would only honor OTPs on the
//      instance that issued them
//   3. no audit trail / no protection if an attacker peeks the row
//
// Stored hashes (sha256) instead of plaintext OTP/token so a DB leak
// doesn't immediately surrender live one-time secrets. Used + verified
// timestamps mean we can detect replay; retention sweep prunes the
// table after 7 days.
const { sendOTPEmail } = require('../services/emailService')
const crypto = require('crypto')
const bcryptPwd = require('bcryptjs')

const OTP_TTL_MS = 10 * 60 * 1000          // 10 minutes
const OTP_MAX_ATTEMPTS = 5
const PWD_MIN_LENGTH = 8                    // matches /auth/change-password
const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest('hex')

router.post('/auth/forgot-password', async (req, res) => {
  const { email } = req.body
  if (typeof email !== 'string' || !email.trim()) {
    return res.status(400).json({ success: false, message: 'กรุณาระบุอีเมล' })
  }
  const emailLc = email.toLowerCase().trim()
  try {
    const result = await query(
      `SELECT u.id, u.email, u.is_active, CONCAT(e.first_name,' ',e.last_name) as full_name
       FROM users u LEFT JOIN employees e ON u.id = e.user_id WHERE u.email = $1`,
      [emailLc])
    // Same response either way — never reveal whether the email exists.
    const okMsg = { success: true, message: 'ถ้าอีเมลนี้มีในระบบ จะได้รับ OTP ทางอีเมล' }
    if (!result.rows[0] || !result.rows[0].is_active) return res.json(okMsg)

    // crypto.randomInt is uniform and unpredictable; Math.random isn't.
    // 6-digit zero-padded so codes like 042371 don't collapse to 5 digits.
    const otp = String(crypto.randomInt(0, 1_000_000)).padStart(6, '0')
    const otpHash = sha256(otp)
    const expiresAt = new Date(Date.now() + OTP_TTL_MS)

    // Invalidate previous pending OTPs for this email so an attacker
    // can't brute-force across multiple requests in parallel.
    await query(
      `UPDATE password_reset_tokens
          SET used_at = NOW()
        WHERE email = $1 AND used_at IS NULL`,
      [emailLc]
    )
    await query(
      `INSERT INTO password_reset_tokens
         (user_id, email, otp_hash, expires_at, ip_address)
       VALUES ($1, $2, $3, $4, $5)`,
      [result.rows[0].id, emailLc, otpHash, expiresAt, req.ip || null]
    )

    await sendOTPEmail(result.rows[0].email, result.rows[0].full_name || 'ผู้ใช้งาน', otp)
    res.json(okMsg)
  } catch (err) {
    console.error('forgot-password error:', err.message)
    res.status(500).json({ success: false, message: 'เกิดข้อผิดพลาด กรุณาลองใหม่' })
  }
})

router.post('/auth/verify-otp', async (req, res) => {
  const { email, otp } = req.body
  if (typeof email !== 'string' || typeof otp !== 'string') {
    return res.status(400).json({ success: false, message: 'ข้อมูลไม่ครบ' })
  }
  const emailLc = email.toLowerCase().trim()
  try {
    // Pick the most recent unused OTP for this email; even if forgot-
    // password was hammered, we invalidated the older ones above.
    const r = await query(
      `SELECT id, otp_hash, attempts, expires_at, used_at
         FROM password_reset_tokens
        WHERE email = $1 AND used_at IS NULL
        ORDER BY created_at DESC
        LIMIT 1`,
      [emailLc]
    )
    const row = r.rows[0]
    if (!row) {
      return res.status(400).json({ success: false, message: 'ไม่พบคำขอ OTP กรุณาขอใหม่' })
    }
    if (new Date(row.expires_at) < new Date()) {
      await query(`UPDATE password_reset_tokens SET used_at = NOW() WHERE id = $1`, [row.id])
      return res.status(400).json({ success: false, message: 'OTP หมดอายุ กรุณาขอใหม่' })
    }
    if (row.attempts >= OTP_MAX_ATTEMPTS) {
      await query(`UPDATE password_reset_tokens SET used_at = NOW() WHERE id = $1`, [row.id])
      return res.status(400).json({ success: false, message: 'ลองผิดหลายครั้ง กรุณาขอ OTP ใหม่' })
    }
    // Compare hashes constant-time so an attacker can't time-attack the
    // OTP digit-by-digit. Both buffers are equal length (sha256 hex = 64).
    const incomingHash = Buffer.from(sha256(otp), 'hex')
    const storedHash   = Buffer.from(row.otp_hash, 'hex')
    const matches = incomingHash.length === storedHash.length
      && crypto.timingSafeEqual(incomingHash, storedHash)
    if (!matches) {
      const r2 = await query(
        `UPDATE password_reset_tokens SET attempts = attempts + 1 WHERE id = $1 RETURNING attempts`,
        [row.id]
      )
      const left = Math.max(0, OTP_MAX_ATTEMPTS - r2.rows[0].attempts)
      return res.status(400).json({ success: false, message: `OTP ไม่ถูกต้อง (เหลือ ${left} ครั้ง)` })
    }

    // Issue the second-stage reset token. Stored hashed too — the client
    // gets the plaintext token only here, in this single response.
    const resetToken = crypto.randomBytes(32).toString('hex')
    await query(
      `UPDATE password_reset_tokens
          SET reset_token_hash = $1, verified_at = NOW()
        WHERE id = $2`,
      [sha256(resetToken), row.id]
    )
    res.json({ success: true, message: 'OTP ถูกต้อง', data: { resetToken } })
  } catch (err) {
    console.error('verify-otp error:', err.message)
    res.status(500).json({ success: false, message: 'เกิดข้อผิดพลาด' })
  }
})

router.post('/auth/reset-password', async (req, res) => {
  const { email, resetToken, newPassword } = req.body
  if (typeof email !== 'string' || typeof resetToken !== 'string' || typeof newPassword !== 'string') {
    return res.status(400).json({ success: false, message: 'ข้อมูลไม่ครบ' })
  }
  // Same minimum as /auth/change-password — was 6, which gave a way
  // to bypass the 8-char policy via the reset flow.
  if (newPassword.length < PWD_MIN_LENGTH) {
    return res.status(400).json({ success: false, message: `รหัสผ่านต้องมีอย่างน้อย ${PWD_MIN_LENGTH} ตัวอักษร` })
  }
  const emailLc = email.toLowerCase().trim()
  try {
    const r = await query(
      `SELECT id, user_id, reset_token_hash, expires_at, used_at, verified_at
         FROM password_reset_tokens
        WHERE email = $1
          AND used_at IS NULL
          AND verified_at IS NOT NULL
        ORDER BY created_at DESC
        LIMIT 1`,
      [emailLc]
    )
    const row = r.rows[0]
    if (!row) {
      return res.status(400).json({ success: false, message: 'Token ไม่ถูกต้อง กรุณาขอ OTP ใหม่' })
    }
    if (new Date(row.expires_at) < new Date()) {
      return res.status(400).json({ success: false, message: 'Token หมดอายุ กรุณาขอ OTP ใหม่' })
    }
    const incomingHash = Buffer.from(sha256(resetToken), 'hex')
    const storedHash   = Buffer.from(row.reset_token_hash || '', 'hex')
    const matches = storedHash.length > 0
      && incomingHash.length === storedHash.length
      && crypto.timingSafeEqual(incomingHash, storedHash)
    if (!matches) {
      return res.status(400).json({ success: false, message: 'Token ไม่ถูกต้อง กรุณาขอ OTP ใหม่' })
    }

    // Re-check the user is still active — between forgot-password and
    // reset-password, HR/owner could have suspended the account. The
    // previous Map-based version skipped this check entirely.
    const userRow = await query('SELECT is_active FROM users WHERE id = $1', [row.user_id])
    if (!userRow.rows[0] || !userRow.rows[0].is_active) {
      return res.status(403).json({ success: false, message: 'บัญชีถูกระงับ — ติดต่อ HR' })
    }

    const hash = await bcryptPwd.hash(newPassword, 12)
    // Mark the token used INSIDE the same statement set, so a parallel
    // attempt to reuse the same resetToken finds used_at NOT NULL and
    // is rejected by the SELECT above.
    await query(
      `UPDATE users SET password_hash = $1, failed_login_count = 0, locked_until = NULL WHERE id = $2`,
      [hash, row.user_id]
    )
    await query(`UPDATE password_reset_tokens SET used_at = NOW() WHERE id = $1`, [row.id])
    // Existing sessions should be invalidated when the password changes —
    // a recovered account's old refresh tokens become dead weight.
    await query(`DELETE FROM refresh_tokens WHERE user_id = $1`, [row.user_id])
    res.json({ success: true, message: 'เปลี่ยนรหัสผ่านสำเร็จ' })
  } catch (err) {
    console.error('reset-password error:', err.message)
    res.status(500).json({ success: false, message: 'เกิดข้อผิดพลาด' })
  }
})
// ====== CLEANING ROSTER ======
// Shared-responsibility rota. Everyone sees today's list; only the
// inspector for the day fills in "who did what" + per-item notes; HR or
// owner closes the loop with approve/reject. Inspector queue advances
// by one position every time HR approves a session.

// Helper: today's date in Asia/Bangkok as 'YYYY-MM-DD'. We do all
// scheduling in local civil time so a session created at 11pm UTC still
// counts as "tomorrow's" cleaning in Thailand.
function bangkokDateISO(d = new Date()) {
  // Bangkok is UTC+7, no DST. Shift by 7h and slice.
  const shifted = new Date(d.getTime() + 7 * 60 * 60 * 1000);
  return shifted.toISOString().slice(0, 10);
}

// ---- Items (master list) ----
router.get('/cleaning/items', authenticate, async (req, res) => {
  try {
    const includeInactive = req.query.includeInactive === '1' || req.query.includeInactive === 'true';
    const r = await query(
      `SELECT id, name, description, display_order, is_active, created_at
         FROM cleaning_items
        ${includeInactive ? '' : 'WHERE is_active = true'}
        ORDER BY display_order, name`
    );
    res.json({ success: true, data: r.rows });
  } catch (e) {
    console.error('GET /cleaning/items error:', e.message);
    res.status(500).json({ success: false, message: 'เกิดข้อผิดพลาด' });
  }
});

router.post('/cleaning/items', authenticate, authorize('hr', 'owner'),
  auditLog('cleaning_item_create', 'cleaning_items'),
  async (req, res) => {
  const { name, description, displayOrder } = req.body;
  if (!name || !String(name).trim()) {
    return res.status(400).json({ success: false, message: 'กรุณาระบุชื่องาน' });
  }
  try {
    const r = await query(
      `INSERT INTO cleaning_items (name, description, display_order)
       VALUES ($1, $2, $3) RETURNING *`,
      [String(name).trim(), description || null, Number.isFinite(+displayOrder) ? +displayOrder : 0]
    );
    res.status(201).json({ success: true, data: r.rows[0] });
  } catch (e) {
    console.error('POST /cleaning/items error:', e.message);
    res.status(500).json({ success: false, message: 'เกิดข้อผิดพลาด' });
  }
});

router.patch('/cleaning/items/:id', authenticate, authorize('hr', 'owner'),
  auditLog('cleaning_item_update', 'cleaning_items'),
  async (req, res) => {
  const { name, description, displayOrder, isActive } = req.body;
  try {
    await query(
      `UPDATE cleaning_items SET
         name          = COALESCE($1, name),
         description   = COALESCE($2, description),
         display_order = COALESCE($3, display_order),
         is_active     = COALESCE($4, is_active),
         updated_at    = NOW()
       WHERE id = $5`,
      [name ?? null, description ?? null,
       displayOrder ?? null, typeof isActive === 'boolean' ? isActive : null,
       req.params.id]
    );
    res.json({ success: true, message: 'อัปเดตแล้ว' });
  } catch (e) {
    console.error('PATCH /cleaning/items/:id error:', e.message);
    res.status(500).json({ success: false, message: 'เกิดข้อผิดพลาด' });
  }
});

router.delete('/cleaning/items/:id', authenticate, authorize('hr', 'owner'),
  auditLog('cleaning_item_delete', 'cleaning_items'),
  async (req, res) => {
  try {
    await query('DELETE FROM cleaning_items WHERE id = $1', [req.params.id]);
    res.json({ success: true, message: 'ลบแล้ว' });
  } catch (e) {
    console.error('DELETE /cleaning/items/:id error:', e.message);
    res.status(500).json({ success: false, message: 'เกิดข้อผิดพลาด' });
  }
});

// ---- Settings (singleton) ----
router.get('/cleaning/settings', authenticate, async (req, res) => {
  try {
    const r = await query('SELECT * FROM cleaning_settings WHERE id = 1');
    res.json({ success: true, data: r.rows[0] || null });
  } catch (e) {
    console.error('GET /cleaning/settings error:', e.message);
    res.status(500).json({ success: false, message: 'เกิดข้อผิดพลาด' });
  }
});

router.patch('/cleaning/settings', authenticate, authorize('hr', 'owner'),
  auditLog('cleaning_settings_update', 'cleaning_settings'),
  async (req, res) => {
  const { weekdays, startTime, endTime, isActive } = req.body;
  // Validate weekdays array: every element must be 0..6.
  let validWeekdays = null;
  if (Array.isArray(weekdays)) {
    if (!weekdays.every(d => Number.isInteger(d) && d >= 0 && d <= 6)) {
      return res.status(400).json({ success: false, message: 'วันในสัปดาห์ต้องอยู่ในช่วง 0-6' });
    }
    validWeekdays = [...new Set(weekdays)].sort();
  }
  try {
    await query(
      `UPDATE cleaning_settings SET
         weekdays   = COALESCE($1, weekdays),
         start_time = COALESCE($2, start_time),
         end_time   = COALESCE($3, end_time),
         is_active  = COALESCE($4, is_active),
         updated_at = NOW()
       WHERE id = 1`,
      [validWeekdays, startTime ?? null, endTime ?? null,
       typeof isActive === 'boolean' ? isActive : null]
    );
    res.json({ success: true, message: 'บันทึกแล้ว' });
  } catch (e) {
    console.error('PATCH /cleaning/settings error:', e.message);
    res.status(500).json({ success: false, message: 'เกิดข้อผิดพลาด' });
  }
});

// ---- Inspector queue ----
// GET returns the queue in position order with employee info joined,
// plus the pointer so the UI can mark "next up".
router.get('/cleaning/inspector-queue', authenticate, async (req, res) => {
  try {
    const r = await query(
      `SELECT q.id, q.employee_id, q.position, q.is_active,
              e.first_name, e.last_name, e.nickname, e.avatar_url, e.employee_id AS emp_code,
              e.is_active AS employee_active
         FROM cleaning_inspector_queue q
         LEFT JOIN employees e ON q.employee_id = e.id
        ORDER BY q.position`
    );
    const p = await query('SELECT next_position FROM cleaning_queue_pointer WHERE id = 1');
    res.json({ success: true, data: { queue: r.rows, nextPosition: p.rows[0]?.next_position || 0 } });
  } catch (e) {
    console.error('GET /cleaning/inspector-queue error:', e.message);
    res.status(500).json({ success: false, message: 'เกิดข้อผิดพลาด' });
  }
});

// Bulk replace: accepts { employeeIds: [...] } and rewrites the queue in
// that order. Simpler than per-row CRUD for what is essentially an
// ordered list managed in one screen.
router.put('/cleaning/inspector-queue', authenticate, authorize('hr', 'owner'),
  auditLog('cleaning_queue_replace', 'cleaning_inspector_queue'),
  async (req, res) => {
  const { employeeIds } = req.body;
  if (!Array.isArray(employeeIds)) {
    return res.status(400).json({ success: false, message: 'รูปแบบข้อมูลไม่ถูกต้อง' });
  }
  const unique = [...new Set(employeeIds.filter(Boolean))];
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('DELETE FROM cleaning_inspector_queue');
    for (let i = 0; i < unique.length; i++) {
      await client.query(
        `INSERT INTO cleaning_inspector_queue (employee_id, position) VALUES ($1, $2)`,
        [unique[i], i]
      );
    }
    // Clamp pointer if the queue shrunk below the previous pointer.
    await client.query(
      `UPDATE cleaning_queue_pointer
          SET next_position = CASE WHEN $1 = 0 THEN 0 ELSE LEAST(next_position, $1 - 1) END,
              updated_at = NOW()
        WHERE id = 1`,
      [unique.length]
    );
    await client.query('COMMIT');
    res.json({ success: true, message: 'บันทึกคิวแล้ว', data: { count: unique.length } });
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('PUT /cleaning/inspector-queue error:', e.message);
    res.status(500).json({ success: false, message: 'เกิดข้อผิดพลาด' });
  } finally { client.release(); }
});

// ---- Sessions ----
// Helper: pick the next eligible inspector from the queue. Returns the
// employees.id (or null if no eligible person). "Eligible" = queue row
// active AND the underlying employee still active AND not the owner —
// company policy is that the owner does not participate in the cleaning
// rota (mirrors the same exclusion on /attendance, /ot, /leave). We
// honor the pointer but skip over inactive entries so the queue degrades
// gracefully.
async function pickNextInspector(client) {
  const q = await (client || { query }).query(
    `SELECT q.position, q.employee_id
       FROM cleaning_inspector_queue q
       JOIN employees e ON q.employee_id = e.id
       LEFT JOIN users u ON e.user_id = u.id
      WHERE q.is_active = true
        AND e.is_active = true
        AND (u.role IS NULL OR u.role <> 'owner')
      ORDER BY q.position`
  );
  if (q.rows.length === 0) return { employeeId: null, position: 0 };
  const ptrRes = await (client || { query }).query(
    'SELECT next_position FROM cleaning_queue_pointer WHERE id = 1'
  );
  const ptr = ptrRes.rows[0]?.next_position || 0;
  // Find the first row at or after pointer, wrapping to start.
  const idx = q.rows.findIndex(r => r.position >= ptr);
  const chosen = idx >= 0 ? q.rows[idx] : q.rows[0];
  return { employeeId: chosen.employee_id, position: chosen.position };
}

// GET /cleaning/today — lazy-create today's session if the schedule says
// so and one doesn't exist. Returns the session (or null if today isn't
// a scheduled day / settings disabled / no items). Anyone authenticated.
router.get('/cleaning/today', authenticate, async (req, res) => {
  try {
    const today = bangkokDateISO();
    const dow = new Date(today + 'T00:00:00').getDay(); // 0..6
    const settingsRes = await query('SELECT * FROM cleaning_settings WHERE id = 1');
    const s = settingsRes.rows[0];
    if (!s || !s.is_active || !Array.isArray(s.weekdays) || !s.weekdays.includes(dow)) {
      // Not a cleaning day — still return any existing session for today
      // so UI can show a re-opened/in-flight rejection from a prior call.
      const existing = await query('SELECT id FROM cleaning_sessions WHERE session_date = $1', [today]);
      if (!existing.rows[0]) return res.json({ success: true, data: null });
    }

    let session = (await query(
      'SELECT * FROM cleaning_sessions WHERE session_date = $1', [today]
    )).rows[0];

    if (!session) {
      // Lazy-create. Snapshot active items + assign inspector from queue.
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const items = await client.query(
          `SELECT id, name, display_order FROM cleaning_items
            WHERE is_active = true ORDER BY display_order, name`
        );
        if (items.rows.length === 0) {
          await client.query('ROLLBACK');
          return res.json({ success: true, data: null, message: 'ยังไม่มีรายการงานทำความสะอาด' });
        }
        const { employeeId: inspectorId } = await pickNextInspector(client);
        const ins = await client.query(
          `INSERT INTO cleaning_sessions (session_date, start_time, end_time, inspector_id)
           VALUES ($1, $2, $3, $4)
           ON CONFLICT (session_date) DO NOTHING
           RETURNING *`,
          [today, s.start_time, s.end_time, inspectorId]
        );
        session = ins.rows[0];
        if (!session) {
          // Race: another request created it. Just fetch.
          session = (await client.query(
            'SELECT * FROM cleaning_sessions WHERE session_date = $1', [today]
          )).rows[0];
        } else {
          // First creator: insert snapshot rows.
          for (const it of items.rows) {
            await client.query(
              `INSERT INTO cleaning_session_items
                 (session_id, item_id, item_name, display_order)
               VALUES ($1, $2, $3, $4)`,
              [session.id, it.id, it.name, it.display_order]
            );
          }
          // Broadcast to everyone active.
          const allUsers = await client.query(
            `SELECT id FROM users WHERE is_active = true`
          );
          const inspectorEmp = inspectorId
            ? await client.query(
                `SELECT CONCAT(first_name, ' ', last_name) AS name FROM employees WHERE id = $1`,
                [inspectorId]
              )
            : { rows: [] };
          await client.query('COMMIT');
          const inspectorName = inspectorEmp.rows[0]?.name || 'ยังไม่กำหนด';
          const timeRange = `${s.start_time.slice(0,5)}-${s.end_time.slice(0,5)}`;
          for (const u of allUsers.rows) {
            notify(u.id, {
              type: 'cleaning_session_new',
              title: 'ตารางทำความสะอาดวันนี้',
              body: `${timeRange} · ผู้ตรวจ: ${inspectorName}`,
              link: '/cleaning',
              relatedId: session.id,
            });
          }
        }
      } catch (txErr) {
        await client.query('ROLLBACK').catch(() => {});
        throw txErr;
      } finally { client.release(); }
    }

    // Return full detail (matches GET /sessions/:id shape).
    const full = await loadSessionDetail(session.id);
    res.json({ success: true, data: full });
  } catch (e) {
    console.error('GET /cleaning/today error:', e.message);
    res.status(500).json({ success: false, message: 'เกิดข้อผิดพลาด' });
  }
});

async function loadSessionDetail(sessionId) {
  const s = await query(
    `SELECT s.*,
            insp.first_name AS inspector_first_name,
            insp.last_name  AS inspector_last_name,
            insp.nickname   AS inspector_nickname,
            insp.avatar_url AS inspector_avatar_url,
            approver_emp.first_name AS approver_first_name,
            approver_emp.last_name  AS approver_last_name
       FROM cleaning_sessions s
       LEFT JOIN employees insp ON s.inspector_id = insp.id
       LEFT JOIN users approver_u ON s.approved_by = approver_u.id
       LEFT JOIN employees approver_emp ON approver_emp.user_id = approver_u.id
      WHERE s.id = $1`,
    [sessionId]
  );
  if (!s.rows[0]) return null;
  const items = await query(
    `SELECT i.id, i.item_id, i.item_name, i.display_order,
            i.done_by_employee_id, i.inspector_note, i.not_done,
            de.first_name AS done_by_first_name,
            de.last_name  AS done_by_last_name,
            de.nickname   AS done_by_nickname,
            de.avatar_url AS done_by_avatar_url
       FROM cleaning_session_items i
       LEFT JOIN employees de ON i.done_by_employee_id = de.id
      WHERE i.session_id = $1
      ORDER BY i.display_order, i.item_name`,
    [sessionId]
  );
  return { ...s.rows[0], items: items.rows };
}

router.get('/cleaning/sessions', authenticate, async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit, 10) || 50, 200);
    const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);
    const r = await query(
      `SELECT s.id, s.session_date, s.start_time, s.end_time, s.status,
              s.inspector_id, s.approved_at,
              insp.first_name AS inspector_first_name,
              insp.last_name  AS inspector_last_name,
              insp.nickname   AS inspector_nickname,
              insp.avatar_url AS inspector_avatar_url,
              (SELECT COUNT(*) FROM cleaning_session_items WHERE session_id = s.id)::int AS item_count,
              (SELECT COUNT(*) FROM cleaning_session_items
                WHERE session_id = s.id
                  AND (done_by_employee_id IS NOT NULL OR not_done = true))::int AS filled_count
         FROM cleaning_sessions s
         LEFT JOIN employees insp ON s.inspector_id = insp.id
        ORDER BY s.session_date DESC
        LIMIT $1 OFFSET $2`,
      [limit, offset]
    );
    res.json({ success: true, data: r.rows });
  } catch (e) {
    console.error('GET /cleaning/sessions error:', e.message);
    res.status(500).json({ success: false, message: 'เกิดข้อผิดพลาด' });
  }
});

router.get('/cleaning/sessions/:id', authenticate, async (req, res) => {
  try {
    const full = await loadSessionDetail(req.params.id);
    if (!full) return res.status(404).json({ success: false, message: 'ไม่พบรอบ' });
    res.json({ success: true, data: full });
  } catch (e) {
    console.error('GET /cleaning/sessions/:id error:', e.message);
    res.status(500).json({ success: false, message: 'เกิดข้อผิดพลาด' });
  }
});

// HR/owner can swap the inspector mid-session (e.g. assigned person is
// on leave). Doesn't affect queue rotation — pointer still advances at
// approve time so the original person comes back around naturally.
router.patch('/cleaning/sessions/:id/inspector', authenticate, authorize('hr', 'owner'),
  auditLog('cleaning_inspector_reassign', 'cleaning_sessions'),
  async (req, res) => {
  const { employeeId } = req.body;
  if (!employeeId) return res.status(400).json({ success: false, message: 'กรุณาระบุพนักงาน' });
  try {
    const s = await query('SELECT status FROM cleaning_sessions WHERE id = $1', [req.params.id]);
    if (!s.rows[0]) return res.status(404).json({ success: false, message: 'ไม่พบรอบ' });
    if (s.rows[0].status === 'approved') {
      return res.status(400).json({ success: false, message: 'รอบที่อนุมัติแล้วเปลี่ยนผู้ตรวจไม่ได้' });
    }
    await query(
      'UPDATE cleaning_sessions SET inspector_id = $1, updated_at = NOW() WHERE id = $2',
      [employeeId, req.params.id]
    );
    const empUser = await userIdFromEmployee(employeeId);
    notify(empUser, {
      type: 'cleaning_inspector_assigned',
      title: 'คุณได้รับมอบหมายเป็นผู้ตรวจรอบทำความสะอาด',
      body: 'กรุณาตรวจและกรอกชื่อคนทำเมื่อเสร็จ',
      link: `/cleaning?session=${req.params.id}`,
      relatedId: req.params.id,
    });
    res.json({ success: true, message: 'เปลี่ยนผู้ตรวจแล้ว' });
  } catch (e) {
    console.error('PATCH /cleaning/sessions/:id/inspector error:', e.message);
    res.status(500).json({ success: false, message: 'เกิดข้อผิดพลาด' });
  }
});

// Inspector submits the day's report: per-item "who did it" + optional
// note, plus an overall comment. Only the assigned inspector can call
// this; HR/owner cannot (they have their own approve/reject step).
router.post('/cleaning/sessions/:id/inspect', authenticate,
  auditLog('cleaning_inspect', 'cleaning_sessions'),
  async (req, res) => {
  const { items, notes } = req.body;
  if (!Array.isArray(items)) {
    return res.status(400).json({ success: false, message: 'รูปแบบข้อมูลไม่ถูกต้อง' });
  }
  try {
    const s = await query('SELECT * FROM cleaning_sessions WHERE id = $1', [req.params.id]);
    if (!s.rows[0]) return res.status(404).json({ success: false, message: 'ไม่พบรอบ' });
    const session = s.rows[0];
    if (!['open', 'rejected', 'inspector_reviewed'].includes(session.status)) {
      return res.status(400).json({ success: false, message: 'สถานะรอบไม่อนุญาตให้แก้ไข' });
    }
    // Authorize: only the assigned inspector. Map req.user.id → employees.id.
    const me = await query('SELECT id FROM employees WHERE user_id = $1', [req.user.id]);
    const myEmpId = me.rows[0]?.id;
    if (!myEmpId || myEmpId !== session.inspector_id) {
      return res.status(403).json({ success: false, message: 'เฉพาะผู้ตรวจของรอบนี้เท่านั้น' });
    }
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      for (const it of items) {
        if (!it || !it.itemId) continue;
        // notDone is mutually exclusive with doneByEmployeeId — force
        // the assignee to null when the row is marked skipped so the
        // two columns never disagree.
        const notDone = !!it.notDone;
        const doneBy = notDone ? null : (it.doneByEmployeeId || null);
        await client.query(
          `UPDATE cleaning_session_items
              SET done_by_employee_id = $1,
                  inspector_note = $2,
                  not_done = $3
            WHERE id = $4 AND session_id = $5`,
          [doneBy, it.note || null, notDone, it.itemId, req.params.id]
        );
      }
      await client.query(
        `UPDATE cleaning_sessions
            SET status = 'inspector_reviewed',
                inspector_notes = $1,
                inspector_completed_at = NOW(),
                updated_at = NOW()
          WHERE id = $2`,
        [notes || null, req.params.id]
      );
      await client.query('COMMIT');
    } catch (txErr) {
      await client.query('ROLLBACK').catch(() => {});
      throw txErr;
    } finally { client.release(); }

    notifyManyByRole(['hr', 'owner'], {
      type: 'cleaning_review_pending',
      title: 'ผู้ตรวจรายงานรอบทำความสะอาดแล้ว',
      body: `วันที่ ${session.session_date} รอ HR/เจ้าของอนุมัติ`,
      link: `/cleaning?session=${req.params.id}`,
      relatedId: req.params.id,
    });
    res.json({ success: true, message: 'ส่งรายงานแล้ว รอ HR/เจ้าของอนุมัติ' });
  } catch (e) {
    console.error('POST /cleaning/sessions/:id/inspect error:', e.message);
    res.status(500).json({ success: false, message: 'เกิดข้อผิดพลาด' });
  }
});

router.post('/cleaning/sessions/:id/approve', authenticate, authorize('hr', 'owner'),
  auditLog('cleaning_approve', 'cleaning_sessions'),
  async (req, res) => {
  const { hrNotes } = req.body;
  try {
    const s = await query('SELECT * FROM cleaning_sessions WHERE id = $1', [req.params.id]);
    if (!s.rows[0]) return res.status(404).json({ success: false, message: 'ไม่พบรอบ' });
    const session = s.rows[0];
    if (session.status !== 'inspector_reviewed') {
      return res.status(400).json({ success: false, message: 'รอบนี้ยังไม่ได้รับการตรวจจากผู้ตรวจ' });
    }
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `UPDATE cleaning_sessions
            SET status = 'approved',
                approved_by = $1, approved_at = NOW(),
                hr_notes = $2, updated_at = NOW()
          WHERE id = $3`,
        [req.user.id, hrNotes || null, req.params.id]
      );
      // Advance the queue pointer modulo *eligible* queue length —
      // owner-rows are excluded from the rotation (same filter as
      // pickNextInspector). Without this, having an owner accidentally
      // left in the queue would skew the modulus and stall rotation.
      const qLen = await client.query(
        `SELECT COUNT(*)::int AS n FROM cleaning_inspector_queue q
           JOIN employees e ON q.employee_id = e.id
           LEFT JOIN users u ON e.user_id = u.id
          WHERE q.is_active = true
            AND e.is_active = true
            AND (u.role IS NULL OR u.role <> 'owner')`
      );
      const len = qLen.rows[0]?.n || 0;
      if (len > 0) {
        await client.query(
          `UPDATE cleaning_queue_pointer
              SET next_position = ((next_position + 1) % $1),
                  updated_at = NOW()
            WHERE id = 1`,
          [len]
        );
      }
      await client.query('COMMIT');
    } catch (txErr) {
      await client.query('ROLLBACK').catch(() => {});
      throw txErr;
    } finally { client.release(); }

    if (session.inspector_id) {
      const inspectorUser = await userIdFromEmployee(session.inspector_id);
      notify(inspectorUser, {
        type: 'cleaning_approved',
        title: 'รอบทำความสะอาดได้รับอนุมัติ',
        body: `วันที่ ${session.session_date}${hrNotes ? ' · ' + hrNotes : ''}`,
        link: `/cleaning?session=${req.params.id}`,
        relatedId: req.params.id,
      });
    }
    res.json({ success: true, message: 'อนุมัติแล้ว' });
  } catch (e) {
    console.error('POST /cleaning/sessions/:id/approve error:', e.message);
    res.status(500).json({ success: false, message: 'เกิดข้อผิดพลาด' });
  }
});

router.post('/cleaning/sessions/:id/reject', authenticate, authorize('hr', 'owner'),
  auditLog('cleaning_reject', 'cleaning_sessions'),
  async (req, res) => {
  const { hrNotes } = req.body;
  try {
    const s = await query('SELECT * FROM cleaning_sessions WHERE id = $1', [req.params.id]);
    if (!s.rows[0]) return res.status(404).json({ success: false, message: 'ไม่พบรอบ' });
    const session = s.rows[0];
    if (session.status !== 'inspector_reviewed') {
      return res.status(400).json({ success: false, message: 'รอบนี้ยังไม่ได้รับการตรวจจากผู้ตรวจ' });
    }
    await query(
      `UPDATE cleaning_sessions
          SET status = 'rejected',
              hr_notes = $1, updated_at = NOW()
        WHERE id = $2`,
      [hrNotes || null, req.params.id]
    );
    if (session.inspector_id) {
      const inspectorUser = await userIdFromEmployee(session.inspector_id);
      notify(inspectorUser, {
        type: 'cleaning_rejected',
        title: 'รอบทำความสะอาดถูกตีกลับ',
        body: hrNotes ? `เหตุผล: ${hrNotes}` : 'กรุณาแก้ไขและส่งใหม่',
        link: `/cleaning?session=${req.params.id}`,
        relatedId: req.params.id,
      });
    }
    res.json({ success: true, message: 'ตีกลับแล้ว' });
  } catch (e) {
    console.error('POST /cleaning/sessions/:id/reject error:', e.message);
    res.status(500).json({ success: false, message: 'เกิดข้อผิดพลาด' });
  }
});

// ====== OFFICE LOCATIONS ======
// Owner-managed list of allowed GPS check-in spots. Anyone authenticated
// can read (the attendance UI may want to show which spots are valid);
// only the owner can mutate. Backend attendance check-in iterates this
// list and allows the entry if any active location matches its own
// radius. Falls back to env vars when the table is empty so a fresh
// install still works.
router.get('/office-locations', authenticate, async (req, res) => {
  try {
    const r = await query(
      `SELECT id, name, lat::float AS lat, lng::float AS lng,
              radius_meters, is_active, created_at, updated_at
         FROM office_locations
        ORDER BY is_active DESC, name`
    );
    res.json({ success: true, data: r.rows });
  } catch (e) {
    console.error('GET /office-locations error:', e.message);
    res.status(500).json({ success: false, message: 'เกิดข้อผิดพลาด' });
  }
});

function validateLocPayload(body) {
  const name = String(body.name || '').trim();
  const lat = Number(body.lat);
  const lng = Number(body.lng);
  const radius = Math.round(Number(body.radiusMeters));
  if (!name)                                   return 'กรุณาระบุชื่อสถานที่';
  if (name.length > 100)                       return 'ชื่อสถานที่ยาวเกินไป (สูงสุด 100 ตัว)';
  if (!Number.isFinite(lat) || lat < -90 || lat > 90)        return 'พิกัด latitude ไม่ถูกต้อง';
  if (!Number.isFinite(lng) || lng < -180 || lng > 180)      return 'พิกัด longitude ไม่ถูกต้อง';
  if (!Number.isFinite(radius) || radius < 10 || radius > 5000) return 'รัศมีต้องอยู่ในช่วง 10–5000 เมตร';
  return null;
}

router.post('/office-locations', authenticate, authorize('owner'),
  auditLog('office_location_create', 'office_locations'),
  async (req, res) => {
  const err = validateLocPayload(req.body);
  if (err) return res.status(400).json({ success: false, message: err });
  try {
    const r = await query(
      `INSERT INTO office_locations (name, lat, lng, radius_meters, is_active)
       VALUES ($1, $2, $3, $4, COALESCE($5, true)) RETURNING *`,
      [String(req.body.name).trim(), Number(req.body.lat), Number(req.body.lng),
       Math.round(Number(req.body.radiusMeters)),
       typeof req.body.isActive === 'boolean' ? req.body.isActive : null]
    );
    res.status(201).json({ success: true, data: r.rows[0] });
  } catch (e) {
    console.error('POST /office-locations error:', e.message);
    res.status(500).json({ success: false, message: 'เกิดข้อผิดพลาด' });
  }
});

router.patch('/office-locations/:id', authenticate, authorize('owner'),
  auditLog('office_location_update', 'office_locations'),
  async (req, res) => {
  const { name, lat, lng, radiusMeters, isActive } = req.body;
  // Partial update: validate only fields present.
  if (lat !== undefined) {
    const n = Number(lat);
    if (!Number.isFinite(n) || n < -90 || n > 90) {
      return res.status(400).json({ success: false, message: 'พิกัด latitude ไม่ถูกต้อง' });
    }
  }
  if (lng !== undefined) {
    const n = Number(lng);
    if (!Number.isFinite(n) || n < -180 || n > 180) {
      return res.status(400).json({ success: false, message: 'พิกัด longitude ไม่ถูกต้อง' });
    }
  }
  if (radiusMeters !== undefined) {
    const n = Math.round(Number(radiusMeters));
    if (!Number.isFinite(n) || n < 10 || n > 5000) {
      return res.status(400).json({ success: false, message: 'รัศมีต้องอยู่ในช่วง 10–5000 เมตร' });
    }
  }
  try {
    await query(
      `UPDATE office_locations SET
         name          = COALESCE($1, name),
         lat           = COALESCE($2, lat),
         lng           = COALESCE($3, lng),
         radius_meters = COALESCE($4, radius_meters),
         is_active     = COALESCE($5, is_active),
         updated_at    = NOW()
       WHERE id = $6`,
      [name ? String(name).trim() : null,
       lat !== undefined ? Number(lat) : null,
       lng !== undefined ? Number(lng) : null,
       radiusMeters !== undefined ? Math.round(Number(radiusMeters)) : null,
       typeof isActive === 'boolean' ? isActive : null,
       req.params.id]
    );
    res.json({ success: true, message: 'อัปเดตแล้ว' });
  } catch (e) {
    console.error('PATCH /office-locations/:id error:', e.message);
    res.status(500).json({ success: false, message: 'เกิดข้อผิดพลาด' });
  }
});

router.delete('/office-locations/:id', authenticate, authorize('owner'),
  auditLog('office_location_delete', 'office_locations'),
  async (req, res) => {
  try {
    await query('DELETE FROM office_locations WHERE id = $1', [req.params.id]);
    res.json({ success: true, message: 'ลบแล้ว' });
  } catch (e) {
    console.error('DELETE /office-locations/:id error:', e.message);
    res.status(500).json({ success: false, message: 'เกิดข้อผิดพลาด' });
  }
});

module.exports = router;
