const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { query } = require('../../config/database');
const { runPurgeIfDue } = require('./retentionController');
const { runSweepIfDue } = require('./attendanceController');

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
//
// Previously: jwt.verify alone was enough to mint a new access token, so
// logout (DELETE FROM refresh_tokens) didn't actually revoke anything —
// any leaked refresh token stayed valid until its 30-day JWT expiry.
//
// Now: after JWT signature/expiry passes, we bcrypt.compare the incoming
// token against every non-expired refresh_tokens row for the user. No
// match → 401 (token was revoked via logout, password change, etc.).
// On success we rotate: delete the matched row and insert a new one, so
// the previous refresh token cannot be replayed.
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

    const stored = await query(
      'SELECT id, token_hash FROM refresh_tokens WHERE user_id = $1 AND expires_at > NOW()',
      [user.id]
    );
    let matchedRowId = null;
    for (const row of stored.rows) {
      if (await bcrypt.compare(token, row.token_hash)) { matchedRowId = row.id; break; }
    }
    if (!matchedRowId) {
      return res.status(401).json({ success: false, message: 'Refresh token ถูกเพิกถอน' });
    }

    const payload = { userId: user.id, role: user.role, employeeId: user.employee_id };
    const newAccessToken = jwt.sign(payload, process.env.JWT_SECRET, { expiresIn: process.env.JWT_EXPIRES_IN || '8h' });
    const newRefreshToken = jwt.sign(payload, process.env.JWT_SECRET, { expiresIn: process.env.JWT_REFRESH_EXPIRES_IN || '30d' });
    const newHash = await bcrypt.hash(newRefreshToken, 8);

    await query('DELETE FROM refresh_tokens WHERE id = $1', [matchedRowId]);
    await query(
      'INSERT INTO refresh_tokens (user_id, token_hash, expires_at, device_info, ip_address) VALUES ($1, $2, NOW() + INTERVAL \'30 days\', $3, $4)',
      [user.id, newHash, req.headers['user-agent']?.substring(0, 200), req.ip]
    );

    res.json({ success: true, data: { accessToken: newAccessToken, refreshToken: newRefreshToken } });
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
    // Piggyback lazy daily auto-purge here. Fire-and-forget — the cost
    // is one SELECT on org_settings unless we're actually due, and the
    // user shouldn't wait for /me on the rare day it actually runs.
    runPurgeIfDue().catch(() => {});
    // Same lazy-daily pattern: catch up on missing-checkout rows once
    // per day from whoever's the first to load the app. Cheap no-op
    // after the first hit each day thanks to the in-process gate.
    runSweepIfDue().catch(() => {});
    res.json({ success: true, data: { ...u, fullName: u ? `${u.first_name} ${u.last_name}` : null } });
  } catch (err) {
    res.status(500).json({ success: false, message: 'เกิดข้อผิดพลาด' });
  }
};

