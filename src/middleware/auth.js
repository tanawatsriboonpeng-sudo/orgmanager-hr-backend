const jwt = require('jsonwebtoken');
const { query } = require('../../config/database');

// ตรวจสอบ JWT token
const authenticate = async (req, res, next) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ success: false, message: 'กรุณาเข้าสู่ระบบก่อน' });
    }

    const token = authHeader.split(' ')[1];
    const decoded = jwt.verify(token, process.env.JWT_SECRET);

    // ดึงข้อมูล user จาก DB (เพื่อตรวจสอบว่ายังใช้งานอยู่)
    const result = await query(
      'SELECT id, email, role, is_active, employee_id FROM users WHERE id = $1',
      [decoded.userId]
    );

    if (!result.rows[0] || !result.rows[0].is_active) {
      return res.status(401).json({ success: false, message: 'บัญชีถูกระงับการใช้งาน' });
    }

    req.user = result.rows[0];
    next();
  } catch (err) {
    if (err.name === 'TokenExpiredError') {
      return res.status(401).json({ success: false, message: 'Session หมดอายุ กรุณาเข้าสู่ระบบใหม่', code: 'TOKEN_EXPIRED' });
    }
    return res.status(401).json({ success: false, message: 'Token ไม่ถูกต้อง' });
  }
};

// ตรวจสอบ Role
const authorize = (...roles) => {
  return (req, res, next) => {
    if (!roles.includes(req.user.role)) {
      return res.status(403).json({
        success: false,
        message: `ไม่มีสิทธิ์ดำเนินการ (ต้องการ: ${roles.join(' หรือ ')})`
      });
    }
    next();
  };
};

// บันทึก Audit Log
//
// Implementation detail: we wrap res.json so we can write the audit row
// AFTER the handler decides on the response shape (so resource_id can
// come from data.data?.id when the handler returned it). The wrapper is
// fire-and-forget on the INSERT — we don't want a flaky audit write to
// turn a successful business action into a 500 — but we do log the
// failure to stderr so it shows up in Render logs. Previously this
// catch was silent and we lost months of audits to an undetected error.
const auditLog = (action, resource) => {
  return async (req, res, next) => {
    const originalJson = res.json.bind(res);
    res.json = (data) => {
      // Fire the INSERT off the critical path. We intentionally don't
      // await it here — the response goes out immediately, and any audit
      // failure is logged but doesn't block the user.
      if (data && data.success !== false) {
        query(
          `INSERT INTO audit_logs (user_id, action, resource, resource_id, details, ip_address, device_info)
           VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7)`,
          [
            req.user?.id || null,
            action,
            resource,
            data.data?.id || req.params.id || null,
            JSON.stringify({ method: req.method, path: req.path }),
            req.ip || null,
            req.headers['user-agent']?.substring(0, 200) || null,
          ]
        ).catch(err => {
          console.error(`[audit] failed to log ${action}/${resource}:`, err.message);
        });
      }
      return originalJson(data);
    };
    next();
  };
};

module.exports = { authenticate, authorize, auditLog };
