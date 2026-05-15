const express = require('express');
const router = express.Router();
const { authenticate, authorize, auditLog } = require('../middleware/auth');
const authCtrl = require('../controllers/authController');
const attendCtrl = require('../controllers/attendanceController');
const leaveCtrl = require('../controllers/leaveController');
const { query } = require('../../config/database');

// ====== AUTH ======
router.post('/auth/login', authCtrl.login);
router.post('/auth/refresh', authCtrl.refreshToken);
router.post('/auth/logout', authenticate, authCtrl.logout);
router.post('/auth/change-password', authenticate, authCtrl.changePassword);
router.get('/auth/me', authenticate, authCtrl.getMe);

// ====== ATTENDANCE ======
router.post('/attendance/check-in', authenticate, attendCtrl.checkIn);
router.post('/attendance/check-out', authenticate, attendCtrl.checkOut);
router.get('/attendance/today', authenticate, attendCtrl.getToday);
router.get('/attendance/my-history', authenticate, attendCtrl.getMyHistory);
router.get('/attendance/daily-summary', authenticate, authorize('owner', 'hr'), attendCtrl.getDailySummary);

// ====== LEAVE ======
router.get('/leave/types', authenticate, leaveCtrl.getLeaveTypes);
router.get('/leave/my-quota', authenticate, leaveCtrl.getMyQuota);
router.get('/leave/my-history', authenticate, leaveCtrl.getMyHistory);
router.post('/leave/request', authenticate, leaveCtrl.createRequest);
router.get('/leave/pending', authenticate, authorize('hr', 'owner'), leaveCtrl.getPending);
router.patch('/leave/:id/approve', authenticate, authorize('hr'), auditLog('leave_approval', 'leave_requests'), leaveCtrl.approveRequest);

// ====== OT ======
router.get('/ot/pending', authenticate, authorize('hr', 'owner'), async (req, res) => {
  try {
    const result = await query(
      `SELECT o.*, e.first_name, e.last_name, e.employee_id as emp_code, d.name as department
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

router.patch('/ot/:id/approve', authenticate, authorize('hr'), async (req, res) => {
  try {
    const { action } = req.body;
    await query(
      'UPDATE ot_requests SET status = $1, hr_approved_by = $2, hr_approved_at = NOW(), updated_at = NOW() WHERE id = $3',
      [action === 'approved' ? 'hr_approved' : 'rejected', req.user.id, req.params.id]
    );
    res.json({ success: true, message: action === 'approved' ? 'อนุมัติ OT แล้ว' : 'ปฏิเสธ OT แล้ว' });
  } catch (e) { res.status(500).json({ success: false, message: 'เกิดข้อผิดพลาด' }); }
});

// ====== EMPLOYEES ======
router.get('/employees', authenticate, authorize('hr', 'owner'), async (req, res) => {
  try {
    const result = await query(
      `SELECT e.*, u.email, u.role, u.is_active as account_active, u.last_login_at, d.name as department_name
       FROM employees e
       LEFT JOIN users u ON e.user_id = u.id
       LEFT JOIN departments d ON e.department_id = d.id
       WHERE e.is_active = true
       ORDER BY e.first_name`
    );
    res.json({ success: true, data: result.rows });
  } catch (e) { res.status(500).json({ success: false, message: 'เกิดข้อผิดพลาด' }); }
});

router.get('/employees/me', authenticate, async (req, res) => {
  try {
    const result = await query(
      `SELECT e.*, u.email, d.name as department_name
       FROM employees e
       LEFT JOIN users u ON e.user_id = u.id
       LEFT JOIN departments d ON e.department_id = d.id
       WHERE e.user_id = $1`,
      [req.user.id]
    );
    res.json({ success: true, data: result.rows[0] });
  } catch (e) { res.status(500).json({ success: false, message: 'เกิดข้อผิดพลาด' }); }
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
  const {firstName,lastName,position,department,shiftType,baseSalary,role} = req.body
  try {
    const deptRes = await query('SELECT id FROM departments WHERE name=$1',[department])
    const deptId = deptRes.rows[0]?.id||null
    await query('UPDATE employees SET first_name=COALESCE($1,first_name),last_name=COALESCE($2,last_name),position=COALESCE($3,position),department_id=COALESCE($4,department_id),shift_type=COALESCE($5,shift_type),base_salary=COALESCE($6,base_salary),updated_at=NOW() WHERE id=$7',[firstName,lastName,position,deptId,shiftType,baseSalary,req.params.id])
    if(role&&req.user.role==='owner'){const e=await query('SELECT user_id FROM employees WHERE id=$1',[req.params.id]);if(e.rows[0])await query('UPDATE users SET role=$1 WHERE id=$2',[role,e.rows[0].user_id])}
    res.json({success:true,message:'อัปเดตสำเร็จ'})
  } catch(err){res.status(500).json({success:false,message:'เกิดข้อผิดพลาด'})}
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