/* ===== LINE Login (LIFF integration) ===== */
// Mirrors /auth/login's JWT contract so the frontend can use the same
// token storage + axios interceptors. The verification flow:
//   1. LIFF gives us a LINE access_token (client-side, after liff.login()).
//   2. Backend hits LINE's verify endpoint to confirm the token is
//      valid AND was minted for OUR channel (defends against an
//      attacker sending a token from a different LINE app).
//   3. Fetch the LINE profile to get the immutable userId.
//   4. Look up users.line_user_id. If found → mint JWTs.
//      If not + email/password supplied → verify those, link the LINE
//      userId to the matching account, mint JWTs.
//      If not + no credentials → 404 so the frontend can prompt linking.
async function verifyLineToken(accessToken) {
  const expectedChannelId = process.env.LINE_LOGIN_CHANNEL_ID;
  if (!expectedChannelId) {
    throw Object.assign(new Error('LINE_LOGIN_CHANNEL_ID env var missing'), { status: 500 });
  }
  const verifyRes = await fetch(
    'https://api.line.me/oauth2/v2.1/verify?access_token=' + encodeURIComponent(accessToken)
  );
  if (!verifyRes.ok) {
    throw Object.assign(new Error('LINE token verification failed'), { status: 401 });
  }
  const verify = await verifyRes.json();
  // Defend against tokens issued for some other LINE app.
  if (String(verify.client_id) !== String(expectedChannelId)) {
    throw Object.assign(new Error('LINE token belongs to a different channel'), { status: 401 });
  }
  if (typeof verify.expires_in === 'number' && verify.expires_in <= 0) {
    throw Object.assign(new Error('LINE token expired'), { status: 401 });
  }
  const profileRes = await fetch('https://api.line.me/v2/profile', {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!profileRes.ok) {
    throw Object.assign(new Error('Failed to fetch LINE profile'), { status: 401 });
  }
  return profileRes.json(); // { userId, displayName, pictureUrl?, statusMessage? }
}

// Shared "issue JWT pair + write refresh token row" used by both
// password login and LINE login. Returns the same response shape the
// frontend already consumes.
async function issueTokensAndRespond(res, req, user) {
  await query(
    'UPDATE users SET failed_login_count = 0, locked_until = NULL, last_login_at = NOW() WHERE id = $1',
    [user.id]
  );
  const empResult = await query(
    `SELECT e.id as emp_id, e.first_name, e.last_name, e.avatar_url, d.name as department
       FROM employees e LEFT JOIN departments d ON e.department_id = d.id
      WHERE e.user_id = $1`,
    [user.id]
  );
  const emp = empResult.rows[0];

  const payload = { userId: user.id, role: user.role, employeeId: user.employee_id };
  const accessToken  = jwt.sign(payload, process.env.JWT_SECRET, { expiresIn: process.env.JWT_EXPIRES_IN || '8h' });
  const refreshToken = jwt.sign(payload, process.env.JWT_SECRET, { expiresIn: process.env.JWT_REFRESH_EXPIRES_IN || '30d' });
  const tokenHash = await bcrypt.hash(refreshToken, 8);
  await query(
    'INSERT INTO refresh_tokens (user_id, token_hash, expires_at, device_info, ip_address) VALUES ($1, $2, NOW() + INTERVAL \'30 days\', $3, $4)',
    [user.id, tokenHash, req.headers['user-agent']?.substring(0, 200), req.ip]
  );

  res.json({
    success: true,
    data: {
      accessToken, refreshToken,
      user: {
        id: user.id, email: user.email, role: user.role, employeeId: user.employee_id,
        firstName: emp?.first_name, lastName: emp?.last_name,
        fullName: emp ? `${emp.first_name} ${emp.last_name}` : null,
        avatarUrl: emp?.avatar_url, department: emp?.department,
      }
    }
  });
}

// POST /api/auth/line-login
// Body: { lineAccessToken, email?, password? }
//   - First call from a linked account: just lineAccessToken; we
//     resolve users via line_user_id and mint JWTs.
//   - First-ever call from a not-yet-linked account: must include
//     email + password; we verify credentials and link line_user_id.
const lineLogin = async (req, res) => {
  try {
    const { lineAccessToken, email, password } = req.body;
    if (!lineAccessToken) {
      return res.status(400).json({ success: false, message: 'กรุณาส่ง LINE access token' });
    }
    let profile;
    try { profile = await verifyLineToken(lineAccessToken); }
    catch (e) { return res.status(e.status || 401).json({ success: false, message: e.message }); }

    const lineUserId = profile.userId;
    const linked = await query(
      'SELECT id, email, role, employee_id, is_active FROM users WHERE line_user_id = $1',
      [lineUserId]
    );
    if (linked.rows[0]) {
      const user = linked.rows[0];
      if (!user.is_active) return res.status(403).json({ success: false, message: 'บัญชีถูกระงับการใช้งาน' });
      return issueTokensAndRespond(res, req, user);
    }

    // Not yet linked. Need email+password to bind this LINE userId to a
    // real account. Frontend should detect this 404 and show a small
    // "ผูกบัญชี" form.
    if (!email || !password) {
      return res.status(404).json({
        success: false,
        code: 'LINE_NOT_LINKED',
        message: 'บัญชี LINE นี้ยังไม่ได้ผูกกับพนักงาน — กรุณากรอกอีเมล/รหัสผ่านเพื่อผูก',
        data: { lineDisplayName: profile.displayName, linePictureUrl: profile.pictureUrl },
      });
    }

    const passRes = await query(
      'SELECT id, email, password_hash, role, is_active, employee_id FROM users WHERE email = $1',
      [email.toLowerCase().trim()]
    );
    const candidate = passRes.rows[0];
    if (!candidate || !candidate.is_active) {
      return res.status(401).json({ success: false, message: 'อีเมลหรือรหัสผ่านไม่ถูกต้อง' });
    }
    if (!(await bcrypt.compare(password, candidate.password_hash))) {
      return res.status(401).json({ success: false, message: 'อีเมลหรือรหัสผ่านไม่ถูกต้อง' });
    }
    try {
      await query('UPDATE users SET line_user_id = $1 WHERE id = $2', [lineUserId, candidate.id]);
    } catch (err) {
      // 23505 = unique violation; means this LINE id raced and got
      // linked elsewhere in between.
      if (err.code === '23505') {
        return res.status(409).json({ success: false, message: 'บัญชี LINE นี้ถูกใช้กับบัญชีอื่นแล้ว' });
      }
      throw err;
    }
    return issueTokensAndRespond(res, req, candidate);
  } catch (err) {
    console.error('LINE login error:', err);
    res.status(500).json({ success: false, message: 'เกิดข้อผิดพลาด' });
  }
};

// POST /api/auth/line-link  (must be authenticated via email login first)
// For the path "I already logged in normally and want to attach my
// LINE account now". Body: { lineAccessToken }
const lineLink = async (req, res) => {
  try {
    const { lineAccessToken } = req.body;
    if (!lineAccessToken) {
      return res.status(400).json({ success: false, message: 'กรุณาส่ง LINE access token' });
    }
    let profile;
    try { profile = await verifyLineToken(lineAccessToken); }
    catch (e) { return res.status(e.status || 401).json({ success: false, message: e.message }); }
    try {
      await query('UPDATE users SET line_user_id = $1 WHERE id = $2', [profile.userId, req.user.id]);
    } catch (err) {
      if (err.code === '23505') {
        return res.status(409).json({ success: false, message: 'บัญชี LINE นี้ถูกใช้กับบัญชีอื่นแล้ว' });
      }
      throw err;
    }
    res.json({
      success: true,
      message: 'ผูกบัญชี LINE แล้ว',
      data: { lineDisplayName: profile.displayName, linePictureUrl: profile.pictureUrl },
    });
  } catch (err) {
    console.error('LINE link error:', err);
    res.status(500).json({ success: false, message: 'เกิดข้อผิดพลาด' });
  }
};

// POST /api/auth/line-unlink  (must be authenticated)
const lineUnlink = async (req, res) => {
  try {
    await query('UPDATE users SET line_user_id = NULL WHERE id = $1', [req.user.id]);
    res.json({ success: true, message: 'ยกเลิกการผูกบัญชี LINE แล้ว' });
  } catch (err) {
    res.status(500).json({ success: false, message: 'เกิดข้อผิดพลาด' });
  }
};

module.exports = { login, logout, refreshToken, changePassword, getMe, lineLogin, lineLink, lineUnlink };
