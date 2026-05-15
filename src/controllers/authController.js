const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { query } = require('../../config/database');

const MAX_FAILED_ATTEMPTS = 5;
const LOCK_DURATION_MINUTES = 30;

// POST /api/auth/login
const login = async (req, res) => {
  try {
    const { email, password, role } = req.body;

    // ดึง user
    const result = await query(
      'SELECT id, email, password_hash, role, is_active, failed_login_count, locked_until, employee_id FROM users WHERE email = $1',
      [email.toLowerCase().trim()]
    );

    const user = result.rows[0];

    // ไม่พบ user หรือ role ไม่ตรง
    if (!user || (role && user.role !== role)) {
      return res.status(401).json({ success: false, message: 'อีเมลหรือรหัสผ่านไม่ถูกต้อง' });
    }

    // ตรวจสอบ lock
    if (user.locked_until && new Date(user.locked_until) > new Date()) {
      const minutesLeft = Math.ceil((new Date(user.locked_until) - new Date()) / 60000);
      return res.status(423).json({
        success: false,
        message: `บัญชีถูกล็อคชั่วคราว กรุณารอ ${minutesLeft} นาที`
      });
    }

    if (!user.is_active) {
      return res.status(403).json({ success: false, message: 'บัญชีถูกระงับการใช้งาน กรุณาติดต่อ HR' });
    }

    // ตรวจสอบรหัสผ่าน
    const isValid = await bcrypt.compare(password, user.password_hash);

    if (!isValid) {
      const newCount = (user.failed_login_count || 0) + 1;
      if (newCount >= MAX_FAILED_ATTEMPTS) {
        await query(
          'UPDATE users SET failed_login_count = $1, locked_until = NOW() + INTERVAL \'30 minutes\' WHERE id = $2',
          [newCount, user.id]
        );
        return res.status(423).json({
          success: false,
          message: `รหัสผ่านผิดเกิน ${MAX_FAILED_ATTEMPTS} ครั้ง บัญชีถูกล็อค ${LOCK_DURATION_MINUTES} นาที`
        });
      }
      await query('UPDATE users SET failed_login_count = $1 WHERE id = $2', [newCount, user.id]);
      return res.status(401).json({
        success: false,
        message: `อีเมลหรือรหัสผ่านไม่ถูกต้อง (เหลืออีก ${MAX_FAILED_ATTEMPTS - newCount} ครั้ง)`
      });
    }

    // Login สำเร็จ — reset failed count
    await query(
      'UPDATE users SET failed_login_count = 0, locked_until = NULL, last_login_at = NOW() WHERE id = $1',
      [user.id]
    );

    // ดึงข้อมูล employee
    const empResult = await query(
      'SELECT e.id as emp_id, e.first_name, e.last_name, e.avatar_url, d.name as department FROM employees e LEFT JOIN departments d ON e.department_id = d.id WHERE e.user_id = $1',
      [user.id]
    );
    const emp = empResult.rows[0];

    // สร้าง JWT
    const payload = { userId: user.id, role: user.role, employeeId: user.employee_id };
    const accessToken = jwt.sign(payload, process.env.JWT_SECRET, { expiresIn: process.env.JWT_EXPIRES_IN || '8h' });
    const refreshToken = jwt.sign(payload, process.env.JWT_SECRET, { expiresIn: process.env.JWT_REFRESH_EXPIRES_IN || '30d' });

    // บันทึก refresh token
    const tokenHash = await bcrypt.hash(refreshToken, 8);
    await query(
      'INSERT INTO refresh_tokens (user_id, token_hash, expires_at, device_info, ip_address) VALUES ($1, $2, NOW() + INTERVAL \'30 days\', $3, $4)',
      [user.id, tokenHash, req.headers['user-agent']?.substring(0, 200), req.ip]
    );

    res.json({
      success: true,
      data: {
        accessToken,
        refreshToken,
        user: {
          id: user.id,
          email: user.email,
          role: user.role,
          employeeId: user.employee_id,
          firstName: emp?.first_name,
          lastName: emp?.last_name,
          fullName: emp ? `${emp.first_name} ${emp.last_name}` : null,
          avatarUrl: emp?.avatar_url,
          department: emp?.department,
        }
      }
    });
  } catch (err) {
    console.error('Login error:', err);
    res.status(500).json({ success: false, message: 'เกิดข้อผิดพลาด กรุณาลองใหม่' });
  }
};

// POST /api/auth/refresh
const refreshToken = async (req, res) => {
  try {
    const { refreshToken: token } = req.body;
    if (!token) return res.status(400).json({ success: false, message: 'ไม่พบ refresh token' });

    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    const result = await query(
      'SELECT id, email, role, employee_id, is_active FROM users WHERE id = $1',
      [decoded.userId]
    );
    const user = result.rows[0];
    if (!user || !user.is_active) {
      return res.status(401).json({ success: false, message: 'บัญชีไม่พร้อมใช้งาน' });
    }

    const payload = { userId: user.id, role: user.role, employeeId: user.employee_id };
    const newAccessToken = jwt.sign(payload, process.env.JWT_SECRET, { expiresIn: '8h' });

    res.json({ success: true, data: { accessToken: newAccessToken } });
  } catch (err) {
    res.status(401).json({ success: false, message: 'Refresh token ไม่ถูกต้องหรือหมดอายุ' });
  }
};

// POST /api/auth/logout
const logout = async (req, res) => {
  try {
    await query('DELETE FROM refresh_tokens WHERE user_id = $1', [req.user.id]);
    res.json({ success: true, message: 'ออกจากระบบแล้ว' });
  } catch (err) {
    res.status(500).json({ success: false, message: 'เกิดข้อผิดพลาด' });
  }
};

// POST /api/auth/change-password
const changePassword = async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body;
    if (!newPassword || newPassword.length < 8) {
      return res.status(400).json({ success: false, message: 'รหัสผ่านต้องมีอย่างน้อย 8 ตัวอักษร' });
    }
    const result = await query('SELECT password_hash FROM users WHERE id = $1', [req.user.id]);
    const isValid = await bcrypt.compare(currentPassword, result.rows[0].password_hash);
    if (!isValid) return res.status(400).json({ success: false, message: 'รหัสผ่านปัจจุบันไม่ถูกต้อง' });

    const newHash = await bcrypt.hash(newPassword, 12);
    await query('UPDATE users SET password_hash = $1, updated_at = NOW() WHERE id = $2', [newHash, req.user.id]);
    res.json({ success: true, message: 'เปลี่ยนรหัสผ่านสำเร็จ' });
  } catch (err) {
    res.status(500).json({ success: false, message: 'เกิดข้อผิดพลาด' });
  }
};

// GET /api/auth/me
const getMe = async (req, res) => {
  try {
    const result = await query(
      `SELECT u.id, u.email, u.role, u.employee_id, u.last_login_at,
              e.first_name, e.last_name, e.avatar_url, e.position, e.shift_type,
              d.name as department
       FROM users u
       LEFT JOIN employees e ON e.user_id = u.id
       LEFT JOIN departments d ON e.department_id = d.id
       WHERE u.id = $1`,
      [req.user.id]
    );
    const u = result.rows[0];
    res.json({ success: true, data: { ...u, fullName: u ? `${u.first_name} ${u.last_name}` : null } });
  } catch (err) {
    res.status(500).json({ success: false, message: 'เกิดข้อผิดพลาด' });
  }
};

module.exports = { login, logout, refreshToken, changePassword, getMe };
